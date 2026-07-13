/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for ScheduledCheckupService.
 * Validates timer management, per-source CheckupResult construction, and
 * the hard read-only contract (no apply method).
 */

import * as vscode from 'vscode';
import { ScheduledCheckupService } from '../../services/scheduledCheckupService';
import { Device } from '../../types/devices';
import { UpdateSource } from '../../types/scheduledUpdates';
import { UpdateAvailabilityData } from '../../types/manageability';
import { ManageabilityEnvelope } from '../../types/manageability';
import { ManageabilityResult } from '../../services/manageabilityService';

jest.mock('../../services/manageabilityService', () => ({
    manageabilityService: {
        runTool:          jest.fn(),
        collectInventory: jest.fn(),
    },
}));

jest.mock('../../services/deviceService', () => ({
    deviceService: {
        updateDevice:         jest.fn().mockResolvedValue(undefined),
        mergeDeviceMetadata:  jest.fn().mockResolvedValue(undefined),
        getAllDevices:        jest.fn(),
    },
}));

jest.mock('../../services/platformProfileService', () => ({
    platformProfileService: {
        detect: jest.fn(),
        getProfile: jest.fn().mockReturnValue(undefined),
    },
}));

jest.mock('../../services/updateReconciliationService', () => ({
    updateReconciliationService: {
        reconcile: jest.fn().mockResolvedValue({
            candidates: [],
            ansibleExclusions: [],
            kernelExclusions: [],
            firmwareCandidates: [],
            firmwareExclusions: [],
        }),
        buildPendingState: jest.fn().mockReturnValue({
            computedAt: '2026-06-28T10:00:00Z',
            source: 'apt',
            candidates: [],
            ansibleExclusions: [],
            kernelExclusions: [],
            status: 'none',
        }),
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

import { manageabilityService } from '../../services/manageabilityService';
import { deviceService }         from '../../services/deviceService';
import { platformProfileService } from '../../services/platformProfileService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
    return {
        id:         'dev-001',
        name:       'zgx-nano',
        host:       '100.64.0.1',
        username:   'nvidia',
        port:       22,
        isSetup:    true,
        useKeyAuth: true,
        keySetup:   { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt:  '2026-06-28T00:00:00Z',
        metadata:   {},
        ...overrides,
    } as Device;
}

function makeUpdateEnvelope(
    source: UpdateSource,
    updates: UpdateAvailabilityData['updates'],
    status: 'ok' | 'partial' | 'error' = 'ok',
): ManageabilityResult<UpdateAvailabilityData> {
    const envelope: ManageabilityEnvelope<UpdateAvailabilityData> = {
        tool:      'update-availability',
        timestamp: '2026-06-28T10:00:00Z',
        status,
        data:      { source, updates },
    };
    return { success: true, envelope, rawOutput: '' };
}

function makeConfigGetter(enabled: boolean, intervalHours: number) {
    return jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'enabled')       return enabled;
        if (key === 'intervalHours') return intervalHours;
        return defaultValue;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduledCheckupService', () => {
    let service: ScheduledCheckupService;
    let mockContext: vscode.ExtensionContext;
    let configChangeHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();

        service = new ScheduledCheckupService();

        mockContext = { subscriptions: [] } as any;

        (vscode.workspace as any).onDidChangeConfiguration = jest.fn().mockImplementation(
            (listener: (e: vscode.ConfigurationChangeEvent) => void, _filter?: unknown, subscriptions?: any[]) => {
                configChangeHandler = listener;
                const disposable = { dispose: jest.fn() };
                if (Array.isArray(subscriptions)) {
                    subscriptions.push(disposable);
                }
                return disposable;
            }
        );

        // Default: disabled
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: makeConfigGetter(false, 24),
        });

        (platformProfileService.detect      as jest.Mock).mockResolvedValue({});
        (manageabilityService.collectInventory as jest.Mock).mockResolvedValue({});
        (deviceService.updateDevice         as jest.Mock).mockResolvedValue(undefined);
        (deviceService.mergeDeviceMetadata  as jest.Mock).mockResolvedValue(undefined);
    });

    afterEach(() => {
        service.stop();
        jest.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // Timer management
    // -------------------------------------------------------------------------

    describe('start()', () => {
        it('does not schedule a timer when enabled is false', () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            service.start(mockContext);
            jest.advanceTimersByTime(25 * 60 * 60 * 1000);

            expect(deviceService.getAllDevices).not.toHaveBeenCalled();
        });

        it('schedules a timer that fires after intervalHours when enabled', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(true, 24),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            service.start(mockContext);

            // Should not have fired before the interval
            jest.advanceTimersByTime(23 * 60 * 60 * 1000);
            expect(deviceService.getAllDevices).not.toHaveBeenCalled();

            // Should fire at the interval
            jest.advanceTimersByTime(1 * 60 * 60 * 1000);
            expect(deviceService.getAllDevices).toHaveBeenCalled();
        });
    });

    describe('settings change reactivity', () => {
        it('stops the timer when enabled is toggled off', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(true, 24),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            service.start(mockContext);

            // Disable via config change
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(false, 24),
            });
            configChangeHandler?.({
                affectsConfiguration: (s: string) => s === 'zgxToolkit.scheduledCheckups',
            } as vscode.ConfigurationChangeEvent);

            jest.advanceTimersByTime(25 * 60 * 60 * 1000);
            expect(deviceService.getAllDevices).not.toHaveBeenCalled();
        });

        it('reschedules with new interval when intervalHours changes', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(true, 24),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            service.start(mockContext);

            // Change to 12h
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(true, 12),
            });
            configChangeHandler?.({
                affectsConfiguration: (s: string) => s === 'zgxToolkit.scheduledCheckups',
            } as vscode.ConfigurationChangeEvent);

            jest.advanceTimersByTime(12 * 60 * 60 * 1000);
            expect(deviceService.getAllDevices).toHaveBeenCalled();
        });

        it('ignores configuration changes for unrelated settings', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: makeConfigGetter(false, 24),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            service.start(mockContext);

            configChangeHandler?.({
                affectsConfiguration: (s: string) => s === 'zgxToolkit.tailscale.enabled',
            } as vscode.ConfigurationChangeEvent);

            jest.advanceTimersByTime(25 * 60 * 60 * 1000);
            expect(deviceService.getAllDevices).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // runCheckupNow()
    // -------------------------------------------------------------------------

    describe('runCheckupNow()', () => {
        const device = makeDevice();

        it('calls detect, collectInventory, then runTool(update_availability) in order', async () => {
            const callOrder: string[] = [];

            (platformProfileService.detect as jest.Mock).mockImplementation(async () => {
                callOrder.push('detect');
            });
            (manageabilityService.collectInventory as jest.Mock).mockImplementation(async () => {
                callOrder.push('collectInventory');
            });
            (manageabilityService.runTool as jest.Mock).mockImplementation(async () => {
                callOrder.push('runTool');
                return makeUpdateEnvelope('apt', []);
            });

            await service.runCheckupNow(device);

            // detect and collectInventory come first; runTool is called twice in parallel
            // (update_availability + firmware_update_availability)
            expect(callOrder[0]).toBe('detect');
            expect(callOrder[1]).toBe('collectInventory');
            expect(callOrder.filter(c => c === 'runTool')).toHaveLength(2);
            const toolKeys = (manageabilityService.runTool as jest.Mock).mock.calls.map((c: any[]) => c[1]);
            expect(toolKeys).toContain('update_availability');
            expect(toolKeys).toContain('firmware_update_availability');
        });

        it('stores CheckupResult in metadata.lastCheckup via mergeDeviceMetadata', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('apt', [
                    { package: 'curl', current_version: '7.81.0', available_version: '8.0.0' },
                ])
            );

            await service.runCheckupNow(device);

            expect(deviceService.mergeDeviceMetadata).toHaveBeenCalledWith(
                device.id,
                expect.objectContaining({
                    lastCheckup: expect.objectContaining({
                        source: 'apt',
                        status: 'ok',
                        availableUpdates: expect.arrayContaining([
                            expect.objectContaining({
                                package:          'curl',
                                currentVersion:   '7.81.0',
                                availableVersion: '8.0.0',
                            }),
                        ]),
                    }),
                }),
            );
        });

        it('maps snake_case update fields to camelCase in AvailableUpdate', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('apt', [
                    { package: 'libssl3', current_version: '3.0.2', available_version: '3.0.7' },
                ])
            );

            const result = await service.runCheckupNow(device);

            expect(result.availableUpdates[0]).toMatchObject({
                package:          'libssl3',
                currentVersion:   '3.0.2',
                availableVersion: '3.0.7',
            });
        });

        it('carries source "apt" through to CheckupResult', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(makeUpdateEnvelope('apt', []));
            const result = await service.runCheckupNow(device);
            expect(result.source).toBe('apt');
        });

        it('carries source "dnf" through to CheckupResult', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(makeUpdateEnvelope('dnf', []));
            const result = await service.runCheckupNow(device);
            expect(result.source).toBe('dnf');
        });

        it('carries source "zypper" through to CheckupResult', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(makeUpdateEnvelope('zypper', []));
            const result = await service.runCheckupNow(device);
            expect(result.source).toBe('zypper');
        });

        it('sets source to unavailable when envelope has no updates and source is unavailable', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('unavailable', [], 'error')
            );

            const result = await service.runCheckupNow(device);
            expect(result.source).toBe('unavailable');
            expect(result.status).toBe('error');
        });

        it('returns error CheckupResult when runTool SSH fails', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue({
                success: false,
                error:   'SSH connection refused',
            });

            const result = await service.runCheckupNow(device);

            expect(result.status).toBe('error');
            expect(result.source).toBe('unavailable');
            expect(result.availableUpdates).toHaveLength(0);
        });

        it('does not throw when detect() rejects (offline device)', async () => {
            (platformProfileService.detect as jest.Mock).mockRejectedValue(new Error('unreachable'));
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('apt', [])
            );

            await expect(service.runCheckupNow(device)).resolves.toBeDefined();
        });

        it('does not throw when collectInventory() rejects (offline device)', async () => {
            (manageabilityService.collectInventory as jest.Mock).mockRejectedValue(
                new Error('SSH timeout')
            );
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('apt', [])
            );

            await expect(service.runCheckupNow(device)).resolves.toBeDefined();
        });

        it('stamps checkedAt as a valid ISO 8601 timestamp', async () => {
            (manageabilityService.runTool as jest.Mock).mockResolvedValue(
                makeUpdateEnvelope('apt', [])
            );

            const before = new Date().toISOString();
            const result = await service.runCheckupNow(device);
            const after  = new Date().toISOString();

            expect(result.checkedAt >= before).toBe(true);
            expect(result.checkedAt <= after).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // Safety: no apply method
    // -------------------------------------------------------------------------

    describe('read-only safety', () => {
        it('exposes no method that could apply or install packages', () => {
            const svc = service as any;
            expect(svc.applyUpdates).toBeUndefined();
            expect(svc.installUpdate).toBeUndefined();
            expect(svc.upgradePackages).toBeUndefined();
            expect(svc.applyApproved).toBeUndefined();
            expect(svc.runUpdate).toBeUndefined();
        });
    });
});
