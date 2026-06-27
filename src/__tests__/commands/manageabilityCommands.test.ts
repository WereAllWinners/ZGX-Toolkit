/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for Phase 2 manageability command handlers.
 */

import * as vscode from 'vscode';
import { registerManageabilityCommands } from '../../commands/manageabilityCommands';
import { logger } from '../../utils/logger';
import { COMMANDS } from '../../constants/commands';

jest.mock('vscode');
jest.mock('../../utils/logger');

// Mock the services index so the commands file picks up the same mock
jest.mock('../../services', () => ({
    deviceService: {
        getAllDevices: jest.fn(),
    },
    manageabilityService: {
        getHealthPosture: jest.fn(),
        getUpdatePosture: jest.fn(),
        collectInventory: jest.fn(),
        applyUpdates: jest.fn(),
        generateDiagBundle: jest.fn(),
        runTool: jest.fn(),
        hasCollector: jest.fn(),
        installCollector: jest.fn(),
    },
}));

// Import after mocking so we get the mock versions
import { deviceService, manageabilityService } from '../../services';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockDevice = {
    id: 'device-1',
    name: 'ZGX-Test',
    host: '192.168.1.100',
    port: 22,
    metadata: {},
} as any;

const mockHealthEnvelope = {
    tool: 'spark_diagctl',
    timestamp: '2026-06-27T00:00:00Z',
    status: 'ok' as const,
    data: {
        overall_status: 'healthy' as const,
        gpu_vendor: 'nvidia' as const,
        signals: [],
        gpus: [],
    },
};

