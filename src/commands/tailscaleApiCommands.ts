/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Command handlers for Tailscale API credential management (Phase 2).
 *
 * Credentials are stored exclusively in VS Code SecretStorage and are never
 * logged, written to settings, or exposed outside of the SecretStorage API.
 */

import * as vscode from 'vscode';
import { COMMANDS } from '../constants/commands';
import { tailscaleApiService } from '../services/tailscaleApiService';
import { logger } from '../utils/logger';

/**
 * Configure Tailscale API OAuth credentials.
 *
 * Validates credentials by calling the API before storing them — the user
 * never gets a "stored successfully" message for invalid credentials.
 */
async function configureTailscaleApiCommand(): Promise<void> {
    const clientId = await vscode.window.showInputBox({
        title:        'ZGX Toolkit: Configure Tailscale API',
        prompt:       'Enter your Tailscale OAuth Client ID',
        placeHolder:  'e.g. k1234...',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Client ID cannot be empty',
    });
    if (!clientId) { return; }

    const clientSecret = await vscode.window.showInputBox({
        title:        'ZGX Toolkit: Configure Tailscale API',
        prompt:       'Enter your Tailscale OAuth Client Secret',
        placeHolder:  'tskey-client-...',
        password:     true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Client secret cannot be empty',
    });
    if (!clientSecret) { return; }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title:    'ZGX Toolkit: Validating Tailscale API credentials…',
                cancellable: false,
            },
            () => tailscaleApiService.testCredentials(clientId.trim(), clientSecret.trim())
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Tailscale API: credential validation failed', { error: msg });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Tailscale API credentials are invalid — ${msg}. Credentials were not saved.`
        );
        return;
    }

    await tailscaleApiService.setCredentials(clientId.trim(), clientSecret.trim());
    vscode.window.showInformationMessage(
        'ZGX Toolkit: Tailscale API credentials saved. Fleet status will use the API when the local Tailscale client is offline.'
    );
}

/**
 * Clear stored Tailscale API OAuth credentials after user confirmation.
 */
async function clearTailscaleApiCredentialsCommand(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
        'Remove stored Tailscale API credentials? The fleet status API fallback will stop working until you reconfigure it.',
        { modal: true },
        'Remove Credentials'
    );
    if (answer !== 'Remove Credentials') { return; }

    await tailscaleApiService.clearCredentials();
    vscode.window.showInformationMessage('ZGX Toolkit: Tailscale API credentials removed.');
    logger.info('Tailscale API: credentials cleared by user');
}

export function registerTailscaleApiCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            COMMANDS.CONFIGURE_TAILSCALE_API,
            configureTailscaleApiCommand
        ),
        vscode.commands.registerCommand(
            COMMANDS.CLEAR_TAILSCALE_API_CREDENTIALS,
            clearTailscaleApiCredentialsCommand
        )
    );
}
