"""
Victron Bluetooth Low Energy (BLE) device interface.

This module provides a simple interface to read data from Victron devices
using Bluetooth Low Energy communication.
"""

import asyncio
import logging
from typing import Dict, Any, Callable
from dataclasses import dataclass
import time
import traceback
import inspect
from enum import Enum

try:
    # from victron_ble import VictronBLEDevice
    from bleak import BLEDevice
    from victron_ble.scanner import Scanner
    from victron_ble.devices import detect_device_type
    from victron_ble.exceptions import AdvertisementKeyMissingError, UnknownDeviceError

except ImportError:
    raise ImportError("victron-ble package is required. Install with: pip install victron-ble")


@dataclass
class VictronDeviceData:
    """Data structure for Victron device readings."""
    data: Dict[str, Any]
    device: BLEDevice
    data_time: float

    def _data_as_dict(self) -> Dict[str, Any]:
        data = {}
        for name, method in inspect.getmembers(self.data, predicate=inspect.ismethod):
            if name.startswith("get_"):
                value = method()
                if isinstance(value, Enum):
                    value = value.name.lower()
                if value is not None:
                    data[name[4:]] = value
        return data

    @property
    def name(self):
        return self._data_as_dict().get("name", None)
    
    @property
    def address(self):
        return self.device.address
    
    @property
    def rssi(self):
        return self.device.rssi
    
    @property
    def payload(self):
        return self._data_as_dict()
    
    @property
    def state(self):
        result = self.charger_state
        if result is None:
            result = self.charge_state
        return result
    
    @property
    def error(self):
        return self.charger_error
    
    @property
    def output_current(self):
        current_1 = self.output_current1
        current_2 = self.output_current2
        if current_1 is not None and current_2 is not None:
            return current_1 + current_2
        elif current_1 is not None:
            return current_1
        elif current_2 is not None:
            return current_2
        elif self.battery_charging_current is not None:
            return self.battery_charging_current
        return None

    @property
    def output_voltage(self):
        voltage_1 = self.output_voltage1
        voltage_2 = self.output_voltage2
        if voltage_1 is not None and voltage_2 is not None:
            ## Return the higher voltage
            return max(voltage_1, voltage_2)
        elif voltage_1 is not None:
            return voltage_1
        elif voltage_2 is not None:
            return voltage_2
        elif self.battery_voltage is not None:
            return self.battery_voltage
        return None

    @property
    def output_power(self):
        if self.output_current is not None and self.output_voltage is not None:
            return self.output_current * self.output_voltage
        return None

    @property
    def charge_efficiency(self):
        return self.output_power / self.output_current

    def __getattr__(self, name: str) -> Any:
        return self._data_as_dict().get(name, None)

    def pretty_print(self):
        print(f"Name: {self.name}")
        print(f"Address: {self.address}")
        print(f"RSSI: {self.rssi}")
        print(f"Payload: {self.payload}")
        print(f"State: {self.state}")
        print(f"Error: {self.error}")
        print(f"Model Name: {self.model_name}")
        print(f"Output Current 1: {self.output_current}")
        print(f"Output Voltage 1: {self.output_voltage}")


class VictronScanner(Scanner):
    """
    A scanner for Victron devices.
    """
    def __init__(self, device_address: str, device_key: str, callback: Callable[[dict, bytes], None]):
        super().__init__({device_address: device_key})
        self.callback = callback

    def callback(self, device: dict, data: bytes):
        self.callback(device, data)

    # Overridden base class to handle Mac as well as Linux/Windows
    def get_device(self, ble_device: BLEDevice, raw_data: bytes):
        address = ble_device.address.lower()
        try:
            return self._get_device(address, raw_data)
        except Exception as e:
            # try:
            #     # MacOS version
            #     address = ble_device.identifier.lower()
            #     return self._get_device(address, raw_data)
            # except Exception as e:
                raise e

    def _get_device(self, address: str, raw_data: bytes):
        if address not in self._known_devices:
            advertisement_key = self.load_key(address)

            device_klass = detect_device_type(raw_data)
            if not device_klass:
                raise UnknownDeviceError(
                    f"Could not identify device type for {address}"
                )

            self._known_devices[address] = device_klass(advertisement_key)
        return self._known_devices[address]


