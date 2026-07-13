#!/usr/bin/env python3
"""Collect stable device identity: serial, UUID, hostname, manufacturer, product, BIOS."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env

# DMI field name → sysfs file under /sys/class/dmi/id/ (root-less; no sudo)
_DMI_FIELDS = {
    "manufacturer":  "sys_vendor",
    "product_name":  "product_name",
    "serial_number": "product_serial",
    "uuid":          "product_uuid",
    "bios_vendor":   "bios_vendor",
    "bios_version":  "bios_version",
    "bios_date":     "bios_date",
    "board_name":    "board_name",
}


def main():
    errors = []
    data = {}

    did = env.device_id()
    data["hostname"] = did["hostname"]

    for key, sysfs_field in _DMI_FIELDS.items():
        val = env.read_dmi(sysfs_field)
        if not val:
            errors.append({
                "code": f"dmi_{key}_missing",
                "message": f"DMI field '{sysfs_field}' not available",
                "detail": "",
            })
        data[key] = val

    env.emit("device_identity", data, errors)


if __name__ == "__main__":
    main()
