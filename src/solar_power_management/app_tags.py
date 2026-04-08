from pydoover.tags import Tag, Tags


class PowerManagerTags(Tags):
    # Core measurements
    system_voltage = Tag("number", default=None)
    system_temperature = Tag("number", default=None)
    is_online = Tag("boolean", default=True)

    # Victron charger
    victron_hidden = Tag("boolean", default=True)
    charge_state = Tag("string", default=None)
    charge_current = Tag("number", default=None)
    charge_voltage = Tag("number", default=None)
    charge_power = Tag("number", default=None)

    # Warning states
    low_battery_warning_sent = Tag("boolean", default=False)
    low_batt_warning_hidden = Tag("boolean", default=True)
    immune_warning_hidden = Tag("boolean", default=True)
    immune_warning_text = Tag("string", default="Device in Immunity Mode")
    about_to_sleep_warning_hidden = Tag("boolean", default=True)
    about_to_sleep_warning_text = Tag("string", default="Device is about to sleep")

    # App display
    app_display_name = Tag("string", default="Power & Battery")
