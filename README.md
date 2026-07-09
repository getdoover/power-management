# Solar Power Management

<!-- ![Doover Logo](https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png) -->
<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="App Icon" style="max-width: 300px;">

**Manage device power and shutdown procedures on power-limited devices, especially in solar contexts with Victron integration.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/getdoover/power-management)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/getdoover/power-management/blob/main/LICENSE)

[Configuration](#configuration) | [Developer](https://github.com/getdoover/power-management/blob/main/DEVELOPMENT.md) | [Need Help?](#need-help)

<br/>

## Overview

Manage device power and shutdown procedures on power-limited devices, especially in solar contexts with Victron integration.

<br/>

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Profile** | Power management profile | `Regular (12V)` |
| **Victron Configs** | Victron Bluetooth devices | `Required` |
| **Night Profile** | Profile applied during night hours. `Disabled` uses **Profile** around the clock. | `Disabled` |
| **Night Start** / **Night End** | Local 24h `HH:MM` bounds of the night window | `18:00` / `06:00` |
| **Timezone** | IANA name, e.g. `Australia/Brisbane`. Blank uses the device's local time. | `` |
| **Sleep Time Thresholds** | Sleep times by voltage. Only used when **Profile** is `Custom`. | `Required` |
| **Min Awake Time Thresholds** | Minimum awake times by voltage. Only used when **Profile** is `Custom`. | `Required` |
| **Override Shutdown Permission in Minutes** | How long to wait before overriding an app that denies shutdown | `60` |
| **Wake-on Voltage** | Input voltage at which the device wakes itself. Blank defaults to 13.5 V (12 V profiles) or 27 V (24 V profiles). | `` |

<br/>

### Day / night profiles

Set a **Night Profile** to run different power behaviour after dark — typically `Max On` during the day and `Regular` overnight, so the device sleeps more when the panels aren't producing.

- The night window may wrap midnight (`18:00` → `06:00`). If **Night Start** and **Night End** are equal, or either fails to parse as `HH:MM`, the night profile is disabled and the day **Profile** runs around the clock.
- **Night Profile** must be the same voltage class (12 V / 24 V) as **Profile** — a device sits on one battery rail, not both. A mixed pair is rejected with a warning at startup and the day profile runs around the clock.
- **Wake-on Voltage** is a property of the battery rail, not of a profile. It is armed once at startup and stays in effect under both the day and night profiles, so a charging battery wakes the device even part-way through a long night sleep.
- **Custom** is not offered as a night profile, since the custom threshold arrays are shared with the day profile.
- Sleeps are shortened so the device wakes at the next day/night boundary rather than sleeping through it — otherwise a four-hour night sleep beginning at 04:00 would ignore the day profile until 08:00. A sleep is never shortened below 10 minutes; when a boundary is closer than that, the device overshoots it rather than waste a boot cycle.
- Times are interpreted in the device's local timezone, which the container reads from the host's mounted `/etc/localtime`. Set **Timezone** to override this on a device whose OS clock is still UTC. If the system clock is implausible (not yet restored after a sleep), the day profile is used and no clamping occurs.

<br/>

## Integrations

### Tags

This app exposes the following tags for integration with other apps:

| Tag | Description |
|-----|-------------|
| `shutdown_requested` | Global tag to request shutdown from apps |
| `shutdown_at` | Timestamp when shutdown will occur |
| `low_battery_warning_sent` | Whether low battery warning was sent |

<br/>
This app works seamlessly with:

- **Platform Interface**: Core Doover platform component
- **Solar Power Dashboard**: Fleet-wide monitoring (see below)


<br/>

# Solar Power Dashboard

**A fleet dashboard of every device running Solar Power Management — online / offline / nearly-offline status, power-management fault alerts, and an "expected to go offline" estimate from each device's battery-voltage trajectory.**

Deployed once at the organisation level. It renders a `SolarPowerDashboardWidget` remote component (React + Module Federation, Tailwind + shadcn) that reads each device's `tag_values` and `doover_connection` aggregates directly in the browser — no per-device install is required beyond Solar Power Management itself.

<br/>

## What it shows

- **Status** for every device: `Online`, `Nearly Offline` (overdue for a report, low battery, or projected to go flat soon), `Offline`, or `Unknown`.
- **Battery voltage** with 12 V / 24 V auto-detection and low / critical colouring.
- **Voltage trend** — a sparkline + slope (V/day) fitted through the *daily minimum* voltage over the last two weeks, so daytime solar-charging spikes don't skew the trend.
- **Projected offline** — when the daily-minimum trajectory is projected to reach the rail's cutoff voltage (≈ 11 V / 22 V). Devices falling toward that within 72 h are flagged.
- **Power-management issues** — heuristic fault detection: power management not reporting while the device is online, implausible voltage readings, critically low voltage, an active low-battery notification, charger fault states, a steep discharge trajectory, or an unusually long sleep cycle.
- **Summary cards**: Online / Nearly Offline / Offline / Power Mgmt Issues counts.

The table is sortable (default sort is **Priority** — offline devices and active faults first, then soonest-projected-offline). Click a row to expand details (rail, temperature, charger, sleep cycle, next wake). Click the device name to open it. There's an expand button for a full-screen view with all columns.

<br/>

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Devices** (extended permissions) | Which devices the dashboard can see. Set **Apps Installed → Solar Power Management** so every device running it is picked up automatically. | `Required` |
| **Position** | Where the dashboard sits in the app list | `100` |

<br/>

## Need Help?

- Email: support@doover.com
- [Community Forum](https://doover.com/community)
- [Full Documentation](https://docs.doover.com)
- [Developer Documentation](https://github.com/getdoover/power-management/blob/main/DEVELOPMENT.md)

<br/>

## Version History

### v1.0.0 (Current)
- Initial release

<br/>

## License

This app is licensed under the [Apache License 2.0](https://github.com/getdoover/power-management/blob/main/LICENSE).
