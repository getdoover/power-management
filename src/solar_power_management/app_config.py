from pathlib import Path
from enum import Enum

from pydoover import config
from pydoover.config import ApplicationPosition


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
    voltage_threshold = config.Number(
        "Voltage Threshold", default=11.5, minimum=0, maximum=36
    )
    sleep_time = config.Integer(
        "Sleep Time (minutes)", default=30, minimum=0, maximum=3600
    )


class AwakeTimeThresholds(config.Object):
    voltage_threshold = config.Number(
        "Voltage Threshold", default=11.5, minimum=0, maximum=36
    )
    awake_time = config.Integer(
        "Awake Time (seconds)", default=90, minimum=0, maximum=3600
    )


class VictronConfig(config.Object):
    device_address = config.String(
        "Device Address",
        default=None,
        description="The MAC address of the Victron device to bluetooth to. (The short one)",
    )
    device_key = config.String(
        "Device Key",
        default=None,
        description="The Key of the Victron device to bluetooth to. (The long one)",
    )


## Profile presets: voltage -> sleep/awake time mappings
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
    ## Maintain a high battery level, but stay on indefinitely while charging
    Profile.REGULAR_12V.value: {
        "sleep_thresholds": {13.2: 25, 12.9: 60, 12.6: 240},
        "min_awake_thresholds": {13.2: 240, 12.9: 120, 12.6: 120},
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
    ## Maintain a high battery level, but stay on indefinitely while charging
    Profile.REGULAR_24V.value: {
        "sleep_thresholds": {24.5: 25, 24.0: 60, 23.0: 240},
        "min_awake_thresholds": {24.5: 300, 24.0: 240, 23.0: 120},
    },
}


class PowerManagerConfig(config.Schema):
    profile = config.Enum(
        "Profile",
        description="The Profile to use for the power management.",
        default=Profile.REGULAR_12V.value,
        choices=Profile.choices(),
    )
    sleep_time_thresholds = config.Array(
        "Sleep Time Thresholds",
        element=SleepTimeThresholds("Sleep Time Thresholds"),
        description="Only used if the profile is 'Custom'. Custom thresholds for sleep times",
        advanced=True,
    )
    min_awake_time_thresholds = config.Array(
        "Min Awake Time Thresholds",
        element=AwakeTimeThresholds("Awake Time Thresholds"),
        description="Only used if the profile is 'Custom'. Custom thresholds for minimum awake times",
        advanced=True,
    )
    override_shutdown_permission_mins = config.Integer(
        "Override Shutdown Permission in Minutes",
        default=60,
        minimum=10,
        maximum=1440,
        advanced=True,
    )
    victron_configs = config.Array(
        "Victron Configs",
        element=VictronConfig("Victron Bluetooth Config"),
        description="The Victron devices to bluetooth to.",
    )
    position = ApplicationPosition(default=120)

    @property
    def is_12v(self) -> bool:
        return not self.is_24v

    @property
    def is_24v(self) -> bool:
        return self.profile.value in [
            Profile.MONITOR_24V.value,
            Profile.MAX_ON_24V.value,
            Profile.REGULAR_24V.value,
        ]

    @property
    def sleep_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            sleep_thresholds = self.sleep_time_thresholds.elements
            return [
                (threshold.voltage_threshold.value, threshold.sleep_time.value)
                for threshold in sleep_thresholds
            ]
        else:
            return list(profiles[self.profile.value]["sleep_thresholds"].items())

    @property
    def min_awake_time_threshold_lookup(self) -> list[tuple[float, int]]:
        if self.profile.value == Profile.CUSTOM.value:
            min_awake_thresholds = self.min_awake_time_thresholds.elements
            return [
                (threshold.voltage_threshold.value, threshold.awake_time.value)
                for threshold in min_awake_thresholds
            ]
        else:
            return list(profiles[self.profile.value]["min_awake_thresholds"].items())


def export():
    PowerManagerConfig.export(
        Path(__file__).parent.parent.parent / "doover_config.json",
        "solar_power_management",
    )
