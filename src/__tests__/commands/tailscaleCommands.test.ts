/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for Tailscale command handlers and the detection flow.
 */

import * as vscode from 'vscode';
import { registerTailscaleCommands } from '../../commands/tailscaleCommands';
import { COMMANDS } from '../../constants/commands';

jest.mock('vscode');
jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

const mockDevice = {
    id: 'dev-001',
    name: 'dgx-spark-test',
    host: '192.168.1.50',
    port: 22,
    isSetup: true,
    metadata: {},
} as any;

const mockDetectionResult = {
    onDevice: true,
    onClient: false,
    tailnetIp: '100.100.50.5',
    ipSource: 'device' as const,
};

const mockMeta = {
    decision: 'enabled' as const,
    promptShown: true,
    tailnetIp: '100.100.50.5',
    detectedOn: 'device' as const,
    lastDetectedAt: new Date().toISOString(),
    decisionChangedAt: new Date().toISOString(),
    previousHost: '192.168.1.50',
};

jest.mock('../../services', () => ({
    deviceService: {
        getAllDevices: jest.fn(),
        updateDevice: jest.fn().mockResolvedValue(undefined),
        mergeDeviceMetadata: jest.fn().mockResolvedValue(undefined),
    },
    tailscaleService: {
        detect: jest.fn(),
        getMetadata: jest.fn(),
        buildMetadata: jest.fn(),
        isTailscaleIP: jest.fn(),
        isManaged: jest.fn(),
    },
}));

