/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { Device } from '../types/devices';
import { PlatformProfile } from '../types/platformProfile';
import {
    AvailableUpdate,
    ExcludedUpdate,
    PendingUpdatesState,
    UpdateCandidate,
    UpdateSource,
} from '../types/scheduledUpdates';
import { CheckupResult } from '../types/scheduledUpdates';
import { platformProfileService } from './platformProfileService';
import { logger } from '../utils/logger';

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
}

export const updateReconciliationService = new UpdateReconciliationService();
