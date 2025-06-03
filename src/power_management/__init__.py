from pydoover.docker import run_app

from .application import PowerManager
from .app_config import PowerManagerConfig


def main():
    """Main entry point for the Power Management application."""
    run_app(PowerManager(config=PowerManagerConfig()))
