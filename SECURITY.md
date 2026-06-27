# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest release | ✓ |
| Previous minor | ✓ (critical fixes only) |
| Older versions | ✗ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Open a [private GitHub Security Advisory](https://github.com/WereAllWinners/ZGX-Toolkit/security/advisories/new)
on this repository's Security tab.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive a response within 5 business days.

## Security model

### Installation

This extension is distributed as a signed `.vsix` file via GitHub Releases.
Always download from the official releases page at:
https://github.com/WereAllWinners/ZGX-Toolkit/releases

Verify the SHA256 checksum of the downloaded file against the value
published in the release notes before installing.

### SSH authentication

The extension uses SSH key-based authentication only. Password
authentication is not supported. SSH keys are generated and stored in
the standard OS location (`~/.ssh/`).

### Collector scripts

Collector scripts in `DGX_spark_management/bin/` run on target devices
with the permissions of the SSH user. They are read-only and do not
modify device state. Review the scripts before deploying to your devices.

### Controller scripts

Scripts that modify device state (firmware updates, diagnostics bundles)
are never run automatically. The extension always requires explicit user
confirmation. Do not modify this behavior.

### Network

The manageability layer communicates with devices only via SSH over your
existing network. No data is sent to external servers. Telemetry follows
the upstream ZGX Toolkit policy and can be disabled in VS Code settings.

### Privilege

Collector scripts use `sudo` only for `dmidecode` calls (hardware identity
reads). No other collector operation requires elevated privileges.
