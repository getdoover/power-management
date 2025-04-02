from pathlib import Path

from pydoover import config


class SleepTimeThresholds(config.Group):
    def __init__(self):
        super().__init__("Sleep Time Thresholds")

        self.voltage_threshold = config.Decimal("Voltage Threshold", default=11.5, min_val=0, max_val=36)
        self.sleep_time = config.Integer("Sleep Time (minutes)", default=30, min_val=0, max_val=3600)


class AwakeTimeThresholds(config.Group):
    def __init__(self):
        super().__init__("Awake Time Thresholds")

        self.voltage_threshold = config.Decimal("Voltage Threshold", default=11.5, min_val=0, max_val=36)
        self.awake_time = config.Integer("Awake Time (seconds)", default=30, min_val=0, max_val=3600)


class PowerManagerConfig(config.Schema):
    def __init__(self):
        self.sleep_time_thresholds = config.Many("Sleep Time Thresholds", SleepTimeThresholds())
        self.min_awake_time_thresholds = config.Many("Min Awake Time Thresholds", AwakeTimeThresholds())


if __name__ == "__main__":
    c = PowerManagerConfig()
    c.export(Path("app_config.json"))
