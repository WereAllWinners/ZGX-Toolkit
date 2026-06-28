/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../constants/commands';
import { deviceService, scheduledCheckupService } from '../services';
import { Device } from '../types/devices';

async function selectDevice(title: string): Promise<Device | undefined> {
    const devices = await deviceService.getAllDevices();

    if (devices.length === 0) {
        vscode.window.showInformationMessage('ZGX Toolkit: No devices configured. Add a device first.');
        return undefined;
    }

    if (devices.length === 1) {
        return devices[0];
    }

    const items = devices.map((d: Device) => ({
        label: d.name,
        description: `${d.host}:${d.port}`,
        device: d,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a device', title });
    return selected?.device;
}

async function runCheckupNowCommand(): Promise<void> {
    logger.debug('runCheckupNow command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Run Checkup Now');
        if (!device) {
            return;
        }

        let checkupResult: Awaited<ReturnType<typeof scheduledCheckupService.runCheckupNow>>;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Running checkup for ${device.name}…`,
                cancellable: false,
            },
            async () => {
                checkupResult = await scheduledCheckupService.runCheckupNow(device);
            },
        );

        const count = checkupResult!.availableUpdates.length;
        const source = checkupResult!.source;

        const message = count > 0
            ? `ZGX Toolkit: ${device.name}: ${count} update(s) available (via ${source})`
            : `ZGX Toolkit: ${device.name}: up to date`;

        vscode.window.showInformationMessage(message);
        logger.info('Checkup now complete', { device: device.name, source, count });
    } catch (error) {
        logger.error('Failed to run checkup', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Checkup failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

export function registerScheduledCheckupCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.RUN_CHECKUP_NOW, runCheckupNowCommand),
    );
}
