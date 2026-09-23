from pydoover.tags import Tag, Tags, AnyChange


class PowerManagerTags(Tags):
    # Core measurements
    system_voltage = Tag("number", default=None, live=True)
    system_power = Tag("number", default=None, live=True)
    system_temperature = Tag("number", default=None, live=True)
    is_online = Tag("boolean", default=True, live=True, log_on=AnyChange())

    # Cursor for sleep-log backfill: epoch ms of the newest snapshot already
    # written to history, so reboots don't re-post the same points.
    last_sleep_log_ts = Tag("number", default=0)

    # Victron charger
    victron_hidden = Tag("boolean", default=True)
    charge_state = Tag("string", default=None)
    charge_current = Tag("number", default=None, live=True)
    charge_voltage = Tag("number", default=None, live=True)
    charge_power = Tag("number", default=None, live=True)

    # Victron battery monitor (SmartShunt / BMV)
    shunt_hidden = Tag("boolean", default=True)
    shunt_soc = Tag("number", default=None, live=True)
    shunt_voltage = Tag("number", default=None, live=True)
    shunt_current = Tag("number", default=None, live=True)
    shunt_power = Tag("number", default=None, live=True)
    shunt_alarm = Tag("string", default=None)
    shunt_alarm_hidden = Tag("boolean", default=True)

    # Victron SmartShunt in DC energy meter mode (measuring a source or load)
    meter_hidden = Tag("boolean", default=True)
    meter_type = Tag("string", default=None)
    meter_voltage = Tag("number", default=None, live=True)
    meter_current = Tag("number", default=None, live=True)
    meter_power = Tag("number", default=None, live=True)

    # Device address -> DeviceKind, learned from broadcasts and kept across
    # reboots so the right UI sections show before the first packet arrives.
    victron_device_kinds = Tag("object", default=None)

    # Warning states
    low_battery_warning_sent = Tag("boolean", default=False)
    low_batt_warning_hidden = Tag("boolean", default=True)
    immune_warning_hidden = Tag("boolean", default=True)
    immune_warning_text = Tag("string", default="Device in Immunity Mode")
    about_to_sleep_warning_hidden = Tag("boolean", default=True)
    about_to_sleep_warning_text = Tag("string", default="Device is about to sleep")
