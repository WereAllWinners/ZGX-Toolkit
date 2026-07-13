/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Manageability service — bridges VS Code to the zgx-collector CLI installed on
 * each managed device at /usr/local/bin/zgx-collector. Runs collector subcommands
 * over SSH (no sudo required), parses their JSON envelopes, and surfaces results.
 *
 * Pattern mirrors appInstallationService.ts (executeSSHCommand, ssh2-based).
 * applyUpdates MUST only be called after explicit user confirmation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Device } from '../types/devices';
import { logger } from '../utils/logger';
import { executeSSHCommand } from '../utils/sshConnection';
import {
    DGX_TOOL_COMMANDS,
    DGXToolKey,
    ManageabilityEnvelope,
    ManageabilitySnapshot,
    DeviceIdentity,
    OSBuildIdentity,
    HardwareConfig,
    FirmwareReport,
    DriverInventory,
    SoftwareInventory,
    DiagHealthResult,
    UpdatePosture,
    DriftFinding,
    DriftReport,
    DriftCheckResult,
} from '../types/manageability';
import { deviceService } from './deviceService';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface ManageabilityResult<T> {
    success: boolean;
    envelope?: ManageabilityEnvelope<T>;
    rawOutput?: string;
    error?: string;
}

export interface RunToolOptions {
    args?: string[];
    timeoutSeconds?: number;
}

export interface ApplyUpdatesResult {
    success: boolean;
    /** Raw apt-get output */
    output: string;
    error?: string;
    /** True when the first attempt failed only because sudo needs a password. Callers should prompt and retry. */
    requiresPassword?: boolean;
}

export interface InstallCollectorResult {
    success: boolean;
    error?: string;
    /** True when the system-wide install failed only because sudo needs a password. */
    requiresPassword?: boolean;
}

// ---------------------------------------------------------------------------
// Timeout constants (seconds)
// ---------------------------------------------------------------------------

const TIMEOUT_COLLECTOR = 30;
const TIMEOUT_DIAG_BUNDLE = 120;
const TIMEOUT_UPDATE_CONTROLLER = 300;

