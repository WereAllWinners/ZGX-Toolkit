/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { Device } from '../types/devices';
import { PlatformProfile } from '../types/platformProfile';
import {
    ApplyPlan,
    ApplyProvider,
    ApplyResult,
    AvailableUpdate,
    ExcludedUpdate,
    PendingUpdatesState,
    SkippedUpdate,
    UpdateCandidate,
    UpdateSource,
} from '../types/scheduledUpdates';
import { CheckupResult } from '../types/scheduledUpdates';
import { UpdateAvailabilityData } from '../types/manageability';
import { platformProfileService } from './platformProfileService';
import { manageabilityService } from './manageabilityService';
import { deviceService } from './deviceService';
import { executeSSHCommand } from '../utils/sshConnection';
import { logger } from '../utils/logger';

const APPLY_CONN_OPTS = { readyTimeout: 5000 };
const APPLY_TIMEOUT_SECONDS = 300;

export class UpdateReconciliationService {

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Read the Ansible policy file, apply the two pre-filters (ansible-pinned,
     * device/kernel-held), and return the three-way split ready to persist.
     */
    async reconcile(device: Device): Promise<{
        candidates: UpdateCandidate[];
        ansibleExclusions: ExcludedUpdate[];
        kernelExclusions: ExcludedUpdate[];
    }> {
        const lastCheckup = device.metadata?.lastCheckup as CheckupResult | undefined;
        const available = lastCheckup?.availableUpdates ?? [];
        const source: UpdateSource = lastCheckup?.source ?? 'unavailable';

        const inventoryPath = vscode.workspace
            .getConfiguration('zgxToolkit.manageability')
            .get<string>('ansibleInventoryPath', '');

        const pinnedPackages = inventoryPath
            ? await this.parsePinnedPackages(inventoryPath)
            : new Map<string, string>();

        const profile = platformProfileService.getProfile(device);

        return this.reconcileUpdatesWithPolicy(available, source, pinnedPackages, profile);
    }

