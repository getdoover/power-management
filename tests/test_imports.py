"""
Basic tests for an application.

This ensures all modules are importable and that the config is valid.
"""


def test_import_app():
    from power_management.application import PowerManager

    assert PowerManager


def test_config():
    from power_management.app_config import PowerManagerConfig

    config = PowerManagerConfig()
    assert isinstance(config.to_dict(), dict)


def test_ui():
    from power_management.app_ui import PowerManagerUI

    assert PowerManagerUI



# def test_state():
#     from application.app_state import SampleState
#     assert SampleState
