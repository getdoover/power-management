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
| **Sleep Time Thresholds** | Sleep times based on voltage | `Required` |
| **Victron Configs** | Victron Bluetooth devices | `Required` |

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
