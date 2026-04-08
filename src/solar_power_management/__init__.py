from pydoover.docker import run_app

from .application import PowerManager


def main():
    """Main entry point for the Power Management application."""
    run_app(PowerManager())
