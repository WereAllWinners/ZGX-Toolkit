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

Scripts require Python 3.8+ and standard Linux utilities (`ip`, `lsblk`,
`uname`, `ethtool`). No `sudo` access is required — device and BIOS
identity are read directly from `/sys/class/dmi/id/`.

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

`resources/zgx-collector` (the live, actively-installed collector) emits the
same envelope shape as of v1.3.0.

## Safety rules

- **Collectors** may be run automatically on a schedule.
- **Controllers** (scripts that modify device state) must NEVER run
  automatically. The extension always requires explicit user confirmation.
  This is enforced at the `ManageabilityService` layer — do not bypass it.

## Applying updates & sudo configuration

Applying package or firmware updates, and installing the collector
system-wide, may require `sudo` on the target device. Two configurations
are supported:

- **Recommended: NOPASSWD sudoers scoped to the specific commands the
  extension runs.** With this configured, the extension never prompts for
  or transmits a password. Add a drop-in sudoers file on each managed
  device (via `visudo -f /etc/sudoers.d/zgx-toolkit`), scoped to only the
  package-manager commands actually used on that device:

  ```
  # /etc/sudoers.d/zgx-toolkit
  Cmnd_Alias ZGX_APT     = /usr/bin/apt-get full-upgrade -y *, \
                           /usr/bin/apt-get upgrade -y *, \
                           /usr/bin/apt-get install --only-upgrade -y *
  Cmnd_Alias ZGX_DNF     = /usr/bin/dnf upgrade -y *
  Cmnd_Alias ZGX_ZYPPER  = /usr/bin/zypper --non-interactive update *
  Cmnd_Alias ZGX_FWUPD   = /usr/bin/fwupdmgr update -y --no-reboot-check *
  Cmnd_Alias ZGX_COLLECTOR = /usr/bin/tee /usr/local/bin/zgx-collector, \
                             /usr/bin/chmod +x /usr/local/bin/zgx-collector

  your_ssh_user ALL=(root) NOPASSWD: ZGX_APT, ZGX_DNF, ZGX_ZYPPER, ZGX_FWUPD, ZGX_COLLECTOR
  ```

  This is a prerequisite for unattended/fleet update rollouts — an
  operator should not need to type a password per device.

- **Fallback: password prompt.** Without NOPASSWD, the extension prompts
  for the sudo password and sends it directly to the remote command's
  stdin, never as part of a shell command string. See `SECURITY.md` for
  the full handling and redaction guarantees.

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

### Pin schema

`zgxToolkit.manageability.ansibleInventoryPath` points at a YAML file
containing a top-level `pinned_packages` mapping of package name to pinned
version:

```yaml
pinned_packages:
  cuda-toolkit: "12.0.0"
  nvidia-driver: 550.54.15
```

Pinned packages are excluded from both scheduled-checkup candidates and
manual applies, regardless of what version the device reports as available.

The file is parsed as real YAML (flow-style maps, quoted/unquoted values,
and comments are all supported) — it is **not** a hand-rolled format, so
standard YAML syntax rules apply. Two failure modes are handled
differently:

- **No file configured, or the file doesn't exist** — treated as "no pins",
  silently. This is the normal state for a device with no Ansible policy.
- **The file exists but cannot be parsed** (invalid YAML syntax, or
  `pinned_packages` isn't a flat mapping of name → string/number) — **fails
  closed**: the checkup or apply for that device is blocked and a visible
  error is shown, rather than silently proceeding as if nothing were
  pinned. Fix the file and re-run the operation.

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
