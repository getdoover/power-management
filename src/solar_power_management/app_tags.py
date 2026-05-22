from pydoover.tags import Tag, Tags


class PowerManagerTags(Tags):
    # Core measurements
    system_voltage = Tag("number", default=None, live=True)
    system_temperature = Tag("number", default=None, live=True)
    is_online = Tag("boolean", default=True)

    # Victron charger
    victron_hidden = Tag("boolean", default=True)
    charge_state = Tag("string", default=None)
    charge_current = Tag("number", default=None, live=True)
    charge_voltage = Tag("number", default=None, live=True)
    charge_power = Tag("number", default=None, live=True)

    # Warning states
    low_battery_warning_sent = Tag("boolean", default=False)
    low_batt_warning_hidden = Tag("boolean", default=True)
    immune_warning_hidden = Tag("boolean", default=True)
    immune_warning_text = Tag("string", default="Device in Immunity Mode")
    about_to_sleep_warning_hidden = Tag("boolean", default=True)
    about_to_sleep_warning_text = Tag("string", default="Device is about to sleep")
