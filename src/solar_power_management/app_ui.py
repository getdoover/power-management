from pathlib import Path

from pydoover import ui

from .app_tags import PowerManagerTags


class PowerManagerUI(ui.UI, display_name="Power & Battery"):
    system_voltage = ui.NumericVariable(
        "Battery Voltage",
        units="V",
        value=PowerManagerTags.system_voltage,
        precision=1,
    )

    low_batt_alarm = ui.Slider(
        "Low Battery Alarm",
        units="V",
        min_val=6,
        max_val=13,
        step_size=0.25,
        dual_slider=False,
        inverted=False,
        default=11.0,
    )

    # Victron elements - hidden by default, shown when devices are configured
    charge_state = ui.TextVariable(
        "Charger State",
        value=PowerManagerTags.charge_state,
        hidden=PowerManagerTags.victron_hidden,
    )
    charge_current = ui.NumericVariable(
        "Charger Current",
        units="A",
        value=PowerManagerTags.charge_current,
        precision=1,
        hidden=PowerManagerTags.victron_hidden,
    )
    charge_voltage = ui.NumericVariable(
        "Charge Voltage",
        units="V",
        value=PowerManagerTags.charge_voltage,
        precision=1,
        hidden=PowerManagerTags.victron_hidden,
    )
    charge_power = ui.NumericVariable(
        "Charge Power",
        units="W",
        value=PowerManagerTags.charge_power,
        precision=1,
        hidden=PowerManagerTags.victron_hidden,
    )

    system_temperature = ui.NumericVariable(
        "Temperature",
        units="(\u00b0C)",
        value=PowerManagerTags.system_temperature,
        precision=1,
    )

    is_online = ui.BooleanVariable(
        "Online Now",
        value=PowerManagerTags.is_online,
    )

    enable_immunity = ui.Button(
        "Stay On For 30 Mins",
        name="enable_immunity",
        requires_confirm=False,
    )

    low_batt_warning = ui.WarningIndicator(
        "Low Battery",
        hidden=PowerManagerTags.low_batt_warning_hidden,
    )

    is_immune_warning = ui.WarningIndicator(
        name="is_immune_warning",
        display_name=PowerManagerTags.immune_warning_text,
        hidden=PowerManagerTags.immune_warning_hidden,
    )

    about_to_sleep_warning = ui.WarningIndicator(
        name="about_to_sleep_warning",
        display_name=PowerManagerTags.about_to_sleep_warning_text,
        hidden=PowerManagerTags.about_to_sleep_warning_hidden,
    )

    async def setup(self):
        # Set voltage ranges based on 12V/24V config
        if self.config.is_12v:
            self.system_voltage.ranges = [
                ui.Range("Low", 11.5, 12.3, ui.Colour.yellow),
                ui.Range("Good", 12.3, 13.0, ui.Colour.blue),
                ui.Range("Charging", 13.0, 14.0, ui.Colour.green),
                ui.Range("OverCharging", 14.0, 14.5, ui.Colour.red),
            ]
            self.low_batt_alarm.max_val = 13
        else:
            self.system_voltage.ranges = [
                ui.Range("Low", 22.0, 24.0, ui.Colour.yellow),
                ui.Range("Good", 24.0, 26.0, ui.Colour.blue),
                ui.Range("Charging", 26.0, 28.0, ui.Colour.green),
                ui.Range("OverCharging", 28.0, 30.0, ui.Colour.red),
            ]
            self.low_batt_alarm.max_val = 30


def export():
    """Export the base UI schema. Runtime setup() will publish the full dynamic schema."""
    PowerManagerUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "solar_power_management"
    )
