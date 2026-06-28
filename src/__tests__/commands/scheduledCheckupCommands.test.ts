/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for scheduled checkup command handlers.
 */

import * as vscode from 'vscode';
import { registerScheduledCheckupCommands } from '../../commands/scheduledCheckupCommands';
import { COMMANDS } from '../../constants/commands';

jest.mock('vscode');
jest.mock('../../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../services', () => ({
    deviceService: {
        getAllDevices: jest.fn(),
    },
    scheduledCheckupService: {
        runCheckupNow: jest.fn(),
    },
}));

import { deviceService, scheduledCheckupService } from '../../services';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockDevice = {
    id:       'dev-001',
    name:     'zgx-nano',
    host:     '100.64.0.1',
    port:     22,
    username: 'nvidia',
    metadata: {},
} as any;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('scheduledCheckupCommands', () => {
    let mockContext: vscode.ExtensionContext;
    let commandHandlers: Map<string, (...args: any[]) => any>;

    beforeEach(() => {
        commandHandlers = new Map();
        mockContext = { subscriptions: [] } as any;

        (vscode as any).ProgressLocation = { Notification: 15 };

        (vscode.commands.registerCommand as jest.Mock).mockImplementation(
            (command: string, handler: (...args: any[]) => any) => {
                commandHandlers.set(command, handler);
                return { dispose: jest.fn() };
            }
        );

        (vscode.window as any).withProgress = jest.fn().mockImplementation(
            (_opts: any, task: (progress: any) => Promise<any>) => task({ report: jest.fn() })
        );

        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showErrorMessage      as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showQuickPick         as jest.Mock).mockResolvedValue(undefined);

        (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
            checkedAt:        '2026-06-28T10:00:00Z',
            source:           'apt',
            availableUpdates: [],
            status:           'ok',
        });

        jest.clearAllMocks();
    });

    // ---------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------

    it('registers the RUN_CHECKUP_NOW command', () => {
        registerScheduledCheckupCommands(mockContext);
        expect(commandHandlers.has(COMMANDS.RUN_CHECKUP_NOW)).toBe(true);
    });

    // ---------------------------------------------------------------------------
    // runCheckupNowCommand
    // ---------------------------------------------------------------------------

    describe('RUN_CHECKUP_NOW handler', () => {
        beforeEach(() => {
            registerScheduledCheckupCommands(mockContext);
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue([mockDevice]);
        });

        it('calls runCheckupNow with the selected device', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
                checkedAt:        '2026-06-28T10:00:00Z',
                source:           'apt',
                availableUpdates: [],
                status:           'ok',
            });

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            expect(scheduledCheckupService.runCheckupNow).toHaveBeenCalledWith(mockDevice);
        });

        it('shows "up to date" when availableUpdates is empty', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
                checkedAt:        '2026-06-28T10:00:00Z',
                source:           'apt',
                availableUpdates: [],
                status:           'ok',
            });

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('up to date')
            );
        });

        it('shows update count and source when updates are available (apt)', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
                checkedAt:        '2026-06-28T10:00:00Z',
                source:           'apt',
                availableUpdates: [
                    { package: 'curl',    currentVersion: '7.81.0', availableVersion: '8.0.0' },
                    { package: 'libssl3', currentVersion: '3.0.2',  availableVersion: '3.0.7' },
                    { package: 'openssl', currentVersion: '3.0.2',  availableVersion: '3.0.7' },
                    { package: 'wget',    currentVersion: '1.21.2', availableVersion: '1.21.4' },
                ],
                status: 'ok',
            });

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            const call = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0][0] as string;
            expect(call).toContain('4');
            expect(call).toContain('apt');
            expect(call).not.toContain('up to date');
        });

        it('shows update count and source for dnf', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
                checkedAt:        '2026-06-28T10:00:00Z',
                source:           'dnf',
                availableUpdates: [
                    { package: 'curl', currentVersion: '', availableVersion: '8.0.0' },
                    { package: 'wget', currentVersion: '', availableVersion: '1.21.4' },
                ],
                status: 'ok',
            });

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            const call = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0][0] as string;
            expect(call).toContain('2');
            expect(call).toContain('dnf');
        });

        it('does nothing when no device is selected (QuickPick cancelled)', async () => {
            const multiDevice = [mockDevice, { ...mockDevice, id: 'dev-002', name: 'amd-box' }];
            (deviceService.getAllDevices as jest.Mock).mockResolvedValue(multiDevice);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            expect(scheduledCheckupService.runCheckupNow).not.toHaveBeenCalled();
        });

        it('shows an error message when runCheckupNow throws', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockRejectedValue(
                new Error('SSH connection failed')
            );

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('SSH connection failed')
            );
        });

        it('does not offer to apply updates in the info message', async () => {
            (scheduledCheckupService.runCheckupNow as jest.Mock).mockResolvedValue({
                checkedAt:        '2026-06-28T10:00:00Z',
                source:           'apt',
                availableUpdates: [
                    { package: 'curl', currentVersion: '7.81.0', availableVersion: '8.0.0' },
                ],
                status: 'ok',
            });

            await commandHandlers.get(COMMANDS.RUN_CHECKUP_NOW)?.();

            const calls = (vscode.window.showInformationMessage as jest.Mock).mock.calls;
            // The info message should be the only arg — no 'Apply' or 'Update' button
            expect(calls[0].length).toBe(1);
        });
    });
});
