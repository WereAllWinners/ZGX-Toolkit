#!/usr/bin/env python3
"""Collect hardware configuration: CPU, GPU, memory, storage, network interfaces."""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env


def _collect_cpu():
    errors = []
    arch = env._run("uname -m") or "unknown"
    cpuinfo = env._run("cat /proc/cpuinfo 2>/dev/null")

    model_names = []
    logical_cores = 0

    if cpuinfo:
        for line in cpuinfo.splitlines():
            low = line.lower()
            if low.startswith("processor"):
                logical_cores += 1
            elif low.startswith("model name"):
                parts = line.split(":", 1)
                if len(parts) > 1:
                    name = parts[1].strip()
                    if name and name not in model_names:
                        model_names.append(name)

    if not model_names:
        # ARM systems often omit "model name" — try lscpu
        lscpu_model = env._run("lscpu 2>/dev/null | grep 'Model name'")
        if lscpu_model:
            parts = lscpu_model.split(":", 1)
            if len(parts) > 1:
                model_names = [parts[1].strip()]
        if not model_names:
            model_names = [""]
            errors.append({"code": "cpu_model_unknown", "message": "CPU model name not found", "detail": ""})

    if logical_cores == 0:
        nproc = env._run("nproc 2>/dev/null")
        try:
            logical_cores = int(nproc)
        except (ValueError, TypeError):
            logical_cores = 1

    threads_per_core = 1
    tpc_line = env._run("lscpu 2>/dev/null | grep 'Thread(s) per core'")
    if tpc_line:
        try:
            threads_per_core = int(tpc_line.split(":", 1)[1].strip())
        except (ValueError, IndexError):
            pass

    physical_cores = (logical_cores // threads_per_core) if threads_per_core > 0 else logical_cores

    cpu = {
        "architecture": arch,
        "model_names": model_names,       # TypeScript CpuInfo field (list)
        "model": model_names[0] if model_names else "",  # task spec alias
        "cores": logical_cores,            # TypeScript CpuInfo field
        "cores_physical": physical_cores,  # task spec field
        "cores_logical": logical_cores,    # task spec field
        "threads_per_core": threads_per_core,
    }
    return cpu, errors


def _collect_gpus():
    errors = []
    gpus = []
    gpu_vendor = "none"

    nvidia_out = env._run(
        "nvidia-smi --query-gpu=index,name,memory.total,memory.used,"
        "driver_version,pci.bus_id,temperature.gpu,power.draw "
        "--format=csv,noheader,nounits 2>/dev/null"
    )
    if nvidia_out:
        gpu_vendor = "nvidia"
        for i, line in enumerate(nvidia_out.splitlines()):
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split(",")]
            try:
                index = int(parts[0]) if parts else i
                name = parts[1] if len(parts) > 1 else ""
                def _float_or_none(s):
                    try:
                        return float(s) if s and s not in ("[N/A]", "N/A", "") else None
                    except ValueError:
                        return None
                mem_total_raw = parts[2] if len(parts) > 2 else ""
                mem_used_raw  = parts[3] if len(parts) > 3 else ""
                mem_total = _float_or_none(mem_total_raw)
                mem_used  = _float_or_none(mem_used_raw)
                driver_ver = parts[4] if len(parts) > 4 else ""
                pci_id     = parts[5] if len(parts) > 5 else ""
                temp_c     = _float_or_none(parts[6] if len(parts) > 6 else "")
                power_w    = _float_or_none(parts[7] if len(parts) > 7 else "")
                # GB10/unified-memory GPUs report [N/A] for dedicated VRAM fields
                is_unified = mem_total_raw.strip() in ("[N/A]", "N/A", "")
                gpus.append({
                    # TypeScript GpuInfo fields
                    "index": index,
                    "name": name,
                    "vendor": "nvidia",
                    "temp_c": temp_c,
                    "power_w": power_w,
                    "memory_total_mb": int(mem_total) if mem_total is not None else None,
                    "memory_used_mb": int(mem_used) if mem_used is not None else None,
                    "unified_memory": is_unified,
                    # task spec extras
                    "vram_mb": int(mem_total) if mem_total is not None else None,
                    "driver_version": driver_ver,
                    "pci_id": pci_id,
                })
            except Exception:
                errors.append({"code": "gpu_parse_error", "message": "Failed to parse nvidia-smi line", "detail": line})
    else:
        errors.append({"code": "nvidia_smi_unavailable", "message": "nvidia-smi not found or returned no output", "detail": ""})

    return gpu_vendor, gpus, errors


