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


## A dictionary of dictionaries, with the inner dictionary's being the associated sleep_thresholds, and wake  and their associated sleep and awake thresholds (as tuples of voltage and time)
profiles = {

    ## 12V Profiles
    ## Sleep only at a voltage so low that its effectively just monitoring and never shutdown
    Profile.MONITOR_12V.value: {
        "sleep_thresholds": {6.5: 5},
        "min_awake_thresholds": {6.5: 180},
    },
    ## Only sleeps at very low voltages to prevent going flat in emergencies
    Profile.MAX_ON_12V.value: {
        "sleep_thresholds": {10.5: 60},
        "min_awake_thresholds": {10.5: 180},
    },
    ## Maintian a high battery level, but stay on indefinitely while charging
    Profile.REGULAR_12V.value: {
        "sleep_thresholds": {13.2: 25, 12.9: 60, 12.6: 240},
        "min_awake_thresholds": {13.2: 240, 12.9: 120, 12.6: 90},
    },

    ## 24V Profiles
    ## Sleep only at a voltage so low that its effectively just monitoring and never shutdown
    Profile.MONITOR_24V.value: {
        "sleep_thresholds": {6.5: 5},
        "min_awake_thresholds": {6.5: 180},
    },
    ## Only sleeps at very low voltages to prevent going flat in emergencies
    Profile.MAX_ON_24V.value: {
        "sleep_thresholds": {22.0: 60},
        "min_awake_thresholds": {22.0: 180},
    },
    ## Maintian a high battery level, but stay on indefinitely while charging
    Profile.REGULAR_24V.value: {
        "sleep_thresholds": {26.0: 25, 25.0: 60, 24.0: 240},
        "min_awake_thresholds": {26.0: 240, 25.0: 120, 24.0: 90},
    },
}

class VictronConfig(config.Object):
    def __init__(self):
        super().__init__("Victron Bluetooth Config")

        self.device_address = config.String(
            "Device Address", default=None, description="The MAC address of the Victron device to bluetooth to. (The short one)"
        )
        self.device_key = config.String(
            "Device Key", default=None, description="The Key of the Victron device to bluetooth to. (The long one)"
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
    ## A list of tuples of voltage and sleep time
    def sleep_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            sleep_thresholds = self.sleep_time_thresholds.elements
            return [
                (threshold.voltage_threshold.value, threshold.sleep_time.value)
                for threshold in sleep_thresholds
            ]
        else:
            sleep_thresholds = profiles[self.profile.value]["sleep_thresholds"]
            return [
                (k, v)
                for k, v in sleep_thresholds.items()
            ]

    @property
    ## A list of tuples of voltage and awake time
    def min_awake_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            min_awake_thresholds = self.min_awake_time_thresholds.elements
            return [
                (threshold.voltage_threshold.value, threshold.awake_time.value)
                for threshold in min_awake_thresholds
            ]
        else:
            min_awake_thresholds = profiles[self.profile.value]["min_awake_thresholds"]
            return [
                (k, v)
                for k, v in min_awake_thresholds.items()
            ]

def export():
    PowerManagerConfig().export(Path(__file__).parent.parent.parent / "doover_config.json", "solar_power_management")


# if __name__ == "__main__":
#     c = PowerManagerConfig()
#     PowerManagerConfig().export(
#         Path(__file__).parents[2] / "doover_config.json", "solar_power_management"
#     )
