from pathlib import Path

from pydoover import config


class SleepTimeThresholds(config.Object):
    def __init__(self):
        super().__init__("Sleep Time Thresholds")

        self.voltage_threshold = config.Number("Voltage Threshold", default=11.5, minimum=0, maximum=36)
        self.sleep_time = config.Integer("Sleep Time (minutes)", default=30, minimum=0, maximum=3600)


class AwakeTimeThresholds(config.Object):
    def __init__(self):
        super().__init__("Awake Time Thresholds")

        self.voltage_threshold = config.Number("Voltage Threshold", default=11.5, minimum=0, maximum=36)
        self.awake_time = config.Integer("Awake Time (seconds)", default=30, minimum=0, maximum=3600)


class PowerManagerConfig(config.Schema):
    def __init__(self):
        self.sleep_time_thresholds = config.Array("Sleep Time Thresholds", element=SleepTimeThresholds())
        self.min_awake_time_thresholds = config.Array("Min Awake Time Thresholds", element=AwakeTimeThresholds())


if __name__ == "__main__":
    c = PowerManagerConfig()
    c.export(Path("../doover_config.json"), "power_management")
