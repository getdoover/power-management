# Application Template

This repository is a template for creating a new application. This example currently only showcases a Docker application.
Future work will include other examples, including an MQTT device, an HTTP integration, slack integration and others.

The basic structure of the repository is as follows:

```
doover_config.json  <-- Configuration file for the application
application/        <-- Application directory
  Dockerfile        <-- Dockerfile for the application
  Pipfile           <-- Python requirements file
  Pipfile.lock      <-- Python requirements lock file
  application.py    <-- Main application code
  app_config.py     <-- Config schema definition
  app_config.json   <-- Config schema export
```

The `doover_config.json` file is the doover configuration file for the application. 
It defines where the Doover site should find the application code. In our case, this is a fairly straightforward 
```json
{
    "deployment_package_dir": "application/"
}
```

