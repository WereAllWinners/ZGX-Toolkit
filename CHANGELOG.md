# Changelog

## v2.3.0 (2026-06-29)

### Firmware / BIOS Update Integration

#### New capabilities

- **Firmware update detection**: Scheduled checkups now query firmware update availability in parallel with package updates. On GB10/DGX Spark systems, NVIDIA-delivered BIOS and firmware packages (matched by name patterns: `linux-firmware`, `firmware-*`, `nvidia-firmware`, `*-bios`, `*-uefi`, `intel-microcode`, `amd64-microcode`, etc.) are detected via `apt list --upgradable`. On all other Linux devices, `fwupdmgr get-updates --json` queries the Linux Vendor Firmware Service (LVFS).

- **Dual-source firmware detection** (`zgx-collector firmware-updates`): A new `cmd_firmware_updates` subcommand queries both fwupdmgr and apt firmware packages in a single call, deduplicates by package name (fwupd entry takes precedence), and returns a unified list with source attribution.

- **Separate firmware section in Update Review**: The Update Review panel now has two independent sections — Package Updates and Firmware / BIOS Updates — each with its own checkbox-based selection, apply button, and status banner. An "Apply All Updates" button appears when both sections have available items.

- **Independent apply scopes** (`ApplyScope: 'packages' | 'firmware' | 'all'`): Users can apply package updates only, firmware updates only, or both in a single operation. TOCTOU re-validation runs fresh queries for both packages and firmware before building the apply plan.

- **Firmware Ansible policy guard**: The same `pinnedPackages` map from the YAML inventory applies to firmware packages by name. Pinned firmware appears in a new "Held by Ansible Policy (Firmware)" exclusions section. Kernel/device holds do NOT apply to firmware.

- **Reboot warning**: Any firmware apply that includes updates with `requires_reboot: true` shows a modal warning before the user confirms.

- **Admin Dashboard firmware badges**: Device cards show amber firmware update badges (`N firmware update(s)`) and applied state badges independently from package badges. Group cards have a new "Apply Firmware" button that applies firmware across all group devices in parallel.

- **Soft failure model**: Firmware check failure never blocks the package checkup. Firmware apply failure does not roll back package apply success.

#### Files changed

- `DGX_spark_management/bin/firmware_update_reporter.py` — new; dual-source firmware detection script
- `resources/zgx-collector` — added `cmd_firmware_updates` subcommand
- `src/types/manageability.ts` — added `FirmwareUpdateAvailabilityData` and `firmware_update_availability` tool key
- `src/types/scheduledUpdates.ts` — extended `UpdateSource`, `PendingUpdatesState`, `ApplyPlan`, `ApplyResult`; added `FirmwareCandidate`, `ApplyScope`
- `src/services/scheduledCheckupService.ts` — parallel firmware + package checkup via `Promise.all()`
- `src/services/updateReconciliationService.ts` — firmware reconciliation, apply execution, persist helpers
- `src/views/devices/updates/updateReviewViewController.ts` — firmware template data, `applyScoped()` handler
- `src/views/devices/updates/updateReview.html` — firmware section, firmware exclusions section, apply-all bar
- `src/views/devices/updates/updateReview.js` — firmware select-all, apply firmware, apply-all handlers
- `src/views/devices/updates/updateReview.css` — firmware section, warning banner, source tag, apply-all bar styles
- `src/views/admin/adminDashboardViewController.ts` — firmware card data fields, `handleGroupApplyFirmware()`
- `src/views/admin/adminDashboard.html` — firmware badge rows on device cards, Apply Firmware button on group cards
- `src/views/admin/adminDashboard.js` — `group-apply-firmware` action dispatch
- `src/views/admin/adminDashboard.css` — `.update-badge-firmware`, `.btn-firmware` styles

---

## v2.2.2 (2026-06-29)

### Fleet-Wide Update Report Panel

#### New capabilities

- **Update Report panel**: Opens from the "Update Report" button in the Admin
  Dashboard header. Shows every managed device in a single table with its last
  checkup time, current update status (available count, Applied, Check failed,
  Up to date, Not checked), and a preview of the top 5 available packages with
  current → available version info.

- **Fleet summary stats**: Total devices, checked devices, devices with updates,
  and total available packages are shown as chips at the top of the report.
  Devices with pending updates sort to the top automatically.

- **Direct drilldown**: Each device row has a "View →" button that opens its
  Update Review panel directly for side-by-side comparison or to initiate apply.

- **Refresh and back navigation**: The report has its own Refresh and
  "← Dashboard" buttons; it stays in the editor panel alongside the dashboard.

