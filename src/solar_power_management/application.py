import asyncio
import logging
import time
from datetime import timedelta, datetime

from pydoover.docker import Application, run_app
from pydoover.utils import apply_async_kalman_filter

from .app_config import PowerManagerConfig
from .app_ui import PowerManagerUI

log = logging.getLogger()


class PowerManager(Application):
    config: PowerManagerConfig

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.start_time = None

        # Secs that the system is scheduled to sleep for
        self.scheduled_sleep_time = None
        # Time that the system is scheduled to sleep
        self.scheduled_goto_sleep_time = None

        self.soft_watchdog_period_mins = 3 * 60  # 3 hours
        self.last_watchdog_reset_time = None
        self.watchdog_reset_interval_secs = 20

        self.last_voltage = None
        self.last_temp = None
        self.last_voltage_time = None
        self.voltage_update_interval = 5

        self.about_to_shutdown = False

        self.ui = PowerManagerUI()

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
        # Get the current system voltage
        return await self.platform_iface.get_system_voltage_async()

    @apply_async_kalman_filter(process_variance=0.5, outlier_threshold=5)
    async def get_system_temperature(self) -> float:
        return await self.platform_iface.get_system_temperature_async()

    def get_sleep_time(self) -> int | None:
        if self.last_voltage is None:
            return None

        for voltage, sleep_time in sorted(
            self.config.sleep_time_threshold_lookup, key=lambda x: x[0]
        ):
            if self.last_voltage <= voltage:
                log.info(f"Sleep time determined from config: {sleep_time} seconds")
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

    async def maybe_schedule_sleep(self, sleep_time: int, time_till_sleep: int = 20):
        if self.scheduled_goto_sleep_time is not None:
            if self.time_until_sleep is not None:
                log.warning(f"Time till sleep: {self.time_until_sleep}")
            return

        if self.awake_time < (self.get_min_awake_time() - time_till_sleep):
            time_till_sleep = self.get_min_awake_time() - self.awake_time
            log.info(f"Minimum awake time not met: {time_till_sleep} seconds to go")
            return

        # alert apps that they must report if they can shutdown or not.
        await self.set_global_tag_async("shutdown_requested", True)

        # this will fail the first time because apps won't respond
        # quick enough but should run OK on consecutive calls.
        # this is less 300 seconds because we check for a further 5min before actually setting the shutdown.
        # probably unnecessary?
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

        self.ui.update_connection_info(sleep_time, time_till_sleep + sleep_time)

    @property
    def time_until_sleep(self) -> int | None:
        if self.scheduled_goto_sleep_time is None:
            return None
        return int(self.scheduled_goto_sleep_time - time.time())

    @property
    def is_ready_to_sleep(self) -> bool:
        if self.scheduled_goto_sleep_time is None:
            return False
        return time.time() >= self.scheduled_goto_sleep_time

    @property
    def shutdown_permitted(self):
        # search through app state for any apps that have shutdown_permitted = False
        # if they don't define it (shouldn't happen), assume True.
        for k, v in self._tag_values.items():
            if isinstance(v, dict) and v.get("shutdown_check_ok", True) is False:
                log.info(f"Shutdown not permitted by {k}.")
                return False
        return True

    async def get_immunity_time(self):
        immunity_secs = await self.platform_iface.get_immunity_seconds_async()
        if immunity_secs is not None and immunity_secs <= 1:
            immunity_secs = None
        return immunity_secs

    async def schedule_next_startup(self):
        if self.scheduled_sleep_time is None:
            self.scheduled_sleep_time = self.get_sleep_time()

        log.info(f"Scheduling next startup in {self.scheduled_sleep_time} seconds...")
        await self.platform_iface.schedule_startup_async(self.scheduled_sleep_time)

    async def assess_power(self):
        """
        Monitor system voltage, determine sleep time, and handle shutdown.
        """
        if self.start_time is None:
            log.info("Setting start time")
            self.start_time = time.time()

        # Update the system voltage
        await self.update_voltage()

        # If the system is already scheduled to sleep, check if it's time to sleep
        if self.is_ready_to_sleep:
            log.info("Ready to sleep. Requesting shutdown...")
            # await self.request_shutdown_async()
            await self.go_to_sleep()
            return

        # Determine the sleep time from the config & current voltage
        sleep_time = self.get_sleep_time()
        if sleep_time is None:
            log.info("No sleep time found.")
            return

        # Attempt to schedule the sleep
        log.info(f"Scheduling next sleep in {sleep_time} seconds...")
        await self.maybe_schedule_sleep(sleep_time)

    async def go_to_sleep(self):
        """
        Put the system to sleep.
        """
        log.warning("Putting system to sleep...")

        log.info("Setting shutdown_requested hooks")
        # this should run all on_shutdown_requested hooks in each app.
        await self.set_global_tag_async("shutdown_requested", True)

        log.info("Sleeping for 20 seconds to allow shutdown hooks to run...")
        await asyncio.sleep(20)

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

        # either shutdown is permitted, or we've timed out. Either way, proceed to shutdown...
        shutdown_grace_period = 20

        ## Run shutdown hooks
        shutdown_at = datetime.now() + timedelta(seconds=shutdown_grace_period)
        await self.set_global_tag_async("shutdown_at", shutdown_at.timestamp())

        ## schedule the next startup
        await self.schedule_next_startup()

        ## Put the system to sleep
        log.info(f"Scheduling shutdown to occur in {shutdown_grace_period} seconds...")
        await asyncio.sleep(shutdown_grace_period)
        log.info("Scheduling a hard shutdown in 60 seconds time as a safety net")
        await self.platform_iface.schedule_shutdown_async(60)
        await self.platform_iface.shutdown_async()

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
                await self.platform_iface.schedule_shutdown_async(
                    self.soft_watchdog_period_mins * 60
                )
            except Exception as e:
                log.error(f"Error scheduling shutdown for soft watchdog: {e}")
            else:
                self.last_watchdog_reset_time = time.time()

    async def setup(self):
        log.info("Setting up PowerManager...")
        await self.maybe_reset_soft_watchdog()

        self.ui_manager.add_children(*self.ui.fetch())
        self.ui_manager.set_display_name("Power & Battery")
        self.ui_manager.set_position(self.config.position.value)

        # set shutdown_requested for all apps to False.
        log.info("Setting shutdown_requested tag for all apps to False.")
        await self.set_global_tag_async("shutdown_requested", False)
        await self.set_global_tag_async("shutdown_at", None)
        for app_key, v in self._tag_values.items():
            if not isinstance(v, dict) or app_key in (
                "shutdown_requested",
                "shutdown_at",
            ):
                # skip any non-dict values (app-based tags will always be in a dict).
                continue

            await self.set_tag_async("shutdown_requested", False, app_key)

        ## Attempt 3 times to get a non-None voltage
        for i in range(3):
            if self.last_voltage is None:
                await self.update_voltage()
                await asyncio.sleep(0.1)
            else:
                break

    async def main_loop(self):
        await self.maybe_reset_soft_watchdog()
        await self.assess_power()

        shutdown_requested = any(
            isinstance(v, dict) and v.get("shutdown_requested", False) is True
            for k, v in self._tag_values.items()
        )

        if self.is_battery_low:
            if not self.get_tag("low_battery_warning_sent", self.app_key):
                message = f"Battery voltage is low: {self.last_voltage}V."
                await self.publish_to_channel("notifications", message)
                await self.set_tag_async("low_battery_warning_sent", True)
        else:
            await self.set_tag_async("low_battery_warning_sent", False)

        self.ui.update(
            self.last_voltage,
            self.last_temp,
            not self.about_to_shutdown,
            self.is_battery_low,
        )

        if shutdown_requested:
            log.info("Shutdown requested. Initiating shutdown procedure...")
            await self.maybe_schedule_sleep(self.get_sleep_time())

    @property
    def is_battery_low(self) -> bool:
        battery_low_alarm = self.ui.low_batt_alarm.current_value
        if self.last_voltage is None or battery_low_alarm is None:
            return False
        return self.last_voltage < battery_low_alarm

    async def on_shutdown_at(self, dt: datetime) -> None:
        self.about_to_shutdown = True
        self.ui.is_online.update(False)
        await self.ui_manager.handle_comms_async(True)
        log.info("Pre-shutdown hook run, ui synced and ready for shutdown.")


if __name__ == "__main__":
    run_app(PowerManager(config=PowerManagerConfig()))
