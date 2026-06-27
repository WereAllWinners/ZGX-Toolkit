#!/usr/bin/env python3
"""Collect stable device identity: serial, UUID, hostname, manufacturer, product, BIOS."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env

# DMI field name → dmidecode -s type
_DMI_FIELDS = {
    "manufacturer":  "system-manufacturer",
    "product_name":  "system-product-name",
    "serial_number": "system-serial-number",
    "uuid":          "system-uuid",
    "bios_vendor":   "bios-vendor",
    "bios_version":  "bios-version",
    "bios_date":     "bios-release-date",
    "board_name":    "baseboard-product-name",
}


def main():
    errors = []
    data = {}

    did = env.device_id()
    data["hostname"] = did["hostname"]

    for key, dmi_type in _DMI_FIELDS.items():
        val = env._run(f"sudo dmidecode -s {dmi_type} 2>/dev/null || true")
        if not val:
            errors.append({
                "code": f"dmi_{key}_missing",
                "message": f"DMI field '{dmi_type}' not available",
                "detail": "",
            })
        data[key] = val

    env.emit("device_identity", data, errors)


if __name__ == "__main__":
    main()