class VictronDevice:
    """
    A simple interface to read data from Victron devices via Bluetooth LE.
    
    This class provides methods to scan for and read data from Victron devices
    using the victron-ble package.
    """
    
    def __init__(self, device_address: str, device_key: str):
        """
        Initialize the Victron device interface.
        
        Args:
            device_address: The Bluetooth MAC address of the device (e.g., "CB:CF:B2:57:19:DA" or "cbcfb25719da")
            device_key: The encryption key for the device (e.g., "ae6adb08be413881a9dd4f0a5aa410de")
        """
        # Convert the device address to uppercase if it's not already
        if device_address.count(':') == 5 or len(device_address) > 20:
            self.device_address = device_address.lower()
        else:
            self.device_address = ':'.join(device_address[i:i+2] for i in range(0, len(device_address), 2))
        self.device_key = device_key
        self.logger = logging.getLogger(__name__)

        self.scanner = None
        self.last_data = None
        self.last_data_time = None
        self.data_recv_event = asyncio.Event()
        self.reset_data_task = None

    async def reset_data(self):
        """
        A task that runs in the background and resets the data from the victron to None if the data is not received for 60 seconds.
        """
        reset_after = 60
        while True:
            await asyncio.sleep(10)
            if self.last_data is not None and time.time() - self.last_data_time > reset_after:
                self.last_data = None
                self.data_recv_event.clear()

    async def await_data(self):
        """
        Await data from the Victron device.
        """
        # Start the scanner
        await self.start()
        # Await data from the scanner
        await self.data_recv_event.wait()
        # await self.stop()
        return self.last_data

    def recv_data(self, device: dict, data: bytes):
        """
        Callback function to handle received data from the Victron device.
        """
        self.logger.debug(f"Received data from device {device}")
        self.logger.debug(f"Data: {data.hex()}")
        try:
            result = self.parse_data(device, data)
            if result is None:
                return
        except AdvertisementKeyMissingError:
            # Unknown device, ignore
            self.logger.info(f"Unknown device: {device}")
            return
        except Exception as e:
            self.logger.error(f"Error parsing data: {e}")
            traceback.print_exc()
            return
        self.last_data = result
        self.last_data_time = time.time()
        self.data_recv_event.set()

    def parse_data(self, device: BLEDevice, data: bytes):
        """
        Parse the data from the Victron device.
        """
        _dev = self.scanner.get_device(device, data)

        parsed = _dev.parse(data)
        
        result = VictronDeviceData(
            data=parsed,
            device=device,
            data_time=time.time()
        )
        return result

    async def start(self):
        """
        Read data from the Victron device.
        
        """
        if self.scanner:
            return
        if self.reset_data_task is None:
            self.reset_data_task = asyncio.create_task(self.reset_data())
        try:
            # Create a scanner instance
            scanner = VictronScanner(self.device_address, self.device_key, self.recv_data)
            self.scanner = scanner
            await scanner.start()
        except Exception as e:
            self.logger.error(f"Error starting scanner: {e}")
            # raise
    
    async def stop(self):
        """
        Stop the scanner.
        """
        if self.scanner:
            await self.scanner.stop()
            self.scanner = None
        if self.reset_data_task:
            self.reset_data_task.cancel()
            self.reset_data_task = None

    async def scan_for_devices(self, timeout: int = 10) -> list:
        """
        Scan for available Victron devices.
        
        Args:
            timeout: Scanning timeout in seconds
            
        Returns:
            List of discovered Victron devices
        """
        try:
            scanner = Scanner()
            self.logger.info("Scanning for Victron devices...")
            
            devices = await scanner.scan(timeout=timeout)
            
            if devices:
                self.logger.info(f"Found {len(devices)} Victron device(s)")
                for device in devices:
                    self.logger.info(f"  - {device.get('name', 'Unknown')} ({device.get('address', 'Unknown')})")
            else:
                self.logger.info("No Victron devices found")
                
            return devices
            
        except Exception as e:
            self.logger.error(f"Error scanning for devices: {e}")
            return []

    def __getattr__(self, name: str) -> Any:
        return getattr(self.last_data, name) if self.last_data else None


# Example usage and testing
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    async def main():
        # Example device from your output

        ## Shed Battery Charger
        # device_address = "CB:CF:B2:57:19:DA"
        device_address = "46A887B1-2D57-3A13-77DF-691493C18A82" ## It seems mac wants a different address
        device_key = "ae6adb08be413881a9dd4f0a5aa410de"
        
        ## Test Smart Solar Charger
        device_address = "20CF582C-3130-6A4B-F08C-F49A63F76250"
        device_key = "17a91f990954a3cb13f4deb059d70b00"

        device_address = "c551ac9f555d"
        device_key = "a7793eb2ed66f21a3ead17d2a6798a84"

        # Create device instance
        device = VictronDevice(device_address, device_key)
        
        # Await data from the device
        data = await device.await_data()
        await device.stop()
        data.pretty_print()
    
    # Run the example
    asyncio.run(main())