// SSH connection ready-timeout for all manageability calls.
// Keeps cards from staying gray indefinitely when a device is unreachable.
const SSH_READY_TIMEOUT_MS = 5000;
const MANAGEABILITY_CONN_OPTS = { readyTimeout: SSH_READY_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ManageabilityService {

    /**
     * Execute a single DGX management tool on the device and return the
     * parsed JSON envelope. Handles SSH errors and JSON parse errors separately.
     */
    async runTool<T>(
        device: Device,
        toolKey: DGXToolKey,
        options?: RunToolOptions,
    ): Promise<ManageabilityResult<T>> {
        const baseCmd = DGX_TOOL_COMMANDS[toolKey];
        const args = options?.args?.length ? ' ' + options.args.join(' ') : '';
        // Prepend both install locations so the collector is found whether it was
        // installed system-wide (/usr/local/bin) or as a user fallback (~/.local/bin).
        // Non-interactive SSH sessions often have a restricted PATH that omits ~/.local/bin.
        const command = `PATH=/usr/local/bin:$HOME/.local/bin:$PATH ${baseCmd}${args}`;
        const timeoutSeconds = options?.timeoutSeconds ?? TIMEOUT_COLLECTOR;

        logger.debug('Running manageability tool', { device: device.name, toolKey, command });

        const result = await executeSSHCommand(device, command, MANAGEABILITY_CONN_OPTS, {
            operationName: `manageability:${toolKey}`,
            timeoutSeconds,
        });

        if (!result.success) {
            const error = result.error?.message ?? result.stderr ?? 'SSH command failed';
            logger.error('Manageability tool SSH failure', { device: device.name, toolKey, error });
            return { success: false, rawOutput: result.stdout, error };
        }

        const rawOutput = result.stdout.trim();

        try {
            const envelope = JSON.parse(rawOutput) as ManageabilityEnvelope<T>;
            logger.debug('Manageability tool succeeded', { device: device.name, toolKey, status: envelope.status });
            return { success: true, envelope, rawOutput };
        } catch (parseError) {
            const error = `JSON parse failed for ${toolKey}: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
            logger.error('Manageability tool JSON parse error', { device: device.name, toolKey, rawOutput: rawOutput.slice(0, 200) });
            return { success: false, rawOutput, error };
        }
    }

    /**
     * Run all 6 collector tools in parallel and assemble a ManageabilitySnapshot.
     * Uses Promise.allSettled so a single tool failure does not abort the rest.
     * The snapshot is persisted to device.metadata.manageabilitySnapshot.
     */
    async collectInventory(device: Device): Promise<ManageabilitySnapshot> {
        logger.info('Collecting full inventory', { device: device.name });

        const [identity, osBuild, hardware, firmware, drivers, software, health] = await Promise.allSettled([
            this.runTool<DeviceIdentity>(device, 'device_identity'),
            this.runTool<OSBuildIdentity>(device, 'os_build_identity'),
            this.runTool<HardwareConfig>(device, 'hardware_config'),
            this.runTool<FirmwareReport>(device, 'firmware_reporter'),
            this.runTool<DriverInventory>(device, 'driver_inventory_reporter'),
            this.runTool<SoftwareInventory>(device, 'software_inventory_reporter'),
            this.runTool<DiagHealthResult>(device, 'spark_diagctl'),
        ]);

        const snapshot: ManageabilitySnapshot = {
            collectedAt: new Date().toISOString(),
            identity:  identity.status  === 'fulfilled' && identity.value.success  ? identity.value.envelope  : undefined,
            osBuild:   osBuild.status   === 'fulfilled' && osBuild.value.success   ? osBuild.value.envelope   : undefined,
            hardware:  hardware.status  === 'fulfilled' && hardware.value.success  ? hardware.value.envelope  : undefined,
            firmware:  firmware.status  === 'fulfilled' && firmware.value.success  ? firmware.value.envelope  : undefined,
            drivers:   drivers.status   === 'fulfilled' && drivers.value.success   ? drivers.value.envelope   : undefined,
            software:  software.status  === 'fulfilled' && software.value.success  ? software.value.envelope  : undefined,
            health:    health.status    === 'fulfilled' && health.value.success    ? health.value.envelope    : undefined,
        };

        const successCount = [identity, osBuild, hardware, firmware, drivers, software, health]
            .filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<ManageabilityResult<unknown>>).value.success)
            .length;

        logger.info('Inventory collection complete', { device: device.name, successCount, total: 7 });

        await deviceService.mergeDeviceMetadata(device.id, { manageabilitySnapshot: snapshot });

        return snapshot;
    }

    /**
     * Run spark_diagctl.py in L1 health-check mode (no args).
     */
    async getHealthPosture(device: Device): Promise<ManageabilityResult<DiagHealthResult>> {
        logger.info('Getting health posture', { device: device.name });
        return this.runTool<DiagHealthResult>(device, 'spark_diagctl');
    }

    /**
     * Retrieve device health (reused as reset-reason proxy — both run zgx-collector health).
     */
    async getResetReasons(device: Device): Promise<ManageabilityResult<DiagHealthResult>> {
        logger.info('Getting reset reasons / health', { device: device.name });
        return this.runTool<DiagHealthResult>(device, 'reset_reason_reporter');
    }

    /**
     * Check available updates (read-only, does not apply anything).
     */
    async getUpdatePosture(device: Device): Promise<ManageabilityResult<UpdatePosture>> {
        logger.info('Getting update posture', { device: device.name });
        return this.runTool<UpdatePosture>(device, 'spark_updatectl');
    }

    /**
     * Apply all available updates via apt on the device.
     *
     * IMPORTANT: Mutates device state. MUST only be called after explicit user
     * confirmation — never automatically or on a schedule.
     *
     * Runs: sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
     * Requires NOPASSWD for apt-get in the device's sudoers configuration.
     * If sudo prompts for a password, the command will fail with a clear error.
     */
    async applyUpdates(device: Device, sudoPassword?: string): Promise<ApplyUpdatesResult> {
        logger.info('Applying updates via apt', { device: device.name, withPassword: !!sudoPassword });

        // Without a password: sudo -n exits immediately (non-interactive) if one is required.
        // With a password: sudo -S reads it from stdin; -p '' suppresses the prompt string.
        const sudoFlags = sudoPassword ? "-S -p ''" : '-n';
        const execOpts = {
            operationName: 'manageability:applyUpdates',
            timeoutSeconds: TIMEOUT_UPDATE_CONTROLLER,
            ...(sudoPassword ? { sudoPassword } : {}),
        };

        // Prefer full-upgrade (resolves held-back packages) but fall back to upgrade when
        // the device's sudoers rule only covers the bare "upgrade" subcommand.
        // DEBIAN_FRONTEND is omitted — some devices' sudoers block env-var passthrough
        // (env_reset + restricted env_keep). -y and force-conf* cover non-interactive behaviour.
        for (const aptCmd of ['full-upgrade', 'upgrade'] as const) {
            const command = `sudo ${sudoFlags} apt-get ${aptCmd} -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1`;
            const result = await executeSSHCommand(device, command, MANAGEABILITY_CONN_OPTS, execOpts);

            const output = (result.stdout ?? '').trim();
            const combined = output + ' ' + (result.stderr ?? '');

            // Password required — only actionable when we haven't supplied one yet.
            if (!sudoPassword && combined.includes('sudo:') && combined.includes('password')) {
                logger.info('applyUpdates: sudo password required, caller should prompt', { device: device.name });
                return { success: false, output, requiresPassword: true, error: 'Sudo requires a password on this device.' };
            }

            // "not allowed to run" is the sudoers denial phrase, distinct from wrong-password
            // errors ("Sorry, try again"). Skip to the next apt subcommand in either pass —
            // the fallback must work whether or not a password was supplied.
            if (!result.success && combined.includes('not allowed to run')) {
                logger.warn(`applyUpdates: sudoers denied apt-get ${aptCmd}, trying fallback`, { device: device.name });
                continue;
            }

            if (!result.success) {
                const error = result.error?.message ?? result.stderr ?? 'SSH command failed';
                logger.error('applyUpdates SSH failure', { device: device.name, aptCmd, error });
                return { success: false, output, error };
            }

            logger.info('applyUpdates: apt done, attempting fwupdmgr', { device: device.name, aptCmd });

            // Apply firmware updates via fwupdmgr if available. fwupdmgr talks to the
            // fwupd daemon over D-Bus (no sudo required in most setups). Failures are
            // soft — apt success is still reported.
            const fwResult = await executeSSHCommand(
                device,
                'fwupdmgr update --no-reboot-check -y 2>&1',
                MANAGEABILITY_CONN_OPTS,
                { operationName: 'manageability:fwupd', timeoutSeconds: TIMEOUT_UPDATE_CONTROLLER },
            );
            const fwOutput = (fwResult.stdout ?? '').trim();
            // fwupdmgr exits 2 when there's nothing to update — don't treat as error.
            if (!fwResult.success && fwResult.exitCode !== 2) {
                logger.warn('fwupdmgr update did not fully succeed', { device: device.name, exitCode: fwResult.exitCode });
            }

            const finalOutput = fwOutput
                ? `${output}\n\n[Firmware Updates]\n${fwOutput}`
                : output;

            logger.info('applyUpdates complete', { device: device.name, aptCmd });
            return { success: true, output: finalOutput };
        }

        // Both apt-get variants denied by sudoers. If we haven't asked for a password yet,
        // trying with one may still work (device may require sudo auth for apt-get).
        if (!sudoPassword) {
            return { success: false, output: '', requiresPassword: true, error: 'Sudo requires a password on this device.' };
        }

        return {
            success: false,
            output: '',
            error: 'Sudo does not permit apt-get on this device. Verify that the sudoers file allows apt-get for this user.',
        };
    }

    /**
     * Returns true if zgx-collector is installed and executable on the device.
     */
    async hasCollector(device: Device): Promise<boolean> {
        // Use cached value when available — avoids an SSH round-trip on every dashboard render.
        if (device.metadata?.collectorInstalled === true) { return true; }

        // Check both install locations explicitly rather than relying on $PATH,
        // because non-interactive SSH sessions may not include ~/.local/bin.
        const result = await executeSSHCommand(
            device,
            '(test -x /usr/local/bin/zgx-collector || test -x "$HOME/.local/bin/zgx-collector") && echo yes || echo no',
            MANAGEABILITY_CONN_OPTS,
            { operationName: 'manageability:hasCollector', timeoutSeconds: 10 }
        );
        const has = result.success && result.stdout.trim() === 'yes';

        // Persist positive result so future renders skip this SSH check.
        if (has) {
            await deviceService.mergeDeviceMetadata(device.id, { collectorInstalled: true });
        }

        return has;
    }

    /**
     * Install or update the zgx-collector script on the device.
     *
     * Delivers the script via base64 to avoid shell-escaping issues.
     * Tries system-wide install (/usr/local/bin via sudo) first; falls back to
     * ~/.local/bin (no sudo required). Pass sudoPassword when the device requires
     * a password for sudo tee — same flow as applyUpdates.
     */
    async installCollector(device: Device, sudoPassword?: string): Promise<InstallCollectorResult> {
        logger.info('Installing zgx-collector on device', { device: device.name, withPassword: !!sudoPassword });

        const scriptPath = path.join(__dirname, '..', '..', 'resources', 'zgx-collector');
        let scriptContent: string;
        try {
            scriptContent = fs.readFileSync(scriptPath, 'utf8');
        } catch (err) {
            const error = `Cannot read collector script: ${err instanceof Error ? err.message : String(err)}`;
            logger.error('installCollector: script file not found', { scriptPath, error });
            return { success: false, error };
        }

        const b64 = Buffer.from(scriptContent, 'utf8').toString('base64');
        const sudoFlags = sudoPassword ? "-S -p ''" : '-n';

        // System-wide install (sudo tee). Tried first so the binary lands in a
        // standard PATH location that non-interactive SSH sessions will find.
        const systemCmd = `echo '${b64}' | base64 -d | sudo ${sudoFlags} tee /usr/local/bin/zgx-collector > /dev/null && sudo ${sudoFlags} chmod +x /usr/local/bin/zgx-collector`;
        const systemResult = await executeSSHCommand(device, systemCmd, MANAGEABILITY_CONN_OPTS, {
            operationName: 'manageability:installCollector:system',
            timeoutSeconds: 60,
            ...(sudoPassword ? { sudoPassword } : {}),
        });

        if (!systemResult.success) {
            const combined = (systemResult.stdout ?? '') + ' ' + (systemResult.stderr ?? '');
            // sudo needs a password and we haven't supplied one yet — caller should prompt.
            if (!sudoPassword && combined.includes('sudo:') && combined.includes('password')) {
                logger.info('installCollector: sudo password required for system install', { device: device.name });
                // Fall through to user-local install rather than blocking immediately.
            } else {
                logger.warn('installCollector: system-wide install failed, trying ~/.local/bin', {
                    device: device.name, stderr: systemResult.stderr,
                });
            }
        } else {
            logger.info('zgx-collector installed system-wide', { device: device.name });
            await deviceService.mergeDeviceMetadata(device.id, { collectorInstalled: true });
            return { success: true };
        }

        // User-local fallback — no sudo needed, works on any writable home directory.
        const userCmd = `mkdir -p ~/.local/bin && echo '${b64}' | base64 -d > ~/.local/bin/zgx-collector && chmod +x ~/.local/bin/zgx-collector`;
        const userResult = await executeSSHCommand(device, userCmd, MANAGEABILITY_CONN_OPTS, {
            operationName: 'manageability:installCollector:user',
            timeoutSeconds: 60,
        });

        if (userResult.success) {
            logger.info('zgx-collector installed to ~/.local/bin', { device: device.name });
            await deviceService.mergeDeviceMetadata(device.id, { collectorInstalled: true });
            return { success: true };
        }

        // Both paths failed. If we never tried a password, the system install
        // might succeed with one — signal the caller to prompt.
        const sysOutput = (systemResult.stdout ?? '') + ' ' + (systemResult.stderr ?? '');
        if (!sudoPassword && sysOutput.includes('sudo:') && sysOutput.includes('password')) {
            return { success: false, requiresPassword: true, error: 'Sudo requires a password to install system-wide.' };
        }

        return {
            success: false,
            error: `Installation failed on ${device.name}. ` +
                   `System install: ${systemResult.stderr ?? 'failed'}. ` +
                   `User install: ${userResult.stderr ?? 'failed'}.`,
        };
    }

    /**
     * Run a full health diagnostic check.
     */
    async generateDiagBundle(device: Device): Promise<ManageabilityResult<DiagHealthResult>> {
        logger.info('Generating diagnostic bundle', { device: device.name });
        return this.runTool<DiagHealthResult>(device, 'spark_diagctl', {
            timeoutSeconds: TIMEOUT_DIAG_BUNDLE,
        });
    }

    // -----------------------------------------------------------------------
    // Drift detection
    // -----------------------------------------------------------------------

    /** Directory where baseline JSON files are stored. Set via initialize(). */
    private storageDir: string = '';
    /** Output channel for policy drift reporting. Set via initialize(). */
    private policyChannel: vscode.OutputChannel | undefined;

    /**
     * Call once during extension activation to wire up storage and the output channel.
     */
    public initialize(context: vscode.ExtensionContext): void {
        this.storageDir = context.globalStorageUri.fsPath;
        this.policyChannel = vscode.window.createOutputChannel('ZGX Toolkit — Policy');
        logger.debug('ManageabilityService initialized', { storageDir: this.storageDir });
    }

    /** Absolute path of the baselines sub-directory. */
    private get baselinesDir(): string {
        return path.join(this.storageDir, 'baselines');
    }

    /** Absolute path for a device's baseline file. */
    private baselinePath(deviceId: string): string {
        return path.join(this.baselinesDir, `${deviceId}.json`);
    }

    /**
     * Capture and store the current ManageabilitySnapshot as the drift baseline.
     * The snapshot must already exist in device.metadata.manageabilitySnapshot;
     * call collectInventory() first if it is absent.
     */
    async captureBaseline(device: Device): Promise<void> {
        const snapshot = device.metadata?.manageabilitySnapshot as ManageabilitySnapshot | undefined;
        if (!snapshot) {
            throw new Error(
                `No inventory snapshot for "${device.name}". Run "Collect Device Inventory" first.`
            );
        }

        await fs.promises.mkdir(this.baselinesDir, { recursive: true });
        await fs.promises.writeFile(
            this.baselinePath(device.id),
            JSON.stringify(snapshot, null, 2),
            'utf8'
        );
        logger.info('Baseline captured', { device: device.name, path: this.baselinePath(device.id) });
    }

    /**
     * Load the stored baseline for a device, or undefined if none exists.
     */
    async getBaseline(device: Device): Promise<ManageabilitySnapshot | undefined> {
        try {
            const raw = await fs.promises.readFile(this.baselinePath(device.id), 'utf8');
            return JSON.parse(raw) as ManageabilitySnapshot;
        } catch {
            return undefined;
        }
    }

    /**
     * Compare the current device snapshot against the stored baseline and return
     * a structured drift report. If no baseline exists, offers to capture one.
     *
     * Current state is read from device.metadata.manageabilitySnapshot — the
     * snapshot written by the last collectInventory() call, not a fresh SSH run.
     */
    async checkAnsibleDrift(device: Device, inventoryPath: string): Promise<DriftCheckResult> {
        logger.info('Checking Ansible policy drift', { device: device.name, inventoryPath });

        const baseline = await this.getBaseline(device);
        const checkedAt = new Date().toISOString();

        if (!baseline) {
            const choice = await vscode.window.showInformationMessage(
                `ZGX Toolkit: No baseline for "${device.name}". Capture one now?`,
                'Capture Baseline',
                'Cancel'
            );

            if (choice === 'Capture Baseline') {
                await this.captureBaseline(device);
                const captured = `Baseline captured at ${checkedAt}. Run drift check again to compare.`;
                logger.info(captured, { device: device.name });
                return this.emptyDriftResult(device.id, device.name, checkedAt, captured);
            }

            const noBaseline = 'No baseline available. Capture a baseline on a known-good device first.';
            return this.emptyDriftResult(device.id, device.name, checkedAt, noBaseline);
        }

        const current = device.metadata?.manageabilitySnapshot as ManageabilitySnapshot | undefined
            ?? { collectedAt: checkedAt };

        const findings = this.compareSnapshots(baseline, current);

        // Sort: critical → warning → info
        const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
        findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

        const driftDetected = findings.length > 0;
        const summary = driftDetected
            ? `${findings.length} finding(s): ${findings.filter(f => f.severity === 'critical').length} critical, ` +
              `${findings.filter(f => f.severity === 'warning').length} warning, ` +
              `${findings.filter(f => f.severity === 'info').length} info`
            : `${device.name} matches baseline`;

        const report: DriftReport = {
            deviceId: device.id,
            deviceName: device.name,
            baselineCapturedAt: baseline.collectedAt,
            checkedAt,
            driftDetected,
            summary,
            findings,
            baseline,
            current,
        };

        this.writePolicyReport(report, checkedAt);
        return { driftDetected, summary, report };
    }

    /**
     * Generate a commented YAML remediation playbook for critical and warning findings.
     * Returns a YAML string — does not write any file.
     */
    exportRemediationPlaybook(report: DriftReport): string {
        const ts = new Date().toISOString();
        const hostname = report.current?.identity?.data?.hostname ?? report.deviceName;

        const lines: string[] = [
            `# Drift remediation for ${report.deviceName} — generated ${ts}`,
            `# Review each task before applying. This is a starting point, not a`,
            `# runnable playbook. Adjust package names and versions for your environment.`,
            '---',
            `- name: Remediate ${report.deviceName}`,
            `  hosts: "${hostname}"`,
            '  tasks:',
        ];

        const actionable = report.findings.filter(f => f.severity !== 'info');

        if (actionable.length === 0) {
            lines.push('  # No critical or warning findings — nothing to remediate.');
        }

        for (const finding of actionable) {
            lines.push('');
            lines.push(`  # ${finding.severity.toUpperCase()} — ${finding.field} drifted ${finding.baselineValue} → ${finding.currentValue}`);
            lines.push(`  # Baseline expects: ${finding.baselineValue}`);

            if (finding.field === 'drivers.gpuDriverVersion') {
                lines.push(`  - name: Pin NVIDIA driver version`);
                lines.push(`    apt:`);
                lines.push(`      name: nvidia-driver-${finding.baselineValue.split('.')[0]}=${finding.baselineValue}`);
                lines.push(`      state: present`);
                lines.push(`    # NOTE: Adjust package name and version to match your repository`);
            } else if (finding.field === 'os.kernelVersion') {
                lines.push(`  - name: Pin kernel version`);
                lines.push(`    apt:`);
                lines.push(`      name: "linux-image-${finding.baselineValue}"`);
                lines.push(`      state: present`);
            } else {
                lines.push(`  - name: Remediate ${finding.field}`);
                lines.push(`    # TODO: implement task for ${finding.field}`);
                lines.push(`    # Baseline: ${finding.baselineValue} / Current: ${finding.currentValue}`);
                lines.push(`    debug:`);
                lines.push(`      msg: "Manual remediation required for ${finding.field}"`);
            }
        }

        return lines.join('\n') + '\n';
    }

    // -----------------------------------------------------------------------
    // Private drift helpers
    // -----------------------------------------------------------------------

    private emptyDriftResult(deviceId: string, deviceName: string, checkedAt: string, summary: string): DriftCheckResult {
        const empty: ManageabilitySnapshot = { collectedAt: '' };
        const report: DriftReport = {
            deviceId, deviceName,
            baselineCapturedAt: '',
            checkedAt,
            driftDetected: false,
            summary,
            findings: [],
            baseline: empty,
            current: empty,
        };
        return { driftDetected: false, summary, report };
    }

    /**
     * Extract a canonical field value from a snapshot for comparison.
     * Returns a string so all comparisons are uniform.
     */
    private extractField(snapshot: ManageabilitySnapshot, field: string): string {
        switch (field) {
            case 'os.kernelVersion':
                return snapshot.osBuild?.data?.kernel ?? '';
            case 'os.dgxOsVersion':
                return snapshot.osBuild?.data?.os_version ?? '';
            case 'drivers.gpuDriverVersion':
                return snapshot.drivers?.data?.gpu_driver_version ?? '';
            case 'drivers.cudaVersion':
                return snapshot.drivers?.data?.cuda_version ?? '';
            case 'firmware.bios.version':
                return snapshot.firmware?.data?.bios_version ?? '';
            case 'firmware.gpuVbiosVersion':
                return snapshot.firmware?.data?.gpu_vbios_version ?? '';
            case 'hardware.gpu.names':
                return (snapshot.hardware?.data?.gpus ?? []).map(g => g.name).join(',');
            case 'hardware.memory.totalMb': {
                const bytes = snapshot.hardware?.data?.total_memory_bytes ?? 0;
                return String(Math.round(bytes / (1024 * 1024)));
            }
            default:
                return '';
        }
    }

    private readonly DRIFT_FIELDS: Array<{ field: string; severity: 'info' | 'warning' | 'critical'; category: string }> = [
        { field: 'os.kernelVersion',         severity: 'warning',  category: 'os' },
        { field: 'os.dgxOsVersion',          severity: 'warning',  category: 'os' },
        { field: 'drivers.gpuDriverVersion', severity: 'critical', category: 'driver' },
        { field: 'drivers.cudaVersion',      severity: 'warning',  category: 'driver' },
        { field: 'firmware.bios.version',    severity: 'warning',  category: 'firmware' },
        { field: 'firmware.gpuVbiosVersion', severity: 'info',     category: 'firmware' },
        { field: 'hardware.gpu.names',       severity: 'critical', category: 'hardware' },
        { field: 'hardware.memory.totalMb',  severity: 'warning',  category: 'hardware' },
    ];

    private compareSnapshots(baseline: ManageabilitySnapshot, current: ManageabilitySnapshot): DriftFinding[] {
        const findings: DriftFinding[] = [];

        for (const { field, severity, category } of this.DRIFT_FIELDS) {
            const baselineValue = this.extractField(baseline, field);
            const currentValue  = this.extractField(current, field);

            if (!baselineValue && !currentValue) { continue; }

            if (field === 'hardware.memory.totalMb') {
                const bMb = parseInt(baselineValue) || 0;
                const cMb = parseInt(currentValue) || 0;
                if (bMb === 0) { continue; }
                const pctChange = Math.abs(cMb - bMb) / bMb;
                if (pctChange <= 0.10) { continue; }
            } else if (baselineValue === currentValue) {
                continue;
            }

            findings.push({ category, field, baselineValue, currentValue, severity });
        }

        return findings;
    }

    private writePolicyReport(report: DriftReport, checkedAt: string): void {
        if (!this.policyChannel) { return; }

        if (!report.driftDetected) {
            this.policyChannel.appendLine(`[OK] ${report.deviceName} matches baseline (checked ${checkedAt})`);
            return;
        }

        this.policyChannel.appendLine(
            `[DRIFT] ${report.deviceName} — ${report.findings.length} finding(s) (checked ${checkedAt})`
        );
        this.policyChannel.appendLine('');

        for (const f of report.findings) {
            const severity = f.severity.toUpperCase().padEnd(10);
            const field    = f.field.padEnd(40);
            this.policyChannel.appendLine(`  ${severity}  ${field}  ${f.baselineValue}  →  ${f.currentValue}`);
        }

        this.policyChannel.show(true);
    }
}

export const manageabilityService = new ManageabilityService();
