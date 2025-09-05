from pathlib import Path
from enum import Enum

from pydoover import config

class Profile(Enum):
    CUSTOM = "Custom"
    MONITOR_12V = "Monitor (12V)"
    MAX_ON_12V = "Max On (12V)"
    REGULAR_12V = "Regular (12V)"
    MONITOR_24V = "Monitor (24V)"
    MAX_ON_24V = "Max On (24V)"
    REGULAR_24V = "Regular (24V)"

    @classmethod
    def choices(cls):
        return [choice.value for choice in cls]

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

class ProfileConfig:
    def __init__(self, sleep_thresholds: list[SleepTimeThresholds], min_awake_thresholds: list[AwakeTimeThresholds]):
        self.sleep_thresholds = sleep_thresholds
        self.min_awake_thresholds = min_awake_thresholds


profiles = {
    ## Sleep only at a voltage so low that its effectively just monitoring and never shutdown
    Profile.MONITOR_12V: ProfileConfig(
        sleep_thresholds=[SleepTimeThresholds(voltage_threshold=6.5, sleep_time=5),],
        min_awake_thresholds=[AwakeTimeThresholds(voltage_threshold=6.5, awake_time=180)],
    ),
    ## Only sleeps at very low voltages to prevent going flat in emergencies
    Profile.MAX_ON_12V: ProfileConfig(
        sleep_thresholds=[SleepTimeThresholds(voltage_threshold=10.5, sleep_time=60),],
        min_awake_thresholds=[AwakeTimeThresholds(voltage_threshold=10.5, awake_time=180)],
    ),
    Profile.REGULAR_12V: ProfileConfig(
        sleep_thresholds=[
            SleepTimeThresholds(voltage_threshold=13.2, sleep_time=25),
            SleepTimeThresholds(voltage_threshold=12.9, sleep_time=60),
            SleepTimeThresholds(voltage_threshold=12.6, sleep_time=240),
        ],
        min_awake_thresholds=[
            AwakeTimeThresholds(voltage_threshold=13.2, awake_time=240),
            AwakeTimeThresholds(voltage_threshold=12.9, awake_time=120),
            AwakeTimeThresholds(voltage_threshold=12.6, awake_time=90),
        ],
    ),
    Profile.MONITOR_24V: ProfileConfig(
        sleep_thresholds=[SleepTimeThresholds(voltage_threshold=6.5, sleep_time=5),],
        min_awake_thresholds=[AwakeTimeThresholds(voltage_threshold=6.5, awake_time=180)],
    ),
    Profile.MAX_ON_24V: ProfileConfig(
        sleep_thresholds=[SleepTimeThresholds(voltage_threshold=22.0, sleep_time=60),],
        min_awake_thresholds=[AwakeTimeThresholds(voltage_threshold=22.0, awake_time=180)],
    ),
    Profile.REGULAR_24V: ProfileConfig(
        sleep_thresholds=[
            SleepTimeThresholds(voltage_threshold=26.0, sleep_time=25),
            SleepTimeThresholds(voltage_threshold=25.0, sleep_time=60),
            SleepTimeThresholds(voltage_threshold=24.0, sleep_time=240),
        ],
        min_awake_thresholds=[
            AwakeTimeThresholds(voltage_threshold=26.0, awake_time=240),
            AwakeTimeThresholds(voltage_threshold=25.0, awake_time=120),
            AwakeTimeThresholds(voltage_threshold=24.0, awake_time=90),
        ],
    ),
}

class VictronConfig(config.Object):
    def __init__(self):
        super().__init__("Victron Bluetooth Config")

        self.device_address = config.String(
            "Device Address", default=None, description="The address of the Victron device to bluetooth to."
        )
        self.device_key = config.String(
            "Device Key", default=None, description="The key of the Victron device to bluetooth to."
        )

class PowerManagerConfig(config.Schema):
    def __init__(self):

        self.profile = config.Enum(
            "Profile",
            description="The Profile to use for the power management.",
            default=Profile.REGULAR_12V.value,
            choices=Profile.choices(),
        )

        self.sleep_time_thresholds = config.Array(
            "Sleep Time Thresholds",
            element=SleepTimeThresholds(),
            description="Only used if the profile is 'Custom'. Custom thresholds for sleep times",
        )
        self.min_awake_time_thresholds = config.Array(
            "Min Awake Time Thresholds",
            element=AwakeTimeThresholds(),
            description="Only used if the profile is 'Custom'. Custom thresholds for minimum awake times",
        )
        self.override_shutdown_permission_mins = config.Integer(
            "Override Shutdown Permission in Minutes",
            default=6 * 60,
            minimum=10,
            maximum=1440,
        )

        self.victron_configs = config.Array(
            "Victron Configs",
            element=VictronConfig(),
            description="The Victron devices to bluetooth to."
        )

        self.position = config.Integer(
            "Position",
            default=120,  # fairly low
            minimum=0,
            maximum=200,
            description="The position of the power management app in the UI. Smaller is higher, larger is lower. 100 is the default position of most apps.",
        )

    @property
    def is_12v(self) -> bool:
        return not self.is_24v

    @property
    def is_24v(self) -> bool:
        return self.profile.value in [Profile.MONITOR_24V.value, Profile.MAX_ON_24V.value, Profile.REGULAR_24V.value]

    @property
    def sleep_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            sleep_thresholds = self.sleep_time_thresholds.elements
        else:
            sleep_thresholds = profiles[Profile(self.profile.value)].sleep_thresholds

        return [
            (threshold.voltage_threshold.value, threshold.sleep_time.value)
            for threshold in sleep_thresholds
        ]

    @property
    def min_awake_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            min_awake_thresholds = self.min_awake_time_thresholds.elements
        else:
            min_awake_thresholds = profiles[Profile(self.profile.value)].min_awake_thresholds

        return [
            (threshold.voltage_threshold.value, threshold.awake_time.value)
            for threshold in min_awake_thresholds
        ]

def export():
    PowerManagerConfig().export(Path(__file__).parent.parent.parent / "doover_config.json", "solar_power_management")


# if __name__ == "__main__":
#     c = PowerManagerConfig()
#     PowerManagerConfig().export(
#         Path(__file__).parents[2] / "doover_config.json", "solar_power_management"
#     )
