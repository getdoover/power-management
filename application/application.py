import random
import time

from pydoover.docker import DockerApplication, run_app
from pydoover import ui

from app_config import SampleConfig


# UI Will look like this

# Variable : Is Working : Bool
# Variable : Uptime : Int
# Parameter : Test Message
# Variable : Test Output
# Action : Send this text as an alert
# Submodule :
#      Variable : Battery Voltage
#      Parameter : Low Battery Voltage Alert
#            Once below this setpoint, send a text and show a warning
#      StateCommand : Charge Battery Mode
#           - Charge
#           - Discharge
#           - Idle


class SampleApplication(DockerApplication):
    started: time.time
    is_working: ui.BooleanVariable
    send_alert: ui.Action
    on_text_parameter_change: ui.TextParameter
    config: SampleConfig  # not necessary, but helps your IDE provide autocomplete!

    def setup(self):
        self.started = time.time()
        include_uptime = True

        # Define the UI
        self.is_working = ui.BooleanVariable("is_working", "We Working?")
        ui_elems = (
            self.is_working,
            ui.DateTimeVariable("uptime", "Started") if include_uptime else None,
            self.send_alert,
            self.on_text_parameter_change,
            ui.TextVariable("test_output", "This is message we got"),
            ui.Submodule("battery", "Battery Module", children=[
                ui.NumericVariable(
                    "voltage", "Battery Voltage", precision=2, ranges=[
                        ui.Range("Low", 0, 10, ui.Colour.red),
                        ui.Range("Normal", 10, 20, ui.Colour.green),
                        ui.Range("High", 20, 30, ui.Colour.blue),
                    ]),
                ui.NumericParameter("low_voltage_alert", "Low Voltage Alert"),
                ui.StateCommand(
                    "charge_mode", "Charge Mode", callback=self.on_state_command, user_options=[
                        ui.Option("charge", "Charge"),
                        ui.Option("discharge", "Discharge"),
                        ui.Option("idle", "Idle")
                    ]),
            ]),
        )

        self.ui_manager.add_children(*ui_elems)

    def main_loop(self):
        self.is_working.current_value = True
        self.ui_manager.update_variable("voltage", random.randint(900, 2100)/100)
        self.ui_manager.update_variable("uptime", time.time() - self.started)

    @ui.action("send_alert", "Send message as alert", position=1)
    def send_alert(self, new_value):
        output = self.ui_manager.get_element("test_output").current_value
        self.log(f"Sending alert: {output}")
        self.publish_to_channel("significantAlerts", output)
        self.send_alert.coerce(None)

    @ui.text_parameter("test_message", "Put in a message")
    def on_text_parameter_change(self, new_value):
        self.log(f"New value for test message: {new_value}")
        # Set the value as an output to the corresponding variable is this case
        self.get_ui_manager().update_variable("test_output", new_value)

    def on_state_command(self, new_value):
        self.log("New value for state command: " + new_value)


if __name__ == "__main__":
    app = SampleApplication(config=SampleConfig())
    run_app(app)
