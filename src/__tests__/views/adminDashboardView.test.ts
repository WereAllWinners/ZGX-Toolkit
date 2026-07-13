/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import { AdminDashboardViewController } from '../../views/admin/adminDashboardViewController';
import { Logger } from '../../utils/logger';
import { ITelemetryService } from '../../types/telemetry';
import { DeviceService } from '../../services/deviceService';
import { ManageabilityService } from '../../services/manageabilityService';
import { UserGroupService } from '../../services/userGroupService';
import { Device } from '../../types/devices';
import { CheckupResult, PendingUpdatesState } from '../../types/scheduledUpdates';

jest.mock('vscode');

jest.mock('../../services/scheduledCheckupService', () => ({
    scheduledCheckupService: {
        runCheckupNow: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../../services/tailscaleService', () => ({
    tailscaleService: { detect: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn(),
    },
}));

import { scheduledCheckupService } from '../../services/scheduledCheckupService';

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

function makeCheckupResult(overrides: Partial<CheckupResult> = {}): CheckupResult {
    return {
        checkedAt: new Date().toISOString(),
        source: 'apt',
        availableUpdates: [],
        status: 'ok',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeDeps(deviceOverrides: Partial<jest.Mocked<DeviceService>> = {}) {
    const mockLogger: jest.Mocked<Logger> = {
        debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn(),
    } as any;

    const mockTelemetry: jest.Mocked<ITelemetryService> = {
        trackEvent: jest.fn(), trackError: jest.fn(),
        isEnabled: jest.fn().mockReturnValue(false),
        setEnabled: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
    } as any;

    const mockDeviceService: jest.Mocked<DeviceService> = {
        getDevice: jest.fn().mockResolvedValue(undefined),
        getAllDevices: jest.fn().mockResolvedValue([]),
        createDevice: jest.fn(),
        updateDevice: jest.fn(),
        mergeDeviceMetadata: jest.fn().mockResolvedValue(undefined),
        deleteDevice: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => {}),
        ...deviceOverrides,
    } as any;

    const mockManageabilityService: jest.Mocked<ManageabilityService> = {
        getUpdatePosture: jest.fn(),
        applyUpdates: jest.fn(),
    } as any;

    const mockUserGroupService = {
        getAllGroups: jest.fn().mockReturnValue([]),
        subscribe: jest.fn().mockReturnValue(() => {}),
    } as any;

    return { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService, mockUserGroupService };
}

function makeController(deviceOverrides: Partial<jest.Mocked<DeviceService>> = {}) {
    const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService, mockUserGroupService } = makeDeps(deviceOverrides);
    const ctrl = new AdminDashboardViewController({
        logger: mockLogger,
        telemetry: mockTelemetry,
        deviceService: mockDeviceService,
        manageabilityService: mockManageabilityService,
        userGroupService: mockUserGroupService,
    });
    return { ctrl, mockDeviceService };
}

// ---------------------------------------------------------------------------
// render() — card update state badges
// ---------------------------------------------------------------------------

describe('AdminDashboardViewController — render() update state', () => {
    afterEach(() => { jest.clearAllMocks(); });

    it('renders update badge when status is available and candidates exist', async () => {
        const device = makeDevice({
            pendingUpdates: makePending({
                status: 'available',
                candidates: [
                    { package: 'curl', currentVersion: '7.0', availableVersion: '8.0', source: 'apt' },
                    { package: 'openssl', currentVersion: '3.0', availableVersion: '3.1', source: 'apt' },
                ],
            }),
        });
        const { ctrl, mockDeviceService } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('2 update(s)');
        expect(html).toContain('open-update-review');
    });

    it('does not show update badge when status is available but candidates is empty', async () => {
        const device = makeDevice({
            pendingUpdates: makePending({ status: 'available', candidates: [] }),
        });
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        // No badge buttons when candidate list is empty (CSS class names are present in styles but not as button classes)
        expect(html).not.toContain('update(s)');
        expect(html).not.toContain('Applied');
        expect(html).not.toContain('Up to date');
    });

    it('renders applied badge when status is applied', async () => {
        const device = makeDevice({
            pendingUpdates: makePending({ status: 'applied' }),
        });
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('update-badge-applied');
        expect(html).toContain('Applied');
    });

    it('renders error badge when status is error', async () => {
        const device = makeDevice({
            pendingUpdates: makePending({ status: 'error' }),
        });
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('update-badge-error');
        expect(html).toContain('Check failed');
    });

    it('renders "Up to date" text when status is none', async () => {
        const device = makeDevice({
            pendingUpdates: makePending({ status: 'none' }),
        });
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('Up to date');
        expect(html).not.toContain('update(s)');
        expect(html).not.toContain('Check failed');
        expect(html).not.toContain('>Applied<');
    });

    it('shows no update row when pendingUpdates metadata is absent', async () => {
        const device = makeDevice({});
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).not.toContain('update(s)');
        expect(html).not.toContain('Up to date');
        expect(html).not.toContain('Check failed');
        expect(html).not.toContain('Applied');
    });
});

