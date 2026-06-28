/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as fs from 'fs';
import { UpdateReconciliationService } from '../../services/updateReconciliationService';
import { AvailableUpdate, UpdateSource } from '../../types/scheduledUpdates';
import { PlatformProfile } from '../../types/platformProfile';
import { Device } from '../../types/devices';

jest.mock('vscode');

jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
    },
}));

jest.mock('../../services/platformProfileService', () => ({
    platformProfileService: {
        getProfile: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info:  jest.fn(),
        warn:  jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { platformProfileService } from '../../services/platformProfileService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpdate(pkg: string, cur = '1.0.0', avail = '2.0.0'): AvailableUpdate {
    return { package: pkg, currentVersion: cur, availableVersion: avail };
}

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

function makeDevice(metadata: Record<string, any> = {}): Device {
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
        metadata,
    } as Device;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateReconciliationService', () => {
    let service: UpdateReconciliationService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new UpdateReconciliationService();
    });

    // -------------------------------------------------------------------------
    // reconcileUpdatesWithPolicy — pure function
    // -------------------------------------------------------------------------

    describe('reconcileUpdatesWithPolicy()', () => {
        const source: UpdateSource = 'apt';

        it('passes all updates as candidates when no pins and no holds', () => {
            const available = [makeUpdate('curl'), makeUpdate('openssl')];
            const { candidates, ansibleExclusions, kernelExclusions } =
                service.reconcileUpdatesWithPolicy(available, source, new Map(), undefined);

            expect(candidates).toHaveLength(2);
            expect(ansibleExclusions).toHaveLength(0);
            expect(kernelExclusions).toHaveLength(0);
        });

        it('routes a pinned package to ansibleExclusions with reason ansible-pinned', () => {
            const pins = new Map([['cuda-toolkit', '12.0.0']]);
            const available = [makeUpdate('cuda-toolkit', '11.0.0', '12.5.0'), makeUpdate('curl')];

            const { candidates, ansibleExclusions } =
                service.reconcileUpdatesWithPolicy(available, source, pins, undefined);

            expect(candidates).toHaveLength(1);
            expect(candidates[0].package).toBe('curl');
            expect(ansibleExclusions).toHaveLength(1);
            expect(ansibleExclusions[0]).toMatchObject({
                package: 'cuda-toolkit',
                reason: 'ansible-pinned',
                heldOrPinnedVersion: '12.0.0',
            });
        });

        it('routes a kernel-held package to kernelExclusions with reason kernel-held', () => {
            const profile = makeProfile({ heldKernelPackages: ['linux-headers-dgx'], heldPackages: ['linux-headers-dgx'] });
            const available = [makeUpdate('linux-headers-dgx', '5.15.1', '5.15.5'), makeUpdate('curl')];

            const { candidates, kernelExclusions } =
                service.reconcileUpdatesWithPolicy(available, source, new Map(), profile);

            expect(candidates).toHaveLength(1);
            expect(kernelExclusions).toHaveLength(1);
            expect(kernelExclusions[0]).toMatchObject({
                package: 'linux-headers-dgx',
                reason: 'kernel-held',
            });
        });

        it('routes a device-held (non-kernel) package to kernelExclusions with reason device-held', () => {
            const profile = makeProfile({
                heldPackages: ['libssl3'],
                heldKernelPackages: [],
            });
            const available = [makeUpdate('libssl3'), makeUpdate('curl')];

            const { candidates, kernelExclusions } =
                service.reconcileUpdatesWithPolicy(available, source, new Map(), profile);

            expect(candidates).toHaveLength(1);
            expect(kernelExclusions).toHaveLength(1);
            expect(kernelExclusions[0].reason).toBe('device-held');
        });

        it('prefers ansible-pinned over kernel-held when package is both', () => {
            const pins = new Map([['nvidia-driver', '550.54.15']]);
            const profile = makeProfile({
                heldKernelPackages: ['nvidia-driver'],
                heldPackages: ['nvidia-driver'],
            });
            const available = [makeUpdate('nvidia-driver', '535.0.0', '565.0.0')];

            const { ansibleExclusions, kernelExclusions } =
                service.reconcileUpdatesWithPolicy(available, source, pins, profile);

            expect(ansibleExclusions).toHaveLength(1);
            expect(ansibleExclusions[0].reason).toBe('ansible-pinned');
            expect(kernelExclusions).toHaveLength(0);
        });

        it('does not throw when profile is undefined', () => {
            const available = [makeUpdate('curl')];
            const result = service.reconcileUpdatesWithPolicy(available, source, new Map(), undefined);
            expect(result.kernelExclusions).toHaveLength(0);
            expect(result.candidates).toHaveLength(1);
        });

        it('carries the source field onto each candidate', () => {
            const available = [makeUpdate('curl')];
            const { candidates } =
                service.reconcileUpdatesWithPolicy(available, 'dnf', new Map(), undefined);
            expect(candidates[0].source).toBe('dnf');
        });
    });

    // -------------------------------------------------------------------------
    // parsePinnedPackages — YAML parser
    // -------------------------------------------------------------------------

    describe('parsePinnedPackages()', () => {
        it('returns empty map when path is empty string', async () => {
            const result = await service.parsePinnedPackages('');
            expect(result.size).toBe(0);
        });

        it('parses quoted version strings', async () => {
            const yaml = [
                'pinned_packages:',
                '  cuda-toolkit: "12.0.0"',
                '  nvidia-driver: "550.54.15"',
            ].join('\n');

            (fs.promises.readFile as jest.Mock).mockResolvedValue(yaml);

            const result = await service.parsePinnedPackages('/policy.yml');
            expect(result.get('cuda-toolkit')).toBe('12.0.0');
            expect(result.get('nvidia-driver')).toBe('550.54.15');
        });

        it('parses unquoted version strings', async () => {
            const yaml = [
                'pinned_packages:',
                '  libssl3: 3.0.7',
            ].join('\n');

            (fs.promises.readFile as jest.Mock).mockResolvedValue(yaml);

            const result = await service.parsePinnedPackages('/policy.yml');
            expect(result.get('libssl3')).toBe('3.0.7');
        });

        it('skips comment lines and blank lines', async () => {
            const yaml = [
                '# This is a policy file',
                '',
                'pinned_packages:',
                '  # kernel is managed separately',
                '  cuda-toolkit: "12.0.0"',
            ].join('\n');

            (fs.promises.readFile as jest.Mock).mockResolvedValue(yaml);

            const result = await service.parsePinnedPackages('/policy.yml');
            expect(result.size).toBe(1);
            expect(result.get('cuda-toolkit')).toBe('12.0.0');
        });

        it('stops parsing at the next top-level key', async () => {
            const yaml = [
                'pinned_packages:',
                '  cuda-toolkit: "12.0.0"',
                'other_section:',
                '  should-not-parse: "9.9.9"',
            ].join('\n');

            (fs.promises.readFile as jest.Mock).mockResolvedValue(yaml);

            const result = await service.parsePinnedPackages('/policy.yml');
            expect(result.size).toBe(1);
            expect(result.has('should-not-parse')).toBe(false);
        });

        it('returns empty map when file is not found (no throw)', async () => {
            (fs.promises.readFile as jest.Mock).mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            );

            const result = await service.parsePinnedPackages('/nonexistent.yml');
            expect(result.size).toBe(0);
        });

        it('returns empty map when pinned_packages section is absent', async () => {
            const yaml = 'some_other_key:\n  value: 1\n';
            (fs.promises.readFile as jest.Mock).mockResolvedValue(yaml);

            const result = await service.parsePinnedPackages('/policy.yml');
            expect(result.size).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // reconcile() — integration (reads config + profile + metadata)
    // -------------------------------------------------------------------------

    describe('reconcile()', () => {
        beforeEach(() => {
            const vscode = require('vscode');
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(''),
            });
        });

        it('returns all updates as candidates when no policy and no holds', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile());

            const device = makeDevice({
                lastCheckup: {
                    source: 'apt',
                    availableUpdates: [makeUpdate('curl')],
                },
            });

            const { candidates, ansibleExclusions, kernelExclusions } =
                await service.reconcile(device);

            expect(candidates).toHaveLength(1);
            expect(ansibleExclusions).toHaveLength(0);
            expect(kernelExclusions).toHaveLength(0);
        });

        it('returns empty candidates when lastCheckup is absent', async () => {
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile());
            const device = makeDevice({});

            const { candidates } = await service.reconcile(device);
            expect(candidates).toHaveLength(0);
        });

        it('uses policy file when ansibleInventoryPath is configured', async () => {
            const vscode = require('vscode');
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('/policy.yml'),
            });

            (fs.promises.readFile as jest.Mock).mockResolvedValue(
                'pinned_packages:\n  cuda-toolkit: "12.0.0"\n'
            );
            (platformProfileService.getProfile as jest.Mock).mockReturnValue(makeProfile());

            const device = makeDevice({
                lastCheckup: {
                    source: 'apt',
                    availableUpdates: [
                        makeUpdate('cuda-toolkit', '11.0', '12.5'),
                        makeUpdate('curl'),
                    ],
                },
            });

            const { candidates, ansibleExclusions } = await service.reconcile(device);
            expect(candidates).toHaveLength(1);
            expect(ansibleExclusions).toHaveLength(1);
        });
    });

    // -------------------------------------------------------------------------
    // buildPendingState
    // -------------------------------------------------------------------------

    describe('buildPendingState()', () => {
        it('sets status to available when candidates > 0', () => {
            const candidate = {
                package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' as UpdateSource,
            };
            const state = service.buildPendingState('apt', [candidate], [], []);
            expect(state.status).toBe('available');
            expect(state.candidates).toHaveLength(1);
        });

        it('sets status to none when candidates is empty', () => {
            const state = service.buildPendingState('apt', [], [], []);
            expect(state.status).toBe('none');
        });

        it('stamps computedAt as a valid ISO timestamp', () => {
            const before = new Date().toISOString();
            const state = service.buildPendingState('apt', [], [], []);
            const after = new Date().toISOString();
            expect(state.computedAt >= before).toBe(true);
            expect(state.computedAt <= after).toBe(true);
        });
    });
});
