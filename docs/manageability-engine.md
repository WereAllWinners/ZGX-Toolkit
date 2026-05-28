# ZGX Toolkit — Manageability Engine

Technical reference for the NVIDIA DGX Spark Manageability Engine built into the ZGX Toolkit VS Code extension. Covers architecture, every component, data flow, and Ansible group policy.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [The Collector — `zgx-collector`](#the-collector--zgx-collector)
4. [ManageabilityService](#manageabilityservice)
5. [Device Info View](#device-info-view)
6. [Admin Dashboard Integration](#admin-dashboard-integration)
7. [Ansible Group Policy](#ansible-group-policy)
8. [VS Code Commands](#vs-code-commands)
9. [Data Flow: End to End](#data-flow-end-to-end)
10. [Deployment & Updates](#deployment--updates)
11. [Key Design Decisions & Gotchas](#key-design-decisions--gotchas)

---

## Overview

The Manageability Engine surfaces NVIDIA DGX Spark device lifecycle management directly from VS Code. It answers four questions without leaving the editor:

- **What is running on this device?** (inventory: OS, hardware, firmware, drivers)
- **Is the device healthy?** (GPU temps, power, signal status)
- **Are there updates available?** (apt packages + fwupdmgr firmware)
- **Is the fleet in a consistent state?** (Ansible group policy enforcement)

All data collection happens over the existing SSH trust established during device setup — no additional credentials, no agents, no daemons.

---

## Architecture

```
VS Code Extension Host
│
├── src/commands/manageabilityCommands.ts   ← Command Palette entry points
├── src/services/manageabilityService.ts    ← SSH bridge + snapshot persistence
├── src/services/ansibleService.ts          ← Ansible inventory/playbook runner
├── src/types/manageability.ts              ← TypeScript interfaces for all JSON shapes
├── src/types/userGroup.ts                  ← GroupPolicy interface
│
├── src/views/admin/
│   ├── adminDashboard{.html,.css,.js}      ← Fleet overview with health cards
│   └── adminDashboardViewController.ts     ← Message handlers for all dashboard actions
│
└── src/views/devices/info/
    ├── deviceInfo{.html,.css,.js}          ← Per-device detail panel
    └── deviceInfoViewController.ts         ← Renders ManageabilitySnapshot sections
                │
                │  SSH (ssh2)
                ▼
Managed Device (/usr/local/bin/zgx-collector)
    ├── device-identity   → /sys/class/dmi/id, dmidecode
    ├── os-build          → /etc/os-release, uname
    ├── hardware-config   → nvidia-smi, /sys, lscpu
    ├── firmware          → dmidecode, nvidia-smi
    ├── drivers           → nvidia-smi, dpkg-query, modinfo amdgpu
    ├── software          → dpkg-query
    ├── health            → nvidia-smi, rocm-smi, sensors
    └── updates           → apt-get --simulate, fwupdmgr get-updates
```

The extension never persists a long-lived connection. Every collector invocation opens a fresh SSH session, runs the command, and closes.

---

## The Collector — `zgx-collector`

**File:** `resources/zgx-collector`
**Installed on device at:** `/usr/local/bin/zgx-collector` (or `~/.local/bin/zgx-collector` as fallback)
**Language:** Python 3, zero third-party dependencies

### Subcommands

| Subcommand | What it collects | Key data sources |
|---|---|---|
| `device-identity` | Product name, manufacturer, hostname, board name, BIOS version | `/sys/class/dmi/id/*`, `dmidecode` |
| `os-build` | OS name/version, kernel, architecture | `/etc/os-release`, `uname -r` |
| `hardware-config` | GPU list (name, VRAM, temp, power), CPU model, total RAM, NICs | `nvidia-smi`, `/sys/class/drm`, `lscpu`, `/proc/meminfo` |
| `firmware` | BIOS version/date, GPU VBIOS version, GPU driver version | `dmidecode`, `nvidia-smi` |
| `drivers` | GPU driver version, all NVIDIA/CUDA/AMD dpkg packages | `nvidia-smi`, `modinfo amdgpu`, `dpkg-query` |
| `software` | Count of installed packages | `dpkg-query` |
| `health` | Overall status, per-GPU temp/power/memory signals | `nvidia-smi`, `rocm-smi`, `sensors` |
| `updates` | Pending apt packages, pending firmware updates | `apt-get --simulate upgrade`, `fwupdmgr get-updates --json` |

### Output Format

Every subcommand prints a single JSON line to stdout:

```json
{
  "tool": "hardware-config",
  "timestamp": "2025-05-28T14:32:00.000000+00:00",
  "status": "ok",
  "version": "1.1.1",
  "data": { ... }
}
```

`status` is always `"ok"` or `"error"`. The extension treats anything other than `"ok"` as a partial result and still displays whatever fields are present.

### Multi-Vendor GPU Support

The collector probes **both** NVIDIA and AMD paths on every run, regardless of what `detect_gpu_vendor()` returns. This tolerates mixed-vendor systems and edge cases where the vendor detection logic can't find the management tool:

- **NVIDIA:** `nvidia-smi --query-gpu=...` for live data, `dpkg-query` for package list
- **AMD:** `rocm-smi`, `/sys/class/drm` sysfs, `modinfo amdgpu` for kernel module version

### PATH Extension

Non-interactive SSH sessions receive a stripped `PATH` that often omits `/usr/local/cuda/bin`, `/opt/rocm/bin`, and sometimes even `/usr/local/bin`. The collector fixes this at startup:

```python
for _p in ('/usr/local/cuda/bin', '/usr/local/bin', '/usr/local/sbin',
           '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/opt/rocm/bin'):
    if _p not in os.environ.get('PATH', ''):
        os.environ['PATH'] = _p + ':' + os.environ.get('PATH', '')
```

The `ManageabilityService` applies the same fix on the SSH command line itself as a belt-and-suspenders measure.

### Installation

The service installs the collector by base64-encoding the local `resources/zgx-collector` file and piping it over SSH — no SCP, no file transfer protocol:

```bash
echo '<base64>' | base64 -d | sudo tee /usr/local/bin/zgx-collector > /dev/null
sudo chmod +x /usr/local/bin/zgx-collector
```

If `sudo` requires a password, the extension falls back to a user-local install at `~/.local/bin/zgx-collector` (no sudo needed). The service updates `device.metadata.collectorInstalled = true` on success so future dashboard renders skip the SSH existence check.

---

## ManageabilityService

**File:** `src/services/manageabilityService.ts`
**Singleton export:** `manageabilityService`
**SSH library:** `ssh2` via `executeSSHCommand()` from `src/utils/sshConnection.ts`

### `runTool<T>(device, toolKey, options?)`

The core SSH bridge. Builds the command, executes it, and parses the JSON envelope:

```typescript
const command = `PATH=/usr/local/bin:$HOME/.local/bin:$PATH zgx-collector ${subcommand}`;
const result = await executeSSHCommand(device, command, connOpts, { timeoutSeconds: 30 });
const envelope = JSON.parse(result.stdout) as ManageabilityEnvelope<T>;
```

SSH errors and JSON parse errors are handled separately — a parse failure doesn't look like an SSH failure in the logs.

**Timeouts:**
- Collectors (identity, OS, hardware, firmware, drivers, software, health): **30 seconds**
- Diagnostic bundle: **120 seconds**
- Update application (apt-get upgrade): **300 seconds**

**SSH ready-timeout:** 5 seconds. Devices that are powered off or unreachable time out quickly so the dashboard doesn't stall.

### `collectInventory(device)`

Runs all 7 collector subcommands in parallel using `Promise.allSettled`. A single tool failure does not abort the rest. The assembled `ManageabilitySnapshot` is persisted to `device.metadata.manageabilitySnapshot` via `deviceService.updateDevice()`.

```typescript
const [identity, osBuild, hardware, firmware, drivers, software, health] =
    await Promise.allSettled([...7 runTool calls...]);

const snapshot: ManageabilitySnapshot = {
    collectedAt: new Date().toISOString(),
    identity:  identity.status === 'fulfilled' && identity.value.success ? identity.value.envelope : undefined,
    // ... same pattern for each field
};
await deviceService.updateDevice(device.id, { metadata: { ...device.metadata, manageabilitySnapshot: snapshot } });
```

### `applyUpdates(device, sudoPassword?)`

The only mutating operation. Protected by several layers:

1. **Never called automatically** — only invoked after an explicit user confirmation dialog
2. Tries `apt-get full-upgrade` first, then falls back to `apt-get upgrade` if sudoers blocks the first variant
3. Uses `sudo -n` (non-interactive) by default; accepts a password via `sudo -S` if provided
4. Chains `fwupdmgr update` after apt succeeds (best-effort, fwupd exit code 2 = nothing to update is treated as success)

### `installCollector(device, sudoPassword?)`

Reads `resources/zgx-collector`, base64-encodes it, and delivers it over SSH. Tries system-wide (`/usr/local/bin`) first, falls back to user-local (`~/.local/bin`). Either path sets `device.metadata.collectorInstalled = true` so future renders skip the SSH check.

---

## Device Info View

**Files:** `src/views/devices/info/`

A per-device panel opened from the Admin Dashboard ("View Details" button) or the Command Palette. Displays the cached `ManageabilitySnapshot` in sections.

### Sections

| Section | Source field | What's shown |
|---|---|---|
| Identity | `snapshot.identity.data` | Product name, manufacturer, hostname, board name, BIOS version |
| OS Build | `snapshot.osBuild.data` | OS version, kernel, architecture |
| Hardware | `snapshot.hardware.data` | GPU name + VRAM, CPU model, total memory |
| Firmware | `snapshot.firmware.data` | UEFI version, GPU VBIOS version, GPU driver version, BIOS date |
| Drivers | `snapshot.drivers.data` | GPU driver version, list of NVIDIA/CUDA/AMD dpkg packages (up to 20) |
| Health | `snapshot.health.data` | Overall status badge, per-signal rows with value + unit |

If `snapshot` is null (device has never had inventory collected), the panel shows an empty state with a "Run Inventory" button.

### View Controller (`deviceInfoViewController.ts`)

`render(params, nonce)` reads `device.metadata.manageabilitySnapshot` from the in-memory device store — **no SSH on render**. The `buildTemplateData()` method normalizes the raw collector JSON into the flat key/value shapes the Handlebars template expects.

`handleMessage` handles:
- `goBack` → navigates to `admin/dashboard` in the editor panel
- `runInventory` → calls `manageabilityService.collectInventory(device)`, sends `inventoryComplete` to the webview in the `finally` block, then calls `this.refresh()` to re-render with new data

The Refresh button embeds the device ID in `data-device-id` on the container div and reads it in `deviceInfo.js` — this ensures the button works even if the view is re-rendered between clicks.

---

## Admin Dashboard Integration

**Files:** `src/views/admin/`

The main fleet overview. Each device card shows:
- Health badge (healthy / degraded / critical / unknown / no data)
- GPU summary (name, temperature, power draw)
- CPU and memory totals
- Snapshot age ("collected 5m ago")
- Per-device action buttons: **View Details**, **Run Inventory**, **Check Updates**

### Health-Derived from Cache

The dashboard render makes **zero SSH connections**. Health status, GPU metrics, and collector presence are all derived from `device.metadata.manageabilitySnapshot` and `device.metadata.collectorInstalled`. This means the back button from Device Info is instant — no SSH round-trips waiting.

### Device Card Actions

| Button | Message type | Handler |
|---|---|---|
| View Details | `viewDetails` | Opens `devices/info` in editor panel |
| Run Inventory | `runInventory` | `handleRunInventory` — progress notification, `collectInventory`, refresh |
| Check Updates | `checkUpdates` | `handleCheckUpdates` — reads update posture, shows Output Channel |
| Apply Updates | `applyUpdates` | `handleApplyUpdates` — confirmation dialog required, then `applyUpdates()` |
| Refresh All | `refreshAll` | Re-renders entire dashboard from cache (no SSH) |

---

## Ansible Group Policy

Groups can carry a `GroupPolicy` that enforces a consistent package state across all devices in the group.

### GroupPolicy Type

```typescript
interface GroupPolicy {
    pinnedPackages?: string[];    // e.g. ["cuda-toolkit=12.3.2-1"]
    requiredPackages?: string[];  // e.g. ["htop", "tmux"]
    customPlaybookPath?: string;  // absolute path to a .yml file on the local machine
}
```

Set via the group form in the Admin Dashboard — expand the "Policy" collapsible section and enter comma-separated package names.

### AnsibleService (`src/services/ansibleService.ts`)

Runs entirely on the **local machine** — Ansible connects outbound to devices over SSH, so no remote agent is needed.

**`isAvailable()`** — checks whether `ansible-playbook` is on the local PATH. The "Run Policy" button is hidden if Ansible is not installed.

**`generateInventory(devices)`** — produces an INI inventory for the group's devices:

```ini
[zgx_devices]
odin ansible_host=192.168.1.10 ansible_user=zgx ansible_port=22 \
     ansible_ssh_private_key_file=~/.ssh/id_ed25519 \
     ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'

[zgx_devices:vars]
ansible_become=yes
ansible_become_method=sudo
```

**`generatePlaybook(group, policy)`** — produces a YAML playbook with one task per policy section:

```yaml
---
- name: "ZGX Toolkit group policy — Prod Cluster"
  hosts: zgx_devices
  gather_facts: no
  tasks:
    - name: Ensure required packages are installed
      ansible.builtin.apt:
        name:
          - htop
          - tmux
        state: present
        update_cache: yes
        cache_valid_time: 3600

    - name: Install pinned package versions
      ansible.builtin.apt:
        name:
          - cuda-toolkit=12.3.2-1
        state: present
```

**`runPolicy(group, devices, policy)`** — writes both files to a temp directory, runs the generated playbook, optionally runs the custom playbook, then cleans up. Timeout: 300 seconds.

### Run Policy Flow

1. User clicks "Run Policy" on a group card in the Admin Dashboard
2. `handleGroupRunPolicy` checks `ansibleService.isAvailable()`
3. If not available: shows error message explaining Ansible is not installed
4. If available: shows a confirmation dialog with the policy details
5. On confirm: runs `ansibleService.runPolicy(group, devices, policy)`
6. Output is streamed to a VS Code Output Channel (ZGX Toolkit)

### Setup All Flow

The "Setup All" button on a group card runs `handleGroupSetup`:

1. Checks which devices in the group already have the collector installed (via `device.metadata.collectorInstalled` or presence of a snapshot — no SSH)
2. Installs the collector on devices that need it, in parallel
3. If any device requires a sudo password, shows a single password prompt for the whole group (not one per device)
4. On success: runs initial `collectInventory` on all newly set-up devices

---

## VS Code Commands

Registered in `src/commands/manageabilityCommands.ts` and `package.json`:

| Command ID | Title | Action |
|---|---|---|
| `zgxToolkit.runInventory` | ZGX Toolkit: Run Device Inventory | QuickPick device → `collectInventory` → opens Device Info panel |
| `zgxToolkit.showHealth` | ZGX Toolkit: Show Device Health | QuickPick device → `getHealthPosture` → Output Channel |
| `zgxToolkit.runDiagnostics` | ZGX Toolkit: Run Diagnostics | QuickPick device → L1 or L2 → Output Channel |
| `zgxToolkit.checkUpdates` | ZGX Toolkit: Check for Updates | QuickPick device → `getUpdatePosture` → Output Channel |
| `zgxToolkit.showDeviceInfo` | ZGX Toolkit: Show Device Info | QuickPick device → opens Device Info panel |

All commands are accessible via the Command Palette (`Ctrl+Shift+P`) and the Admin Dashboard UI. The Command Palette variants are useful for quick access without navigating to the dashboard first.

---

## Data Flow: End to End

### First inventory on a new device

```
User clicks "Run Inventory" on a device card
  └─ adminDashboard.js posts { type: 'runInventory', deviceId }
       └─ adminDashboardViewController.handleRunInventory(deviceId)
            └─ vscode.window.withProgress(...)
                 └─ manageabilityService.collectInventory(device)
                      └─ Promise.allSettled([
                             runTool('device_identity'),   ─┐
                             runTool('os_build_identity'), ─┤
                             runTool('hardware_config'),   ─┤── parallel SSH sessions
                             runTool('firmware_reporter'), ─┤
                             runTool('driver_inventory'),  ─┤
                             runTool('software_inventory'),─┤
                             runTool('spark_diagctl'),     ─┘
                         ])
                      └─ assembles ManageabilitySnapshot
                      └─ deviceService.updateDevice(id, { metadata: { manageabilitySnapshot } })
            └─ sendMessageToWebview({ type: 'clearLoading', deviceId })
            └─ this.refresh()  ← re-renders dashboard from updated metadata
```

### Viewing device info (instant, no SSH)

```
User clicks "View Details"
  └─ adminDashboard.js posts { type: 'viewDetails', deviceId }
       └─ adminDashboardViewController navigates to 'devices/info' in editor panel
            └─ deviceInfoViewController.render({ deviceId })
                 └─ deviceService.getDevice(deviceId)
                 └─ device.metadata.manageabilitySnapshot  ← in-memory, no SSH
                 └─ buildTemplateData(device, snapshot)
                 └─ renderTemplate(html, data)
                 └─ returns HTML immediately
```

### Applying a group policy

```
User clicks "Run Policy" on a group card
  └─ adminDashboard.js posts { type: 'groupRunPolicy', groupId }
       └─ adminDashboardViewController.handleGroupRunPolicy(groupId)
            └─ ansibleService.isAvailable()  ← checks local ansible-playbook binary
            └─ vscode.window.showWarningMessage(confirmation dialog)
            └─ ansibleService.runPolicy(group, devices, policy)
                 └─ generateInventory(devices) → writes to /tmp/zgx-<ts>-inventory
                 └─ generatePlaybook(group, policy) → writes to /tmp/zgx-<ts>-playbook.yml
                 └─ execFile('ansible-playbook', ['-i', inventory, playbook])
                    (ansible-playbook SSHes to each device using the same key as the extension)
                 └─ if customPlaybookPath: runs that too
                 └─ cleans up temp files
            └─ output shown in VS Code Output Channel "ZGX Toolkit"
```

---

## Deployment & Updates

### Deploying a new collector version

1. Edit `resources/zgx-collector` — bump `VERSION`
2. Run `npm run compile` (compiles TypeScript + copies resources to `out/`)
3. Run `npx vsce package --out dist/zgx-toolkit-manageability.vsix`
4. Uninstall the old VSIX in VS Code, install the new one
5. The new collector script ships inside the VSIX at `extension/resources/zgx-collector`
6. Push "Setup All" on any group or "Run Inventory" on individual devices — the extension re-installs the collector via `installCollector()` if `collectorInstalled` is false, or re-uses the existing install otherwise

To force a collector update on all devices: clear `device.metadata.collectorInstalled` from the device store (or add a forced reinstall button), then run "Setup All".

### Updating just the extension

The VSIX packages everything. The collector, TypeScript services, and webview templates are all bundled. A fresh VSIX install is all that's needed.

### Verifying the collector manually

SSH into a device and run:

```bash
zgx-collector health | python3 -m json.tool
```

Expected output:

```json
{
  "tool": "health",
  "timestamp": "2025-05-28T14:32:00+00:00",
  "status": "ok",
  "version": "1.1.1",
  "data": {
    "overall_status": "healthy",
    "gpu_vendor": "nvidia",
    "signals": [...],
    "gpus": [...]
  }
}
```

---

## Key Design Decisions & Gotchas

### No SSH on dashboard render

Early versions called `hasCollector()` (which opens an SSH session) for every device on every dashboard render. This caused the back button to take several seconds. The fix: derive collector presence purely from `device.metadata.collectorInstalled` and snapshot existence — both are in-memory and instant. SSH only happens when the user explicitly requests an action.

### `acquireVsCodeApi` called once per webview

VS Code's `getFullHtml` injects a global script that calls `acquireVsCodeApi()`. If a view's own `<script>` also calls it, the second call throws silently and breaks all `postMessage` calls. The fix across all view scripts:

```javascript
const vscode = window.vscodeApi || acquireVsCodeApi();
window.vscodeApi = vscode;
```

### `npm run compile` must copy resources

The compile script was originally just `tsc -p ./`. TypeScript compiles `.ts` files but does not copy `.html`, `.css`, or `.js` view templates to `out/`. The extension loads templates from `out/`, not `src/`. The fix is in `package.json`:

```json
"compile": "tsc -p ./ && npm run copy-resources"
```

Without this, code changes to HTML/CSS/JS views have no effect until resources are copied manually.

### Refresh button in Device Info

The "Refresh" button needs to send the device ID to the controller so it knows which device to re-inventory. The device ID is embedded in the container div at render time and read by the client script:

```html
<div class="container" data-device-id="{{deviceId}}">
```

```javascript
const deviceId = document.querySelector('.container').getAttribute('data-device-id');
vscode.postMessage({ type: 'runInventory', deviceId });
```

The `inventoryComplete` message and `this.refresh()` are both in the `finally` block so the button always re-enables even if `collectInventory` throws.

### `refreshCallback` must be awaited

`BaseViewController.refresh()` called `this.refreshCallback(params)` without `await`. Since the provider sets the callback as an async function, render errors were silently swallowed as unhandled promise rejections — the webview HTML was never replaced and the disabled button stayed stuck. The fix:

```typescript
await Promise.resolve(this.refreshCallback(params));
```

### Driver entries field name

The collector returns `{ "entries": [...] }` inside the drivers envelope. `DeviceInfoViewController.buildTemplateData` was reading `drv.packages` (the old field name), which always produced an empty array. Fixed with:

```typescript
entries: (drv.entries ?? drv.packages ?? []).slice(0, 20),
```

The fallback to `drv.packages` is kept for compatibility with any old snapshots already stored in device metadata.

### Ansible requires a local binary

`AnsibleService` runs `ansible-playbook` locally. The extension checks `isAvailable()` before showing the "Run Policy" button. If Ansible is not installed on the machine running VS Code, the policy feature is unavailable — install with `pip install ansible` or the system package manager.