---

## v2.2.1 (2026-06-29)

### In-App Scheduled Checkup Controls & Group Update Overview

#### New capabilities

- **Scheduled Checkup Settings Bar**: The Admin Dashboard now has an
  "Auto-check" bar at the top showing the current enabled/disabled state.
  Click the ON/OFF pill to toggle scheduling, and pick an interval from
  the dropdown (1h, 6h, 12h, 24h, 48h, weekly). Selecting an interval
  automatically enables scheduling. No command palette or VS Code Settings
  required.

- **Group Update Summary**: Each User Group card now shows a compact update
  summary section once at least one device in the group has had a checkup
  run. Each device row shows its update state (available count, Applied,
  Failed, or Up to date) and a quick-link arrow to its Update Review panel.
  The section header shows the total number of available updates across
  the group.

- **Command palette additions**: `ZGX Toolkit: Toggle Scheduled Checkups`
  and `ZGX Toolkit: Configure Scheduled Checkups` for keyboard-driven access.

#### Installation

```bash
code --install-extension zgx-toolkit-2.2.1.vsix
```

---

## v2.2.0 (2026-06-29)

### Scheduled Update Checkup & UI-Driven Apply

This release delivers a complete update management pipeline — from background
detection through approved apply — all controlled from the Admin Dashboard UI
without requiring the command palette or terminal.

#### New capabilities

- **Scheduled Checkup Service** (`src/services/scheduledCheckupService.ts`):
  Background polling runs `apt list --upgradable` on each device on a
  configurable interval. Results are stored as `lastCheckup` and
  `pendingUpdates` device metadata and survive extension restarts.

- **Update Reconciliation Gate** (`src/services/updateReconciliationService.ts`):
  Filters raw checkup results against Ansible pinned versions and
  `apt-mark hold` device holds, producing a curated candidate list.
  A TOCTOU re-validation re-runs both filters at apply time.

- **Scoped Package Apply**: Approved packages are applied via
  `apt-get install --only-upgrade -y <pkgs>` (never a blanket upgrade).
  Supports `spark_updatectl` path for DGX-managed devices, sudo password
  retry, and full status tracking (`available → applying → applied/error`).

- **Full UI Controls in Admin Dashboard**: Every feature is now operable
  from the device card — no command palette or terminal required:
  - "Checked Xh ago / Never" row with inline refresh icon button
  - Four mutually exclusive update state badges: available count, Applied
    (green), Check failed (red), Up to date
  - All badge buttons open the Update Review panel directly

- **Update Review Panel enhancements**:
  - "Re-check now" button always visible in the panel header
  - Status banners for `applied` (green) and `error` (red) states
  - Stale "preview stub" note removed; real apply is wired end-to-end

#### Test coverage

Added 80+ unit tests across services and views.
Service tests: 583 passing. View tests: 499 passing.

#### Installation

```bash
code --install-extension zgx-toolkit-2.2.0.vsix
```

---

## v2.0.0 (2026-06-27)

### Enterprise Manageability Engine — new in this fork

This release adds a complete enterprise device lifecycle management layer
on top of the upstream HP ZGX Toolkit. All existing functionality is
unchanged and backward-compatible.

#### New capabilities

- **Device Inventory** (`src/types/manageability.ts`,
  `src/services/manageabilityService.ts`): TypeScript service layer for
  collecting hardware, firmware, OS, driver, and software inventory from
  ZGX devices via SSH, following the NVIDIA DGX Spark Manageability Guide
  JSON envelope spec.

- **Health Monitoring**: Continuous device health posture via
  `spark_diagctl` integration, surfaced in the Device Manager.

- **Device Info Webview Panel**: Live hardware configuration, OS identity,
  GPU status, and firmware versions per device.

- **Ansible Group Policy**: Configuration drift detection and Ansible
  remediation playbook generation for fleet baseline enforcement.

- **Python Collector Scripts** (`DGX_spark_management/bin/`): Agentless,
  stdlib-only Python collectors implementing the NVIDIA manageability tool
  suite: `device_identity.py`, `hardware_config.py`, `firmware_reporter.py`,
  `os_build_identity.py`, `driver_inventory_reporter.py`,
  `software_inventory_reporter.py`.

#### New VS Code commands

- `ZGX Toolkit: Show Device Info`
- `ZGX Toolkit: Run Health Check`
- `ZGX Toolkit: Collect Device Inventory`
- `ZGX Toolkit: Check for Updates`
- `ZGX Toolkit: Check Ansible Policy Drift`

#### Test coverage

