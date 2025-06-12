from pathlib import Path

from pydoover import config


class SleepTimeThresholds(config.Object):
    def __init__(self):
        super().__init__("Sleep Time Thresholds")

        self.voltage_threshold = config.Number(
            "Voltage Threshold", default=11.5, minimum=0, maximum=36
        )
        self.sleep_time = config.Integer(
            "Sleep Time (minutes)", default=30, minimum=0, maximum=3600
        )


class AwakeTimeThresholds(config.Object):
    def __init__(self):
        super().__init__("Awake Time Thresholds")

        self.voltage_threshold = config.Number(
            "Voltage Threshold", default=11.5, minimum=0, maximum=36
        )
        self.awake_time = config.Integer(
            "Awake Time (seconds)", default=30, minimum=0, maximum=3600
        )


class PowerManagerConfig(config.Schema):
    def __init__(self):
        self.sleep_time_thresholds = config.Array(
            "Sleep Time Thresholds", element=SleepTimeThresholds()
        )
        self.min_awake_time_thresholds = config.Array(
            "Min Awake Time Thresholds", element=AwakeTimeThresholds()
        )
        self.override_shutdown_permission_mins = config.Integer(
            "Override Shutdown Permission in Minutes", default=6 * 60, minimum=10, maximum=1440
        )


if __name__ == "__main__":
    c = PowerManagerConfig()
    PowerManagerConfig().export(Path(__file__).parents[2] / "doover_config.json", "solar_power_management")
