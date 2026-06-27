#!/usr/bin/env python3
"""Collect OS build identity: OS version, kernel, DGX OS version."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env


def _parse_os_release():
    errors = []
    fields = {"NAME": "", "VERSION_ID": "", "PRETTY_NAME": ""}

    content = env._run("cat /etc/os-release 2>/dev/null")
    if not content:
        errors.append({"code": "os_release_missing", "message": "/etc/os-release not found", "detail": ""})
        return fields, errors

    for line in content.splitlines():
        line = line.strip()
        if "=" not in line or line.startswith("#"):
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        if key in fields:
            fields[key] = val

    return fields, errors


def _parse_dgx_release():
    dgx_version = ""
    dgx_build = ""

    content = env._run("cat /etc/dgx-release 2>/dev/null")
    if content:
        for line in content.splitlines():
            line = line.strip()
            if "=" not in line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            if key == "DGX_OS_VERSION":
                dgx_version = val
            elif key == "DGX_OS_BUILD":
                dgx_build = val

    return dgx_version, dgx_build


def main():
    errors = []

    os_fields, os_errors = _parse_os_release()
    errors.extend(os_errors)

    kernel = env._run("uname -r") or ""
    kernel_build = env._run("uname -v") or ""
    arch = env._run("uname -m") or ""

    if not kernel:
        errors.append({"code": "kernel_version_missing", "message": "uname -r returned empty", "detail": ""})

    dgx_version, dgx_build = _parse_dgx_release()

    data = {
        # TypeScript OSBuildIdentity fields
        "os_name": os_fields["NAME"],
        "os_version": os_fields["VERSION_ID"],
        "os_pretty": os_fields["PRETTY_NAME"],   # TS field name
        "kernel": kernel,                         # TS field name
        "kernel_build": kernel_build,
        "architecture": arch,
        # task spec aliases / extras
        "os_pretty_name": os_fields["PRETTY_NAME"],
        "kernel_version": kernel,
        "dgx_os_version": dgx_version,
        "dgx_os_build": dgx_build,
    }

    env.emit("os_build_identity", data, errors)


if __name__ == "__main__":
    main()
