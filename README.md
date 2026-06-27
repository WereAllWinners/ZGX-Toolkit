# HP ZGX Toolkit

## Overview 

The HP ZGX Toolkit streamlines AI development workflows on the HP ZGX desktop AI supercomputer by providing automated setup of essential open-source AI tools and seamless device discovery on your LAN. This VS Code extension enables developers to quickly configure their ZGX environment for model fine-tuning and local inference, while solving common network connectivity challenges. 

## About the HP ZGX Toolkit 

The HP ZGX Toolkit addresses two critical pain points for AI developers working with the HP ZGX hardware. First, it provides an automated installation and management system for a curated open-source AI development stack, eliminating hours of manual configuration and dependency resolution. With a single command through the VS Code interface, developers can install and configure Python packages to support model finetuning, experiment tracking and inference, as well as other AI development tools - all optimized for the ZGX's ARM-based architecture and Blackwell GPU. With the ZGX Toolkit, package dependencies are a thing of the past. 

Second, the toolkit includes lightweight IP discovery functionality that automatically locates your ZGX device whether setting up for the first time or when DHCP assigns new IP addresses. This eliminates the frustration of broken SSH connections after router reboots or network changes, saving developers 5-10 minutes of troubleshooting each time their device's IP changes. 

![HP ZGX Toolkit Diagram](/docs/marketplace/images/zgx-tk-extension-diagram.png)

## Enterprise Manageability Engine

This fork extends the upstream ZGX Toolkit with a full enterprise device
lifecycle management layer, built on the
[NVIDIA DGX Spark Manageability Guide](https://developer.nvidia.com/dgx-spark)
specification.

### Capabilities

**Device Inventory** — Hardware configuration (GPU, CPU, memory, storage,
NIC), firmware versions, OS build identity, driver inventory, and software
inventory collected via SSH and surfaced directly in VS Code.

**Health Monitoring** — Continuous health posture signals from
`spark_diagctl`, including GPU status, driver health, and system diagnostics,
with visual alerts in the Device Manager panel.

**Diagnostics** — On-demand and scheduled diagnostics artifact collection
supporting L1 (health posture) and L2 (evidence bundle) modes per the NVIDIA
manageability spec.

**Ansible Group Policy** — Detect configuration drift against known-good
baselines and generate Ansible remediation playbooks, all from within VS Code.

### Architecture

The manageability layer is **agentless** — it uses the same SSH
infrastructure already in the ZGX Toolkit. No software is installed on target
devices beyond lightweight Python collector scripts placed in
`DGX_spark_management/bin/`. Collectors are read-only and safe to run
frequently. Controllers that modify device state always require explicit user
confirmation and are never run automatically.

For full setup and usage, see [Manageability Guide](docs/manageability.md).

### New VS Code commands

| Command | Description |
|---|---|
| `ZGX Toolkit: Show Device Info` | Open the Device Info panel |
| `ZGX Toolkit: Run Health Check` | On-demand health check |
| `ZGX Toolkit: Collect Device Inventory` | Full inventory collection |
| `ZGX Toolkit: Check for Updates` | Firmware/driver update posture |
| `ZGX Toolkit: Check Ansible Policy Drift` | Compare against Ansible baseline |

## Quick Start

### Installing from GitHub (recommended)

1. Go to the [Releases page](https://github.com/WereAllWinners/ZGX-Toolkit/releases)
   and download the latest `.vsix` file.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
3. Click the `···` menu → **Install from VSIX…** and select the downloaded file.

Or install directly from a terminal:

```bash
code --install-extension zgx-toolkit-2.0.0.vsix
```

### After installing

1. Go to the ZGX Toolkit panel in the Activity Bar.
2. Run the device discovery command to locate your ZGX device on the network.
3. Connect via SSH — the Toolkit will help generate and configure SSH keys.
4. Select and install AI stack components from the curated app catalog.
5. Open the **Device Info** panel to view inventory, health status, and
   firmware details for any connected device.

## Setup

See ZGX Onboarding Guide @ https://www.hp.com/zgx-onboard

### Prerequisites: 

* HP ZGX is located on same subnet of local network
* VS Code Remote SSH extension is installed on your primary device (non-ZGX device) 

### Installation Steps:

Download the `.vsix` from the
[Releases page](https://github.com/WereAllWinners/ZGX-Toolkit/releases), then:

1. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
2. Click the `···` menu → **Install from VSIX…** and select the downloaded file.

Or from the terminal: `code --install-extension zgx-toolkit-2.0.0.vsix`

### Supported OS on client device, i.e., not the ZGX 

* Windows 11 
* Ubuntu 24.04 
* MacOS 15 

## Questions, issues, and contributions

For help or to submit a feature request, open an issue on the
[GitHub repository](https://github.com/WereAllWinners/ZGX-Toolkit/issues).

This is a community fork of the HP ZGX Toolkit. The original upstream project
is maintained by HP Inc at
[github.com/HPInc/ZGX-Toolkit](https://github.com/HPInc/ZGX-Toolkit).

## Data and Telemetry 

The HP ZGX Toolkit collects minimal telemetry data to improve the extension's functionality and user experience. To change your telemetry settings change via [VS Code Telemetry Settings](https://code.visualstudio.com/docs/configure/telemetry)

## Testing

### Quick Test Commands

**Run unit tests:**

```powershell
npm run test:unit
```

**Run integration tests:**

```powershell
npm run test:integration
```

**Run unit tests with coverage:**

```powershell
npm run test:unit:coverage
```

For detailed testing instructions, test structure, and troubleshooting, see the [Testing Guide](docs/testing.md).

### Quick Build Steps

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Build the extension:

   ```powershell
   npm run compile
   ```

3. Add a version (optional):

   ```powershell
   npm version VERSION --no-git-tag-version
   ```

4. Create the `.vsix` package:

   ```powershell
   npx @vscode/vsce package
   ```

5. Install:

   ```powershell
   code --install-extension zgx-toolkit-VERSION.vsix
   ```

6. To un install:

   ```powershell
   code --uninstall-extension hpinc.zgx-toolkit
   ```

## Build Instructions

For comprehensive instructions on building and debugging the extension locally, see the [Building Guide](docs/building.md).
