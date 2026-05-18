from pydoover.processor import run_app

from .application import SolarPowerDashboardApp
from .app_config import SolarPowerDashboardConfig


def handler(event, context):
    """Lambda handler entry point."""
    SolarPowerDashboardConfig.clear_elements()
    return run_app(
        SolarPowerDashboardApp(),
        event,
        context,
    )