const mockUpdateEnvelope = {
    tool: 'spark_updatectl',
    timestamp: '2026-06-27T00:00:00Z',
    status: 'ok' as const,
    data: {
        status: 'up-to-date',
        pending_updates: [],
    },
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Manageability Command Handlers (Phase 2)', () => {
    let mockContext: vscode.ExtensionContext;
    let mockProvider: any;
    let commandHandlers: Map<string, (...args: any[]) => any>;

    beforeEach(() => {
        commandHandlers = new Map();

        mockContext = {
            subscriptions: [],
            extensionUri: vscode.Uri.file('/mock/extension'),
        } as any;

        mockProvider = {
            openInEditor: jest.fn().mockResolvedValue(undefined),
        };

        // Add ProgressLocation enum that the handlers reference
        (vscode as any).ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };

        // Capture registered handlers
        (vscode.commands.registerCommand as jest.Mock).mockImplementation(
            (command: string, handler: (...args: any[]) => any) => {
                commandHandlers.set(command, handler);
                return { dispose: jest.fn() };
            }
        );

        // withProgress: immediately invoke the task callback
        (vscode.window as any).withProgress = jest.fn().mockImplementation(
            (_opts: any, task: (progress: any) => Promise<any>) =>
                task({ report: jest.fn() })
        );

        // Default window mocks
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

        // Default workspace configuration mock: empty inventory path
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockReturnValue(''),
        });

        // Default service mocks
        (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);
        (manageabilityService.getHealthPosture as jest.Mock).mockResolvedValue({
            success: true,
            envelope: mockHealthEnvelope,
        });
        (manageabilityService.getUpdatePosture as jest.Mock).mockResolvedValue({
            success: true,
            envelope: mockUpdateEnvelope,
        });
        (manageabilityService.collectInventory as jest.Mock).mockResolvedValue({
            collectedAt: '2026-06-27T00:00:00Z',
            identity: mockHealthEnvelope,
            osBuild: undefined,
            hardware: undefined,
            firmware: undefined,
            drivers: undefined,
            software: undefined,
        });

        // Logger mocks
        (logger.debug as jest.Mock).mockReturnValue(undefined);
        (logger.info as jest.Mock).mockReturnValue(undefined);
        (logger.error as jest.Mock).mockReturnValue(undefined);

        registerManageabilityCommands(mockContext, mockProvider);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // selectDevice helper behaviour (tested through runHealthCheckCommand)
    // -------------------------------------------------------------------------

    describe('selectDevice — no devices', () => {
        it('shows an info message and returns without calling the service', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('No devices configured')
            );
            expect(manageabilityService.getHealthPosture).not.toHaveBeenCalled();
        });
    });

    describe('selectDevice — single device', () => {
        it('skips the QuickPick and uses the only device directly', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);

            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
            expect(manageabilityService.getHealthPosture).toHaveBeenCalledWith(mockDevice);
        });
    });

    // -------------------------------------------------------------------------
    // runHealthCheckCommand
    // -------------------------------------------------------------------------

    describe('runHealthCheckCommand', () => {
        beforeEach(() => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        });

        it('calls getHealthPosture and shows an info message on success', async () => {
            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(manageabilityService.getHealthPosture).toHaveBeenCalledWith(mockDevice);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('ZGX-Test')
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('healthy')
            );
        });

        it('shows an error message when the service returns success:false', async () => {
            (manageabilityService.getHealthPosture as jest.Mock).mockResolvedValue({
                success: false,
                error: 'SSH timeout',
            });

            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('SSH timeout')
            );
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('shows an error message when the service throws', async () => {
            (manageabilityService.getHealthPosture as jest.Mock).mockRejectedValue(
                new Error('Connection refused')
            );

            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Connection refused')
            );
        });

        it('shows ✓ icon when device is healthy', async () => {
            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('✓')
            );
        });

        it('shows ⚠️ icon when device is degraded', async () => {
            (manageabilityService.getHealthPosture as jest.Mock).mockResolvedValue({
                success: true,
                envelope: {
                    ...mockHealthEnvelope,
                    data: { ...mockHealthEnvelope.data, overall_status: 'degraded' },
                },
            });

            const handler = commandHandlers.get(COMMANDS.RUN_HEALTH_CHECK)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('⚠️')
            );
        });
    });

    // -------------------------------------------------------------------------
    // checkForUpdatesCommand
    // -------------------------------------------------------------------------

    describe('checkForUpdatesCommand', () => {
        beforeEach(() => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        });

        it('shows "up to date" when no pending updates exist', async () => {
            const handler = commandHandlers.get(COMMANDS.CHECK_FOR_UPDATES)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('up to date')
            );
        });

        it('shows update count when updates are available', async () => {
            (manageabilityService.getUpdatePosture as jest.Mock).mockResolvedValue({
                success: true,
                envelope: {
                    ...mockUpdateEnvelope,
                    data: {
                        status: 'updates-available',
                        pending_updates: [
                            { name: 'cuda-toolkit', version: '12.5', type: 'apt' },
                            { name: 'nvidia-driver', version: '580.200', type: 'apt' },
                        ],
                    },
                },
            });

            const handler = commandHandlers.get(COMMANDS.CHECK_FOR_UPDATES)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('2')
            );
        });

        it('shows error when service returns success:false', async () => {
            (manageabilityService.getUpdatePosture as jest.Mock).mockResolvedValue({
                success: false,
                error: 'Tool not found',
            });

            const handler = commandHandlers.get(COMMANDS.CHECK_FOR_UPDATES)!;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Tool not found')
            );
        });
    });

    // -------------------------------------------------------------------------
    // checkAnsibleDriftCommand
    // -------------------------------------------------------------------------

    describe('checkAnsibleDriftCommand', () => {
        it('shows a warning and settings prompt when inventory path is not configured', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(''),
            });

            const handler = commandHandlers.get(COMMANDS.CHECK_ANSIBLE_DRIFT)!;
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('Ansible inventory path'),
                'Open Settings'
            );
            expect(deviceService.getAllDevices).not.toHaveBeenCalled();
        });

        it('opens the settings editor when "Open Settings" is clicked', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(''),
            });
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Open Settings');

            const handler = commandHandlers.get(COMMANDS.CHECK_ANSIBLE_DRIFT)!;
            await handler();

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'workbench.action.openSettings',
                'zgxToolkit.manageability.ansibleInventoryPath'
            );
        });

        it('proceeds to device selection when inventory path is configured', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('/etc/ansible/hosts'),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);

            const handler = commandHandlers.get(COMMANDS.CHECK_ANSIBLE_DRIFT)!;
            await handler();

            expect(deviceService.getAllDevices).toHaveBeenCalled();
            expect(manageabilityService.getHealthPosture).toHaveBeenCalledWith(mockDevice);
        });

        it('shows "No drift detected" when device is healthy', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('/etc/ansible/hosts'),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);

            const handler = commandHandlers.get(COMMANDS.CHECK_ANSIBLE_DRIFT)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('No drift detected')
            );
        });

        it('shows "Configuration drift detected" when device is degraded', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('/etc/ansible/hosts'),
            });
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
            (manageabilityService.getHealthPosture as jest.Mock).mockResolvedValue({
                success: true,
                envelope: {
                    ...mockHealthEnvelope,
                    data: { ...mockHealthEnvelope.data, overall_status: 'degraded' },
                },
            });

            const handler = commandHandlers.get(COMMANDS.CHECK_ANSIBLE_DRIFT)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Configuration drift detected')
            );
        });
    });

    // -------------------------------------------------------------------------
    // collectInventoryCommand
    // -------------------------------------------------------------------------

    describe('collectInventoryCommand', () => {
        beforeEach(() => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        });

        it('calls collectInventory and opens the device info panel', async () => {
            const handler = commandHandlers.get(COMMANDS.COLLECT_INVENTORY)!;
            await handler();

            expect(manageabilityService.collectInventory).toHaveBeenCalledWith(mockDevice);
            expect(mockProvider.openInEditor).toHaveBeenCalledWith(
                'devices/info',
                { deviceId: mockDevice.id }
            );
        });

        it('shows success info message after collection', async () => {
            const handler = commandHandlers.get(COMMANDS.COLLECT_INVENTORY)!;
            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Inventory collected')
            );
        });

        it('shows error message when collectInventory throws', async () => {
            (manageabilityService.collectInventory as jest.Mock).mockRejectedValue(
                new Error('SSH key rejected')
            );

            const handler = commandHandlers.get(COMMANDS.COLLECT_INVENTORY)!;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('SSH key rejected')
            );
            expect(mockProvider.openInEditor).not.toHaveBeenCalled();
        });
    });
});
