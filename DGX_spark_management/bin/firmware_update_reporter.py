#!/usr/bin/env python3
# Copyright © 2026 Jerome Gabryszewski
# Licensed under the X11 License. See LICENSE file in the project root for details.
"""Report available firmware/BIOS updates — read-only.

Two sources are queried in order:
  1. fwupdmgr get-updates --json  (all Linux — LVFS BIOS, NIC, USB firmware)
  2. apt firmware packages         (apt-based systems — NVIDIA/BIOS packages by name pattern)

Entries from both sources are deduplicated by package name.  The caller decides
what to apply; this script never modifies device state.
"""
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env

_VERSION = "1.0.0"

_APT_FIRMWARE_PATTERNS = (
    "linux-firmware",
    "firmware-",
    "nvidia-firmware",
    "-bios",
    "-uefi",
    "intel-microcode",
    "amd64-microcode",
    "nvidia-vbios",
    "dgx-bios",
    "amd-ucode",
)


def _get_fwupd_updates():
    """Query fwupdmgr for available firmware updates via LVFS.

    Returns (updates_list, errors_list).
    Exit code 2 from fwupdmgr means nothing to update — not an error.
    """
    updates = []
    errors = []

    if not shutil.which("fwupdmgr"):
        return updates, errors  # soft — not an error, just unavailable

    try:
        import json as _json
        r = subprocess.run(
            ["fwupdmgr", "get-updates", "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        # exit 2 = "no updates available" — treat as success
        if r.returncode not in (0, 2):
            errors.append({
                "code": "fwupd_error",
                "message": f"fwupdmgr exited {r.returncode}: {r.stderr.strip()[:200]}",
            })
            return updates, errors

        if not r.stdout.strip():
            return updates, errors

        data = _json.loads(r.stdout)
        for device in data.get("Devices", []):
            device_name = device.get("Name", "")
            flags = device.get("Flags", [])
            requires_reboot = "require-ac" in flags or "needs-reboot" in flags
            for release in device.get("Releases", []):
                updates.append({
                    "package": device.get("DeviceId", device_name) or device_name,
                    "device_name": device_name,
                    "current_version": device.get("Version", ""),
                    "available_version": release.get("Version", ""),
                    "source": "fwupd",
                    "requires_reboot": requires_reboot,
                    "summary": release.get("Summary", ""),
                })
    except subprocess.TimeoutExpired:
        errors.append({"code": "fwupd_timeout", "message": "fwupdmgr get-updates timed out"})
    except ValueError as exc:
        errors.append({"code": "fwupd_parse", "message": f"fwupdmgr JSON parse error: {exc}"})
    except Exception as exc:
        errors.append({"code": "fwupd_exception", "message": str(exc)})

    return updates, errors


def _get_apt_firmware_packages(existing_packages):
    """Scan apt upgradable list for firmware-pattern packages.

    Skips packages already discovered by fwupdmgr (existing_packages set).
    Returns (updates_list, errors_list).
    """
    updates = []
    errors = []

    if not shutil.which("apt"):
        return updates, errors

    try:
        r = subprocess.run(
            ["apt", "list", "--upgradable"],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "LANG": "C", "LC_ALL": "C"},
        )
        for line in r.stdout.splitlines():
            if line.startswith("Listing") or "/" not in line:
                continue
            try:
                parts = line.split()
                pkg = parts[0].split("/")[0]
            except Exception:
                continue

            if not any(pat in pkg.lower() for pat in _APT_FIRMWARE_PATTERNS):
                continue
            if pkg in existing_packages:
                continue

            avail = parts[1] if len(parts) > 1 else ""
            current = ""
            if "[upgradable from:" in line:
                current = line.split("[upgradable from:")[-1].rstrip("]").strip()

            # Try dpkg-query for current version if apt didn't provide it
            if not current and shutil.which("dpkg-query"):
                try:
                    dq = subprocess.run(
                        ["dpkg-query", "-W", "-f=${Version}", pkg],
                        capture_output=True, text=True, timeout=5,
                    )
                    if dq.returncode == 0:
                        current = dq.stdout.strip()
                except Exception:
                    pass

            updates.append({
                "package": pkg,
                "device_name": pkg,
                "current_version": current,
                "available_version": avail,
                "source": "apt-firmware",
                "requires_reboot": True,
                "summary": f"Firmware package: {pkg}",
            })
    except Exception as exc:
        errors.append({"code": "apt_firmware_error", "message": str(exc)})

    return updates, errors


def main():
    all_updates = []
    all_errors = []

    fwupd_updates, fwupd_errors = _get_fwupd_updates()
    all_updates.extend(fwupd_updates)
    all_errors.extend(fwupd_errors)

    existing = {u["package"] for u in all_updates}
    apt_fw_updates, apt_fw_errors = _get_apt_firmware_packages(existing)
    all_updates.extend(apt_fw_updates)
    all_errors.extend(apt_fw_errors)

    if any(u["source"] == "fwupd" for u in all_updates):
        source = "fwupd"
    elif any(u["source"] == "apt-firmware" for u in all_updates):
        source = "apt-firmware"
    else:
        source = "unavailable"

    data = {"source": source, "updates": all_updates}
    env.emit("firmware_update_availability", data, all_errors, version=_VERSION)


if __name__ == "__main__":
    main()
