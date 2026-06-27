#!/usr/bin/env python3
"""Collect software inventory: key dpkg packages, snap, pip (zgx env), Docker images."""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env

# Only packages with these name prefixes are included in key_packages.
# TODO: add --full flag to include all dpkg packages
_KEY_PREFIXES = ("cuda-", "nvidia-", "nccl-", "cudnn-", "tensorrt-")

_CONDA_BIN = "/opt/miniforge/bin/conda"


def _collect_dpkg():
    errors = []
    total_packages = 0
    key_packages = []

    dpkg_out = env._run("dpkg-query -W -f '${Package}\\t${Version}\\n' 2>/dev/null", timeout=30)
    if dpkg_out:
        for line in dpkg_out.splitlines():
            if not line.strip():
                continue
            total_packages += 1
            parts = line.split("\t", 1)
            name = parts[0] if parts else ""
            version = parts[1] if len(parts) > 1 else ""
            if any(name.startswith(p) for p in _KEY_PREFIXES):
                key_packages.append({"name": name, "version": version})
    else:
        errors.append({"code": "dpkg_unavailable", "message": "dpkg-query returned no output", "detail": ""})

    return {"total_packages": total_packages, "key_packages": key_packages}, errors


def _collect_snap():
    errors = []
    snaps = []

    snap_out = env._run("snap list --unicode=never 2>/dev/null")
    if snap_out:
        for line in snap_out.splitlines()[1:]:  # skip header
            parts = line.split()
            if len(parts) < 2:
                continue
            name = parts[0]
            version = parts[1]
            # channel is the 5th column (index 4) in snap list output
            channel = parts[4] if len(parts) > 4 else ""
            snaps.append({"name": name, "version": version, "channel": channel})

    return snaps, errors


def _collect_pip_zgx():
    errors = []
    packages = []

    conda_check = env._run(f"test -x {_CONDA_BIN} && echo yes 2>/dev/null")
    if conda_check != "yes":
        return packages, errors

    pip_out = env._run(f"{_CONDA_BIN} run -n zgx pip list --format json 2>/dev/null", timeout=30)
    if pip_out:
        try:
            raw = json.loads(pip_out)
            packages = [{"name": p.get("name", ""), "version": p.get("version", "")} for p in raw]
        except (json.JSONDecodeError, TypeError):
            errors.append({"code": "pip_parse_error", "message": "Failed to parse pip list JSON output", "detail": pip_out[:200]})

    return packages, errors


def _collect_docker_images():
    errors = []
    images = []

    # Docker 25+ supports --format json (one JSON object per line)
    docker_out = env._run("docker image ls --format json 2>/dev/null")
    if not docker_out:
        # Older Docker: Go template
        docker_out = env._run("docker image ls --format '{{json .}}' 2>/dev/null")

    if docker_out:
        for line in docker_out.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                img = json.loads(line)
                images.append({
                    "repository": img.get("Repository", ""),
                    "tag": img.get("Tag", ""),
                    "size": img.get("Size", ""),
                })
            except (json.JSONDecodeError, TypeError):
                pass

    return images, errors


def main():
    all_errors = []

    dpkg, dpkg_errors = _collect_dpkg()
    all_errors.extend(dpkg_errors)

    snaps, snap_errors = _collect_snap()
    all_errors.extend(snap_errors)

    pip_zgx, pip_errors = _collect_pip_zgx()
    all_errors.extend(pip_errors)

    docker_images, docker_errors = _collect_docker_images()
    all_errors.extend(docker_errors)

    data = {
        # TypeScript SoftwareInventory.packages = key dpkg packages
        "packages": dpkg["key_packages"],
        # task spec nested fields
        "dpkg": dpkg,
        "snap": snaps,
        "pip_zgx_env": pip_zgx,
        "docker_images": docker_images,
    }

    env.emit("software_inventory_reporter", data, all_errors)


if __name__ == "__main__":
    main()
