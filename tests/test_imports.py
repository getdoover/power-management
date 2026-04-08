"""
Basic tests for an application.

This ensures all modules are importable and that the config is valid.
"""


def test_import_app():
    from solar_power_management.application import PowerManager

    assert PowerManager
    assert PowerManager.config_cls is not None
    assert PowerManager.tags_cls is not None
    assert PowerManager.ui_cls is not None


def test_config():
    from solar_power_management.app_config import PowerManagerConfig

    schema = PowerManagerConfig.to_schema()
    assert isinstance(schema, dict)
    assert len(schema["properties"]) > 0


def test_tags():
    from solar_power_management.app_tags import PowerManagerTags

    assert PowerManagerTags


def test_ui():
    from solar_power_management.app_ui import PowerManagerUI
    from pydoover.ui import UI

    assert issubclass(PowerManagerUI, UI)
