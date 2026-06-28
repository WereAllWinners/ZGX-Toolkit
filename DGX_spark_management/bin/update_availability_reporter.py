#!/usr/bin/env python3
# Copyright © 2026 Jerome Gabryszewski
# Licensed under the X11 License. See LICENSE file in the project root for details.
"""Report available package updates — read-only, package-manager-first.

Dispatches on the detected package manager (apt / dnf / zypper) and reports
available updates without applying anything. Mirrors the zgx-collector
update-availability subcommand; both emit identical data shapes.
"""
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env

_VERSION = "1.0.0"


def _detect_pm():
    if shutil.which("apt-get"):
        return "apt"
    if shutil.which("dnf"):
        return "dnf"
    if shutil.which("zypper"):
        return "zypper"
    return "unavailable"


def _parse_apt():
    """Return (updates, error_or_None) via apt list --upgradable."""
    try:
        r = subprocess.run(
            ["apt", "list", "--upgradable"],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "LANG": "C", "LC_ALL": "C"},
        )
        out = r.stdout
    except Exception as exc:
        return [], str(exc)

    updates = []
    for line in out.splitlines():
        if line.startswith("Listing") or "/" not in line:
            continue
        try:
            parts = line.split()
            package = parts[0].split("/")[0]
            available_version = parts[1] if len(parts) > 1 else ""
            current_version = ""
            if "[upgradable from:" in line:
                current_version = line.split("[upgradable from:")[-1].rstrip("]").strip()
            updates.append({
                "package": package,
                "current_version": current_version,
                "available_version": available_version,
            })
        except Exception:
            continue
    return updates, None


def _parse_dnf():
    """Return (updates, error_or_None) via dnf check-update.

    Exit code 100 means updates are available — not an error.
    """
    try:
        r = subprocess.run(
            ["dnf", "check-update", "--quiet"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        rc = r.returncode
    except Exception as exc:
        return [], str(exc)

    if rc not in (0, 100):
        return [], f"dnf check-update exited with code {rc}"

    # Build current-version lookup from installed packages
    installed = {}
    try:
        ri = subprocess.run(
            ["dnf", "list", "--installed", "--quiet"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        for line in ri.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                pkg_arch = parts[0]
                pkg_name = pkg_arch.rsplit(".", 1)[0] if "." in pkg_arch else pkg_arch
                installed[pkg_name] = parts[1]
    except Exception:
        pass

    updates = []
    in_obsoleting = False
    for line in r.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if "Obsoleting Packages" in stripped:
            in_obsoleting = True
            continue
        if in_obsoleting:
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        try:
            pkg_arch = parts[0]
            pkg_name = pkg_arch.rsplit(".", 1)[0] if "." in pkg_arch else pkg_arch
            available_version = parts[1]
            current_version = installed.get(pkg_name, "")
            updates.append({
                "package": pkg_name,
                "current_version": current_version,
                "available_version": available_version,
            })
        except Exception:
            continue
    return updates, None


def _parse_zypper():
    """Return (updates, error_or_None) via zypper list-updates."""
    try:
        r = subprocess.run(
            ["zypper", "--quiet", "list-updates"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        out = r.stdout
    except Exception as exc:
        return [], str(exc)

    updates = []
    for line in out.splitlines():
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        # Columns: S | Repository | Name | Current Version | Available Version | Arch
        if len(parts) < 6:
            continue
        name = parts[2]
        current_version = parts[3]
        available_version = parts[4]
        if name in ("Name", "S", "") or not available_version:
            continue
        updates.append({
            "package": name,
            "current_version": current_version,
            "available_version": available_version,
        })
    return updates, None


def main():
    pm = _detect_pm()
    errors = []
    updates = []

    if pm == "apt":
        updates, err = _parse_apt()
        if err:
            errors.append({"code": "apt_error", "message": err, "detail": ""})
    elif pm == "dnf":
        updates, err = _parse_dnf()
        if err:
            errors.append({"code": "dnf_error", "message": err, "detail": ""})
    elif pm == "zypper":
        updates, err = _parse_zypper()
        if err:
            errors.append({"code": "zypper_error", "message": err, "detail": ""})
    else:
        errors.append({
            "code": "pm_unavailable",
            "message": "No supported package manager (apt/dnf/zypper) found",
            "detail": "",
        })

    data = {"source": pm, "updates": updates}
    env.emit("update_availability_reporter", data, errors, version=_VERSION)


if __name__ == "__main__":
    main()
