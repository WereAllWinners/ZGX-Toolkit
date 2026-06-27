# DGX_spark_management

On-device management scripts for HP ZGX / NVIDIA DGX Spark devices.

## Scripts

All scripts in `bin/` follow the NVIDIA DGX Spark Manageability Guide JSON
envelope format. They are read-only collectors — they do not modify device
state.

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