    /**
     * Pure reconciliation — deterministic, no I/O. Exported for unit testing.
     *
     * Precedence per package:
     *   1. In pinnedPackages → ansibleExclusions (ansible-pinned)
     *   2. In heldKernelPackages → kernelExclusions (kernel-held)
     *   3. In heldPackages (non-kernel) → kernelExclusions (device-held)
     *   4. Otherwise → candidates
     */
    reconcileUpdatesWithPolicy(
        available: AvailableUpdate[],
        source: UpdateSource,
        pinnedPackages: Map<string, string>,
        profile: PlatformProfile | undefined,
    ): {
        candidates: UpdateCandidate[];
        ansibleExclusions: ExcludedUpdate[];
        kernelExclusions: ExcludedUpdate[];
    } {
        const candidates: UpdateCandidate[] = [];
        const ansibleExclusions: ExcludedUpdate[] = [];
        const kernelExclusions: ExcludedUpdate[] = [];

        const kernelHeld = new Set(profile?.heldKernelPackages ?? []);
        const deviceHeld = new Set(profile?.heldPackages ?? []);

        for (const u of available) {
            if (pinnedPackages.has(u.package)) {
                ansibleExclusions.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    reason: 'ansible-pinned',
                    heldOrPinnedVersion: pinnedPackages.get(u.package)!,
                });
            } else if (kernelHeld.has(u.package)) {
                kernelExclusions.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    reason: 'kernel-held',
                    heldOrPinnedVersion: u.currentVersion,
                });
            } else if (deviceHeld.has(u.package)) {
                kernelExclusions.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    reason: 'device-held',
                    heldOrPinnedVersion: u.currentVersion,
                });
            } else {
                candidates.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    source,
                });
            }
        }

        return { candidates, ansibleExclusions, kernelExclusions };
    }

    // -------------------------------------------------------------------------
    // Ansible policy file parser
    // -------------------------------------------------------------------------

    /**
     * Parse a simple ZGX YAML policy file for pinned package versions.
     *
     * Expected format:
     *   pinned_packages:
     *     cuda-toolkit: "12.0.0"
     *     nvidia-driver: 550.54.15
     *
     * Returns an empty map on any error (file not found, unreadable, bad format).
     */
    async parsePinnedPackages(inventoryPath: string): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        if (!inventoryPath) {
            return result;
        }

        let content: string;
        try {
            content = await fs.promises.readFile(inventoryPath, 'utf-8');
        } catch (err) {
            logger.debug('UpdateReconciliationService: policy file not readable', {
                path: inventoryPath,
                error: err instanceof Error ? err.message : String(err),
            });
            return result;
        }

        try {
            let inPinnedBlock = false;
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trimEnd();

                // Skip comments and blank lines
                if (!line.trim() || line.trim().startsWith('#')) {
                    continue;
                }

                // Detect the pinned_packages: header (may be indented)
                if (/^\s*pinned_packages\s*:/.test(line)) {
                    inPinnedBlock = true;
                    continue;
                }

                if (!inPinnedBlock) {
                    continue;
                }

                // Stop if we hit another top-level key (non-indented, ends with colon)
                if (/^[^\s]/.test(line) && line.trim().endsWith(':')) {
                    break;
                }

                // Parse indented "  key: value" or "  key: 'value'" or '  key: "value"'
                const match = line.match(/^\s+([^:]+?)\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/);
                if (match) {
                    const pkg = match[1].trim();
                    const ver = match[2].trim();
                    if (pkg && ver) {
                        result.set(pkg, ver);
                    }
                }
            }
        } catch (err) {
            logger.warn('UpdateReconciliationService: failed to parse policy file', {
                path: inventoryPath,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        return result;
    }

    // -------------------------------------------------------------------------
    // PendingUpdatesState builder (convenience for callers)
    // -------------------------------------------------------------------------

    buildPendingState(
        source: UpdateSource,
        candidates: UpdateCandidate[],
        ansibleExclusions: ExcludedUpdate[],
        kernelExclusions: ExcludedUpdate[],
    ): PendingUpdatesState {
        return {
            computedAt: new Date().toISOString(),
            source,
            candidates,
            ansibleExclusions,
            kernelExclusions,
            status: candidates.length > 0 ? 'available' : 'none',
        };
    }

    // -------------------------------------------------------------------------
    // Task 03: TOCTOU-safe plan builder + gated executor
    // -------------------------------------------------------------------------

    /**
     * Re-validates both filters at apply-time (TOCTOU protection) and returns an
     * ApplyPlan. This method is read-only — it never calls deviceService.updateDevice.
     */
    async buildApplyPlan(device: Device, selectedPackages: string[]): Promise<ApplyPlan> {
        // 1. Refresh profile (gets current hold state, package manager, vendor controller)
        await platformProfileService.detect(device);
        const profile = platformProfileService.getProfile(device);

        // 2. Fresh update-availability query
        const toolResult = await manageabilityService.runTool<UpdateAvailabilityData>(
            device, 'update_availability',
        );

        let freshAvailable: AvailableUpdate[] = [];
        let freshSource: UpdateSource = 'unavailable';

        if (toolResult.success && toolResult.envelope?.data) {
            const data = toolResult.envelope.data;
            freshSource = data.source;
            freshAvailable = (data.updates ?? []).map(u => ({
                package: u.package,
                currentVersion: u.current_version,
                availableVersion: u.available_version,
            }));
        }

        // 3. Re-run both filters against fresh state
        const inventoryPath = vscode.workspace
            .getConfiguration('zgxToolkit.manageability')
            .get<string>('ansibleInventoryPath', '');

        const pinnedPackages = inventoryPath
            ? await this.parsePinnedPackages(inventoryPath)
            : new Map<string, string>();

        const { candidates } = this.reconcileUpdatesWithPolicy(
            freshAvailable, freshSource, pinnedPackages, profile,
        );
        const candidateSet = new Set(candidates.map(c => c.package));

        // 4. Intersect selected ∩ current candidates
        const toApply = selectedPackages.filter(p => candidateSet.has(p));

        // 5. Classify dropped packages
        const kernelHeld = new Set(profile?.heldKernelPackages ?? []);
        const deviceHeld = new Set(profile?.heldPackages ?? []);
        const skipped: SkippedUpdate[] = selectedPackages
            .filter(p => !candidateSet.has(p))
            .map(p => {
                if (pinnedPackages.has(p)) { return { package: p, reason: 'now-pinned' as const }; }
                if (kernelHeld.has(p) || deviceHeld.has(p)) { return { package: p, reason: 'now-held' as const }; }
                return { package: p, reason: 'no-longer-available' as const };
            });

        // 6. Provider selection
        const isDgxManaged = platformProfileService.isDgxManaged(device);
        const hasVendorController = platformProfileService.hasVendorController(device);
        let provider: ApplyProvider;
        let dgxControllerAbsent = false;

        if (isDgxManaged && hasVendorController) {
            provider = 'spark_updatectl';
        } else if (isDgxManaged && !hasVendorController) {
            provider = this.nativeProvider(profile?.packageManager);
            dgxControllerAbsent = true;
        } else {
            provider = this.nativeProvider(profile?.packageManager);
        }

        // 7. Simulation (best-effort — errors are soft)
        const additionalChanges = toApply.length > 0
            ? await this.simulate(device, provider, toApply)
            : [];

        return { provider, toApply, skipped, additionalChanges, dgxControllerAbsent };
    }

    /**
     * Executes the approved plan. Persists status transitions to device metadata.
     * Returns requiresPassword: true when sudo needs a password and none was supplied.
     */
    async executeApplyPlan(
        device: Device,
        plan: ApplyPlan,
        sudoPassword?: string,
    ): Promise<ApplyResult> {
        if (plan.toApply.length === 0 || plan.provider === 'none') {
            return {
                provider: plan.provider,
                applied: [],
                skipped: plan.skipped,
                success: true,
                note: 'Nothing to apply.',
            };
        }

        // Persist 'applying' status
        await this.persistStatus(device, 'applying');

        const pkgs = plan.toApply.join(' ');
        const sudoFlags = sudoPassword ? "-S -p ''" : '-n';
        const execOpts = {
            operationName: 'updateApply:scoped',
            timeoutSeconds: APPLY_TIMEOUT_SECONDS,
            ...(sudoPassword ? { sudoPassword } : {}),
        };

        const command = this.buildApplyCommand(plan.provider, sudoFlags, pkgs);
        logger.info('executeApplyPlan: running scoped apply', {
            device: device.name, provider: plan.provider, packages: plan.toApply,
        });

        const result = await executeSSHCommand(device, command, APPLY_CONN_OPTS, execOpts);
        const output = (result.stdout ?? '').trim();
        const combined = output + ' ' + (result.stderr ?? '');

        // Detect sudo password requirement
        if (!sudoPassword && combined.includes('sudo:') && combined.includes('password')) {
            logger.info('executeApplyPlan: sudo password required', { device: device.name });
            await this.persistStatus(device, 'available');
            return {
                provider: plan.provider,
                applied: [],
                skipped: plan.skipped,
                success: false,
                requiresPassword: true,
                note: 'Sudo requires a password on this device.',
            };
        }

        if (!result.success) {
            const error = result.error?.message ?? result.stderr ?? 'SSH command failed';
            logger.error('executeApplyPlan: apply failed', { device: device.name, error });
            await this.persistStatus(device, 'error', error);
            return {
                provider: plan.provider,
                applied: [],
                skipped: plan.skipped,
                success: false,
                note: error,
            };
        }

        logger.info('executeApplyPlan: apply succeeded', {
            device: device.name, applied: plan.toApply,
        });
        await this.persistApplied(device, plan.toApply);
        return {
            provider: plan.provider,
            applied: plan.toApply,
            skipped: plan.skipped,
            success: true,
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers for Task 03
    // -------------------------------------------------------------------------

    private nativeProvider(pm: string | undefined): ApplyProvider {
        if (pm === 'apt') { return 'apt'; }
        if (pm === 'dnf') { return 'dnf'; }
        if (pm === 'zypper') { return 'zypper'; }
        return 'none';
    }

    private buildApplyCommand(provider: ApplyProvider, sudoFlags: string, pkgs: string): string {
        switch (provider) {
            case 'apt':
                return `sudo ${sudoFlags} apt-get install --only-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" ${pkgs} 2>&1`;
            case 'dnf':
                return `sudo ${sudoFlags} dnf upgrade -y ${pkgs} 2>&1`;
            case 'zypper':
                return `sudo ${sudoFlags} zypper --non-interactive update ${pkgs} 2>&1`;
            case 'spark_updatectl':
                // Forward-looking — update path when CLI is confirmed on a device with controller.
                return `sudo ${sudoFlags} /usr/local/lib/DGX_spark_management/bin/spark_updatectl.py update ${pkgs} 2>&1`;
            default:
                return '';
        }
    }

    private async simulate(
        device: Device,
        provider: ApplyProvider,
        toApply: string[],
    ): Promise<string[]> {
        const pkgs = toApply.join(' ');
        const toApplySet = new Set(toApply);
        let simCmd = '';

        try {
            if (provider === 'apt') {
                simCmd = `apt-get install --only-upgrade -s ${pkgs} 2>&1`;
            } else if (provider === 'dnf') {
                simCmd = `dnf upgrade --assumeno ${pkgs} 2>&1`;
            } else if (provider === 'zypper') {
                simCmd = `zypper --non-interactive update --dry-run ${pkgs} 2>&1`;
            } else {
                return [];
            }

            const simResult = await executeSSHCommand(
                device, simCmd, APPLY_CONN_OPTS,
                { operationName: 'updateApply:simulate', timeoutSeconds: 60 },
            );
            const lines = (simResult.stdout ?? '').split('\n');
            const extra: string[] = [];

            if (provider === 'apt') {
                for (const line of lines) {
                    const m = line.match(/^Inst (\S+)/);
                    if (m && !toApplySet.has(m[1])) { extra.push(m[1]); }
                }
            } else {
                // dnf / zypper: collect package tokens that aren't in toApply
                let inBlock = false;
                for (const line of lines) {
                    if (/^(Upgrading|Installing|Updating)\s*:/i.test(line)) { inBlock = true; continue; }
                    if (inBlock && /^\S/.test(line) && !/^(Upgrading|Installing|Updating)\s*:/i.test(line)) { inBlock = false; }
                    if (inBlock) {
                        const token = line.trim().split(/\s+/)[0];
                        if (token && !toApplySet.has(token)) { extra.push(token); }
                    }
                }
            }

            return [...new Set(extra)];
        } catch (err) {
            logger.debug('updateApply:simulate: soft failure', {
                device: device.name,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    private async persistStatus(
        device: Device,
        status: PendingUpdatesState['status'],
        note?: string,
    ): Promise<void> {
        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        if (!pending) { return; }
        const updated: PendingUpdatesState = { ...pending, status };
        if (note !== undefined) { (updated as any).note = note; }
        await deviceService.updateDevice(device.id, {
            metadata: { ...device.metadata, pendingUpdates: updated },
        });
    }

    private async persistApplied(device: Device, applied: string[]): Promise<void> {
        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        if (!pending) { return; }
        const appliedSet = new Set(applied);
        const updated: PendingUpdatesState = {
            ...pending,
            status: 'applied',
            candidates: pending.candidates.filter(c => !appliedSet.has(c.package)),
        };
        await deviceService.updateDevice(device.id, {
            metadata: { ...device.metadata, pendingUpdates: updated },
        });
    }
}

export const updateReconciliationService = new UpdateReconciliationService();
