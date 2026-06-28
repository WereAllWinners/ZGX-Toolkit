/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for Tailscale API credential command handlers (Phase 2).
 */

import * as vscode from 'vscode';
import { COMMANDS } from '../../constants/commands';
import { registerTailscaleApiCommands } from '../../commands/tailscaleApiCommands';

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../../services/tailscaleApiService', () => ({
    tailscaleApiService: {
        testCredentials:  jest.fn(),
        setCredentials:   jest.fn(),
        clearCredentials: jest.fn(),
    },
}));

// Import AFTER mock declaration so we get the mocked version
import { tailscaleApiService } from '../../services/tailscaleApiService';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildContext() {
    return { subscriptions: [] as any[] } as vscode.ExtensionContext;
}

async function invokeCommand(commandId: string): Promise<void> {
    const ctx = buildContext();
    registerTailscaleApiCommands(ctx);
    const registration = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
        ([id]) => id === commandId
    );
    if (!registration) { throw new Error(`Command not registered: ${commandId}`); }
    await registration[1]();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('configureTailscaleApiCommand', () => {
    const mockTest = tailscaleApiService.testCredentials as jest.Mock;
    const mockSet  = tailscaleApiService.setCredentials  as jest.Mock;

    beforeEach(() => {
        mockTest.mockResolvedValue(undefined);
        mockSet.mockResolvedValue(undefined);
    });

    it('stores credentials when validation succeeds', async () => {
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('my-client-id')
            .mockResolvedValueOnce('my-client-secret');

        await invokeCommand(COMMANDS.CONFIGURE_TAILSCALE_API);

        expect(mockTest).toHaveBeenCalledWith('my-client-id', 'my-client-secret');
        expect(mockSet).toHaveBeenCalledWith('my-client-id', 'my-client-secret');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('saved')
        );
    });

    it('does NOT store credentials when validation fails', async () => {
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('bad-id')
            .mockResolvedValueOnce('bad-secret');
        mockTest.mockRejectedValue(new Error('401 Unauthorized'));

        await invokeCommand(COMMANDS.CONFIGURE_TAILSCALE_API);

        expect(mockTest).toHaveBeenCalled();
        expect(mockSet).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('invalid')
        );
    });

    it('returns early when user cancels client ID prompt', async () => {
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

        await invokeCommand(COMMANDS.CONFIGURE_TAILSCALE_API);

        expect(mockTest).not.toHaveBeenCalled();
        expect(mockSet).not.toHaveBeenCalled();
    });

    it('returns early when user cancels client secret prompt', async () => {
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('client-id')
            .mockResolvedValueOnce(undefined);

        await invokeCommand(COMMANDS.CONFIGURE_TAILSCALE_API);

        expect(mockTest).not.toHaveBeenCalled();
        expect(mockSet).not.toHaveBeenCalled();
    });
});

describe('clearTailscaleApiCredentialsCommand', () => {
    const mockClear = tailscaleApiService.clearCredentials as jest.Mock;

    beforeEach(() => {
        mockClear.mockResolvedValue(undefined);
    });

    it('clears credentials when user confirms', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Remove Credentials');

        await invokeCommand(COMMANDS.CLEAR_TAILSCALE_API_CREDENTIALS);

        expect(mockClear).toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('removed')
        );
    });

    it('does NOT clear credentials when user cancels', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        await invokeCommand(COMMANDS.CLEAR_TAILSCALE_API_CREDENTIALS);

        expect(mockClear).not.toHaveBeenCalled();
    });

    it('does NOT clear credentials when user dismisses modal', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');

        await invokeCommand(COMMANDS.CLEAR_TAILSCALE_API_CREDENTIALS);

        expect(mockClear).not.toHaveBeenCalled();
    });
});
