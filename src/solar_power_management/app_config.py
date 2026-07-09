import logging
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from enum import Enum
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydoover import config
from pydoover.config import ApplicationPosition

log = logging.getLogger(__name__)

## Sentinel choice meaning "no night profile; use the day profile around the clock".
NIGHT_DISABLED = "Disabled"

SECS_PER_DAY = 86400

_HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


class Profile(Enum):
    CUSTOM = "Custom"
    MONITOR_12V = "Monitor (12V)"
    MAX_ON_12V = "Max On (12V)"
    REGULAR_12V = "Regular (12V)"
    SUPER_SAVER_12V = "Super Saver (12V)"
    MONITOR_24V = "Monitor (24V)"
    MAX_ON_24V = "Max On (24V)"
    REGULAR_24V = "Regular (24V)"
    SUPER_SAVER_24V = "Super Saver (24V)"

    @classmethod
    def choices(cls):
        return [choice.value for choice in cls]


_24V_PROFILES = frozenset(
    {
        Profile.MONITOR_24V.value,
        Profile.MAX_ON_24V.value,
        Profile.REGULAR_24V.value,
        Profile.SUPER_SAVER_24V.value,
    }
)


def parse_hhmm(value: str | None) -> int | None:
    """Parse a 24h "HH:MM" string into seconds since local midnight, or None."""
    if not value:
        return None
    match = _HHMM_RE.match(value.strip())
    if match is None:
        return None
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60


def voltage_class(profile_value: str) -> str:
    return "24V" if profile_value in _24V_PROFILES else "12V"


def _secs_since_midnight(now: datetime) -> int:
    return now.hour * 3600 + now.minute * 60 + now.second


@lru_cache(maxsize=None)
def _resolve_timezone(tz_name: str) -> ZoneInfo | None:
    """Resolve an IANA name, or None to mean "use the device's local time".

    Cached so a bad name warns once rather than on every main-loop tick.
    """
    if not tz_name:
        return None
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        log.warning(f"Unknown timezone {tz_name!r}; falling back to device local time.")
        return None


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
    ## Aggressively conserve power: sleep longer and longer as voltage drops
    Profile.SUPER_SAVER_12V.value: {
        "sleep_thresholds": {
            13.2: 30,
            13.0: 60,
            12.9: 90,
            12.8: 120,
            12.6: 240,
            12.4: 360,
            12.2: 840,
        },
        "min_awake_thresholds": {12.6: 240, 11.8: 120},
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
    ## Aggressively conserve power: sleep longer and longer as voltage drops
    Profile.SUPER_SAVER_24V.value: {
        "sleep_thresholds": {
            26.4: 30,
            26.0: 60,
            25.8: 90,
            25.6: 120,
            25.2: 240,
            24.8: 360,
            24.4: 840,
        },
        "min_awake_thresholds": {25.2: 240, 23.6: 120},
    },
}


