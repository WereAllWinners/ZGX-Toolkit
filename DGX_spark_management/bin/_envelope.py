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


def device_id():
    """Return the device_id block used by all collectors."""
    serial = _run("sudo dmidecode -s system-serial-number 2>/dev/null || true")
    uuid = _run("sudo dmidecode -s system-uuid 2>/dev/null || true")
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
