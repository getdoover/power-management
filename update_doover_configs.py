#!/usr/bin/env python3
"""
Script to update all doover_config.json files across multiple repositories.
Adds lambda_config, owner_org_id, and container_registry_profile_id to app configs.
"""

import json
import os
from pathlib import Path

# Base directory
BASE_DIR = Path("/Users/tomwyatt")

# Registry profile IDs
GHCR_REGISTRY_ID = "93955828574386692"
DOCKERHUB_REGISTRY_ID = "93955623347091970"

# Define all config file paths
CONFIG_PATHS = [
    # Standard repos with doover_config.json in root
    "4-20ma-sensor/doover_config.json",
    "analog-rain-gauge/doover_config.json",
    "battery-monitor/doover_config.json",
    "camera-inference/doover_config.json",
    "cattle-cam/doover_config.json",
    "dooverworx-gateway/doover_config.json",
    "endress-promag/doover_config.json",
    "enip-cip-interface/doover_config.json",
    "foxglove-iface/doover_config.json",
    "generator-control/doover_config.json",
    "hydraulics-controller/doover_config.json",
    "irrigation-gate-control/doover_config.json",
    "logo-displayer/doover_config.json",
    "modbus-channel-relay/doover_config.json",
    "platform-modbus-bridge/doover_config.json",
    "power-management/doover_config.json",
    "small-motor-control/doover_config.json",
    "starlink-manager/doover_config.json",
    "trash-elevator/doover_config.json",
    "wifi-rotate/doover_config.json",
    # Cameras has 2 configs
    "cameras/device_app/doover_config.json",
    "cameras/rtsp_to_web_app/doover_config.json",
]

def find_water_control_configs():
    """Find doover_config.json files in water_control subdirectories that have apps."""
    water_control_dir = BASE_DIR / "water_control"
    configs = []
    
    if water_control_dir.exists():
        for item in water_control_dir.iterdir():
            if item.is_dir():
                config_path = item / "doover_config.json"
                if config_path.exists():
                    # Check if it has actual app configs (not just deployment_package_dir)
                    try:
                        with open(config_path, 'r') as f:
                            data = json.load(f)
                        # Check if any key has image_name (indicates an app)
                        has_app = any(
                            isinstance(v, dict) and 'image_name' in v 
                            for v in data.values()
                        )
                        if has_app:
                            configs.append(f"water_control/{item.name}/doover_config.json")
                    except (json.JSONDecodeError, IOError):
                        pass
    
    return configs

def get_registry_id(image_name):
    """Determine registry profile ID based on image name."""
    if "ghcr.io" in image_name:
        return GHCR_REGISTRY_ID
    else:
        return DOCKERHUB_REGISTRY_ID

def update_config_file(config_path):
    """Update a single doover_config.json file."""
    full_path = BASE_DIR / config_path
    
    if not full_path.exists():
        return None, f"File not found: {full_path}"
    
    try:
        with open(full_path, 'r') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {e}"
    except IOError as e:
        return None, f"Read error: {e}"
    
    changes = []
    modified = False
    
    for key, value in data.items():
        # Skip non-dict values and non-app configs (those without image_name)
        if not isinstance(value, dict):
            continue
        if 'image_name' not in value:
            continue
        
        app_changes = []
        
        # Add lambda_config if not present
        if 'lambda_config' not in value:
            value['lambda_config'] = {}
            app_changes.append("added lambda_config: {}")
            modified = True
        
        # Add owner_org_id if not present
        if 'owner_org_id' not in value:
            value['owner_org_id'] = None
            app_changes.append("added owner_org_id: null")
            modified = True
        
        # Set container_registry_profile_id based on image_name
        image_name = value['image_name']
        registry_id = get_registry_id(image_name)
        old_registry_id = value.get('container_registry_profile_id')
        
        if old_registry_id != registry_id:
            value['container_registry_profile_id'] = registry_id
            registry_type = "ghcr.io" if registry_id == GHCR_REGISTRY_ID else "dockerhub"
            if old_registry_id is None:
                app_changes.append(f"added container_registry_profile_id: {registry_id} ({registry_type})")
            else:
                app_changes.append(f"changed container_registry_profile_id: {old_registry_id} -> {registry_id} ({registry_type})")
            modified = True
        
        if app_changes:
            changes.append(f"  [{key}]: " + ", ".join(app_changes))
    
    if modified:
        try:
            with open(full_path, 'w') as f:
                json.dump(data, f, indent=4)
                f.write('\n')  # Add trailing newline
            return changes, None
        except IOError as e:
            return None, f"Write error: {e}"
    
    return [], None  # No changes needed

def main():
    print("=" * 70)
    print("Updating doover_config.json files across repositories")
    print("=" * 70)
    print()
    
    # Collect all config paths
    all_configs = CONFIG_PATHS.copy()
    
    # Find water_control configs
    water_control_configs = find_water_control_configs()
    all_configs.extend(water_control_configs)
    
    print(f"Found {len(all_configs)} config files to process")
    print()
    
    # Track results
    modified_files = []
    unchanged_files = []
    error_files = []
    
    for config_path in sorted(all_configs):
        print(f"Processing: {config_path}")
        changes, error = update_config_file(config_path)
        
        if error:
            print(f"  ERROR: {error}")
            error_files.append((config_path, error))
        elif changes:
            print(f"  MODIFIED:")
            for change in changes:
                print(f"    {change}")
            modified_files.append((config_path, changes))
        else:
            print(f"  No changes needed")
            unchanged_files.append(config_path)
        print()
    
    # Summary
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"Total files processed: {len(all_configs)}")
    print(f"Files modified: {len(modified_files)}")
    print(f"Files unchanged: {len(unchanged_files)}")
    print(f"Files with errors: {len(error_files)}")
    print()
    
    if modified_files:
        print("Modified files:")
        for path, changes in modified_files:
            print(f"  - {path}")
    
    if error_files:
        print("\nFiles with errors:")
        for path, error in error_files:
            print(f"  - {path}: {error}")

if __name__ == "__main__":
    main()
