/*
 * Copyright ©2025 HP Development Company, L.P.
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

        await deviceService.updateDevice(device.id, {
            metadata: { ...device.metadata, manageabilitySnapshot: snapshot },
        });

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
            await deviceService.updateDevice(device.id, {
                metadata: { ...device.metadata, collectorInstalled: true },
            });
        }

        return has;
    }

    /**
     * Install or update the zgx-collector script on the device.
     *
     * Delivers the script via base64 to avoid shell-escaping issues.
     * Requires the device to have sudo NOPASSWD for /usr/bin/tee, or falls back
     * to installing into ~/.local/bin. PATH is explicitly set in all runTool calls
     * so the collector is found regardless of which location was used.
     */
    async installCollector(device: Device): Promise<InstallCollectorResult> {
        logger.info('Installing zgx-collector on device', { device: device.name });

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

        // Try system-wide install first, fall back to user-local
        const commands = [
            // System-wide (requires sudo NOPASSWD for tee)
            `echo '${b64}' | base64 -d | sudo tee /usr/local/bin/zgx-collector > /dev/null && sudo chmod +x /usr/local/bin/zgx-collector`,
            // User-local fallback
            `mkdir -p ~/.local/bin && echo '${b64}' | base64 -d > ~/.local/bin/zgx-collector && chmod +x ~/.local/bin/zgx-collector`,
        ];

        for (const cmd of commands) {
            const result = await executeSSHCommand(device, cmd, MANAGEABILITY_CONN_OPTS, {
                operationName: 'manageability:installCollector',
                timeoutSeconds: 60,
            });
            if (result.success) {
                logger.info('zgx-collector installed successfully', { device: device.name });
                // Cache so future hasCollector() calls skip the SSH round-trip.
                await deviceService.updateDevice(device.id, {
                    metadata: { ...device.metadata, collectorInstalled: true },
                });
                return { success: true };
            }
            logger.warn('installCollector: command failed, trying fallback', {
                device: device.name, error: result.stderr
            });
        }

        return {
            success: false,
            error: 'Installation failed. Ensure the device has sudo NOPASSWD for /usr/bin/tee, ' +
                   'or that ~/.local/bin is writable and in the SSH session PATH.'
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
}

export const manageabilityService = new ManageabilityService();