import { deviceService, tailscaleService } from '../../services';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Tailscale Command Handlers', () => {
    let mockContext: vscode.ExtensionContext;
    let commandHandlers: Map<string, (...args: any[]) => any>;

    beforeEach(() => {
        commandHandlers = new Map();

        mockContext = {
            subscriptions: [],
        } as any;

        (vscode as any).ProgressLocation = { Notification: 15 };

        (vscode.commands.registerCommand as jest.Mock).mockImplementation(
            (command: string, handler: (...args: any[]) => any) => {
                commandHandlers.set(command, handler);
                return { dispose: jest.fn() };
            }
        );

        (vscode.window as any).withProgress = jest.fn().mockImplementation(
            (_opts: any, task: (progress: any) => Promise<any>) =>
                task({ report: jest.fn() })
        );

        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

        (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        (deviceService.updateDevice as jest.Mock).mockResolvedValue(undefined);
        (deviceService.mergeDeviceMetadata as jest.Mock).mockResolvedValue(undefined);
        (tailscaleService.detect as jest.Mock).mockResolvedValue(mockDetectionResult);
        (tailscaleService.getMetadata as jest.Mock).mockReturnValue(undefined);
        (tailscaleService.buildMetadata as jest.Mock).mockReturnValue(mockMeta);

        registerTailscaleCommands(mockContext);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // enableTailscaleForDevice
    // -----------------------------------------------------------------------

    describe('enableTailscaleForDevice', () => {
        it('persists decision:enabled and switches host to tailnet IP when detected', async () => {
            const handler = commandHandlers.get(COMMANDS.ENABLE_TAILSCALE)!;
            await handler();

            expect(tailscaleService.detect).toHaveBeenCalledWith(mockDevice);
            expect(deviceService.mergeDeviceMetadata).toHaveBeenCalledWith(
                mockDevice.id,
                { tailscale: mockMeta },
                { host: '100.100.50.5' },
            );
        });

        it('shows info message and does not update when no tailnet IP found', async () => {
            (tailscaleService.detect as jest.Mock).mockResolvedValueOnce({
                onDevice: false,
                onClient: false,
                tailnetIp: undefined,
            });

            const handler = commandHandlers.get(COMMANDS.ENABLE_TAILSCALE)!;
            await handler();

            expect(deviceService.mergeDeviceMetadata).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Tailscale not detected')
            );
        });

        it('does nothing when no device is selected', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValueOnce([]);
            const handler = commandHandlers.get(COMMANDS.ENABLE_TAILSCALE)!;
            await handler();
            expect(tailscaleService.detect).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // disableTailscaleForDevice
    // -----------------------------------------------------------------------

    describe('disableTailscaleForDevice', () => {
        it('sets decision:disabled and restores previousHost', async () => {
            const existingMeta = {
                decision: 'enabled' as const,
                promptShown: true,
                tailnetIp: '100.100.50.5',
                previousHost: '192.168.1.50',
            };
            (tailscaleService.getMetadata as jest.Mock).mockReturnValueOnce(existingMeta);
            const deviceWithTailscaleHost = { ...mockDevice, host: '100.100.50.5' };
            (deviceService.getAllDevices as jest.Mock).mockResolvedValueOnce([deviceWithTailscaleHost]);

            const handler = commandHandlers.get(COMMANDS.DISABLE_TAILSCALE)!;
            await handler();

            expect(deviceService.mergeDeviceMetadata).toHaveBeenCalledWith(
                mockDevice.id,
                { tailscale: expect.objectContaining({ decision: 'disabled' }) },
                { host: '192.168.1.50' },
            );
        });

        it('keeps current host when no previousHost is stored', async () => {
            (tailscaleService.getMetadata as jest.Mock).mockReturnValueOnce({
                decision: 'enabled' as const,
                promptShown: true,
            });

            const handler = commandHandlers.get(COMMANDS.DISABLE_TAILSCALE)!;
            await handler();

            expect(deviceService.mergeDeviceMetadata).toHaveBeenCalledWith(
                mockDevice.id,
                expect.any(Object),
                { host: mockDevice.host },
            );
        });
    });

    // -----------------------------------------------------------------------
    // detectTailscale
    // -----------------------------------------------------------------------

    describe('detectTailscale', () => {
        it('reports findings without calling updateDevice', async () => {
            const handler = commandHandlers.get(COMMANDS.DETECT_TAILSCALE)!;
            await handler();

            expect(tailscaleService.detect).toHaveBeenCalledWith(mockDevice);
            expect(deviceService.mergeDeviceMetadata).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('100.100.50.5')
            );
        });

        it('shows not-detected message when nothing found', async () => {
            (tailscaleService.detect as jest.Mock).mockResolvedValueOnce({
                onDevice: false,
                onClient: false,
                tailnetIp: undefined,
            });

            const handler = commandHandlers.get(COMMANDS.DETECT_TAILSCALE)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('not detected')
            );
        });
    });
});

// ---------------------------------------------------------------------------
// Detection flow tests (runTailscaleDetectionFlow)
// ---------------------------------------------------------------------------

jest.mock('../../services/tailscaleService', () => {
    const actual = jest.requireActual('../../services/tailscaleService');
    return {
        ...actual,
        // Keep runTailscaleDetectionFlow as real so we can test it
    };
}, { virtual: false });

describe('runTailscaleDetectionFlow', () => {
    const mockDeviceSvc = {
        updateDevice: jest.fn().mockResolvedValue(undefined),
        mergeDeviceMetadata: jest.fn().mockResolvedValue(undefined),
    };

    const mockSvc = {
        getMetadata: jest.fn(),
        detect: jest.fn(),
        buildMetadata: jest.fn(),
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, def: any) => def),
        });
    });

    it('does nothing when tailscale.enabled is false', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, def: any) => key === 'tailscale.enabled' ? false : def),
        });

        mockSvc.getMetadata.mockReturnValue(undefined);

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        expect(mockSvc.detect).not.toHaveBeenCalled();
        expect(mockDeviceSvc.mergeDeviceMetadata).not.toHaveBeenCalled();
    });

    it('does nothing when promptShown is already true', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        mockSvc.getMetadata.mockReturnValue({ promptShown: true, decision: 'enabled' });

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        expect(mockSvc.detect).not.toHaveBeenCalled();
    });

    it('persists undecided without prompting when no tailnetIp found but detection ran', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        mockSvc.getMetadata.mockReturnValue(undefined);
        mockSvc.detect.mockResolvedValue({ onDevice: true, onClient: false, tailnetIp: undefined });
        mockSvc.buildMetadata.mockReturnValue({ decision: 'undecided', promptShown: false });

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        expect(mockDeviceSvc.mergeDeviceMetadata).toHaveBeenCalledWith(
            mockDevice.id,
            { tailscale: expect.objectContaining({ decision: 'undecided' }) },
        );
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('records undecided without prompting when promptOnDetect is false', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, def: any) => {
                if (key === 'tailscale.enabled') { return true; }
                if (key === 'tailscale.promptOnDetect') { return false; }
                return def;
            }),
        });

        mockSvc.getMetadata.mockReturnValue(undefined);
        mockSvc.detect.mockResolvedValue({ onDevice: true, onClient: false, tailnetIp: '100.100.50.5' });
        mockSvc.buildMetadata.mockReturnValue({ decision: 'undecided', promptShown: false });

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(mockDeviceSvc.mergeDeviceMetadata).toHaveBeenCalledWith(
            mockDevice.id,
            { tailscale: expect.objectContaining({ decision: 'undecided' }) },
        );
    });

    it('shows one-time prompt and persists enabled+host when user accepts', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        mockSvc.getMetadata.mockReturnValue(undefined);
        mockSvc.detect.mockResolvedValue({ onDevice: true, onClient: false, tailnetIp: '100.100.50.5' });
        mockSvc.buildMetadata.mockReturnValue({ decision: 'enabled', promptShown: true, tailnetIp: '100.100.50.5' });

        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Use Tailscale');

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        expect(mockDeviceSvc.mergeDeviceMetadata).toHaveBeenCalledWith(
            mockDevice.id,
            { tailscale: expect.any(Object) },
            { host: '100.100.50.5' },
        );
    });

    it('shows one-time prompt and persists disabled when user declines', async () => {
        const { runTailscaleDetectionFlow } = await import('../../services/tailscaleService');

        mockSvc.getMetadata.mockReturnValue(undefined);
        mockSvc.detect.mockResolvedValue({ onDevice: true, onClient: false, tailnetIp: '100.100.50.5' });
        mockSvc.buildMetadata.mockReturnValue({ decision: 'disabled', promptShown: true });

        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Not now');

        await runTailscaleDetectionFlow(mockDevice, mockSvc, mockDeviceSvc as any);

        // decision is 'disabled', so host is left unchanged — no deviceUpdates arg is passed
        expect(mockDeviceSvc.mergeDeviceMetadata).toHaveBeenCalledWith(
            mockDevice.id,
            { tailscale: expect.any(Object) },
            undefined,
        );
    });
});
