from pydoover import ui


class PowerManagerUI:
    def __init__(self, app):
        self.app = app

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
            ] if self.app.config.is_12v else [
                ui.Range("Low", 22.0, 24.0, ui.Colour.yellow),
                ui.Range("Good", 24.0, 26.0, ui.Colour.blue),
                ui.Range("Charging", 26.0, 28.0, ui.Colour.green),
                ui.Range("OverCharging", 28.0, 30.0, ui.Colour.red),
            ],
        )
        self.low_batt_alarm = ui.Slider(
            "batteryAlarms",
            "Low Battery Alarm (V)",
            min_val=6,
            max_val=13 if self.app.config.is_12v else 30,
            step=0.25,
            default=11.0,
            dual_slider=False,
            inverted=False,
        )
        if self.app.victron_devices:
            self.charge_state = ui.TextVariable(
                "chargeState",
                "Charger State",
            )
            self.charge_current = ui.NumericVariable(
                "chargeCurrent",
                "Charger Current (A)",
                precision=1,
            )
            self.charge_voltage = ui.NumericVariable(
                "chargeVoltage",
                "Charge Voltage (V)",
                precision=1,
            )
            self.charge_power = ui.NumericVariable(
                "chargePower",
                "Charge Power (W)",
                precision=1,
            )

        self.system_temperature = ui.NumericVariable(
            "systemTemp", "Temperature (°C)", precision=1
        )
        self.is_online = ui.BooleanVariable("isOnline", "Online Now")

        self.enable_immunity = ui.Action(
            "enableImmunity",
            "Stay On For 30 Mins",
            colour="blue",
            requires_confirm=False,
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
        elements = [
            self.alert_stream,
            self.connection_info,
            self.system_voltage,
            self.low_batt_alarm,
            self.system_temperature,
            self.is_online,
            self.enable_immunity,
            self.low_batt_warning,
            self.is_immune_warning,
            self.about_to_sleep_warning,
        ]
        if self.app.victron_devices:
            elements.extend([
                self.charge_state,
                self.charge_current,
                self.charge_voltage,
                self.charge_power,
            ])
        return elements

    def update(
        self,
        voltage: float,
        temperature: float,
        is_online: bool,
        is_battery_low: bool,
        immunity_time: int | None,
        sleep_warning_time: int | None,
    ):
        if self.app.victron_devices:
            for device in self.app.victron_devices:
                self.charge_state.update(device.state)
                self.charge_current.update(device.output_current)
                self.charge_voltage.update(device.output_voltage)
                self.charge_power.update(device.output_power)
        self.system_voltage.update(voltage)
        self.system_temperature.update(temperature)
        self.is_online.update(is_online)
        self.low_batt_warning.hidden = not (voltage and is_battery_low)
        
        if immunity_time and immunity_time > 45:
            self.is_immune_warning.hidden = False
            mins_awake = round(immunity_time / 60)
            immune_str = f"Device will stay awake for {mins_awake} mins"
            if mins_awake <= 1:
                mins_awake = 1
                immune_str = "Device will stay awake for 1 min"
            self.is_immune_warning.display_name = (immune_str)
        else:
            self.is_immune_warning.hidden = True

        if sleep_warning_time:
            self.about_to_sleep_warning.hidden = False
            sleep_str = f"Device will sleep in {sleep_warning_time} seconds"
            if sleep_warning_time < 30:
                sleep_str = "Device about to sleep"
            self.about_to_sleep_warning.display_name = (sleep_str)
        else:
            self.about_to_sleep_warning.hidden = True

    def update_connection_info(self, period: int, next_connection: int):
        self.connection_info.connection_period = period
        self.connection_info.next_connection = next_connection
        self.connection_info.offline_after = next_connection * 5
