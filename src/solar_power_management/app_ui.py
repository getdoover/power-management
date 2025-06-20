from pydoover import ui


class PowerManagerUI:
    def __init__(self):
        self.connection_info = ui.ConnectionInfo(
            "connection_info", ui.ConnectionType.periodic
        )
        self.alert_stream = ui.AlertStream(
            "significantEvent", "Notify me of any problems"
        )

        self.system_voltage = ui.NumericVariable(
            "systemVoltage",
            "Battery Voltage (V)",
            precision=1,
            ranges=[
                ui.Range("Low", 11.5, 12.3, ui.Colour.yellow),
                ui.Range("Good", 12.3, 13.0, ui.Colour.blue),
                ui.Range("Charging", 13.0, 14.0, ui.Colour.green),
                ui.Range("OverCharging", 14.0, 14.5, ui.Colour.red),
            ],
        )
        self.system_temperature = ui.NumericVariable(
            "systemTemp", "Temperature (°C)", precision=1
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

        self.low_batt_warning = ui.WarningIndicator(
            "BatteryWarning",
            "Low Battery",
        )

        self.is_immune_warning = ui.WarningIndicator(
            "ImmuneWarning",
            "Device in Immunity Mode",
            hidden=True,
        )

        self.about_to_sleep_warning = ui.WarningIndicator(
            "AboutToSleepWarning",
            "Device is about to sleep",
            hidden=True,
        )

    def fetch(self):
        return (
            self.alert_stream,
            self.connection_info,
            self.system_voltage,
            self.system_temperature,
            self.is_online,
            self.low_batt_alarm,
            self.low_batt_warning,
            self.is_immune_warning,
            self.about_to_sleep_warning,
        )

    def update(
        self,
        voltage: float,
        temperature: float,
        is_online: bool,
        is_battery_low: bool,
        is_immune: bool,
        sleep_warning_time: int | None,
    ):
        self.system_voltage.update(voltage)
        self.system_temperature.update(temperature)
        self.is_online.update(is_online)
        self.low_batt_warning.hidden = not (voltage and is_battery_low)
        self.is_immune_warning.hidden = not is_immune

        if sleep_warning_time:
            self.about_to_sleep_warning.hidden = False
            self.about_to_sleep_warning.display_name = (
                f"Device will sleep in {sleep_warning_time} seconds"
            )
        else:
            self.about_to_sleep_warning.hidden = True

    def update_connection_info(self, period: int, next_connection: int):
        self.connection_info.connection_period = period
        self.connection_info.next_connection = next_connection
        self.connection_info.offline_after = next_connection * 5
