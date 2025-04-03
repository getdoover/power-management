import asyncio
import time

from pydoover.docker import Application, run_app
from pydoover.utils import apply_async_kalman_filter, call_maybe_async

from app_config import PowerManagerConfig, SleepTimeThresholds, AwakeTimeThresholds


class PowerManager(Application):
    config: PowerManagerConfig

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.start_time = None
        self.scheduled_sleep_time = None  ## Secs that the system is scheduled to sleep for
        self.scheduled_goto_sleep_time = None  ## Time that the system is scheduled to sleep

        self.last_voltage = None
        self.last_voltage_time = None
        self.voltage_update_interval = 5

        self.request_shutdown_hooks = []  # Request shutdown hooks will be run and if all return True, the system will shutdown

        self.pre_shutdown_hooks = []  # Pre shutdown hooks will be run when the system schedules a shutdown
        self.shutdown_hooks = []  # Shutdown hooks will be run when the system is about to shutdown

    def register_request_shutdown_hook(self, hook):
        self.request_shutdown_hooks.append(hook)

    def register_pre_shutdown_hook(self, hook):
        self.pre_shutdown_hooks.append(hook)

    def register_shutdown_hook(self, hook):
        self.shutdown_hooks.append(hook)

    def is_active(self):
        return bool(self.config)

    async def update_voltage(self):
        # Only update the voltage every voltage_update_interval seconds
        if self.last_voltage_time is None or time.time() - self.last_voltage_time > self.voltage_update_interval:
            try:
                self.last_voltage = await self.get_system_voltage()
            except Exception as e:
                self.log("error", f"Error fetching system voltage: {e}")

            if self.last_voltage is not None:
                self.last_voltage = round(self.last_voltage, 2)
                self.last_voltage_time = time.time()

            self.log(f"Filtered system voltage: {self.last_voltage}")

    @apply_async_kalman_filter(
        process_variance=0.05,
        outlier_threshold=0.5,
    )
    async def get_system_voltage(self) -> float:
        # Get the current system voltage
        return await self.platform_iface.get_system_voltage_async()

    def get_sleep_time(self) -> int | None:
        for entry in sorted(self.config.sleep_time_thresholds.elements, key=lambda x: x.voltage_threshold):
            entry: SleepTimeThresholds
            if self.last_voltage <= entry.voltage_threshold:
                return entry.sleep_time * 60

    def get_min_awake_time(self) -> int:
        abs_min_awake_time = 30  # The floor value for the minimum awake time

        if self.last_voltage is None:
            return self.config.min_awake_time_thresholds.element.awake_time.default

        for entry in sorted(self.config.min_awake_time_thresholds.elements, key=lambda x: x.voltage_threshold):
            entry: AwakeTimeThresholds
            if self.last_voltage <= entry.voltage_threshold:
                return max(entry.awake_time, abs_min_awake_time)

        return abs_min_awake_time

    def get_awake_time(self) -> int:
        if self.start_time is None:
            self.start_time = time.time()
        return int(time.time() - self.start_time)

    async def maybe_schedule_sleep(self, sleep_time: int, time_till_sleep: int = 20):
        if self.scheduled_goto_sleep_time is not None:
            if self.get_time_till_sleep() is not None:
                self.log("warning", f"Time till sleep: {self.get_time_till_sleep()}")
            return

        if self.get_awake_time() < (self.get_min_awake_time() - time_till_sleep):
            time_till_sleep = self.get_min_awake_time() - self.get_awake_time()
            self.log("Minimum awake time not met: {} seconds to go".format(time_till_sleep))
            return

        if not self.shutdown_permitted():
            self.log("Scheduling of shutdown not yet permitted by application. Waiting...")
            return

        immunity_time = await self.get_immunity_time()
        if immunity_time is not None:
            self.log(f"Device immune to shutdown for {immunity_time} seconds.")
            return

        self.log(f"Scheduling sleep of {sleep_time} secs in {time_till_sleep} secs.")
        self.scheduled_goto_sleep_time = time.time() + time_till_sleep
        self.scheduled_sleep_time = sleep_time
        await self.run_pre_shutdown_hooks(time_till_sleep, sleep_time)

    def get_time_till_sleep(self):
        if self.scheduled_goto_sleep_time is None:
            return None
        return int(self.scheduled_goto_sleep_time - time.time())

    def is_ready_to_sleep(self):
        if self.scheduled_goto_sleep_time is None:
            return False
        return time.time() >= self.scheduled_goto_sleep_time

    def shutdown_permitted(self):
        for hook in self.request_shutdown_hooks:
            if not hook():
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
        await self.platform_iface.schedule_startup_async(self.scheduled_sleep_time)

    async def assess_power(self):
        """
        Monitor system voltage, determine sleep time, and handle shutdown.
        """
        if not self.is_active():
            return

        if self.start_time is None:
            self.start_time = time.time()

        # Update the system voltage
        await self.update_voltage()

        # If the system is already scheduled to sleep, check if it's time to sleep
        if self.is_ready_to_sleep():
            await self.go_to_sleep()
            return

            # Determine the sleep time from the config & current voltage
        sleep_time = self.get_sleep_time()
        if sleep_time is None:
            return

        # Attempt to schedule the sleep
        await self.maybe_schedule_sleep(sleep_time)

    async def go_to_sleep(self):
        """
        Put the system to sleep.
        """
        self.log("warning", "Putting system to sleep...")

        ## Run shutdown hooks
        for hook in self.shutdown_hooks:
            await self.run_hook(hook)

        ## schedule the next startup
        await self.schedule_next_startup()

        ## Put the system to sleep
        await self.platform_iface.shutdown_async()

        ## Cleanly disconnect the device comms and then wait for sleep
        try:
            await self.close_app(with_delay=120)
        except Exception as e:
            self.log("error", f"Error closing device application for shutdown: {e}")

        # Wait for the system to shutdown
        await asyncio.sleep(120)

    async def run_pre_shutdown_hooks(self, time_till_sleep, sleep_time):
        for hook in self.pre_shutdown_hooks:
            await call_maybe_async(hook, time_till_sleep=time_till_sleep, sleep_time=sleep_time)

    async def run_hook(self, hook, **kwargs):
        try:
            ## If the hook is a coroutine, await it
            if asyncio.iscoroutinefunction(hook):
                await hook(**kwargs)
            else:
                hook(**kwargs)
        except Exception as e:
            self.log("error", f"Error running hook {hook}: {e}")

    async def setup(self):
        self.log("Setting up PowerManager...")
        if not self.is_active():
            return

        ## Attempt 3 times to get a non-None voltage
        for i in range(3):
            if self.last_voltage is None:
                await self.update_voltage()
                await asyncio.sleep(0.1)
            else:
                break

    async def main_loop(self):
        await self.assess_power()


if __name__ == "__main__":
    run_app(PowerManager(config=PowerManagerConfig()))
