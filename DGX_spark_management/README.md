# DGX_spark_management

On-device management scripts for Linux AI development and agentic devices.
Supports HP ZGX / NVIDIA DGX Spark (GB10), AMD Strix Halo, Intel, and generic
Linux hosts.

## Scripts

All scripts in `bin/` follow the ZGX Toolkit JSON envelope format and are
invoked via `zgx-collector` (see `resources/zgx-collector`). They are read-only
collectors — they do not modify device state.

| Script | zgx-collector subcommand | Purpose |
|--------|--------------------------|---------|
| `device_identity.py` | `device-identity` | Stable identity: hostname, manufacturer, serial, UUID, BIOS |
| `os_build_identity.py` | `os-build` | OS name/version, kernel version |
| `hardware_config.py` | `hardware-config` | CPU, GPU, memory, storage, NICs |
| `firmware_reporter.py` | `firmware` | BIOS, GPU VBIOS, NIC firmware, SSD firmware |
| `driver_inventory_reporter.py` | `drivers` | GPU driver, CUDA/ROCm version, NIC/storage drivers |
| `software_inventory_reporter.py` | `software` | Installed packages, snaps, pip packages, Docker images |
| `platform_profile_reporter.py` | `platform-profile` | Cross-platform capability profile: arch, CPU vendor, OS family, package manager, GPU vendor/stack/memory model, kernel flavor, held packages |
| `update_availability_reporter.py` | `update-availability` | Available package updates per detected package manager (apt/dnf/zypper); read-only, never applies anything |

## Installation

Copy the `bin/` directory to the target device:

```bash
scp -r DGX_spark_management/bin/ USER@DEVICE:/usr/local/lib/DGX_spark_management/
```

## Requirements

- Python 3.8+
- `sudo` access for `dmidecode` calls
- `nvidia-smi` for GPU data
- Standard Linux utilities: `ip`, `lsblk`, `uname`, `ethtool`, `nvme`

## Usage

```bash
python3 /usr/local/lib/DGX_spark_management/bin/device_identity.py
python3 /usr/local/lib/DGX_spark_management/bin/hardware_config.py
# etc.
```
