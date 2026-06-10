import asyncio
import logging
import time
from datetime import timedelta, datetime

from pydoover.docker import Application, run_app
from pydoover.models import ConnectionConfig, ConnectionType as DooverConnectionType
from pydoover.ui import handler
from pydoover.utils import apply_async_kalman_filter

from .victron import VictronDevice
from .app_config import PowerManagerConfig
from .app_tags import PowerManagerTags
from .app_ui import PowerManagerUI

log = logging.getLogger()


class PowerManager(Application):
    config_cls = PowerManagerConfig
    tags_cls = PowerManagerTags
    ui_cls = PowerManagerUI

    config: PowerManagerConfig
    tags: PowerManagerTags
    ui: PowerManagerUI

    async def update_voltage(self):
        # Only update the voltage every voltage_update_interval seconds
        if (
            self.last_voltage_time is None
            or time.time() - self.last_voltage_time > self.voltage_update_interval
        ):
            try:
                self.last_voltage = await self.get_system_voltage()
            except Exception as e:
                log.error(f"Error fetching system voltage: {e}")

            if self.last_voltage is not None:
                self.last_voltage = round(self.last_voltage, 2)
                self.last_voltage_time = time.time()

            self.last_temp = await self.get_system_temperature()
            log.info(
                f"Filtered system voltage: {self.last_voltage}, temp: {self.last_temp}"
            )

    @apply_async_kalman_filter(
        process_variance=0.05,
        outlier_threshold=0.5,
    )
    async def get_system_voltage(self) -> float:
        return await self.platform_iface.fetch_system_voltage()

    @apply_async_kalman_filter(process_variance=0.5, outlier_threshold=5)
    async def get_system_temperature(self) -> float:
        return await self.platform_iface.fetch_system_temperature()

    def get_sleep_time(self) -> int | None:
        if self.last_voltage is None:
            return None

        for voltage, sleep_time in sorted(
            self.config.sleep_time_threshold_lookup, key=lambda x: x[0]
        ):
            if self.last_voltage <= voltage:
                log.info(f"Sleep time determined from config: {sleep_time} minutes")
                return sleep_time * 60

    def get_min_awake_time(self) -> int:
        abs_min_awake_time = 90  # The floor value for the minimum awake time

        if self.last_voltage is None:
            return max(
                self.config.min_awake_time_thresholds.element.awake_time.default,
                abs_min_awake_time,
            )

        for voltage, awake_time in sorted(
            self.config.min_awake_time_threshold_lookup, key=lambda x: x[0]
        ):
            if self.last_voltage <= voltage:
                log.info(f"Min awake time determined from config: {awake_time} seconds")
                return max(abs_min_awake_time, awake_time)

        return abs_min_awake_time

    @property
    def awake_time(self) -> int:
        if self.start_time is None:
            self.start_time = time.time()

        return int(time.time() - self.start_time)

    async def publish_connection_config(
        self,
        sleep_time: int | None = None,
        time_till_sleep: int | None = None,
    ) -> None:
        """Publish the device's connection config to the doover_connection channel."""
        if sleep_time is not None and time_till_sleep is not None:
            next_wake_at_ms = int((time.time() + time_till_sleep + sleep_time) * 1000)
            offline_after = (time_till_sleep + sleep_time) * 5
        else:
            next_wake_at_ms = None
            offline_after = None

        config = ConnectionConfig(
            connection_type=DooverConnectionType.periodic_continuous,
            expected_interval=sleep_time,
            offline_after=offline_after,
            sleep_time=sleep_time,
            next_wake_time=next_wake_at_ms,
        )
        payload = {"config": config.to_dict()}
        try:
            await self.update_channel_aggregate(
                "doover_connection", payload, max_age_secs=-1
            )
            await self.create_message("doover_connection", payload)
        except Exception as e:
            log.error(f"Error publishing doover_connection config: {e}")

    async def maybe_schedule_sleep(self, sleep_time: int, time_till_sleep: int = 20):
        if self.scheduled_goto_sleep_time is not None:
            if self.time_until_sleep is not None:
                log.warning(f"Time till sleep: {self.time_until_sleep}")

            ## Already scheduled to sleep, so just return.
            return

        if self.awake_time < (self.get_min_awake_time() - time_till_sleep):
            time_till_sleep = self.get_min_awake_time() - self.awake_time
            log.info(f"Minimum awake time not met: {time_till_sleep} seconds to go")
            return

        # alert apps that they must report if they can shutdown or not.
        await self.set_global_tag("shutdown_requested", True)

        # this will fail the first time because apps won't respond
        # quick enough but should run OK on consecutive calls.
        config_override_secs = (
            self.config.override_shutdown_permission_mins.value * 60 - 300
        )
        if self.shutdown_permitted is False and self.awake_time < config_override_secs:
            time_left = config_override_secs - self.awake_time
            log.info(
                f"One of more app denied a shutdown and we can only override this in {time_left} seconds..."
            )
            return

        immunity_time = await self.get_immunity_time()
        if immunity_time is not None:
            log.info(f"Device immune to shutdown for {immunity_time} seconds.")
            return

        log.info(f"Scheduling sleep of {sleep_time} secs in {time_till_sleep} secs.")
        self.scheduled_goto_sleep_time = time.time() + time_till_sleep
        self.scheduled_sleep_time = sleep_time

        await self.publish_connection_config(sleep_time, time_till_sleep)

    @property
    def time_until_sleep(self) -> int | None:
        if self.scheduled_goto_sleep_time is None:
            return None
        result = int(
            self.scheduled_goto_sleep_time - time.time() + self.shutdown_process_time
        )
        return max(result, 0)

    @property
    def is_ready_to_sleep(self) -> bool:
        if self.scheduled_goto_sleep_time is None:
            return False
        return time.time() >= self.scheduled_goto_sleep_time

    @property
    def shutdown_permitted(self):
        # search through app state for any apps that have shutdown_permitted = False
        for k, v in self.tag_manager._tag_values.items():
            if isinstance(v, dict) and v.get("shutdown_check_ok", True) is False:
                log.info(f"Shutdown not permitted by {k}.")
                return False
        return True

    async def get_immunity_time(self) -> int | None:
        immunity_secs = await self.platform_iface.fetch_immunity_seconds()
        if immunity_secs is not None and immunity_secs <= 1:
            immunity_secs = None
        return immunity_secs

    async def schedule_next_startup(self):
        if self.scheduled_sleep_time is None:
            self.scheduled_sleep_time = self.get_sleep_time()

        log.info(f"Scheduling next startup in {self.scheduled_sleep_time} seconds...")
        await self.platform_iface.schedule_startup(self.scheduled_sleep_time)

    async def assess_power(self):
        """Monitor system voltage, determine sleep time, and handle shutdown."""
        if self.start_time is None:
            log.info("Setting start time")
            self.start_time = time.time()

        await self.update_voltage()

        if self.is_ready_to_sleep:
            log.info("Ready to sleep. Requesting shutdown...")
            await self.go_to_sleep()
            return

        sleep_time = self.get_sleep_time()
        if sleep_time is None:
            log.info("No sleep time found.")
            return

        log.info(f"Scheduling next sleep in {sleep_time} seconds...")
        await self.maybe_schedule_sleep(sleep_time)

    @property
    def shutdown_process_time(self) -> int:
        """Return the time it takes to shutdown the system."""
        return 40

    async def go_to_sleep(self):
        """Put the system to sleep."""
        log.warning("Putting system to sleep...")

        log.info("Setting shutdown_requested hooks")
        await self.set_global_tag("shutdown_requested", True)

        log.info("Sleeping for 20 seconds to allow shutdown hooks to run...")
        await asyncio.sleep(20)

        await self.refresh_ui()

        # for a maximum of 300 seconds (5min), check if shutdown is permitted
        for _ in range(60):
            if self.shutdown_permitted:
                log.info("All shutdown checks passed. Proceeding to shutdown...")
                break
            else:
                log.info(
                    "Shutdown not permitted. Waiting for 5 seconds before retrying..."
                )
                await asyncio.sleep(5)

        await self.refresh_ui()

        # either shutdown is permitted, or we've timed out. Either way, proceed to shutdown...
        shutdown_grace_period = 20

        ## Run shutdown hooks
        shutdown_at = datetime.now() + timedelta(seconds=shutdown_grace_period)
        await self.set_global_tag("shutdown_at", shutdown_at.timestamp())

        ## schedule the next startup
        await self.schedule_next_startup()

        # Publish final connection config so the cloud knows when we'll be back.
        await self.publish_connection_config(
            self.scheduled_sleep_time, shutdown_grace_period
        )

        ## Put the system to sleep
        log.info(f"Scheduling shutdown to occur in {shutdown_grace_period} seconds...")
        await asyncio.sleep(shutdown_grace_period / 2)
        await self.run_shutdown_hook(shutdown_at)
        await asyncio.sleep(shutdown_grace_period / 2)

        log.info("Scheduling a hard shutdown in 60 seconds time as a safety net")
        await self.platform_iface.schedule_shutdown(60)
        await self.platform_iface.shutdown()

        ## Cleanly disconnect the device comms and then wait for sleep
        log.info("Waiting for device to shutdown...")
        await asyncio.sleep(40)
        raise asyncio.CancelledError(
            "Quitting power manager in anticipation of a system shutdown..."
        )

    async def maybe_reset_soft_watchdog(self):
        """Continually reset the soft watchdog to 3 hours from now.

        This ensures that if anything goes wrong, the system will shutdown and the RP2040 will reboot it.
        """
        if self.last_watchdog_reset_time:
            flag = (
                time.time() - self.last_watchdog_reset_time
                > self.watchdog_reset_interval_secs
            )
        else:
            flag = True

        if flag:
            try:
                await self.platform_iface.schedule_shutdown(
                    self.soft_watchdog_period_mins * 60
                )
            except Exception as e:
                log.error(f"Error scheduling shutdown for soft watchdog: {e}")
            else:
                self.last_watchdog_reset_time = time.time()

    async def setup(self):
        log.info("Setting up PowerManager...")

        # Initialize state
        self.start_time = None
        self.scheduled_sleep_time = None
        self.scheduled_goto_sleep_time = None
        self.soft_watchdog_period_mins = 3 * 60  # 3 hours
        self.last_watchdog_reset_time = None
        self.watchdog_reset_interval_secs = 20
        self.last_voltage = None
        self.last_temp = None
        self.last_voltage_time = None
        self.voltage_update_interval = 5
        self.about_to_shutdown = False
        self.victron_devices = []

        await self.maybe_reset_soft_watchdog()

        for victron_config in self.config.victron_configs.elements:
            self.victron_devices.append(
                VictronDevice(
                    victron_config.device_address.value,
                    victron_config.device_key.value,
                )
            )
            await self.victron_devices[-1].start()
        log.info(f"Found {len(self.victron_devices)} Victron devices.")

        # Show Victron UI elements if devices are configured
        if self.victron_devices:
            await self.tags.victron_hidden.set(False)

        # set shutdown_requested for all apps to False.
        log.info("Setting shutdown_requested tag for all apps to False.")
        await self.set_global_tag("shutdown_requested", False)
        await self.set_global_tag("shutdown_at", None)
        for app_key, v in self.tag_manager._tag_values.items():
            if not isinstance(v, dict) or app_key in (
                "shutdown_requested",
                "shutdown_at",
            ):
                continue
            await self.set_tag("shutdown_requested", False, app_key)

        ## Attempt 3 times to get a non-None voltage
        for i in range(3):
            if self.last_voltage is None:
                await self.update_voltage()
                await asyncio.sleep(0.1)
            else:
                break

        # Announce connection type up-front so the cloud knows this is a periodic
        # device even before we schedule a sleep. Timings are filled in later.
        await self.publish_connection_config(self.get_sleep_time())

    async def main_loop(self):
        await self.maybe_reset_soft_watchdog()
        await self.assess_power()

        shutdown_requested = any(
            isinstance(v, dict) and v.get("shutdown_requested", False) is True
            for k, v in self.tag_manager._tag_values.items()
        )

        if self.is_battery_low:
            if not self.tags.low_battery_warning_sent.value:
                message = f"Battery voltage is low: {self.last_voltage}V."
                log.info(f"Sending low battery message: {message}")
                await self.create_message("notification", {"message": message})
                await self.tags.low_battery_warning_sent.set(True)
        else:
            await self.tags.low_battery_warning_sent.set(False)

        await self.refresh_ui()

        if shutdown_requested:
            log.info("Shutdown requested. Initiating shutdown procedure...")
            await self.maybe_schedule_sleep(self.get_sleep_time())

    async def refresh_ui(self):
        """Update tags which auto-update the UI via tag bindings."""
        await self.tags.system_voltage.set(self.last_voltage)
        await self.tags.system_temperature.set(self.last_temp)
        await self.tags.is_online.set(not self.about_to_shutdown)

        # Low battery warning
        await self.tags.low_batt_warning_hidden.set(
            not (self.last_voltage and self.is_battery_low)
        )

        # Immunity warning
        immunity_time = await self.get_immunity_time()
        if immunity_time and immunity_time > 45:
            await self.tags.immune_warning_hidden.set(False)
            mins_awake = max(1, round(immunity_time / 60))
            if mins_awake <= 1:
                text = "Device will stay awake for 1 min"
            else:
                text = f"Device will stay awake for {mins_awake} mins"
            await self.tags.immune_warning_text.set(text)
        else:
            await self.tags.immune_warning_hidden.set(True)

        # Sleep warning
        sleep_warning_time = (
            self.time_until_sleep
            if self.time_until_sleep
            and self.time_until_sleep < 90
            and not self.about_to_shutdown
            else None
        )
        if sleep_warning_time:
            if sleep_warning_time < 45:
                # Hide in the last 45 seconds so it doesn't persist while asleep
                await self.tags.about_to_sleep_warning_hidden.set(True)
            else:
                await self.tags.about_to_sleep_warning_hidden.set(False)
                await self.tags.about_to_sleep_warning_text.set(
                    f"Device will sleep in {sleep_warning_time} seconds"
                )
        else:
            await self.tags.about_to_sleep_warning_hidden.set(True)

        # Victron charger data
        if self.victron_devices:
            for device in self.victron_devices:
                await self.tags.charge_state.set(device.state)
                await self.tags.charge_current.set(device.output_current)
                await self.tags.charge_voltage.set(device.output_voltage)
                await self.tags.charge_power.set(device.output_power)

    @handler("enable_immunity")
    async def on_enable_immunity(self, ctx, value):
        log.info("Immunity for 30 mins triggered")
        await self.platform_iface.set_immunity_seconds(30 * 60)

    @property
    def is_battery_low(self) -> bool:
        try:
            battery_low_alarm = self.ui.low_batt_alarm.value
        except (KeyError, AttributeError):
            battery_low_alarm = self.ui.low_batt_alarm.default
        if self.last_voltage is None or battery_low_alarm is None:
            return False
        return self.last_voltage < battery_low_alarm

    async def run_shutdown_hook(self, dt: datetime) -> None:
        self.about_to_shutdown = True
        await self.refresh_ui()
        await self.tag_manager.commit_tags()
        await asyncio.sleep(3)
        log.info("Pre-shutdown hook run, tags flushed and ready for shutdown.")


if __name__ == "__main__":
    run_app(PowerManager())
