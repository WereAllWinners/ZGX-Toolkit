/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import { UpdateReviewViewController } from '../../views/devices/updates/updateReviewViewController';
import { Logger } from '../../utils/logger';
import { ITelemetryService } from '../../types/telemetry';
import { DeviceService } from '../../services/deviceService';
import { Device } from '../../types/devices';
import { PendingUpdatesState } from '../../types/scheduledUpdates';

jest.mock('vscode');

jest.mock('../../services/updateReconciliationService', () => ({
    updateReconciliationService: {
        buildApplyPlan: jest.fn().mockResolvedValue({
            provider: 'apt',
            toApply: ['curl'],
            skipped: [],
            additionalChanges: [],
            dgxControllerAbsent: false,
        }),
        executeApplyPlan: jest.fn().mockResolvedValue({
            provider: 'apt',
            applied: ['curl'],
            skipped: [],
            success: true,
        }),
    },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makePending(overrides: Partial<PendingUpdatesState> = {}): PendingUpdatesState {
    return {
        computedAt: new Date().toISOString(),
        source: 'apt',
        candidates: [],
        ansibleExclusions: [],
        kernelExclusions: [],
        status: 'none',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeDeps(deviceOverrides: Partial<jest.Mocked<DeviceService>> = {}) {
    const mockLogger: jest.Mocked<Logger> = {
        debug: jest.fn(),
        info:  jest.fn(),
        warn:  jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    } as any;

    const mockTelemetry: jest.Mocked<ITelemetryService> = {
        trackEvent: jest.fn(),
        trackError: jest.fn(),
        isEnabled: jest.fn().mockReturnValue(false),
        setEnabled: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
    } as any;

    const mockDeviceService: jest.Mocked<DeviceService> = {
        getDevice: jest.fn().mockResolvedValue(undefined),
        getAllDevices: jest.fn().mockResolvedValue([]),
        createDevice: jest.fn(),
        updateDevice: jest.fn(),
        deleteDevice: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => {}),
        ...deviceOverrides,
    } as any;

    return { mockLogger, mockTelemetry, mockDeviceService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateReviewViewController', () => {
    let view: UpdateReviewViewController;

    afterEach(() => {
        view?.dispose();
        jest.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // render() — guard cases
    // -------------------------------------------------------------------------

    describe('render() — guard cases', () => {
        it('returns "No device selected" when called without params', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render(undefined);

            expect(html).toContain('No device selected');
            expect(mockDeviceService.getDevice).not.toHaveBeenCalled();
        });

        it('returns "Device not found" when device does not exist', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(undefined),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: 'missing' });

            expect(html).toContain('Device not found');
        });

        it('returns prompt to run checkup when device has no pendingUpdates metadata', async () => {
            const device = makeDevice({});
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('Run Checkup Now');
        });
    });

    // -------------------------------------------------------------------------
    // render() — candidates section
    // -------------------------------------------------------------------------

    describe('render() — candidates', () => {
        it('renders candidate rows with checkboxes checked by default', async () => {
            const pending = makePending({
                status: 'available',
                candidates: [
                    { package: 'curl', currentVersion: '7.81.0', availableVersion: '8.0.0', source: 'apt' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('curl');
            expect(html).toContain('candidate-cb');
            expect(html).toContain('checked');
            expect(html).toContain('8.0.0');
        });

        it('renders source tag on candidate row', async () => {
            const pending = makePending({
                status: 'available',
                candidates: [
                    { package: 'openssl', currentVersion: '3.0.0', availableVersion: '3.0.7', source: 'apt' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('source-tag');
            expect(html).toContain('apt');
        });

        it('shows empty-state message when no candidates', async () => {
            const pending = makePending({
                status: 'none',
                candidates: [],
                ansibleExclusions: [
                    { package: 'cuda-toolkit', currentVersion: '11.0', availableVersion: '12.0', reason: 'ansible-pinned', heldOrPinnedVersion: '11.0' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            // No candidate checkbox inputs should be rendered (data-package only on candidate rows)
            expect(html).not.toContain('data-package=');
            expect(html).toContain('held by policy');
        });
    });

    // -------------------------------------------------------------------------
    // render() — exclusion sections
    // -------------------------------------------------------------------------

    describe('render() — ansible exclusions', () => {
        it('renders ansible exclusions without a checkbox', async () => {
            const pending = makePending({
                ansibleExclusions: [
                    { package: 'cuda-toolkit', currentVersion: '11.0', availableVersion: '12.0', reason: 'ansible-pinned', heldOrPinnedVersion: '11.0' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('Ansible Policy');
            expect(html).toContain('cuda-toolkit');
            // candidate checkboxes use data-package; held rows must not have them
            expect(html).not.toContain('data-package="cuda-toolkit"');
        });

        it('hides ansible section when there are no ansible exclusions', async () => {
            const pending = makePending({
                status: 'available',
                candidates: [
                    { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).not.toContain('Ansible Policy');
        });
    });

    describe('render() — kernel exclusions', () => {
        it('renders kernel exclusions with reason tag and no checkbox', async () => {
            const pending = makePending({
                kernelExclusions: [
                    { package: 'linux-headers-dgx', currentVersion: '5.15.1', availableVersion: '5.15.5', reason: 'kernel-held', heldOrPinnedVersion: '5.15.1' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('Kernel');
            expect(html).toContain('linux-headers-dgx');
            expect(html).toContain('kernel-held');
            // kernel rows must not have candidate checkboxes (data-package only on candidate rows)
            expect(html).not.toContain('data-package="linux-headers-dgx"');
        });

        it('hides kernel section when there are no kernel exclusions', async () => {
            const pending = makePending({
                status: 'available',
                candidates: [
                    { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            expect(html).not.toContain('Kernel / Device Policy');
        });
    });

    // -------------------------------------------------------------------------
    // render() — summary counts
    // -------------------------------------------------------------------------

    describe('render() — summary counts', () => {
        it('shows correct total count in summary bar', async () => {
            const pending = makePending({
                status: 'available',
                candidates: [
                    { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                    { package: 'openssl', currentVersion: '3.0', availableVersion: '3.1', source: 'apt' },
                ],
                ansibleExclusions: [
                    { package: 'cuda-toolkit', currentVersion: '11.0', availableVersion: '12.0', reason: 'ansible-pinned', heldOrPinnedVersion: '11.0' },
                ],
                kernelExclusions: [
                    { package: 'linux-headers', currentVersion: '5.15.1', availableVersion: '5.15.5', reason: 'kernel-held', heldOrPinnedVersion: '5.15.1' },
                ],
            });
            const device = makeDevice({ pendingUpdates: pending });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const html = await view.render({ deviceId: device.id });

            // totalAvailable = 2 + 1 + 1 = 4
            expect(html).toContain('4 available');
            expect(html).toContain('2 approvable');
        });
    });

    // -------------------------------------------------------------------------
    // handleMessage() — apply-selected (real handler, Task 03)
    // -------------------------------------------------------------------------

    describe('handleMessage() — apply-selected', () => {
        it('triggers the confirmation modal for selected packages', async () => {
            const device = makeDevice({
                pendingUpdates: makePending({
                    status: 'available',
                    candidates: [
                        { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                    ],
                }),
            });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            await view.render({ deviceId: device.id });

            const vscode = require('vscode');
            vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Apply updates');
            vscode.window.withProgress = jest.fn().mockImplementation(async (_: any, task: any) => { await task(); });
            // eslint-disable-next-line @typescript-eslint/naming-convention
            vscode.ProgressLocation = { Notification: 15 };

            await view.handleMessage({ type: 'apply-selected', packages: ['curl'] } as any);

            // Real handler shows a confirmation modal first
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('curl'),
                { modal: true },
                'Apply updates',
            );
        });

        it('does not expose any package manager method on the controller instance', async () => {
            const device = makeDevice({
                pendingUpdates: makePending({
                    status: 'available',
                    candidates: [
                        { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                    ],
                }),
            });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            await view.render({ deviceId: device.id });

            const svc = view as any;
            expect(svc.applyUpdates).toBeUndefined();
            expect(svc.installPackages).toBeUndefined();
            expect(svc.runApt).toBeUndefined();
        });

        it('shows warning when no packages are selected', async () => {
            const device = makeDevice({
                pendingUpdates: makePending({ status: 'available', candidates: [] }),
            });
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps({
                getDevice: jest.fn().mockResolvedValue(device),
            });
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            await view.render({ deviceId: device.id });
            await view.handleMessage({ type: 'apply-selected', packages: [] } as any);

            const vscode = require('vscode');
            expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // handleMessage() — goBack
    // -------------------------------------------------------------------------

    describe('handleMessage() — goBack', () => {
        it('calls navigateTo admin/dashboard on goBack', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService } = makeDeps();
            view = new UpdateReviewViewController({ logger: mockLogger, telemetry: mockTelemetry, deviceService: mockDeviceService });

            const navigateSpy = jest.spyOn(view as any, 'navigateTo').mockResolvedValue(undefined);

            await view.handleMessage({ type: 'goBack' } as any);

            expect(navigateSpy).toHaveBeenCalledWith('admin/dashboard', {}, 'sidebar');
        });
    });
});
