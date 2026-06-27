/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for DeviceInfoViewController.
 * Tests render output and message handling against the existing HP-authored
 * implementation which reads snapshots from Device.metadata.manageabilitySnapshot.
 */

import { DeviceInfoViewController } from '../../views/devices/info/deviceInfoViewController';
import { Logger } from '../../utils/logger';
import { ITelemetryService } from '../../types/telemetry';
import { DeviceService } from '../../services/deviceService';
import { ManageabilityService } from '../../services/manageabilityService';
import { Device } from '../../types/devices';
import { ManageabilitySnapshot } from '../../types/manageability';

jest.mock('vscode');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeDevice = (overrides: Partial<Device> = {}): Device => ({
    id: 'device-1',
    name: 'ZGX-Test',
    host: '10.0.0.42',
    username: 'root',
    port: 22,
    isSetup: true,
    useKeyAuth: true,
    keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
    createdAt: '2026-01-01T00:00:00Z',
    metadata: {},
    ...overrides,
});

const makeSnapshot = (overrides: Partial<ManageabilitySnapshot> = {}): ManageabilitySnapshot => ({
    collectedAt: '2026-06-27T12:00:00Z',
    identity: {
        tool: 'device_identity',
        timestamp: '2026-06-27T12:00:00Z',
        status: 'ok',
        data: {
            manufacturer: 'NVIDIA',
            product_name: 'DGX Spark',
            bios_version: '1.0.0',
            bios_date: '2026-01-01',
            board_name: 'PCB-001',
            hostname: 'dgx-spark-01',
        },
    },
    health: {
        tool: 'spark_diagctl',
        timestamp: '2026-06-27T12:00:00Z',
        status: 'ok',
        data: {
            overall_status: 'healthy',
            gpu_vendor: 'nvidia',
            signals: [],
            gpus: [],
        },
    },
    ...overrides,
});

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: {
    deviceService?: Partial<jest.Mocked<DeviceService>>;
    manageabilityService?: Partial<jest.Mocked<ManageabilityService>>;
} = {}) {
    const mockLogger: jest.Mocked<Logger> = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
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
        ...overrides.deviceService,
    } as any;

    const mockManageabilityService: jest.Mocked<ManageabilityService> = {
        collectInventory: jest.fn().mockResolvedValue({} as ManageabilitySnapshot),
        getHealthPosture: jest.fn(),
        getUpdatePosture: jest.fn(),
        runTool: jest.fn(),
        hasCollector: jest.fn(),
        installCollector: jest.fn(),
        applyUpdates: jest.fn(),
        generateDiagBundle: jest.fn(),
        getResetReasons: jest.fn(),
        ...overrides.manageabilityService,
    } as any;

    return { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeviceInfoViewController', () => {
    let view: DeviceInfoViewController;

    afterEach(() => {
        view?.dispose();
        jest.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // render() — no deviceId
    // -------------------------------------------------------------------------

    describe('render() — no deviceId', () => {
        it('returns "No device selected" HTML when called without params', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps();
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render(undefined);

            expect(html).toContain('No device selected');
            expect(mockDeviceService.getDevice).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // render() — device not found
    // -------------------------------------------------------------------------

    describe('render() — device not found', () => {
        it('returns "Device not found" HTML when deviceId resolves to nothing', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(undefined) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: 'missing-device' });

            expect(html).toContain('Device not found');
            expect(mockDeviceService.getDevice).toHaveBeenCalledWith('missing-device');
        });
    });

    // -------------------------------------------------------------------------
    // render() — device found but no snapshot
    // -------------------------------------------------------------------------

    describe('render() — device without snapshot', () => {
        it('shows the empty state when no manageabilitySnapshot exists', async () => {
            const device = makeDevice({ metadata: {} });
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('ZGX-Test');
            expect(html).toContain('No inventory data yet');
        });

        it('includes the Run Inventory button in the empty state', async () => {
            const device = makeDevice();
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('runInventoryBtn');
        });
    });

    // -------------------------------------------------------------------------
    // render() — device with snapshot
    // -------------------------------------------------------------------------

    describe('render() — device with snapshot', () => {
        it('includes the device name and identity data from the snapshot', async () => {
            const snapshot = makeSnapshot();
            const device = makeDevice({
                metadata: { manageabilitySnapshot: snapshot },
            });
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('ZGX-Test');
            expect(html).toContain('DGX Spark');
            expect(html).toContain('NVIDIA');
        });

        it('shows the collected-at timestamp', async () => {
            const snapshot = makeSnapshot();
            const device = makeDevice({ metadata: { manageabilitySnapshot: snapshot } });
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('2026-06-27T12:00:00Z');
        });

        it('shows health status when present in snapshot', async () => {
            const snapshot = makeSnapshot();
            const device = makeDevice({ metadata: { manageabilitySnapshot: snapshot } });
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const html = await view.render({ deviceId: device.id });

            expect(html).toContain('healthy');
        });
    });

    // -------------------------------------------------------------------------
    // handleMessage() — runInventory
    // -------------------------------------------------------------------------

    describe('handleMessage() — runInventory', () => {
        it('calls manageabilityService.collectInventory and then refreshes', async () => {
            const device = makeDevice();
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });

            mockManageabilityService.collectInventory.mockResolvedValue({
                collectedAt: '2026-06-27T12:00:00Z',
            } as any);

            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const mockRefresh = jest.fn();
            const mockMessage = jest.fn();
            view.setRefreshCallback(mockRefresh);
            view.setMessageCallback(mockMessage);

            await view.handleMessage({ type: 'runInventory', deviceId: device.id } as any);

            expect(mockManageabilityService.collectInventory).toHaveBeenCalledWith(device);
            // inventoryComplete message sent to webview
            expect(mockMessage).toHaveBeenCalledWith({ type: 'inventoryComplete' });
        });

        it('sends inventoryComplete even when collectInventory throws', async () => {
            const device = makeDevice();
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps({
                deviceService: { getDevice: jest.fn().mockResolvedValue(device) },
            });

            mockManageabilityService.collectInventory.mockRejectedValue(new Error('SSH timeout'));

            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const mockMessage = jest.fn();
            view.setMessageCallback(mockMessage);
            view.setRefreshCallback(jest.fn());

            await view.handleMessage({ type: 'runInventory', deviceId: device.id } as any);

            // inventoryComplete is sent in the finally block
            expect(mockMessage).toHaveBeenCalledWith({ type: 'inventoryComplete' });
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('warns and returns early when deviceId is missing from message', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps();
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            await view.handleMessage({ type: 'runInventory' } as any);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('runInventory message missing deviceId')
            );
            expect(mockManageabilityService.collectInventory).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // handleMessage() — goBack
    // -------------------------------------------------------------------------

    describe('handleMessage() — goBack', () => {
        it('navigates to admin/dashboard when goBack message is received', async () => {
            const { mockLogger, mockTelemetry, mockDeviceService, mockManageabilityService } = makeDeps();
            view = new DeviceInfoViewController({
                logger: mockLogger,
                telemetry: mockTelemetry,
                deviceService: mockDeviceService,
                manageabilityService: mockManageabilityService,
            });

            const mockNavigate = jest.fn().mockResolvedValue(undefined);
            view.setNavigationCallback(mockNavigate);

            await view.handleMessage({ type: 'goBack' } as any);

            expect(mockNavigate).toHaveBeenCalledWith('admin/dashboard', undefined, 'editor');
        });
    });
});
