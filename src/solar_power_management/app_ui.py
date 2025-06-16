from pydoover import ui


class PowerManagerUI:
    def __init__(self):
        self.connection_info = ui.ConnectionInfo(
            "meter_connection_info", ui.ConnectionType.periodic
        )

        self.system_voltage = ui.NumericVariable(
            "systemVoltage",
            "Telemetry battery (V)",
            precision=1,
            ranges=[
                ui.Range("Low", 11.5, 12.3, ui.Colour.yellow),
                ui.Range("Good", 12.3, 13.0, ui.Colour.blue),
                ui.Range("Charging", 13.0, 14.0, ui.Colour.green),
                ui.Range("OverCharging", 14.0, 14.5, ui.Colour.red),
            ],
        )
        self.system_temperature = ui.NumericVariable(
            "systemTemp", "Temperature (C)", precision=1
        )
        self.is_online = ui.BooleanVariable("isOnline", "Online now")

        self.low_batt_alarm = ui.Slider(
            "batteryAlarms",
            "Low Battery Alarm (V)",
            min_val=6,
            max_val=13,
            step=0.25,
            default=11.0,
            dual_slider=False,
            inverted=False,
        )

        self.details = ui.Submodule(
            "telemetry_details_submodule",
            "Details",
            children=[self.system_voltage, self.system_temperature, self.is_online, self.low_batt_alarm],
        )

        self.low_batt_warning = ui.WarningIndicator(
            "BatteryWarning",
            "Low Battery",
        )

    def fetch(self):
        return self.connection_info, self.details, self.low_batt_warning

    def update(self, voltage: float, temperature: float, is_online: bool, is_battery_low: bool):
        self.system_voltage.update(voltage)
        self.system_temperature.update(temperature)
        self.is_online.update(is_online)
        self.low_batt_warning.hidden = not is_battery_low

    def update_connection_info(self, period: int, next_connection: int):
        self.connection_info.connection_period = period
        self.connection_info.next_connection = next_connection
        self.connection_info.offline_after = next_connection * 2
