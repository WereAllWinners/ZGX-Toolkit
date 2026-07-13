/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { Device } from '../types/devices';
import { PlatformProfile } from '../types/platformProfile';
import {
    ApplyPlan,
    ApplyProvider,
    ApplyResult,
    ApplyScope,
    AvailableUpdate,
    ExcludedUpdate,
    FirmwareAvailableUpdate,
    FirmwareCandidate,
    PendingUpdatesState,
    SkippedUpdate,
    UpdateCandidate,
    UpdateSource,
} from '../types/scheduledUpdates';
import { CheckupResult } from '../types/scheduledUpdates';
import { FirmwareUpdateAvailabilityData, UpdateAvailabilityData } from '../types/manageability';
import { platformProfileService } from './platformProfileService';
import { manageabilityService } from './manageabilityService';
import { deviceService } from './deviceService';
import { executeSSHCommand } from '../utils/sshConnection';
import { logger } from '../utils/logger';
import { redactSudoOutput } from '../utils/string';
import { assertValidPackageNames } from '../utils/packageName';

const APPLY_CONN_OPTS = { readyTimeout: 5000 };
const APPLY_TIMEOUT_SECONDS = 300;

export class UpdateReconciliationService {

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Read the Ansible policy file, apply the two pre-filters (ansible-pinned,
     * device/kernel-held), and return the split ready to persist.
     */
    async reconcile(device: Device): Promise<{
        candidates: UpdateCandidate[];
        ansibleExclusions: ExcludedUpdate[];
        kernelExclusions: ExcludedUpdate[];
        firmwareCandidates: FirmwareCandidate[];
        firmwareExclusions: ExcludedUpdate[];
    }> {
        const lastCheckup = device.metadata?.lastCheckup as CheckupResult | undefined;
        const available = lastCheckup?.availableUpdates ?? [];
        const source: UpdateSource = lastCheckup?.source ?? 'unavailable';
        const availableFirmware: FirmwareAvailableUpdate[] = lastCheckup?.availableFirmwareUpdates ?? [];

        const inventoryPath = vscode.workspace
            .getConfiguration('zgxToolkit.manageability')
            .get<string>('ansibleInventoryPath', '');

        const pinnedPackages = await this.resolvePinnedPackages(inventoryPath, device);

        const profile = platformProfileService.getProfile(device);

        const packageResult = this.reconcileUpdatesWithPolicy(available, source, pinnedPackages, profile);
        const firmwareResult = this.reconcileFirmwareWithPolicy(availableFirmware, pinnedPackages);

        return {
            ...packageResult,
            firmwareCandidates: firmwareResult.firmwareCandidates,
            firmwareExclusions: firmwareResult.firmwareExclusions,
        };
    }