Added 11 unit tests for the manageability service layer.
Total: 1091 passing.

#### Installation

Download the `.vsix` from the
[Releases page](https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine/releases)
and install with:

```bash
code --install-extension zgx-toolkit-2.0.0.vsix
```

#### Fork attribution

Maintained by Jerome Gabryszewski. Original ZGX Toolkit by HP Inc at
https://github.com/HPInc/ZGX-Toolkit — licensed under the X11 License.

---

# Version v1.21.3 → v1.21.5 (May 2026)

## What's New

### Telemetry Enabled by Default
Telemetry is now enabled by default to help improve the extension. If you had previously disabled telemetry, your preference is preserved and will not be overridden. To change this at any time, update the [Telemetry Enabled](vscode://settings/zgxToolkit.telemetry.enabled) setting in VS Code Settings (`File > Preferences > Settings`, then search for "ZGX Toolkit").

# Version v1.13.6 → v1.21.3 (March 2026)

## What's New
This release introduces **ConnectX device pairing**, enabling two ZGX Nano devices to be linked together for high-performance networking over ConnectX NICs - all managed directly from VS Code. It also delivers UX polish, a more capable RAG sample, and a collection of bug fixes.

## Major Features

### ConnectX Device Pairing
You can now pair two ZGX Nano devices to form a high-bandwidth ConnectX network link. The entire pairing workflow—selecting devices, entering credentials, configuring NICs, and monitoring the result—is handled within the extension.

#### What's included:
- **ConnectX NIC Configuration** - SSH-based configuration and unconfiguration of ConnectX NICs is wired into the group service, with centralized SSH connection utilities shared across the application.
- **Pair Devices View** - A dedicated view and controller guide the user through selecting two devices, entering the sudo password, and completing ConnectX pairing. Error paths include overlay messaging and group/NIC rollback on failure.
- **Pairing Details View** - Shows the ConnectX network interfaces and their assigned IP addresses for each device in the pair. Accessible via the Sidebar, Device Manager, and the "Show Pairing Details" command palette entry.
- **Unpair Devices View** - A dedicated view to list the devices in a pair, collect the sudo password, unconfigure the ConnectX NICs, and remove the group.
- **Sidebar Pairing Integration** - The sidebar device list now separates devices into "Paired" and "Unpaired" collapsible sections. Paired devices are grouped in expandable pair containers that include Pair Details and Unpair action buttons.
- **Device Manager Pairing Integration** - Pair containers with Pairing Details and Unpair Devices buttons are surfaced in the Device Manager.
- **Deleting a Paired Device** - Attempting to delete a paired device shows a warning overlay, prompts for the sudo password, and proceeds with unpairing before deletion. Unpairing will succeed even if one (or both) of the devices are not reachable on the network.

#### Getting started:
1. Open the Device Manager
2. Click **Pair Devices** button to open the Pair Devices View
3. Select two set up ZGX devices and click **Pair Devices**
4. Enter the sudo password when prompted; the extension will configure ConnectX and report the result
5. Use the **Pair Details** button to inspect ConnectX IP addresses, or **Unpair** to remove the link

### RAG Sample: Sample Questions
The RAG quick-start sample now ships with pre-defined sample questions. This makes it faster to explore the application's capabilities and understand RAG workflows on your ZGX device without having to craft your own queries first.

### Other Changes
- Small bug fixes and improvements.

---

# Version v1.13.3 → v1.13.6 January 2026

## What's New
This release contains bug fixes and improvements.

# Version v1.8.0 → v1.13.3 January 2026

## What's New
This release brings significant improvements to device management and network reliability, along with a new sample project and extensive test coverage enhancements.

## Major Features

### Automatic Device IP Discovery with mDNS
Your ZGX device's IP address may change due to DHCP lease renewals or network reconfiguration. With this release, the ZGX Toolkit can now automatically track and update device IP addresses in the background, so you never lose connectivity.

#### Benefits for you:
- No more manually updating IP addresses when your device moves or your network changes
- Seamless reconnection to devices, even after network disruptions
- Device Manager now shows a "Rediscover Device" button for quick manual updates

#### How it works:
- When you first set up a device with SSH key authentication, the extension registers a unique identifier on your ZGX device using the Avahi mDNS service
- A background updater periodically rediscovers registered devices and updates their IP addresses if they've changed
- If you have existing devices that were set up before this update, you'll see a notification prompting you to complete the mDNS registration

### RAG Sample Application for AI Workflows
A new ready-to-run Retrieval-Augmented Generation (RAG) sample has been added to help you get started with AI development on your ZGX device.
 
#### Benefits for you:
- Jump-start your AI projects with a working example instead of building from scratch
- Learn RAG implementation patterns 
- Develop and test entirely on local hardware with no cloud API costs or data egress fees

#### What's included:
- A complete Python application using Streamlit, Ollama, and LangChain
- In-memory FAISS vector store for document embedding and retrieval
- PDF document ingestion with automatic chunking
- Interactive Q&A interface powered by your local LLM

#### Getting started:
1. Install the required applications on your ZGX device (Ollama, Python/Miniforge)
2. Select the Quick Start Templates option on the bottom of the extension
3. Select the "Build your first RAG application" card
4. Follow the instructions on the next screen

This sample demonstrates best practices for building retrieval-augmented AI applications entirely on your local hardware—no cloud services required.

## Quality & Reliability Improvements
- **Expanded test coverage:** Comprehensive new test suites for device services, DNS registration, discovery services, and view controllers
- **Code organization:** Added copyright headers across test files and utility scripts
- **Connection service improvements:** Better handling of DNS service registration with detailed error types and recovery paths
- **Discovery service enhancements:** Improved handling of multiple network interfaces and protocol support (TCP/UDP)
- **Background updater resilience:** Graceful error handling when discovery fails, with automatic retry on next interval

## Upgrade Notes
**Existing devices:** After upgrading, devices set up with SSH key authentication will prompt for mDNS registration. This is optional but recommended for automatic IP tracking.

**No breaking changes:** All existing functionality remains unchanged. The new features are additive and backward-compatible.

# v0.0.47 → v1.7.3 (October 2025 - November 2025)

## Feature Highlights

### Built-in ZGX Network Discovery

Discover HP ZGX devices on your local network automatically using mDNS. No more manually tracking IP addresses or hunting through your network, just run the discovery command from the Device Manager and connect to detected ZGX devices by name. This streamlines first-time setup and makes it easy to reconnect when network configurations change.

### One-Click Application Installation

Install a curated AI development stack on your ZGX device directly from VS Code. Select from Python environments (Miniforge, pip, uv, poetry), container tools (Podman), AI productivity tools (Ollama, MLflow, Streamlit, Open WebUI), and developer utilities (curl, nvtop, nmon). Dependencies are resolved automatically with real-time progress visualization. Get from fresh device to production-ready AI workstation in minutes.

### SSH-Only Authentication (Security First)

Password authentication has been completely removed in favor of SSH key-based authentication. The extension now guides you through generating SSH keys, adding them to your ZGX device, and maintaining secure connections, all from within VS Code. This enterprise-ready approach reduces security risks while simplifying the setup experience.

### Configurable Logging & Telemetry

New granular controls for debugging and diagnostics. Adjust log levels (Error, Warn, Info, Debug, Trace) from the command palette, open or locate log files with one click, and enable/disable extension telemetry independently of VS Code's global settings. Logs now write to both the VS Code output channel and rotating daily files, making field issue troubleshooting significantly easier.

### Open-Source release

The extension source code is now fully available at https://github.com/HPInc/ZGX-Toolkit.

## Developer Experience

### Quick Links Sidebar

Access frequently used resources and documentation instantly with the new Quick Links menu. Jump to the ZGX onboarding guide, GitHub repository, or key documentation without 
leaving your editor.

### Centralized Quick-Start Guides 

Accessible from the quick links sidebar, you can now browse and select quick-start guides through a visual card-based interface. Better organization and clearer visual hierarchy make it easier to find the right starting point for your AI projects.
### Improved Application Selection UI

- Sticky footer navigation: Install, Continue, and action buttons stay visible as you scroll through the app catalog
- Pinned buttons in editor: Quick access to common actions from any view
- Enhanced completion screen: Clearer success states with next-step guidance after installations complete
- Uninstallation support: It is now possible to selectively uninstall applications from the application management screen.
Smarter SSH Workflows
- Non-standard port support: SSH commands now correctly handle custom ports with proper -p flags
- Auto-generated config entries: The extension safely manages your ~/.ssh/config file, creating and maintaining host entries for ZGX devices without overwriting your existing configurations
- Clearer error messages: When Remote-SSH isn't available, you get explicit commands you can copy and run manually

### Accessibility Improvements

Fixed color contrast issues in high-contrast themes (both light and dark variants). Code boxes, text elements, and UI components now meet accessibility standards for users requiring enhanced visual contrast.

### Enhanced Inference & Fine-Tuning Pages

Connect buttons on Inference and Fine-Tuning pages now work reliably. These critical workflows are no longer blocked by connectivity issues.