class PowerManagerConfig(config.Schema):
    profile = config.Enum(
        "Profile",
        description="The Profile to use for the power management.",
        default=Profile.REGULAR_12V.value,
        choices=Profile.choices(),
    )
    night_profile = config.Enum(
        "Night Profile",
        description="Optional. Applies during night hours (see Night Start / Night End). "
        "Leave as 'Disabled' to use the main Profile around the clock. "
        "Must be the same voltage class (12V/24V) as the main Profile.",
        default=NIGHT_DISABLED,
        choices=[NIGHT_DISABLED]
        + [c for c in Profile.choices() if c != Profile.CUSTOM.value],
    )
    night_start = config.String(
        "Night Start",
        default="18:00",
        description="Local time in 24h HH:MM when the night profile takes over.",
        advanced=True,
    )
    night_end = config.String(
        "Night End",
        default="06:00",
        description="Local time in 24h HH:MM when the day profile takes over.",
        advanced=True,
    )
    timezone = config.String(
        "Timezone",
        default="",
        description="IANA name, e.g. 'Australia/Brisbane'. Leave blank to use the device's local time.",
        advanced=True,
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
    wake_on_voltage = config.Number(
        "Wake-on Voltage",
        default=None,
        minimum=0,
        maximum=36,
        description="Input voltage at which the device wakes itself from sleep. "
        "Leave blank to default to 13.5V for 12V profiles or 27V for 24V profiles.",
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
        return voltage_class(self.profile.value) == "24V"

    def local_now(self) -> datetime:
        """Current wall-clock time in the device's local timezone.

        The container mounts the host's /etc/localtime, so a naive ``datetime.now()``
        is already device-local. ``timezone`` overrides that for devices whose OS
        clock is still UTC.
        """
        tz = _resolve_timezone((self.timezone.value or "").strip())
        return datetime.now(tz) if tz else datetime.now()

    def night_disabled_reason(self) -> str | None:
        """Why the night profile isn't in play, or None if it is.

        Kept separate from ``night_enabled`` so the reason can be logged once at
        startup rather than on every main-loop tick.
        """
        night = self.night_profile.value
        if not night or night == NIGHT_DISABLED:
            return "no night profile configured"

        start, end = (
            parse_hhmm(self.night_start.value),
            parse_hhmm(self.night_end.value),
        )
        if start is None or end is None:
            return (
                f"could not parse Night Start {self.night_start.value!r} / "
                f"Night End {self.night_end.value!r} as HH:MM"
            )
        if start == end:
            return "Night Start and Night End are the same"

        if voltage_class(night) != voltage_class(self.profile.value):
            return (
                f"{night!r} and {self.profile.value!r} disagree on the battery rail; "
                f"a device is either 12V or 24V, not both"
            )
        return None

    @property
    def night_enabled(self) -> bool:
        return self.night_disabled_reason() is None

    def is_night(self, now: datetime) -> bool:
        if not self.night_enabled:
            return False

        start, end = (
            parse_hhmm(self.night_start.value),
            parse_hhmm(self.night_end.value),
        )
        current = _secs_since_midnight(now)
        if start < end:
            return start <= current < end
        ## Window wraps midnight, e.g. 18:00 -> 06:00
        return current >= start or current < end

    def active_profile_value(self, now: datetime) -> str:
        if self.is_night(now):
            return self.night_profile.value
        return self.profile.value

    def secs_to_next_boundary(self, now: datetime) -> int | None:
        """Seconds until the next day<->night transition, or None if night is disabled."""
        if not self.night_enabled:
            return None

        current = _secs_since_midnight(now)
        deltas = [
            (boundary - current) % SECS_PER_DAY
            for boundary in (
                parse_hhmm(self.night_start.value),
                parse_hhmm(self.night_end.value),
            )
        ]
        ## Sitting exactly on a boundary means the next one is a full day away.
        return min(delta if delta > 0 else SECS_PER_DAY for delta in deltas)

    def sleep_lookup_for(self, profile_value: str) -> list[tuple[float, int]]:
        if profile_value == Profile.CUSTOM.value:
            return [
                (threshold.voltage_threshold.value, threshold.sleep_time.value)
                for threshold in self.sleep_time_thresholds.elements
            ]
        return list(profiles[profile_value]["sleep_thresholds"].items())

    def awake_lookup_for(self, profile_value: str) -> list[tuple[float, int]]:
        if profile_value == Profile.CUSTOM.value:
            return [
                (threshold.voltage_threshold.value, threshold.awake_time.value)
                for threshold in self.min_awake_time_thresholds.elements
            ]
        return list(profiles[profile_value]["min_awake_thresholds"].items())

    @property
    def sleep_time_threshold_lookup(self) -> list[tuple[float, int]]:
        return self.sleep_lookup_for(self.profile.value)

    @property
    def wake_on_voltage_value(self) -> float | None:
        """Effective wake-on voltage to push to the platform.

        Uses the explicit config value if set, otherwise defaults to 13.5V for
        12V profiles and 27V for 24V profiles.

        This is a property of the battery rail, not of a profile: it is pushed once
        to the hardware at startup and stays armed through both day and night
        profiles, so a charging battery wakes the device even mid-way through a
        long night sleep. Day and night profiles are required to share a rail, so
        deriving the default from the day profile is unambiguous.
        """
        if self.wake_on_voltage.value is not None:
            return self.wake_on_voltage.value
        return 27.0 if self.is_24v else 13.5

    @property
    def min_awake_time_threshold_lookup(self) -> list[tuple[float, int]]:
        return self.awake_lookup_for(self.profile.value)


def export():
    PowerManagerConfig.export(
        Path(__file__).parent.parent.parent / "doover_config.json",
        "solar_power_management",
    )
