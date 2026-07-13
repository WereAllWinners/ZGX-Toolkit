# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest release | ✓ |
| Previous minor | ✓ (critical fixes only) |
| Older versions | ✗ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Open a [private GitHub Security Advisory](https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine/security/advisories/new)
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
https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine/releases

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

### Sudo password handling

Applying package or firmware updates, and installing the collector
system-wide, may require `sudo` on the target device. The extension
supports two ways to satisfy this:

- **Recommended: passwordless `sudo` (NOPASSWD) scoped to the specific
  commands the extension runs.** This is the preferred enterprise
  configuration — the extension never transmits a password at all. Add a
  sudoers entry (via `visudo` or a drop-in file under `/etc/sudoers.d/`)
  scoped to only the commands actually invoked:

  ```
  # /etc/sudoers.d/zgx-toolkit — minimal NOPASSWD scope for ZGX Toolkit
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

  Adjust binary paths (`/usr/bin/...`) to match the target distribution.
  Only include the aliases relevant to that device's package manager.

- **Fallback: password prompt.** If NOPASSWD is not configured, the
  extension prompts for the sudo password and sends it to the remote
  command's stdin stream over the existing SSH connection. The password
  is:
  - Never interpolated into a command string — it is only ever written to
    stdin, and only for commands the extension itself explicitly flags as
    expecting it (never inferred by inspecting the command text).
  - Never persisted to device metadata, settings, or disk.
  - Scrubbed from command output (stdout/stderr) before that output is
    logged or shown in a notification — lines matching known sudo/PAM
    prompt patterns are stripped, and any literal occurrence of the
    password itself is redacted as a defense-in-depth measure.
