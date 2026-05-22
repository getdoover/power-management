from pathlib import Path

from pydoover import config
from pydoover.processor import ExtendedPermissionsConfig


class SolarPowerDashboardConfig(config.Schema):
    # Grant the dashboard read access to the devices it should monitor. Set
    # "Apps Installed" to the Solar Power Management app so every device running
    # it is automatically picked up; the platform populates a ``DEVICE_MAP`` in
    # this app's deployment config which the widget reads. The extra fields
    # ride along on each entry so the widget can locate each device's battery
    # voltage tag (per device-type config) without any hardcoded app keys.
    extended_permissions = ExtendedPermissionsConfig(
        extra_fields=[
            "type__name",
            "type__config__battery_voltage_tag",
            # Per-device-type override for the "nearly offline" projection horizon
            # (in days). Slow-draining solar sites can afford ~30 days' warning,
            # while a Doovit that recharges over ~3 days wants a much tighter
            # window. Falls back to ``default_flat_battery_horizon_days`` below
            # when a device type doesn't set it.
            "type__config__flat_battery_horizon_days",
            "solution_installs__display_name",
            "group__id",
            "id",
            "display_name",
        ]
    )

    dormant_after_days = config.Integer(
        "Dormant After (Days)",
        default=30,
        minimum=1,
        description="A device offline for at least this many days is shown as 'Dormant'.",
    )

    flat_battery_horizon_days = config.Integer(
        "Flat Battery Horizon (Days)",
        default=30,
        minimum=1,
        description="When a device's battery is projected to reach flat within this many days "
                    "it is flagged 'Nearly Offline'. Device types can override this with their own "
                    "'flat_battery_horizon_days' (e.g. a Doovit that recharges over ~3 days).",
    )

    position = config.ApplicationPosition()

    ignore_groups = config.GroupsConfig(
        "Ignored Groups",
        description="Any devices in these groups will be hidden. "
                    "Useful for testing or unallocated groups where you otherwise want to include all devices. "
                    "Does not support hierarchical nesting - you must provide direct parent groups.",
    )


def export():
    SolarPowerDashboardConfig.export(
        Path(__file__).parents[2] / "doover_config.json",
        "solar_power_dashboard",
    )