    /**
     * Filter firmware updates through the Ansible pinning check.
     * Kernel/device holds do NOT apply to firmware.
     */
    reconcileFirmwareWithPolicy(
        available: FirmwareAvailableUpdate[],
        pinnedPackages: Map<string, string>,
    ): {
        firmwareCandidates: FirmwareCandidate[];
        firmwareExclusions: ExcludedUpdate[];
    } {
        const firmwareCandidates: FirmwareCandidate[] = [];
        const firmwareExclusions: ExcludedUpdate[] = [];

        for (const u of available) {
            if (pinnedPackages.has(u.package)) {
                firmwareExclusions.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    reason: 'ansible-pinned',
                    heldOrPinnedVersion: pinnedPackages.get(u.package)!,
                });
            } else {
                firmwareCandidates.push({
                    package: u.package,
                    currentVersion: u.currentVersion,
                    availableVersion: u.availableVersion,
                    source: u.source,
                    requiresReboot: u.requiresReboot,
                    deviceLabel: u.deviceLabel,
                });
            }
        }

        return { firmwareCandidates, firmwareExclusions };
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
     * Parse a ZGX Ansible-style YAML policy file for pinned package versions.
     *
     * Expected format (top-level `pinned_packages` mapping of package name to
     * pinned version — see docs/manageability.md for the full schema):
     *   pinned_packages:
     *     cuda-toolkit: "12.0.0"
     *     nvidia-driver: 550.54.15
     *
     * Fail-closed: a missing file is not an error (no policy configured is a
     * legitimate, common state) and silently yields an empty map, as does a
     * file that parses but has no `pinned_packages` key. A file that EXISTS
     * but cannot be parsed as YAML, or whose `pinned_packages` isn't a flat
     * string/number-valued mapping, THROWS — callers must not treat "couldn't
     * parse the policy" the same as "nothing is pinned".
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

        let parsed: unknown;
        try {
            // load() (not loadAll()) deliberately rejects multi-document
            // streams rather than silently picking one.
            parsed = yaml.load(content);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('UpdateReconciliationService: Ansible policy file is not valid YAML', {
                path: inventoryPath, error: message,
            });
            throw new Error(`Ansible policy file at ${inventoryPath} could not be parsed as YAML: ${message}`);
        }

        if (parsed == null) {
            // Genuinely empty/blank file — no policy configured, not an error.
            return result;
        }

        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Ansible policy file at ${inventoryPath}: expected a YAML mapping at the top level.`);
        }

        const pinnedRaw = (parsed as Record<string, unknown>).pinned_packages;
        if (pinnedRaw == null) {
            // No pinned_packages key — legitimately nothing pinned via this file.
            return result;
        }
        if (typeof pinnedRaw !== 'object' || Array.isArray(pinnedRaw)) {
            throw new Error(`Ansible policy file at ${inventoryPath}: 'pinned_packages' must be a mapping of package name to version.`);
        }

        for (const [pkg, ver] of Object.entries(pinnedRaw as Record<string, unknown>)) {
            if (typeof ver === 'string' || typeof ver === 'number') {
                result.set(pkg, String(ver));
            } else {
                throw new Error(`Ansible policy file at ${inventoryPath}: 'pinned_packages.${pkg}' must be a string or number version, got ${typeof ver}.`);
            }
        }

        return result;
    }

    /**
     * Resolve the pinned-packages map for a device, blocking (with a visible
     * notification) rather than silently proceeding as "nothing is pinned"
     * when the configured policy file exists but can't be parsed. An empty
     * `inventoryPath` (no policy configured) is not an error.
     */
    private async resolvePinnedPackages(inventoryPath: string, device: Device): Promise<Map<string, string>> {
        if (!inventoryPath) {
            return new Map<string, string>();
        }
        try {
            return await this.parsePinnedPackages(inventoryPath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('UpdateReconciliationService: Ansible policy file could not be parsed — blocking to avoid silently applying unpinned packages', {
                device: device.name, path: inventoryPath, error: message,
            });
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Ansible policy file could not be parsed (${message}). Blocking this operation for ${device.name} rather than risk applying an update that should have been pinned.`,
            );
            throw new Error(`Ansible policy file could not be parsed: ${message}`);
        }
    }

    // -------------------------------------------------------------------------
    // PendingUpdatesState builder (convenience for callers)
    // -------------------------------------------------------------------------

    buildPendingState(
        source: UpdateSource,
        candidates: UpdateCandidate[],
        ansibleExclusions: ExcludedUpdate[],
        kernelExclusions: ExcludedUpdate[],
        firmwareCandidates: FirmwareCandidate[] = [],
        firmwareExclusions: ExcludedUpdate[] = [],
        firmwareSource?: UpdateSource,
    ): PendingUpdatesState {
        return {
            computedAt: new Date().toISOString(),
            source,
            candidates,
            ansibleExclusions,
            kernelExclusions,
            status: candidates.length > 0 ? 'available' : 'none',
            firmwareCandidates,
            firmwareExclusions,
            firmwareStatus: firmwareCandidates.length > 0 ? 'available' : 'none',
            firmwareSource,
        };
    }

    // -------------------------------------------------------------------------
    // Task 03: TOCTOU-safe plan builder + gated executor
    // -------------------------------------------------------------------------

    /**
     * Re-validates both filters at apply-time (TOCTOU protection) and returns an
     * ApplyPlan. This method is read-only — it never calls deviceService.updateDevice.
     *
     * @param selectedFirmware  fwupd DeviceIds / apt package names to apply
     * @param scope             'packages' | 'firmware' | 'all'
     */
    async buildApplyPlan(
        device: Device,
        selectedPackages: string[],
        selectedFirmware: string[] = [],
        scope: ApplyScope = 'packages',
    ): Promise<ApplyPlan> {
        // 1. Refresh profile (gets current hold state, package manager, vendor controller)
        await platformProfileService.detect(device);
        const profile = platformProfileService.getProfile(device);

        const inventoryPath = vscode.workspace
            .getConfiguration('zgxToolkit.manageability')
            .get<string>('ansibleInventoryPath', '');

        const pinnedPackages = await this.resolvePinnedPackages(inventoryPath, device);

        // 2. Package path: fresh update-availability query + re-filters
        let freshAvailable: AvailableUpdate[] = [];
        let freshSource: UpdateSource = 'unavailable';
        let toApply: string[] = [];
        let skipped: SkippedUpdate[] = [];
        let provider: ApplyProvider = 'none';
        let dgxControllerAbsent = false;
        let additionalChanges: string[] = [];

        if (scope !== 'firmware') {
            const toolResult = await manageabilityService.runTool<UpdateAvailabilityData>(
                device, 'update_availability',
            );

            if (toolResult.success && toolResult.envelope?.data) {
                const data = toolResult.envelope.data;
                freshSource = data.source;
                freshAvailable = (data.updates ?? []).map(u => ({
                    package: u.package,
                    currentVersion: u.current_version,
                    availableVersion: u.available_version,
                }));
            }

            // Re-run both filters against fresh state
            const { candidates } = this.reconcileUpdatesWithPolicy(
                freshAvailable, freshSource, pinnedPackages, profile,
            );
            const candidateSet = new Set(candidates.map(c => c.package));

            // Intersect selected ∩ current candidates
            toApply = selectedPackages.filter(p => candidateSet.has(p));

            // Classify dropped packages
            const kernelHeld = new Set(profile?.heldKernelPackages ?? []);
            const deviceHeld = new Set(profile?.heldPackages ?? []);
            skipped = selectedPackages
                .filter(p => !candidateSet.has(p))
                .map(p => {
                    if (pinnedPackages.has(p)) { return { package: p, reason: 'now-pinned' as const }; }
                    if (kernelHeld.has(p) || deviceHeld.has(p)) { return { package: p, reason: 'now-held' as const }; }
                    return { package: p, reason: 'no-longer-available' as const };
                });

            // Provider selection
            const isDgxManaged = platformProfileService.isDgxManaged(device);
            const hasVendorController = platformProfileService.hasVendorController(device);

            if (isDgxManaged && hasVendorController) {
                provider = 'spark_updatectl';
            } else if (isDgxManaged && !hasVendorController) {
                provider = this.nativeProvider(profile?.packageManager);
                dgxControllerAbsent = true;
            } else {
                provider = this.nativeProvider(profile?.packageManager);
            }

            // Simulation (best-effort — errors are soft)
            additionalChanges = toApply.length > 0
                ? await this.simulate(device, provider, toApply)
                : [];
        }

        // 3. Firmware path: fresh firmware query + Ansible filter
        let toApplyFirmware: FirmwareCandidate[] = [];
        let firmwareProvider: 'fwupd' | 'apt' | 'none' = 'none';
        let firmwareRequiresReboot = false;

        if (scope !== 'packages' && selectedFirmware.length > 0) {
            const fwToolResult = await manageabilityService.runTool<FirmwareUpdateAvailabilityData>(
                device, 'firmware_update_availability',
            );

            if (fwToolResult.success && fwToolResult.envelope?.data) {
                const fwData = fwToolResult.envelope.data;
                const freshFirmware: FirmwareAvailableUpdate[] = (fwData.updates ?? []).map(u => ({
                    package: u.package,
                    deviceLabel: u.device_name ?? u.package,
                    currentVersion: u.current_version,
                    availableVersion: u.available_version,
                    source: (u.source === 'fwupd' ? 'fwupd' : 'apt-firmware') as 'fwupd' | 'apt-firmware',
                    requiresReboot: !!u.requires_reboot,
                    summary: u.summary,
                }));

                const { firmwareCandidates } = this.reconcileFirmwareWithPolicy(freshFirmware, pinnedPackages);
                const fwCandidateSet = new Set(firmwareCandidates.map(c => c.package));
                toApplyFirmware = firmwareCandidates.filter(c => fwCandidateSet.has(c.package) && selectedFirmware.includes(c.package));

                if (toApplyFirmware.some(f => f.source === 'fwupd')) {
                    firmwareProvider = 'fwupd';
                } else if (toApplyFirmware.length > 0) {
                    firmwareProvider = 'apt';
                }

                firmwareRequiresReboot = toApplyFirmware.some(f => f.requiresReboot);
            }
        }

        return {
            provider,
            toApply,
            skipped,
            additionalChanges,
            dgxControllerAbsent,
            scope,
            toApplyFirmware,
            firmwareProvider,
            firmwareRequiresReboot,
        };
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
        const redact = (s: string) => redactSudoOutput(s, sudoPassword);
        const toApplyFirmware = plan.toApplyFirmware ?? [];
        const firmwareProvider = plan.firmwareProvider ?? 'none';
        const hasPackages = plan.toApply.length > 0 && plan.provider !== 'none';
        const hasFirmware = toApplyFirmware.length > 0 && firmwareProvider !== 'none';

        if (!hasPackages && !hasFirmware) {
            return {
                provider: plan.provider,
                applied: [],
                skipped: plan.skipped,
                success: true,
                note: 'Nothing to apply.',
                firmwareApplied: [],
                firmwareSuccess: true,
            };
        }

        // Reject the entire apply if any selected package/firmware token isn't a
        // plausible package name — abort rather than silently dropping the bad
        // token(s), which could mask an attack or a corrupted candidate list.
        try {
            assertValidPackageNames(plan.toApply);
            assertValidPackageNames(toApplyFirmware.map(f => f.package));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('executeApplyPlan: rejected invalid package/firmware name', { device: device.name, error: message });
            return {
                provider: plan.provider,
                applied: [],
                skipped: plan.skipped,
                success: false,
                note: message,
                firmwareApplied: [],
                firmwareSuccess: false,
            };
        }

        const sudoFlags = sudoPassword ? "-S -p ''" : '-n';
        const execOpts = {
            operationName: 'updateApply:scoped',
            timeoutSeconds: APPLY_TIMEOUT_SECONDS,
            ...(sudoPassword ? { sudoPassword, sendSudoPassword: true } : {}),
        };

        let packageSuccess = !hasPackages;
        let applied: string[] = [];
        let pkgNote: string | undefined;

        // ── Package apply ────────────────────────────────────────────────────────
        if (hasPackages) {
            await this.persistStatus(device, 'applying');

            const pkgs = plan.toApply.join(' ');
            const command = this.buildApplyCommand(plan.provider, sudoFlags, pkgs);
            logger.info('executeApplyPlan: running scoped apply', {
                device: device.name, provider: plan.provider, packages: plan.toApply,
            });

            const result = await executeSSHCommand(device, command, APPLY_CONN_OPTS, execOpts);
            const output = (result.stdout ?? '').trim();
            const combined = output + ' ' + (result.stderr ?? '');

            // Detect sudo password requirement — bail out early (firmware not attempted yet)
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
                    firmwareApplied: [],
                    firmwareSuccess: false,
                };
            }

            if (!result.success) {
                const error = redact(result.error?.message ?? result.stderr ?? 'SSH command failed');
                logger.error('executeApplyPlan: package apply failed', { device: device.name, error });
                await this.persistStatus(device, 'error', error);
                return {
                    provider: plan.provider,
                    applied: [],
                    skipped: plan.skipped,
                    success: false,
                    note: error,
                    firmwareApplied: [],
                    firmwareSuccess: false,
                };
            }

            logger.info('executeApplyPlan: package apply succeeded', {
                device: device.name, applied: plan.toApply,
            });
            await this.persistApplied(device, plan.toApply);
            packageSuccess = true;
            applied = plan.toApply;
        }

        // ── Firmware apply (soft — package success is not rolled back on firmware failure) ──
        const firmwareApplied: string[] = [];
        let firmwareSuccess = !hasFirmware;

        if (hasFirmware) {
            await this.persistFirmwareStatus(device, 'applying');
            const fwCommand = this.buildFirmwareApplyCommand(firmwareProvider, sudoFlags);

            logger.info('executeApplyPlan: running firmware apply', {
                device: device.name, provider: firmwareProvider,
                firmware: toApplyFirmware.map(f => f.package),
            });

            const fwResult = await executeSSHCommand(device, fwCommand, APPLY_CONN_OPTS, {
                ...execOpts,
                operationName: 'updateApply:firmware',
            });

            // fwupdmgr exits 2 when nothing updated (race-condition after checkup) — treat as success
            const fwExitSuccess = fwResult.success || (fwResult.stderr ?? '').includes('LVFS: Nothing to do');

            if (fwExitSuccess) {
                firmwareSuccess = true;
                firmwareApplied.push(...toApplyFirmware.map(f => f.package));
                await this.persistFirmwareApplied(device, firmwareApplied);
                logger.info('executeApplyPlan: firmware apply succeeded', { device: device.name });
            } else {
                const fwError = redact(fwResult.error?.message ?? fwResult.stderr ?? 'Firmware apply failed');
                logger.error('executeApplyPlan: firmware apply failed', { device: device.name, error: fwError });
                await this.persistFirmwareStatus(device, 'error');
                pkgNote = pkgNote ? `${pkgNote}; firmware: ${fwError}` : `Firmware: ${fwError}`;
            }
        }

        return {
            provider: plan.provider,
            applied,
            skipped: plan.skipped,
            success: packageSuccess,
            note: pkgNote,
            firmwareApplied,
            firmwareSuccess,
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers for Task 03
    // -------------------------------------------------------------------------

    private buildFirmwareApplyCommand(provider: 'fwupd' | 'apt' | 'none', sudoFlags: string): string {
        if (provider === 'fwupd') {
            return `sudo ${sudoFlags} fwupdmgr update -y --no-reboot-check 2>&1`;
        }
        // apt-firmware: handled by including packages in the package apply command
        return '';
    }

    private async persistFirmwareStatus(
        device: Device,
        status: PendingUpdatesState['firmwareStatus'],
    ): Promise<void> {
        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        if (!pending) { return; }
        const updated: PendingUpdatesState = { ...pending, firmwareStatus: status };
        await deviceService.mergeDeviceMetadata(device.id, { pendingUpdates: updated });
    }

    private async persistFirmwareApplied(device: Device, applied: string[]): Promise<void> {
        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        if (!pending) { return; }
        const appliedSet = new Set(applied);
        const updated: PendingUpdatesState = {
            ...pending,
            firmwareStatus: 'applied',
            firmwareCandidates: (pending.firmwareCandidates ?? []).filter(c => !appliedSet.has(c.package)),
        };
        await deviceService.mergeDeviceMetadata(device.id, { pendingUpdates: updated });
    }

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
        // Validate before the soft-fail try block below — a malicious name must
        // abort the whole plan, not be swallowed as an ordinary simulate() error
        // (e.g. a transient SSH failure), since toApply here only guarantees a
        // match against the device's own self-reported candidate set, which
        // isn't trustworthy on an already-compromised device.
        assertValidPackageNames(toApply);

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
        await deviceService.mergeDeviceMetadata(device.id, { pendingUpdates: updated });
    }

    private async persistApplied(device: Device, applied: string[]): Promise<void> {
        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        if (!pending) { return; }
        const appliedSet = new Set(applied);
        const remaining = pending.candidates.filter(c => !appliedSet.has(c.package));
        const updated: PendingUpdatesState = {
            ...pending,
            status: remaining.length > 0 ? 'available' : 'applied',
            candidates: remaining,
        };
        await deviceService.mergeDeviceMetadata(device.id, { pendingUpdates: updated });
    }
}

export const updateReconciliationService = new UpdateReconciliationService();
