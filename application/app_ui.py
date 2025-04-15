from pydoover import ui


class PowerManagerUI:
    def __init__(self):
        self.connection_info = ui.ConnectionInfo("meter_connection_info", ui.ConnectionType.periodic)

    def fetch(self):
        return (self.connection_info, )

    def update(self, period: int, next_connection: int):
        self.connection_info.connection_period = period
        self.connection_info.next_connection = next_connection
        self.connection_info.offline_after = next_connection * 2
