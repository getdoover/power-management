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
            "Awake Time (seconds)", default=90, minimum=0, maximum=3600
        )


class PowerManagerConfig(config.Schema):
    def __init__(self):
        self.sleep_time_thresholds = config.Array(
            "Sleep Time Thresholds",
            element=SleepTimeThresholds(),
            hidden=True,
        )
        self.min_awake_time_thresholds = config.Array(
            "Min Awake Time Thresholds",
            element=AwakeTimeThresholds(),
            hidden=True,
        )
        self.override_shutdown_permission_mins = config.Integer(
            "Override Shutdown Permission in Minutes",
            default=6 * 60,
            minimum=10,
            maximum=1440,
        )
        self.position = config.Integer(
            "Position",
            default=120,  # fairly low
            minimum=0,
            maximum=200,
            description="The position of the power management app in the UI. Smaller is higher, larger is lower. 100 is the default position of most apps.",
        )

    @property
    def sleep_time_threshold_lookup(self) -> list[tuple[float, int]]:
        elems: list[SleepTimeThresholds] = self.sleep_time_thresholds.elements
        if not elems:
            return [
                (13.2, 25),
                (12.9, 60),
                (12.6, 240),
            ]

        return [
            (threshold.voltage_threshold.value, threshold.sleep_time.value)
            for threshold in elems
        ]

    @property
    def min_awake_time_threshold_lookup(self) -> list[tuple[float, int]]:
        elems: list[AwakeTimeThresholds] = self.min_awake_time_thresholds.elements
        if not elems:
            return [
                (13.2, 240),
                (12.9, 120),
                (12.6, 90),
            ]

        return [
            (threshold.voltage_threshold.value, threshold.awake_time.value)
            for threshold in elems
        ]


if __name__ == "__main__":
    c = PowerManagerConfig()
    PowerManagerConfig().export(
        Path(__file__).parents[2] / "doover_config.json", "solar_power_management"
    )
