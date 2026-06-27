#!/usr/bin/env python3
"""Collect driver inventory: GPU driver, CUDA, NIC drivers, storage drivers."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env


def _collect_gpu_driver():
    errors = []
    driver_version = ""
    kernel_module = ""

    ver_out = env._run(
        "nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits 2>/dev/null"
    )
    if ver_out:
        driver_version = ver_out.splitlines()[0].strip()
    else:
        errors.append({"code": "nvidia_smi_unavailable", "message": "nvidia-smi not found or returned no output", "detail": ""})

    lsmod_out = env._run("lsmod 2>/dev/null | grep '^nvidia'")
    if lsmod_out:
        kernel_module = lsmod_out.splitlines()[0].split()[0].strip()

    return driver_version, kernel_module, errors


def _collect_cuda_version():
    # Try nvidia-smi header line first
    header = env._run("nvidia-smi 2>/dev/null | head -4")
    if header:
        for line in header.splitlines():
            if "CUDA Version:" in line:
                try:
                    after = line.split("CUDA Version:")[1].strip()
                    return after.split()[0].rstrip(")")
                except (IndexError, ValueError):
                    pass

    # Fall back to /usr/local/cuda/version.txt
    version_file = env._run("cat /usr/local/cuda/version.txt 2>/dev/null")
    if version_file:
        parts = version_file.strip().split()
        if len(parts) >= 3:
            return parts[2]

    return ""


def _collect_nic_drivers():
    errors = []
    nic_drivers = []

    ifaces_out = env._run("ip link show 2>/dev/null | grep '^[0-9]' | awk '{print $2}' | tr -d ':'")
    ifaces = [i for i in (ifaces_out or "").splitlines() if i and i != "lo" and "@" not in i]

    for iface in ifaces:
        ethtool_out = env._run(f"ethtool -i {iface} 2>/dev/null")
        if not ethtool_out:
            continue
        driver_name = ""
        driver_ver = ""
        for line in ethtool_out.splitlines():
            if line.startswith("driver:"):
                driver_name = line.split(":", 1)[1].strip()
            elif line.startswith("version:"):
                driver_ver = line.split(":", 1)[1].strip()
        if driver_name:
            nic_drivers.append({"interface": iface, "driver": driver_name, "version": driver_ver})

    return nic_drivers, errors


def _collect_storage_drivers():
    errors = []
    storage_drivers = []

    lsblk_out = env._run("lsblk -d -o NAME --noheadings 2>/dev/null")
    if not lsblk_out:
        return storage_drivers, errors

    seen_drivers = set()
    for dev in lsblk_out.splitlines():
        dev = dev.strip()
        if not dev:
            continue
        driver_link = env._run(f"readlink /sys/block/{dev}/device/driver 2>/dev/null")
        driver_name = os.path.basename(driver_link) if driver_link else ""
        if not driver_name:
            # NVMe devices may use a different sysfs path
            driver_link2 = env._run(f"readlink -f /sys/block/{dev}/device/driver 2>/dev/null")
            driver_name = os.path.basename(driver_link2) if driver_link2 else ""
        if not driver_name:
            continue
        driver_ver = ""
        if driver_name not in seen_drivers:
            modinfo_out = env._run(f"modinfo {driver_name} 2>/dev/null | grep '^version'")
            if modinfo_out:
                try:
                    driver_ver = modinfo_out.split(":", 1)[1].strip()
                except IndexError:
                    pass
            seen_drivers.add(driver_name)
        storage_drivers.append({"device": dev, "driver": driver_name, "version": driver_ver})

    return storage_drivers, errors


def main():
    all_errors = []

    gpu_driver_version, kernel_module, gpu_errors = _collect_gpu_driver()
    all_errors.extend(gpu_errors)

    cuda_version = _collect_cuda_version()

    nic_drivers, nic_errors = _collect_nic_drivers()
    all_errors.extend(nic_errors)

    storage_drivers, stor_errors = _collect_storage_drivers()
    all_errors.extend(stor_errors)

    # Build TypeScript DriverInventory.packages from collected driver info
    packages = []
    if gpu_driver_version:
        packages.append({"name": "nvidia-driver", "version": gpu_driver_version})
    if cuda_version:
        packages.append({"name": "cuda", "version": cuda_version})
    for d in nic_drivers:
        if d.get("version"):
            packages.append({"name": d["driver"], "version": d["version"]})
    for d in storage_drivers:
        name = d.get("driver", "")
        ver = d.get("version", "")
        if ver and not any(p["name"] == name for p in packages):
            packages.append({"name": name, "version": ver})

    data = {
        # TypeScript DriverInventory fields
        "gpu_driver_version": gpu_driver_version,
        "cuda_version": cuda_version,
        "packages": packages,
        # task spec nested fields
        "gpu_driver": {"version": gpu_driver_version, "kernel_module": kernel_module},
        "nic_drivers": nic_drivers,
        "storage_drivers": storage_drivers,
    }

    env.emit("driver_inventory_reporter", data, all_errors)


if __name__ == "__main__":
    main()