// ---------------------------------------------------------------------------
// render() — last checked row
// ---------------------------------------------------------------------------

describe('AdminDashboardViewController — render() last checked', () => {
    afterEach(() => { jest.clearAllMocks(); });

    it('shows "Never" when no lastCheckup in metadata', async () => {
        const device = makeDevice({});
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('Never');
        expect(html).toContain('run-checkup-now');
    });

    it('shows formatted age when lastCheckup is present', async () => {
        const past = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
        const device = makeDevice({ lastCheckup: makeCheckupResult({ checkedAt: past }) });
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('5m ago');
        expect(html).toContain('run-checkup-now');
    });

    it('always renders the refresh icon button for setup devices', async () => {
        const device = makeDevice({});
        const { ctrl } = makeController({ getAllDevices: jest.fn().mockResolvedValue([device]) });

        const html = await ctrl.render();

        expect(html).toContain('codicon-refresh');
        expect(html).toContain('run-checkup-now');
    });
});

// ---------------------------------------------------------------------------
// handleMessage() — runCheckupNow
// ---------------------------------------------------------------------------

describe('AdminDashboardViewController — handleMessage() runCheckupNow', () => {
    let vscode: any;

    beforeEach(() => {
        jest.clearAllMocks();
        vscode = require('vscode');
        vscode.window.withProgress = jest.fn().mockImplementation(
            async (_opts: any, task: any) => { await task(); },
        );
        // eslint-disable-next-line @typescript-eslint/naming-convention
        vscode.ProgressLocation = { Notification: 15 };
        vscode.window.showErrorMessage = jest.fn();
    });

    it('calls scheduledCheckupService.runCheckupNow for the device', async () => {
        const device = makeDevice({});
        const { ctrl } = makeController({
            getDevice: jest.fn().mockResolvedValue(device),
            getAllDevices: jest.fn().mockResolvedValue([device]),
        });

        await ctrl.handleMessage({ type: 'runCheckupNow', deviceId: 'dev-001' } as any);

        expect(scheduledCheckupService.runCheckupNow).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'dev-001' }),
        );
    });

    it('shows error message when runCheckupNow throws', async () => {
        const device = makeDevice({});
        (scheduledCheckupService.runCheckupNow as jest.Mock).mockRejectedValueOnce(new Error('SSH timeout'));
        vscode.window.withProgress = jest.fn().mockImplementation(
            async (_opts: any, task: any) => { await task(); },
        );

        const { ctrl } = makeController({
            getDevice: jest.fn().mockResolvedValue(device),
            getAllDevices: jest.fn().mockResolvedValue([device]),
        });

        await ctrl.handleMessage({ type: 'runCheckupNow', deviceId: 'dev-001' } as any);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Checkup failed'),
        );
    });

    it('does nothing when device is not found', async () => {
        const { ctrl } = makeController({
            getDevice: jest.fn().mockResolvedValue(undefined),
        });

        await ctrl.handleMessage({ type: 'runCheckupNow', deviceId: 'missing' } as any);

        expect(scheduledCheckupService.runCheckupNow).not.toHaveBeenCalled();
    });
});
