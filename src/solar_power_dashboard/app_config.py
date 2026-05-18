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
