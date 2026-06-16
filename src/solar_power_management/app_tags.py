from pydoover.tags import Tag, Tags


class PowerManagerTags(Tags):
    # Core measurements
    system_voltage = Tag("number", default=None, live=True)
    system_power = Tag("number", default=None, live=True)
    system_temperature = Tag("number", default=None, live=True)
    is_online = Tag("boolean", default=True, live=True)

    # Cursor for sleep-log backfill: epoch ms of the newest snapshot already
    # written to history, so reboots don't re-post the same points.
    last_sleep_log_ts = Tag("number", default=0)

    # Cursor for offline UI-command replay: snowflake id of the newest ui_cmds
    # message already replayed, so reboots don't run the same command twice.
    last_ui_cmd_id = Tag("number", default=0)

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
