/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for platform command handlers.
 */

import * as vscode from 'vscode';
import { registerPlatformCommands } from '../../commands/platformCommands';
import { COMMANDS } from '../../constants/commands';

jest.mock('vscode');
jest.mock('../../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../services', () => ({
    deviceService: {
        getAllDevices: jest.fn(),
    },
    platformProfileService: {
        detect:        jest.fn(),
        isKernelHeld:  jest.fn().mockReturnValue(false),
    },
}));

import { deviceService, platformProfileService } from '../../services';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockDevice = {
    id:       'dev-001',
    name:     'ZGX-Test',
    host:     '192.168.1.50',
    port:     22,
    username: 'nvidia',
    metadata: {},
} as any;

const mockProfile = {
    manufacturer:  'HP',
    productName:   'HP ZGX Nano G1n AI Station',
    isHpDevice:    true,
    arch:          'arm64',
    os:            { id: 'ubuntu', idLike: 'debian', family: 'debian', versionId: '24.04', prettyName: 'Ubuntu 24.04.2 LTS' },
    packageManager: 'apt',
    kernel:        { release: '6.17.0-1018-nvidia', flavor: 'nvidia' },
    gpu:           { vendor: 'nvidia', computeStack: 'cuda', computeStackVersion: '12.4', memoryModel: 'unified', driverBranch: '580' },
    heldPackages:  ['linux-image-6.17.0-1018-nvidia'],
    heldKernelPackages: ['linux-image-6.17.0-1018-nvidia'],
    vendorController: { sparkUpdatectl: false },
    detectedAt:    '2026-06-28T10:00:00Z',
    isDgxOs:       true,
    dgxRelease:    '7.1',
    cpu:           { vendor: 'nvidia-grace', model: 'NVIDIA Grace', coresLogical: 20 },
} as any;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Platform Command Handlers', () => {
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

        (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);
        (platformProfileService.detect as jest.Mock).mockResolvedValue(mockProfile);
        (platformProfileService.isKernelHeld as jest.Mock).mockReturnValue(false);

        jest.clearAllMocks();

        // Re-setup base mocks after clearAllMocks
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

        (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);
        (platformProfileService.detect as jest.Mock).mockResolvedValue(mockProfile);
        (platformProfileService.isKernelHeld as jest.Mock).mockReturnValue(false);

        registerPlatformCommands(mockContext);
    });

    // -------------------------------------------------------------------------
    // detectPlatform command
    // -------------------------------------------------------------------------

    describe('DETECT_PLATFORM', () => {
        it('shows info message and returns early when no devices are configured', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([]);

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('No devices configured')
            );
            expect(platformProfileService.detect).not.toHaveBeenCalled();
        });

        it('calls detect directly without QuickPick when there is exactly one device', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
            expect(platformProfileService.detect).toHaveBeenCalledWith(mockDevice);
        });

        it('shows a formatted summary message on success', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('·')
            );
            const msg = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0][0] as string;
            expect(msg).toContain('HP');
            expect(msg).toContain('ubuntu');
            expect(msg).toContain('apt');
            expect(msg).toContain('nvidia');
            expect(msg).toContain('kernel -nvidia');
        });

        it('appends (held) to the summary when kernel is held', async () => {
            (deviceService.getAllDevices as jest.Mock)
                .mockResolvedValueOnce([mockDevice])   // selectDevice call
                .mockResolvedValue([mockDevice]);       // post-detect getAllDevices
            (platformProfileService.isKernelHeld as jest.Mock).mockReturnValue(true);

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            const msg = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0][0] as string;
            expect(msg).toContain('(held)');
        });

        it('shows an error message when detect() throws', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
            (platformProfileService.detect as jest.Mock).mockRejectedValue(
                new Error('SSH connection refused')
            );

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('SSH connection refused')
            );
        });

        it('returns early without error when device selection is cancelled', async () => {
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice, mockDevice]);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await commandHandlers.get(COMMANDS.DETECT_PLATFORM)!();

            expect(platformProfileService.detect).not.toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });
    });
});
