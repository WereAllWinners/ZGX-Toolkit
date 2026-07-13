#!/usr/bin/env python3
"""Shared JSON envelope builder for DGX Spark management collectors."""
import json
import subprocess
import datetime
import socket


def _run(cmd, timeout=10):
    """Run a shell command; return stdout string or '' on failure."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip()
    except Exception:
        return ""


def read_dmi(field, default=""):
    """Read a DMI field directly from sysfs (root-less). Some fields (e.g.
    product_serial, product_uuid) are root-only readable on many distros and
    will return the default rather than escalating via sudo."""
    try:
        with open(f"/sys/class/dmi/id/{field}") as f:
            return f.read().strip()
    except Exception:
        return default


def device_id():
    """Return the device_id block used by all collectors. Root-less: reads
    DMI identity directly from sysfs rather than shelling out to dmidecode
    with sudo."""
    serial = read_dmi("product_serial")
    uuid = read_dmi("product_uuid")
    hostname = socket.gethostname()
    return {"serial": serial, "uuid": uuid, "hostname": hostname}


def now_utc():
    """Return current UTC timestamp in ISO 8601 format."""
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def emit(tool_name, data, errors=None, version="1.0.0"):
    """Emit the final JSON envelope to stdout and exit."""
    errors = errors or []
    status = "error" if not data else ("partial" if errors else "ok")
    summary_map = {
        "ok": f"{tool_name} collected successfully",
        "partial": f"{tool_name} collected with {len(errors)} error(s)",
        "error": f"{tool_name} failed to collect data",
    }
    envelope = {
        # Task spec fields
        "tool_name": tool_name,
        "tool_version": version,
        "timestamp_utc": now_utc(),
        "device_id": device_id(),
        "status": status,
        "summary": summary_map[status],
        "data": data,
        "artifacts": [],
        "errors": errors,
        # TypeScript ManageabilityEnvelope aliases
        "tool": tool_name,
        "timestamp": now_utc(),
    }
    print(json.dumps(envelope, indent=2))
