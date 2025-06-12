# Testing Plan:

# 1. No config - do nothing
# 2. Voltage above any config - never sleep
# 3. Voltage below lowest config - sleep for longest time
# 4. Voltage between configs - sleep for appropriate time
# 5. Platform interface returns error - skip round
# 6.

# 7. The app shouldn't shutdown before `config.override_shutdown_permission_mins` minutes.
# 8. Every `watchdog_reset_interval_secs` seconds the app should schedule a shutdown in `soft_watchdog_period_mins` minutes.


# Notes:
# - Disregard momentary voltage drops. The kalman filter will handle that, and testing of the filter is out of scope of this suite.
# - Nevertheless, we can (and should) simulate platform iface returning errors.