def _collect_memory():
    errors = []
    total_kb = 0
    avail_kb = 0

    meminfo = env._run("cat /proc/meminfo 2>/dev/null")
    if meminfo:
        for line in meminfo.splitlines():
            if line.startswith("MemTotal:"):
                try:
                    total_kb = int(line.split()[1])
                except (ValueError, IndexError):
                    pass
            elif line.startswith("MemAvailable:"):
                try:
                    avail_kb = int(line.split()[1])
                except (ValueError, IndexError):
                    pass
    if total_kb == 0:
        errors.append({"code": "memory_info_missing", "message": "Could not read MemTotal from /proc/meminfo", "detail": ""})

    return {
        "total_mb": total_kb // 1024,
        "available_mb": avail_kb // 1024,
        "total_bytes": total_kb * 1024,
    }, errors


def _collect_storage():
    errors = []
    devices = []

    raw = env._run("lsblk -d -o NAME,MODEL,SIZE,ROTA --json 2>/dev/null")
    if raw:
        try:
            parsed = json.loads(raw)
            for bd in parsed.get("blockdevices", []):
                name = bd.get("name", "")
                model = (bd.get("model") or "").strip()
                size_str = bd.get("size", "") or ""
                rota = bd.get("rota", True)
                if isinstance(rota, str):
                    rota = rota == "1"
                dev_type = "HDD" if rota else ("NVMe" if "nvme" in name.lower() else "SSD")
                devices.append({"device": f"/dev/{name}", "model": model, "size": size_str, "type": dev_type})
        except (json.JSONDecodeError, KeyError, TypeError):
            errors.append({"code": "lsblk_json_parse_error", "message": "Failed to parse lsblk JSON output", "detail": ""})

    if not devices:
        # Plain text fallback
        plain = env._run("lsblk -d -o NAME,MODEL,SIZE,ROTA 2>/dev/null")
        if plain:
            for line in plain.splitlines()[1:]:
                parts = line.split()
                if not parts:
                    continue
                name = parts[0]
                model = parts[1] if len(parts) > 1 else ""
                size_str = parts[2] if len(parts) > 2 else ""
                rota = (parts[3] == "1") if len(parts) > 3 else True
                dev_type = "HDD" if rota else ("NVMe" if "nvme" in name.lower() else "SSD")
                devices.append({"device": f"/dev/{name}", "model": model.strip(), "size": size_str, "type": dev_type})
        else:
            errors.append({"code": "storage_info_missing", "message": "lsblk returned no output", "detail": ""})

    return devices, errors


def _collect_nics():
    errors = []
    nics = []

    raw = env._run("ip -j link show 2>/dev/null")
    if raw:
        try:
            links = json.loads(raw)
            for link in links:
                iface = link.get("ifname", "")
                if iface == "lo" or "@" in iface:
                    continue
                mac = link.get("address", "")
                if not mac or mac == "00:00:00:00:00:00":
                    continue
                speed_mbps = 0
                speed_raw = env._run(f"cat /sys/class/net/{iface}/speed 2>/dev/null")
                try:
                    speed_mbps = int(speed_raw) if speed_raw else 0
                except ValueError:
                    speed_mbps = 0
                nics.append({
                    # TypeScript NicInfo fields
                    "name": iface,
                    "mac": mac,
                    # task spec extras
                    "interface": iface,
                    "speed_mbps": speed_mbps,
                })
        except (json.JSONDecodeError, TypeError, KeyError):
            errors.append({"code": "nic_parse_error", "message": "Failed to parse ip -j link show output", "detail": ""})
    else:
        errors.append({"code": "ip_cmd_unavailable", "message": "ip command returned no output", "detail": ""})

    return nics, errors


def main():
    all_errors = []

    cpu, cpu_errors = _collect_cpu()
    all_errors.extend(cpu_errors)

    gpu_vendor, gpus, gpu_errors = _collect_gpus()
    all_errors.extend(gpu_errors)

    memory, mem_errors = _collect_memory()
    all_errors.extend(mem_errors)

    storage, stor_errors = _collect_storage()
    all_errors.extend(stor_errors)

    nics, nic_errors = _collect_nics()
    all_errors.extend(nic_errors)

    data = {
        # TypeScript HardwareConfig fields
        "cpu": cpu,
        "gpu_vendor": gpu_vendor,
        "gpus": gpus,
        "total_memory_bytes": memory["total_bytes"],
        "storage": storage,
        "nics": nics,
        # task spec aliases
        "gpu": gpus,
        "memory": {"total_mb": memory["total_mb"], "available_mb": memory["available_mb"]},
        "network": nics,
    }

    env.emit("hardware_config", data, all_errors)


if __name__ == "__main__":
    main()
