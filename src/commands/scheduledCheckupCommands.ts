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

async function toggleScheduledCheckupsCommand(): Promise<void> {
    const config = vscode.workspace.getConfiguration('zgxToolkit');
    const current = config.get<boolean>('scheduledCheckups.enabled', false);
    const next = !current;
    await config.update('scheduledCheckups.enabled', next, vscode.ConfigurationTarget.Global);

    if (next) {
        const intervalHours = config.get<number>('scheduledCheckups.intervalHours', 24);
        vscode.window.showInformationMessage(
            `ZGX Toolkit: Scheduled checkups enabled — running every ${intervalHours}h. ` +
            `Change the interval in Settings (zgxToolkit.scheduledCheckups.intervalHours).`,
        );
    } else {
        vscode.window.showInformationMessage('ZGX Toolkit: Scheduled checkups disabled.');
    }
}

async function configureScheduledCheckupsCommand(): Promise<void> {
    const config = vscode.workspace.getConfiguration('zgxToolkit');
    const currentInterval = config.get<number>('scheduledCheckups.intervalHours', 24);
    const currentEnabled = config.get<boolean>('scheduledCheckups.enabled', false);

    const items: vscode.QuickPickItem[] = [
        {
            label: currentEnabled ? '$(check) Disable automatic checkups' : '$(check) Enable automatic checkups',
            description: currentEnabled ? 'Currently enabled' : 'Currently disabled',
        },
        { label: '$(clock) Every hour',        description: '1 hour' },
        { label: '$(clock) Every 6 hours',     description: '6 hours' },
        { label: '$(clock) Every 12 hours',    description: '12 hours' },
        { label: '$(clock) Every 24 hours',    description: '24 hours (default)' },
        { label: '$(clock) Every 48 hours',    description: '48 hours' },
        { label: '$(clock) Every week',        description: '168 hours' },
        { label: '$(gear) Open full settings', description: 'Open VS Code Settings for all checkup options' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Scheduled checkups: ${currentEnabled ? 'ON' : 'OFF'}, every ${currentInterval}h`,
        title: 'ZGX Toolkit: Configure Scheduled Checkups',
    });

    if (!pick) { return; }

    if (pick.label.includes('Enable') || pick.label.includes('Disable')) {
        await config.update('scheduledCheckups.enabled', !currentEnabled, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            `ZGX Toolkit: Scheduled checkups ${!currentEnabled ? 'enabled' : 'disabled'}.`,
        );
        return;
    }

    if (pick.label.includes('Open full settings')) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'zgxToolkit.scheduledCheckups');
        return;
    }

    const intervalOptions = [
        { label: '$(clock) Every hour',     hours: 1   },
        { label: '$(clock) Every 6 hours',  hours: 6   },
        { label: '$(clock) Every 12 hours', hours: 12  },
        { label: '$(clock) Every 24 hours', hours: 24  },
        { label: '$(clock) Every 48 hours', hours: 48  },
        { label: '$(clock) Every week',     hours: 168 },
    ];

    const hours = intervalOptions.find(o => o.label === pick.label)?.hours;
    if (hours !== undefined) {
        await config.update('scheduledCheckups.intervalHours', hours, vscode.ConfigurationTarget.Global);
        if (!currentEnabled) {
            await config.update('scheduledCheckups.enabled', true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `ZGX Toolkit: Scheduled checkups enabled — running every ${hours}h.`,
            );
        } else {
            vscode.window.showInformationMessage(
                `ZGX Toolkit: Checkup interval set to every ${hours}h.`,
            );
        }
    }
}

export function registerScheduledCheckupCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.RUN_CHECKUP_NOW, runCheckupNowCommand),
        vscode.commands.registerCommand(COMMANDS.TOGGLE_SCHEDULED_CHECKUPS, toggleScheduledCheckupsCommand),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE_SCHEDULED_CHECKUPS, configureScheduledCheckupsCommand),
    );
}
