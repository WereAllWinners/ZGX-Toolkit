# Manageability Engine

The ZGX Toolkit Manageability Engine provides enterprise device lifecycle
management for HP ZGX / NVIDIA DGX Spark devices. It is built on the
[NVIDIA DGX Spark Manageability Guide](https://developer.nvidia.com/dgx-spark)
specification and uses the same SSH infrastructure already present in the
extension.

## Architecture

```
VS Code Extension (TypeScript)
  └── ManageabilityService
        └── SSH (existing ZGX Toolkit infrastructure)
              └── DGX_spark_management/bin/ (on-device Python scripts)
                    └── JSON stdout → parsed and displayed in VS Code
```

All data collection is **agentless** — no persistent software is installed
on target devices beyond the collector scripts in `DGX_spark_management/bin/`.

## Installing collector scripts on a device

Copy the scripts to the target device once:

```bash
scp -r DGX_spark_management/ USER@DEVICE_HOST:/usr/local/lib/
```

Scripts require Python 3.8+, standard Linux utilities (`ip`, `lsblk`,
`uname`, `ethtool`), and `sudo` access for `dmidecode` calls.

## Collector scripts

Collectors are read-only Python scripts (stdlib only). They run on the
device and emit a single JSON envelope on stdout. Safe to run frequently
and at high concurrency.

| Script | Purpose |
|---|---|
| `device_identity.py` | Serial, UUID, hostname, manufacturer |
| `hardware_config.py` | CPU, GPU, memory, storage, NIC |
| `firmware_reporter.py` | UEFI/BIOS, GPU VBIOS, NIC, SSD firmware |
| `os_build_identity.py` | OS version, kernel, DGX OS identity |
| `driver_inventory_reporter.py` | GPU, NIC, storage driver versions |
| `software_inventory_reporter.py` | dpkg, snap, pip (zgx env), Docker images |

### JSON envelope format

Every collector outputs:

```json
{
  "tool_name": "device_identity",
  "tool_version": "1.0.0",
  "timestamp_utc": "2026-06-27T12:00:00Z",
  "device_id": { "serial": "...", "uuid": "...", "hostname": "..." },
  "status": "ok",
  "summary": "Device identity collected successfully",
  "data": { ... },
  "artifacts": [],
  "errors": []
}
```

## Safety rules

- **Collectors** may be run automatically on a schedule.
- **Controllers** (scripts that modify device state) must NEVER run
  automatically. The extension always requires explicit user confirmation.
  This is enforced at the `ManageabilityService` layer — do not bypass it.

## Health monitoring

The extension polls device health on a configurable interval (default:
5 minutes) and shows status in the Device Manager:

- 🟢 **Healthy** — all signals nominal
- 🟡 **Warning** — one or more signals degraded
- 🔴 **Critical** — one or more signals failed

## Drift detection & Ansible policy

The **Check Ansible Policy Drift** command compares the current device
state against a stored baseline and flags deviations. Results appear in
the Device Info panel's Policy tab and can be exported as an Ansible
remediation playbook.

To establish a baseline, run **Collect Device Inventory** on a known-good
device. Subsequent drift checks compare against that snapshot.

## Configuration

Under **Settings → ZGX Toolkit**:

| Setting | Default | Description |
|---|---|---|
| `zgxToolkit.manageability.enabled` | `true` | Enable the manageability engine |
| `zgxToolkit.manageability.healthPollIntervalMinutes` | `5` | Health check interval |
| `zgxToolkit.manageability.collectorPath` | `/usr/local/lib/DGX_spark_management/bin` | Collector script path on device |
| `zgxToolkit.manageability.ansibleInventoryPath` | `""` | Ansible inventory file path |

## Troubleshooting

**Collectors not found** — Verify the collector path setting matches where
you copied the scripts. Run **Show Device Info** to see collector status.

**Health check timeouts** — Check SSH connectivity. Health checks use the
same SSH key as the rest of the extension.

**JSON parse errors** — The device may be running an older version of the
collector scripts. Re-copy `DGX_spark_management/bin/` to the device.
