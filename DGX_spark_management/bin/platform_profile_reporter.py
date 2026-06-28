#!/usr/bin/env python3
# Copyright © 2026 Jerome Gabryszewski
# Licensed under the X11 License. See LICENSE file in the project root for details.
"""
Detect and report the platform capability profile for this device.

Standalone dev/test mirror of cmd_platform_profile() in resources/zgx-collector.
Uses _envelope.py for JSON envelope emission. Stdlib-only. Read-only — never
changes device state.

Usage:
    python3 platform_profile_reporter.py | python3 -m json.tool
"""
import sys
import os
import shutil
import glob

sys.path.insert(0, os.path.dirname(__file__))
import _envelope as env


def _read_file(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return default


def _detect_gpu_vendor():
    """Returns 'nvidia', 'amd', 'intel', or 'none'."""
    if shutil.which("nvidia-smi"):
        out = env._run("nvidia-smi -L 2>/dev/null")
        if out:
            return "nvidia"
    if shutil.which("rocm-smi"):
        out = env._run("rocm-smi --version 2>/dev/null")
        if out:
            return "amd"
    for vp in glob.glob("/sys/class/drm/card*/device/vendor"):
        if _read_file(vp) == "0x1002":
            return "amd"
    # best-effort: not yet validated on Intel hardware
    for vp in glob.glob("/sys/class/drm/card*/device/vendor"):
        if _read_file(vp) == "0x8086":
            return "intel"
    return "none"


def main():
    errors = []

    # Manufacturer / product / HP
    manufacturer = _read_file("/sys/class/dmi/id/sys_vendor")
    product_name = _read_file("/sys/class/dmi/id/product_name")
    is_hp_device = manufacturer.lower().startswith(("hp", "hewlett"))

    # Architecture
    arch_raw = env._run("uname -m")
    arch = "arm64" if arch_raw == "aarch64" else (arch_raw or "unknown")

    # CPU vendor / model / cores
    cpu_vendor = "unknown"
    cpu_model = ""
    cpu_cores_logical = 0
    try:
        with open("/proc/cpuinfo") as f:
            cpuinfo = f.read()
        for line in cpuinfo.splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            key = key.strip().lower()
            val = val.strip()
            if key == "vendor_id":
                if val == "GenuineIntel":
                    cpu_vendor = "intel"
                elif val == "AuthenticAMD":
                    cpu_vendor = "amd"
            elif key == "cpu implementer" and cpu_vendor == "unknown":
                # 0x41 = ARM Ltd. — used by all ARM-licensed designs including
                # Grace GB10 Cortex cores. nvidia-grace resolved after GPU detection.
                cpu_vendor = "arm"
            elif key == "model name" and not cpu_model:
                cpu_model = val
        # ARM /proc/cpuinfo has no "model name"; fall back to lscpu
        if not cpu_model:
            import json as _json
            lscpu_raw = env._run("lscpu --json 2>/dev/null")
            if lscpu_raw:
                try:
                    lscpu_data = _json.loads(lscpu_raw)
                    models = [e["data"] for e in lscpu_data.get("lscpu", [])
                              if e.get("field", "").startswith("Model name")]
                    seen = []
                    for m in models:
                        if m not in seen:
                            seen.append(m)
                    cpu_model = " / ".join(seen)
                except Exception:
                    pass
        cpu_cores_logical = sum(1 for l in cpuinfo.splitlines()
                                if l.startswith("processor") and ":" in l)
        if cpu_cores_logical == 0:
            nproc = env._run("nproc")
            try:
                cpu_cores_logical = int(nproc)
            except Exception:
                cpu_cores_logical = 0
    except Exception as e:
        errors.append({"code": "cpu_detection_failed", "message": str(e), "detail": ""})

    # OS
    os_id = os_id_like = os_version_id = os_pretty_name = ""
    try:
        with open("/etc/os-release") as f:
            for line in f:
                k, _, v = line.strip().partition("=")
                v = v.strip('"')
                if k == "ID":            os_id = v
                elif k == "ID_LIKE":     os_id_like = v
                elif k == "VERSION_ID":  os_version_id = v
                elif k == "PRETTY_NAME": os_pretty_name = v
    except Exception as e:
        errors.append({"code": "os_release_failed", "message": str(e), "detail": ""})

    combined = (os_id + " " + os_id_like).lower()
    if any(x in combined for x in ("debian", "ubuntu")):
        os_family = "debian"
    elif any(x in combined for x in ("rhel", "fedora", "centos")):
        os_family = "rhel"
    elif any(x in combined for x in ("suse", "opensuse")):
        os_family = "suse"
    else:
        os_family = "unknown"

    # DGX OS
    is_dgx_os = os.path.exists("/etc/dgx-release")
    dgx_release = ""
    if is_dgx_os:
        try:
            with open("/etc/dgx-release") as f:
                for line in f:
                    k, _, v = line.strip().partition("=")
                    if k.strip() in ("DGX_SWBUILD_VERSION", "DGX_OS_VERSION"):
                        dgx_release = v.strip().strip('"')
                        break
        except Exception:
            pass

    # Package manager
    if shutil.which("apt-get"):
        package_manager = "apt"
    elif shutil.which("dnf"):
        package_manager = "dnf"
    elif shutil.which("zypper"):
        package_manager = "zypper"
    else:
        package_manager = ""

    # Kernel
    kernel_release = env._run("uname -r")
    kernel_flavor = kernel_release.rsplit("-", 1)[-1] if "-" in kernel_release else ""

    # GPU vendor
    gpu_vendor = _detect_gpu_vendor()

    # GPU compute stack / version
    gpu_compute_stack = "none"
    gpu_compute_stack_version = ""
    if gpu_vendor == "nvidia":
        gpu_compute_stack = "cuda"
        smi_out = env._run("nvidia-smi 2>/dev/null", timeout=10)
        for line in smi_out.splitlines():
            if "CUDA Version" in line:
                try:
                    gpu_compute_stack_version = line.split("CUDA Version:")[-1].strip().split()[0]
                except Exception:
                    pass
                break
        if not gpu_compute_stack_version:
            ver_txt = _read_file("/usr/local/cuda/version.txt")
            if ver_txt:
                gpu_compute_stack_version = ver_txt.split()[-1]
    elif gpu_vendor == "amd":
        if shutil.which("rocm-smi"):
            gpu_compute_stack = "rocm"
            ver = _read_file("/opt/rocm/.info/version").strip()
            if ver:
                gpu_compute_stack_version = ver.split()[0]
    elif gpu_vendor == "intel":  # best-effort: not yet validated on Intel hardware
        if shutil.which("sycl-ls") or os.path.isdir("/opt/intel/oneapi"):
            gpu_compute_stack = "oneapi"

    # GPU memory model
    gpu_memory_model = "none"
    if gpu_vendor == "nvidia":
        try:
            drv_mem = env._run(
                "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null"
            )
            vals = [v.strip() for v in drv_mem.splitlines() if v.strip()]
            if any(v in ("[N/A]", "N/A", "") for v in vals):
                gpu_memory_model = "unified"
            elif vals:
                gpu_memory_model = "discrete"
        except Exception:
            gpu_memory_model = "discrete"
    elif gpu_vendor == "amd":  # best-effort: not yet validated on AMD hardware
        try:
            # Check sysfs VRAM for unified memory (APU/Strix Halo)
            cards = sorted([
                e for e in os.listdir("/sys/class/drm")
                if e.startswith("card") and "-" not in e and
                   _read_file(f"/sys/class/drm/{e}/device/vendor") == "0x1002"
            ]) if os.path.isdir("/sys/class/drm") else []
            vram_values = []
            for card in cards:
                raw = _read_file(f"/sys/class/drm/{card}/device/mem_info_vram_total")
                if raw.isdigit():
                    vram_values.append(int(raw))
            if vram_values:
                # APU / Strix Halo: VRAM ≈ system RAM (within 15%)
                try:
                    with open("/proc/meminfo") as f:
                        for line in f:
                            if line.startswith("MemTotal:"):
                                sys_bytes = int(line.split()[1]) * 1024
                                if any(abs(v - sys_bytes) / sys_bytes < 0.15
                                       for v in vram_values):
                                    gpu_memory_model = "unified"
                                else:
                                    gpu_memory_model = "discrete"
                                break
                except Exception:
                    gpu_memory_model = "discrete"
            else:
                gpu_memory_model = "integrated"
        except Exception:
            gpu_memory_model = "integrated"
    elif gpu_vendor == "intel":  # best-effort: not yet validated on Intel hardware
        gpu_memory_model = "integrated"

    # GPU driver branch
    gpu_driver_branch = ""
    if gpu_vendor == "nvidia":
        drv = env._run(
            "nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null"
        )
        if drv.strip():
            try:
                gpu_driver_branch = drv.strip().split(".")[0]
            except Exception:
                pass
    elif gpu_vendor == "amd":
        amdgpu_ver = env._run("modinfo amdgpu -F version 2>/dev/null")
        if amdgpu_ver.strip():
            gpu_driver_branch = amdgpu_ver.strip().split()[0]

    # Held packages
    held_packages = []
    try:
        if package_manager == "apt":
            held_out = env._run("apt-mark showhold 2>/dev/null")
            held_packages = [p for p in held_out.splitlines() if p.strip()]
        elif package_manager == "dnf":
            held_out = env._run("dnf versionlock list 2>/dev/null")
            for line in held_out.splitlines():
                line = line.strip()
                if not line or line.startswith(("#", "Last metadata")):
                    continue
                parts = line.split()
                if parts:
                    held_packages.append(parts[0])
        elif package_manager == "zypper":
            held_out = env._run("zypper locks 2>/dev/null")
            for line in held_out.splitlines():
                parts = [p.strip() for p in line.split("|")]
                if len(parts) >= 4 and parts[0].isdigit() and parts[3]:
                    held_packages.append(parts[3])
    except Exception as e:
        errors.append({"code": "held_packages_failed", "message": str(e), "detail": ""})

    # Held kernel packages
    kernel_prefixes = ("linux-image", "linux-headers", "kernel-", "kernel-default")
    held_kernel_packages = [p for p in held_packages
                             if any(p.startswith(pfx) for pfx in kernel_prefixes)]

    # nvidia-grace: arm64 + NVIDIA GPU = Grace-family SoC.
    # Grace uses ARM-licensed cores (X925/A725 on GB10, Neoverse V2 on DGX GH,
    # A78AE on Jetson Orin) — all report implementer 0x41 (ARM Ltd.), so the
    # implementer alone can't distinguish Grace from other ARM SoCs.
    if arch == "arm64" and gpu_vendor == "nvidia":
        cpu_vendor = "nvidia-grace"

    # Vendor controller
    vendor_controller_spark_updatectl = bool(
        shutil.which("spark_updatectl.py") or
        os.path.exists("/usr/local/lib/DGX_spark_management/bin/spark_updatectl.py")
    )

    data = {
        "manufacturer":                      manufacturer,
        "product_name":                      product_name,
        "is_hp_device":                      is_hp_device,
        "arch":                              arch,
        "cpu_vendor":                        cpu_vendor,
        "cpu_model":                         cpu_model,
        "cpu_cores_logical":                 cpu_cores_logical,
        "os_id":                             os_id,
        "os_id_like":                        os_id_like,
        "os_family":                         os_family,
        "os_version_id":                     os_version_id,
        "os_pretty_name":                    os_pretty_name,
        "is_dgx_os":                         is_dgx_os,
        "dgx_release":                       dgx_release,
        "package_manager":                   package_manager,
        "kernel_release":                    kernel_release,
        "kernel_flavor":                     kernel_flavor,
        "gpu_vendor":                        gpu_vendor,
        "gpu_compute_stack":                 gpu_compute_stack,
        "gpu_compute_stack_version":         gpu_compute_stack_version,
        "gpu_memory_model":                  gpu_memory_model,
        "gpu_driver_branch":                 gpu_driver_branch,
        "held_packages":                     held_packages,
        "held_kernel_packages":              held_kernel_packages,
        "vendor_controller_spark_updatectl": vendor_controller_spark_updatectl,
    }
    env.emit("platform_profile", data, errors)


if __name__ == "__main__":
    main()
