# # Test Function
# import logging
# import asyncio
#
# from application import PowerManager
#
# # Simulate the app's interface with required stubs
# class MockPlatformInterface:
#     async def get_system_voltage_async(self):
#         if not hasattr(self, "start_time"):
#             self.start_time = asyncio.get_event_loop().time()
#         run_time = asyncio.get_event_loop().time() - self.start_time
#
#         if not hasattr(self, "run_count"):
#             self.run_count = 0
#         self.run_count += 1
#
#         ## Test Voltages - A steadily decreasing voltage from 13.8 to 11.8 V
#         voltage = 13.8 - run_time / 50
#         if voltage < 11.8:
#             voltage = 11.8
#
#         ## Add a random noise to the voltage (up to 3v)
#         import random
#         voltage += random.random() * 3
#
#         ## Every 5th iteration, simulate a voltage drop
#         if self.run_count % 6 < 2:
#             voltage -= 5
#
#         ## Every 6th iteration return None
#         if self.run_count % 7 < 2:
#             voltage = None
#         else:
#             voltage = round(voltage, 2)
#
#         logging.debug(f"Simulated voltage: {voltage}")
#         return voltage
#
#     async def schedule_startup_async(self, sleep_time):
#         logging.error(f"Startup scheduled after {sleep_time} seconds.")
#
#     async def shutdown_async(self):
#         logging.error("System shutting down...")
#
#
# class MockApp:
#     def __init__(self):
#         self.platform_iface = MockPlatformInterface()
#
#     async def get_config_async(self, key_filter=None, wait=True):
#         # Simulated configuration for testing
#         if key_filter == "POWER_MANAGEMENT":
#             return {
#                 "VOLTAGE_SLEEP_MINUTES": {
#                     12.7: 15,  # 15 mins of sleep if voltage <= 12.7
#                     12.2: 60,  # 1 hour of sleep if voltage <= 12.2
#                     11.8: 240,  # 4 hours sleep if voltage <= 11.8
#                 },
#                 # "MIN_AWAKE_SECONDS": 45,  # Minimum awake time in seconds
#                 "MIN_AWAKE_SECONDS": {
#                     12.7: 120,
#                     12.2: 60,
#                     11.8: 40,
#                 }
#             }
#         return {}
#
#
#
# # Main testing function
# async def main():
#     logging.basicConfig(level=logging.DEBUG)
#
#     # Instantiate the mock app and PowerManager
#     app = MockApp()
#     power_manager = PowerManager(app)
#
#     # Register pre-shutdown hooks
#     power_manager.register_pre_shutdown_hook(sync_pre_shutdown_hook)
#     power_manager.register_pre_shutdown_hook(async_pre_shutdown_hook)
#
#     # Register shutdown hooks
#     power_manager.register_shutdown_hook(sync_shutdown_hook)
#     power_manager.register_shutdown_hook(async_shutdown_hook)
#
#     # Setup the PowerManager
#     await power_manager.setup()
#
#     # Simulate a short monitoring loop for testing
#     while True:
#         await power_manager.main_loop()
#         await asyncio.sleep(2)
#
#
# # asyncio.run(main())
