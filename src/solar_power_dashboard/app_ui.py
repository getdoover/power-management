from pathlib import Path

from pydoover import ui


class SolarPowerDashboardUI(ui.UI, default_open=True):
    widget = ui.RemoteComponent(
        name="SolarPowerDashboard",
        display_name="Solar Power Dashboard",
        component_url="$config.app().dv_widget_url",
        scope="SolarPowerDashboardWidget",
        module="./SolarPowerDashboardWidget",
        # The dashboard agent's deployment config holds the DEVICE_MAP under
        # this app's key (populated from the extended-permissions config). Each
        # entry carries `type.config.battery_voltage_tag` (e.g.
        # ``solar_power_management_1.system_voltage``) — the widget reads that
        # per-device rather than hardcoding the path.
        app_key="$config.app().APP_KEY",
    )


def export():
    SolarPowerDashboardUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "solar_power_dashboard"
    )
