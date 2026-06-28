/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Command handlers for platform profile detection.
 * Follows the same pattern as manageabilityCommands.ts.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../constants/commands';
import { deviceService, platformProfileService } from '../services';
import { Device } from '../types/devices';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function selectDevice(title: string): Promise<Device | undefined> {
    const devices = await deviceService.getAllDevices();

    if (devices.length === 0) {
        vscode.window.showInformationMessage('ZGX Toolkit: No devices configured. Add a device first.');
        return undefined;
    }

    if (devices.length === 1) {
        return devices[0];
    }

    const items = devices.map((d: Device) => ({ label: d.name, description: `${d.host}:${d.port}`, device: d }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a device', title });

    return selected?.device;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function detectPlatformCommand(): Promise<void> {
    logger.debug('detectPlatform command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Detect Platform Profile');
        if (!device) {
            return;
        }

        let profile = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Detecting platform: ${device.name}…`,
                cancellable: false,
            },
            async () => platformProfileService.detect(device),
        );

        // Re-read the freshly updated device so isKernelHeld reads from persisted metadata
        const updatedDevices = await deviceService.getAllDevices();
        const updatedDevice = updatedDevices.find(d => d.id === device.id) ?? device;
        const held = platformProfileService.isKernelHeld(updatedDevice);

        const summary = [
            profile.manufacturer,
            `${profile.os.id} ${profile.os.versionId}`,
            profile.packageManager,
            `${profile.gpu.vendor} ${profile.gpu.memoryModel}`,
            `kernel -${profile.kernel.flavor}${held ? ' (held)' : ''}`,
        ].join(' · ');

        vscode.window.showInformationMessage(`ZGX Toolkit: ${device.name}: ${summary}`);

        logger.info('Platform profile detected', { device: device.name, summary });
    } catch (error) {
        logger.error('Failed to detect platform profile', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Platform detection failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlatformCommands(context: vscode.ExtensionContext): void {
    logger.debug('Registering platform commands');

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.DETECT_PLATFORM, detectPlatformCommand),
    );
}
