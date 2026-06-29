/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for Task 03: UpdateReconciliationService.buildApplyPlan() and
 * .executeApplyPlan() — TOCTOU re-validation, provider selection, scoped apply
 * commands, status transitions, and structural safety.
 */

import { UpdateReconciliationService } from '../../services/updateReconciliationService';
import { Device } from '../../types/devices';
import { ApplyPlan, PendingUpdatesState } from '../../types/scheduledUpdates';
import { PlatformProfile } from '../../types/platformProfile';

jest.mock('vscode');

jest.mock('../../utils/sshConnection', () => ({
    executeSSHCommand: jest.fn(),
}));

jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
    },
}));

jest.mock('../../services/manageabilityService', () => ({
    manageabilityService: {
        runTool: jest.fn(),
    },
}));

jest.mock('../../services/platformProfileService', () => ({
    platformProfileService: {
        detect: jest.fn().mockResolvedValue({}),
        getProfile: jest.fn(),
        isDgxManaged: jest.fn().mockReturnValue(false),
        hasVendorController: jest.fn().mockReturnValue(false),
    },
}));

jest.mock('../../services/deviceService', () => ({
    deviceService: {
        updateDevice: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { executeSSHCommand } from '../../utils/sshConnection';
import { manageabilityService } from '../../services/manageabilityService';
import { platformProfileService } from '../../services/platformProfileService';
import { deviceService } from '../../services/deviceService';
import { scheduledCheckupService } from '../../services/scheduledCheckupService';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<PlatformProfile> = {}): PlatformProfile {
    return {
        detectedAt: '2026-06-28T00:00:00Z',
        manufacturer: 'NVIDIA',
        productName: 'DGX Spark',
        isHpDevice: false,
        arch: 'arm64',
        cpu: { vendor: 'nvidia-grace', model: 'Grace', coresLogical: 72 },
        os: { id: 'ubuntu', idLike: 'debian', versionId: '22.04', prettyName: 'Ubuntu 22.04', family: 'debian' },
        isDgxOs: true,
        dgxRelease: '1.0',
        packageManager: 'apt',
        kernel: { release: '5.15.0', flavor: 'dgx' },
        gpu: { vendor: 'nvidia', computeStack: 'cuda', computeStackVersion: '12.0', memoryModel: 'unified', driverBranch: '550' },
        heldPackages: [],
        heldKernelPackages: [],
        vendorController: { sparkUpdatectl: false },
        ...overrides,
    };
}

function makeDevice(metaOverrides: Record<string, any> = {}): Device {
    const pending: PendingUpdatesState = {
        computedAt: '2026-06-28T10:00:00Z',
        source: 'apt',
        candidates: [],
        ansibleExclusions: [],
        kernelExclusions: [],
        status: 'available',
    };
    return {
        id: 'dev-001',
        name: 'zgx-nano',
        host: '10.0.0.1',
        username: 'nvidia',
        port: 22,
        isSetup: true,
        useKeyAuth: true,
        keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt: '2026-06-28T00:00:00Z',
        metadata: { pendingUpdates: pending, ...metaOverrides },
    } as Device;
}

function makeToolResult(packages: Array<{ pkg: string; cur: string; avail: string }> = []) {
    return {
        success: true,
        envelope: {
            tool: 'update-availability',
            timestamp: '2026-06-28T10:00:00Z',
            status: 'ok',
            data: {
                source: 'apt',
                // eslint-disable-next-line @typescript-eslint/naming-convention
                updates: packages.map(p => ({ package: p.pkg, current_version: p.cur, available_version: p.avail })),
            },
        },
        rawOutput: '',
    };
}

function makeSshResult(stdout: string, success = true) {
    return { success, stdout, stderr: '', exitCode: success ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateReconciliationService — Task 03', () => {
    let service: UpdateReconciliationService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new UpdateReconciliationService();

        // Default vscode config: no Ansible policy path
        const vscode = require('vscode');
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockReturnValue(''),
        });

        // Default: plain apt device, not DGX-managed
        (platformProfileService.detect as jest.Mock).mockResolvedValue({});
        (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile());
        (platformProfileService.isDgxManaged as jest.Mock).mockReturnValue(false);
        (platformProfileService.hasVendorController as jest.Mock).mockReturnValue(false);

        // Simulation succeeds with no additional packages by default
        (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult(''));
    });

    // =========================================================================
    // buildApplyPlan() — re-validation
    // =========================================================================

    describe('buildApplyPlan() — TOCTOU re-validation', () => {
        it('keeps a package that is still a valid candidate', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.toApply).toContain('curl');
            expect(plan.skipped).toHaveLength(0);
        });

        it('drops a package re-pinned by Ansible with reason now-pinned', async () => {
            const vscode = require('vscode');
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('/policy.yml'),
            });
            (fs.promises.readFile as jest.Mock).mockResolvedValue(
                'pinned_packages:\n  curl: "7.0"\n',
            );
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.toApply).not.toContain('curl');
            expect(plan.skipped).toContainEqual(
                expect.objectContaining({ package: 'curl', reason: 'now-pinned' }),
            );
        });

        it('drops a package now held on the device with reason now-held', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(
                makeProfile({ heldPackages: ['curl'] }),
            );
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            // curl is in heldPackages — it gets routed to kernelExclusions, not candidates
            expect(plan.toApply).not.toContain('curl');
            expect(plan.skipped).toContainEqual(
                expect.objectContaining({ package: 'curl', reason: 'now-held' }),
            );
        });

        it('drops a package no longer in the available set with reason no-longer-available', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([]),  // curl has been installed already / no longer upgradable
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.toApply).not.toContain('curl');
            expect(plan.skipped).toContainEqual(
                expect.objectContaining({ package: 'curl', reason: 'no-longer-available' }),
            );
        });

        it('handles multiple packages with mixed fates correctly', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([
                    { pkg: 'curl', cur: '7.0', avail: '8.0' },
                    // openssl gone from available
                ]),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl', 'openssl']);

            expect(plan.toApply).toEqual(['curl']);
            expect(plan.skipped).toContainEqual(
                expect.objectContaining({ package: 'openssl', reason: 'no-longer-available' }),
            );
        });
    });

    // =========================================================================
    // buildApplyPlan() — provider selection
    // =========================================================================

    describe('buildApplyPlan() — provider selection', () => {
        beforeEach(() => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );
        });

        it('selects spark_updatectl when DGX-managed and controller present', async () => {
            (platformProfileService.isDgxManaged as jest.Mock).mockReturnValue(true);
            (platformProfileService.hasVendorController as jest.Mock).mockReturnValue(true);

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.provider).toBe('spark_updatectl');
            expect(plan.dgxControllerAbsent).toBe(false);
        });

        it('selects native PM and sets dgxControllerAbsent when DGX-managed without controller', async () => {
            (platformProfileService.isDgxManaged as jest.Mock).mockReturnValue(true);
            (platformProfileService.hasVendorController as jest.Mock).mockReturnValue(false);
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile({ packageManager: 'apt' }));

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.provider).toBe('apt');
            expect(plan.dgxControllerAbsent).toBe(true);
        });

        it('selects apt for a generic apt device', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile({ packageManager: 'apt' }));

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.provider).toBe('apt');
            expect(plan.dgxControllerAbsent).toBe(false);
        });

        it('selects dnf for a dnf device', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(
                makeProfile({ packageManager: 'dnf', isDgxOs: false }),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.provider).toBe('dnf');
        });

        it('selects none when packageManager is unknown and no controller', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(
                makeProfile({ packageManager: 'unknown' as any, isDgxOs: false }),
            );

            const plan = await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(plan.provider).toBe('none');
        });
    });

    // =========================================================================
    // buildApplyPlan() — read-only guarantee
    // =========================================================================

    describe('buildApplyPlan() — read-only guarantee', () => {
        it('does not call deviceService.updateDevice', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );

            await service.buildApplyPlan(makeDevice(), ['curl']);

            expect(deviceService.updateDevice).not.toHaveBeenCalled();
        });

        it('only runs the simulation SSH command (no state-changing commands)', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeToolResult([{ pkg: 'curl', cur: '7.0', avail: '8.0' }]),
            );
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile({ packageManager: 'apt' }));

            await service.buildApplyPlan(makeDevice(), ['curl']);

            const calls = (executeSSHCommand as jest.Mock).mock.calls;
            // All SSH calls during buildApplyPlan must be simulation-only
            for (const [, cmd] of calls) {
                expect(cmd).toMatch(/(-s|--assumeno|--dry-run)/);
                // Must not be a blanket upgrade (no args after subcommand end)
                expect(cmd).not.toMatch(/apt(-get)?\s+(full-upgrade|dist-upgrade)\s/);
            }
        });
    });

    // =========================================================================
    // executeApplyPlan() — command correctness
    // =========================================================================

    describe('executeApplyPlan() — scoped apply commands', () => {
        function makeMinimalPlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
            return {
                provider: 'apt',
                toApply: ['curl'],
                skipped: [],
                additionalChanges: [],
                dgxControllerAbsent: false,
                ...overrides,
            };
        }

        it('issues apt-get install --only-upgrade (not full-upgrade or dist-upgrade)', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('0 upgraded'));

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan({ provider: 'apt' }));

            const cmd = (executeSSHCommand as jest.Mock).mock.calls[0][1] as string;
            expect(cmd).toContain('install --only-upgrade');
            expect(cmd).toContain('curl');
            expect(cmd).not.toMatch(/apt(-get)?\s+(full-upgrade|dist-upgrade|upgrade)\s*2>&1$/);
        });

        it('issues dnf upgrade -y with package name (not bare dnf upgrade)', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('Complete!'));

            await service.executeApplyPlan(
                makeDevice(),
                makeMinimalPlan({ provider: 'dnf', toApply: ['curl'] }),
            );

            const cmd = (executeSSHCommand as jest.Mock).mock.calls[0][1] as string;
            expect(cmd).toMatch(/dnf upgrade -y curl/);
            expect(cmd).not.toMatch(/dnf upgrade -y\s*2>&1$/);
        });

        it('issues zypper --non-interactive update with package name', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('Nothing to do'));

            await service.executeApplyPlan(
                makeDevice(),
                makeMinimalPlan({ provider: 'zypper', toApply: ['curl'] }),
            );

            const cmd = (executeSSHCommand as jest.Mock).mock.calls[0][1] as string;
            expect(cmd).toMatch(/zypper --non-interactive update curl/);
            expect(cmd).not.toMatch(/zypper --non-interactive update\s*2>&1$/);
        });

        it('returns success without SSH call when toApply is empty', async () => {
            const result = await service.executeApplyPlan(
                makeDevice(),
                makeMinimalPlan({ toApply: [] }),
            );

            expect(result.success).toBe(true);
            expect(result.applied).toHaveLength(0);
            expect(executeSSHCommand).not.toHaveBeenCalled();
        });

        it('returns success without SSH call when provider is none', async () => {
            const result = await service.executeApplyPlan(
                makeDevice(),
                makeMinimalPlan({ provider: 'none', toApply: ['curl'] }),
            );

            expect(result.success).toBe(true);
            expect(executeSSHCommand).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // executeApplyPlan() — status transitions
    // =========================================================================

    describe('executeApplyPlan() — status transitions', () => {
        function makeMinimalPlan(): ApplyPlan {
            return { provider: 'apt', toApply: ['curl'], skipped: [], additionalChanges: [], dgxControllerAbsent: false };
        }

        it('writes applying then applied on success', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('0 upgraded, 1 newly installed'));

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan());

            const calls = (deviceService.updateDevice as jest.Mock).mock.calls;
            expect(calls[0][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'applying' }),
                }),
            });
            expect(calls[1][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'applied' }),
                }),
            });
        });

        it('writes applying then error on SSH failure', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(
                makeSshResult('dpkg error', false),
            );

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan());

            const calls = (deviceService.updateDevice as jest.Mock).mock.calls;
            expect(calls[0][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'applying' }),
                }),
            });
            expect(calls[1][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'error' }),
                }),
            });
        });

        it('writes applying then restores available when requiresPassword', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(
                makeSshResult('sudo: a password is required password', false),
            );

            const result = await service.executeApplyPlan(makeDevice(), makeMinimalPlan());

            expect(result.requiresPassword).toBe(true);
            const calls = (deviceService.updateDevice as jest.Mock).mock.calls;
            expect(calls[0][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'applying' }),
                }),
            });
            expect(calls[1][1]).toMatchObject({
                metadata: expect.objectContaining({
                    pendingUpdates: expect.objectContaining({ status: 'available' }),
                }),
            });
        });
    });

    // =========================================================================
    // executeApplyPlan() — password flow
    // =========================================================================

    describe('executeApplyPlan() — password flow', () => {
        function makeMinimalPlan(): ApplyPlan {
            return { provider: 'apt', toApply: ['curl'], skipped: [], additionalChanges: [], dgxControllerAbsent: false };
        }

        it('returns requiresPassword: true when stdout contains sudo: and password', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(
                makeSshResult('sudo: a password is required password', false),
            );

            const result = await service.executeApplyPlan(makeDevice(), makeMinimalPlan());

            expect(result.requiresPassword).toBe(true);
            expect(result.success).toBe(false);
        });

        it('passes sudoPassword to executeSSHCommand on retry', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('0 upgraded'));

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan(), 'hunter2');

            const execOpts = (executeSSHCommand as jest.Mock).mock.calls[0][3];
            expect(execOpts.sudoPassword).toBe('hunter2');
        });

        it('uses sudo -S flags when password is supplied', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('0 upgraded'));

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan(), 'mypassword');

            const cmd = (executeSSHCommand as jest.Mock).mock.calls[0][1] as string;
            expect(cmd).toContain("-S -p ''");
        });

        it('uses sudo -n flags when no password is supplied', async () => {
            (executeSSHCommand as jest.Mock).mockResolvedValue(makeSshResult('0 upgraded'));

            await service.executeApplyPlan(makeDevice(), makeMinimalPlan());

            const cmd = (executeSSHCommand as jest.Mock).mock.calls[0][1] as string;
            expect(cmd).toContain('sudo -n');
        });
    });

    // =========================================================================
    // Structural safety: scheduledCheckupService has no apply surface
    // =========================================================================

    describe('structural safety', () => {
        it('scheduledCheckupService exposes no apply methods', () => {
            const svc = scheduledCheckupService as any;
            expect(svc.buildApplyPlan).toBeUndefined();
            expect(svc.executeApplyPlan).toBeUndefined();
            expect(svc.applySelected).toBeUndefined();
            expect(svc.applyUpdates).toBeUndefined();
        });
    });
});
