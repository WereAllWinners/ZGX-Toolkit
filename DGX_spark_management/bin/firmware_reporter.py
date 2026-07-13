#!/usr/bin/env python3
"""Collect firmware versions: BIOS, GPU VBIOS, NIC firmware, SSD firmware."""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env


def _collect_bios():
    errors = []
    # Root-less: read BIOS DMI fields directly from sysfs rather than
    # shelling out to `sudo dmidecode -t bios`.
    vendor = env.read_dmi("bios_vendor")
    version = env.read_dmi("bios_version")
    release_date = env.read_dmi("bios_date")

    if not (vendor or version or release_date):
        errors.append({"code": "bios_info_missing", "message": "BIOS DMI fields not available under /sys/class/dmi/id/", "detail": ""})

    return {"vendor": vendor, "version": version, "release_date": release_date}, errors


def _collect_gpu_firmware():
    errors = []
    gpu_firmware = []
    gpu_driver_version = ""

    nvidia_out = env._run(
        "nvidia-smi --query-gpu=index,vbios_version,driver_version "
        "--format=csv,noheader 2>/dev/null"
    )
    if nvidia_out:
        for i, line in enumerate(nvidia_out.splitlines()):
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split(",")]
            try:
                index = int(parts[0]) if parts else i
                vbios_ver = parts[1] if len(parts) > 1 else ""
                driver_ver = parts[2] if len(parts) > 2 else ""
                gpu_firmware.append({"index": index, "vbios_version": vbios_ver})
                if driver_ver and not gpu_driver_version:
                    gpu_driver_version = driver_ver
            except Exception:
                pass
    else:
        errors.append({"code": "nvidia_smi_unavailable", "message": "nvidia-smi not available", "detail": ""})

    return gpu_firmware, gpu_driver_version, errors


def _collect_nic_firmware():
    errors = []
    nic_firmware = []

    ifaces_out = env._run("ip link show 2>/dev/null | grep '^[0-9]' | awk '{print $2}' | tr -d ':'")
    ifaces = [i for i in (ifaces_out or "").splitlines() if i and i != "lo" and "@" not in i]

    for iface in ifaces:
        ethtool_out = env._run(f"ethtool -i {iface} 2>/dev/null")
        if not ethtool_out:
            continue
        fw_version = ""
        for line in ethtool_out.splitlines():
            if line.startswith("firmware-version:"):
                fw_version = line.split(":", 1)[1].strip()
                break
        if fw_version:
            nic_firmware.append({"interface": iface, "firmware_version": fw_version})

    return nic_firmware, errors


def _collect_ssd_firmware():
    errors = []
    ssd_firmware = []

    nvme_out = env._run("nvme list -o json 2>/dev/null")
    if nvme_out:
        try:
            parsed = json.loads(nvme_out)
            for dev in parsed.get("Devices", []):
                dev_path = dev.get("DevicePath") or dev.get("DevPath", "")
                fw = dev.get("Firmware") or dev.get("FirmwareRevision", "")
                if dev_path:
                    ssd_firmware.append({"device": dev_path, "firmware_version": fw or ""})
        except (json.JSONDecodeError, KeyError, TypeError):
            errors.append({"code": "nvme_json_parse_error", "message": "Failed to parse nvme list JSON", "detail": ""})

    return ssd_firmware, errors


def main():
    all_errors = []

    bios, bios_errors = _collect_bios()
    all_errors.extend(bios_errors)

    gpu_firmware, gpu_driver_version, gpu_errors = _collect_gpu_firmware()
    all_errors.extend(gpu_errors)

    nic_firmware, nic_errors = _collect_nic_firmware()
    all_errors.extend(nic_errors)

    ssd_firmware, ssd_errors = _collect_ssd_firmware()
    all_errors.extend(ssd_errors)

    data = {
        # TypeScript FirmwareReport fields (flat) — None serialises to JSON null so
        # the TypeScript side can reliably distinguish "not available" from empty string.
        "bios_version": bios["version"] or None,
        "bios_date": bios["release_date"] or None,
        "gpu_vbios_version": (gpu_firmware[0]["vbios_version"] or None) if gpu_firmware else None,
        "gpu_driver_version": gpu_driver_version or None,
        # task spec nested fields
        "bios": bios,
        "gpu_firmware": gpu_firmware,
        "nic_firmware": nic_firmware,
        "ssd_firmware": ssd_firmware,
    }

    env.emit("firmware_reporter", data, all_errors)


if __name__ == "__main__":
    main()
