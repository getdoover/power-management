import logging
from datetime import datetime, timezone

from pydoover.models.data.connection import ConnectionDisplay
from pydoover.processor import Application
from pydoover.models import (
    ConnectionStatus,
    ConnectionDetermination,
    DeploymentEvent,
    ConnectionConfig,
    ConnectionType,
)

from .app_config import SolarPowerDashboardConfig
from .app_ui import SolarPowerDashboardUI

log = logging.getLogger(__name__)


class SolarPowerDashboardApp(Application):
    """Fleet dashboard for devices running Solar Power Management.

    This processor does no per-device work. All of the online / offline /
    nearly-offline classification, power-management fault detection and the
    "expected to go offline" voltage-trajectory projection happen client side
    in the ``SolarPowerDashboardWidget`` remote component, which reads each
    device's ``tag_values`` / ``doover_connection`` aggregates directly.

    The processor exists only to host that widget (via the static UI schema)
    and to keep the dashboard's own agent looking online whenever it is
    (re)deployed.
    """

    config_cls = SolarPowerDashboardConfig
    ui_cls = SolarPowerDashboardUI

    async def on_deployment(self, event: DeploymentEvent):
        """Ping the connection on (re)deployment so the dashboard agent stays online."""
        await self.api.ping_connection_at(
            datetime.now(timezone.utc),
            ConnectionStatus.continuous_online_no_ping,
            ConnectionDetermination.online,
            user_agent="power-management;solar-power-dashboard",
        )
        await self.api.update_connection_config(
            ConnectionConfig(ConnectionType.periodic, display=ConnectionDisplay.never)
        )
        log.info(f"Pinged connection for dashboard agent {self.agent_id}")
