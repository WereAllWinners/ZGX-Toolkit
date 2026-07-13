/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tests for ManageabilityService drift detection methods:
 *   captureBaseline, getBaseline, checkAnsibleDrift, exportRemediationPlaybook.
 * Real file I/O is performed in a temp directory; no mocks for fs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ManageabilityService } from '../../services/manageabilityService';
import { Device } from '../../types/devices';
import { ManageabilitySnapshot } from '../../types/manageability';

// ---------------------------------------------------------------------------
// VS Code + SSH mocks (unused by drift methods but required for import tree)
// ---------------------------------------------------------------------------

jest.mock('../../utils/sshConnection', () => ({ executeSSHCommand: jest.fn() }));
jest.mock('../../services/deviceService', () => ({
    deviceService: {
        updateDevice: jest.fn().mockResolvedValue(undefined),
        mergeDeviceMetadata: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('../../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() },
}));

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
    return {
        id: 'dev-drift-001',
        name: 'DGX Drift Test',
        host: '192.168.1.1',
        username: 'nvidia',
        port: 22,
        isSetup: true,
        useKeyAuth: true,
        keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt: new Date().toISOString(),
        ...overrides,
    } as Device;
}

function makeSnapshot(overrides: Partial<ManageabilitySnapshot> = {}): ManageabilitySnapshot {
    return {
        collectedAt: '2026-06-27T10:00:00Z',
        osBuild: {
            tool: 'os_build_identity',
            timestamp: '2026-06-27T10:00:00Z',
            status: 'ok',
            data: {
                os_name: 'Ubuntu',
                os_version: '22.04.4',
                os_pretty: 'DGX OS 7.5.0',
                kernel: '5.15.0-117-generic',
                kernel_build: '#127-Ubuntu SMP',
                architecture: 'aarch64',
            },
        },
        drivers: {
            tool: 'driver_inventory_reporter',
            timestamp: '2026-06-27T10:00:00Z',
            status: 'ok',
            data: {
                gpu_driver_version: '580.142',
                cuda_version: '12.8',
                packages: [],
            },
        },
        firmware: {
            tool: 'firmware_reporter',
            timestamp: '2026-06-27T10:00:00Z',
            status: 'ok',
            data: {
                bios_version: '1.5.0',
                bios_date: '2026-01-15',
                gpu_vbios_version: '96.00.9C.00.04',
                gpu_driver_version: '580.142',
            },
        },
        hardware: {
            tool: 'hardware_config',
            timestamp: '2026-06-27T10:00:00Z',
            status: 'ok',
            data: {
                cpu: { architecture: 'aarch64', model_names: ['Grace'], cores: 72, threads_per_core: 1 },
                gpu_vendor: 'nvidia',
                gpus: [{ index: 0, name: 'B200', vendor: 'nvidia', temp_c: null, power_w: null, memory_total_mb: 192000, memory_used_mb: null, unified_memory: false }],
                total_memory_bytes: 536870912000,
                storage: {},
                nics: [],
            },
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let svc: ManageabilityService;
let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zgx-drift-test-'));
    svc = new ManageabilityService();

    // Inject the temp dir as the storage root (bypasses initialize() which needs context)
    (svc as any).storageDir = tmpDir;

    // Mock the output channel (it won't exist without initialize())
    (svc as any).policyChannel = {
        appendLine: jest.fn(),
        show: jest.fn(),
    };

    // Default vscode mock: user cancels "Capture Baseline?" prompt
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');
});

afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getBaseline
// ---------------------------------------------------------------------------

describe('getBaseline()', () => {
    it('returns undefined when no baseline file exists', async () => {
        const device = makeDevice();
        const result = await svc.getBaseline(device);
        expect(result).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// captureBaseline
// ---------------------------------------------------------------------------

describe('captureBaseline()', () => {
    it('writes a baseline file that getBaseline can read back', async () => {
        const snapshot = makeSnapshot();
        const device = makeDevice({ metadata: { manageabilitySnapshot: snapshot } });

        await svc.captureBaseline(device);

        const loaded = await svc.getBaseline(device);
        expect(loaded).toBeDefined();
        expect(loaded!.collectedAt).toBe(snapshot.collectedAt);
        expect(loaded!.drivers?.data.gpu_driver_version).toBe('580.142');
    });

    it('throws when no snapshot exists on the device', async () => {
        const device = makeDevice({ metadata: {} });
        await expect(svc.captureBaseline(device)).rejects.toThrow(
            /No inventory snapshot/
        );
    });
});

// ---------------------------------------------------------------------------
// checkAnsibleDrift
// ---------------------------------------------------------------------------

describe('checkAnsibleDrift()', () => {
    it('returns driftDetected: false when current snapshot matches baseline', async () => {
        const snapshot = makeSnapshot();
        const device = makeDevice({ metadata: { manageabilitySnapshot: snapshot } });

        await svc.captureBaseline(device);

        const result = await svc.checkAnsibleDrift(device, '');

        expect(result.driftDetected).toBe(false);
        expect(result.report.findings).toHaveLength(0);
    });

    it('detects a critical finding when gpu driver version changed', async () => {
        const baseline = makeSnapshot();
        const deviceWithBaseline = makeDevice({ metadata: { manageabilitySnapshot: baseline } });
        await svc.captureBaseline(deviceWithBaseline);

        // Now the device has a newer driver
        const currentSnapshot = makeSnapshot({
            drivers: {
                tool: 'driver_inventory_reporter',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: { gpu_driver_version: '590.00', cuda_version: '12.8', packages: [] },
            },
        });
        const device = makeDevice({ metadata: { manageabilitySnapshot: currentSnapshot } });

        const result = await svc.checkAnsibleDrift(device, '');

        expect(result.driftDetected).toBe(true);
        const finding = result.report.findings.find(f => f.field === 'drivers.gpuDriverVersion');
        expect(finding).toBeDefined();
        expect(finding!.severity).toBe('critical');
        expect(finding!.baselineValue).toBe('580.142');
        expect(finding!.currentValue).toBe('590.00');
    });

    it('detects a warning finding when kernel version changed', async () => {
        const baseline = makeSnapshot();
        const deviceWithBaseline = makeDevice({ metadata: { manageabilitySnapshot: baseline } });
        await svc.captureBaseline(deviceWithBaseline);

        const currentSnapshot = makeSnapshot({
            osBuild: {
                tool: 'os_build_identity',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: {
                    os_name: 'Ubuntu',
                    os_version: '22.04.4',
                    os_pretty: 'DGX OS 7.5.0',
                    kernel: '5.15.0-125-generic',   // changed
                    kernel_build: '#127-Ubuntu SMP',
                    architecture: 'aarch64',
                },
            },
        });
        const device = makeDevice({ metadata: { manageabilitySnapshot: currentSnapshot } });

        const result = await svc.checkAnsibleDrift(device, '');

        expect(result.driftDetected).toBe(true);
        const finding = result.report.findings.find(f => f.field === 'os.kernelVersion');
        expect(finding).toBeDefined();
        expect(finding!.severity).toBe('warning');
    });

    it('sorts findings critical → warning → info', async () => {
        // Baseline has all fields set; current has changes in driver (critical), kernel (warning), vbios (info)
        const baseline = makeSnapshot();
        const deviceWithBaseline = makeDevice({ metadata: { manageabilitySnapshot: baseline } });
        await svc.captureBaseline(deviceWithBaseline);

        const currentSnapshot = makeSnapshot({
            osBuild: {
                tool: 'os_build_identity',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: { os_name: 'Ubuntu', os_version: '22.04.4', os_pretty: 'DGX OS 7.5.0', kernel: '5.15.0-125-generic', kernel_build: '#127', architecture: 'aarch64' },
            },
            drivers: {
                tool: 'driver_inventory_reporter',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: { gpu_driver_version: '590.00', cuda_version: '12.8', packages: [] },
            },
            firmware: {
                tool: 'firmware_reporter',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: { bios_version: '1.5.0', bios_date: '2026-01-15', gpu_vbios_version: '97.00.00.00.00', gpu_driver_version: '590.00' },
            },
        });
        const device = makeDevice({ metadata: { manageabilitySnapshot: currentSnapshot } });

        const result = await svc.checkAnsibleDrift(device, '');

        const severities = result.report.findings.map(f => f.severity);
        const order = { critical: 0, warning: 1, info: 2 };
        for (let i = 1; i < severities.length; i++) {
            expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
        }
        // Confirm all three severities are represented
        expect(severities).toContain('critical');
        expect(severities).toContain('warning');
        expect(severities).toContain('info');
    });
});

// ---------------------------------------------------------------------------
// exportRemediationPlaybook
// ---------------------------------------------------------------------------

describe('exportRemediationPlaybook()', () => {
    it('generates a YAML playbook with tasks for critical and warning findings', async () => {
        const baseline = makeSnapshot();
        const deviceWithBaseline = makeDevice({ metadata: { manageabilitySnapshot: baseline } });
        await svc.captureBaseline(deviceWithBaseline);

        const currentSnapshot = makeSnapshot({
            drivers: {
                tool: 'driver_inventory_reporter',
                timestamp: '2026-06-27T11:00:00Z',
                status: 'ok',
                data: { gpu_driver_version: '590.00', cuda_version: '12.8', packages: [] },
            },
        });
        const device = makeDevice({ metadata: { manageabilitySnapshot: currentSnapshot } });
        const result = await svc.checkAnsibleDrift(device, '');

        const yaml = svc.exportRemediationPlaybook(result.report);

        expect(yaml).toContain('---');
        expect(yaml).toContain('nvidia-driver');
        expect(yaml).toContain('580.142');
        expect(yaml).toContain('590.00');
    });
});
