/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Command handlers for Tailscale Phase 1 integration.
 * Allows users to enable, disable, or re-detect Tailscale for any configured device.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../constants/commands';
import { deviceService, tailscaleService } from '../services';
import { Device } from '../types/devices';

// ---------------------------------------------------------------------------
// Internal helper (mirrors manageabilityCommands.ts pattern)
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

    const items = devices.map((d: Device) => ({
        label: d.name,
        description: `${d.host}:${d.port}`,
        device: d,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a device', title });
    return selected?.device;
}

// ---------------------------------------------------------------------------
// Command: enableTailscaleForDevice
// ---------------------------------------------------------------------------

async function enableTailscaleForDeviceCommand(): Promise<void> {
    logger.debug('enableTailscaleForDevice command invoked');

    const device = await selectDevice('ZGX Toolkit: Use Tailscale for Device');
    if (!device) { return; }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Detecting Tailscale for ${device.name}…` },
        async () => {
            try {
                const result = await tailscaleService.detect(device);

                if (!result.tailnetIp) {
                    vscode.window.showInformationMessage(
                        `ZGX Toolkit: Tailscale not detected for ${device.name}. ` +
                        `Ensure Tailscale is installed and connected on the device.`
                    );
                    return;
                }

                const previousHost = device.host;
                const meta = tailscaleService.buildMetadata('enabled', result, true, previousHost);
                await deviceService.mergeDeviceMetadata(device.id, { tailscale: meta }, { host: result.tailnetIp });

                vscode.window.showInformationMessage(
                    `✓ ${device.name} will now connect over Tailscale (${result.tailnetIp}).`
                );
                logger.info('Tailscale enabled for device', { device: device.name, tailnetIp: result.tailnetIp });
            } catch (err) {
                logger.error('Failed to enable Tailscale for device', {
                    device: device.name,
                    error: err instanceof Error ? err.message : String(err),
                });
                vscode.window.showErrorMessage(
                    `Failed to enable Tailscale for ${device.name}: ` +
                    (err instanceof Error ? err.message : 'Unknown error')
                );
            }
        }
    );
}

// ---------------------------------------------------------------------------
// Command: disableTailscaleForDevice
// ---------------------------------------------------------------------------

async function disableTailscaleForDeviceCommand(): Promise<void> {
    logger.debug('disableTailscaleForDevice command invoked');

    const device = await selectDevice('ZGX Toolkit: Stop Using Tailscale for Device');
    if (!device) { return; }

    try {
        const existing = tailscaleService.getMetadata(device);
        const previousHost = existing?.previousHost;
        const now = new Date().toISOString();

        const meta = {
            ...(existing ?? { decision: 'disabled' as const, promptShown: true }),
            decision: 'disabled' as const,
            decisionChangedAt: now,
        };

        const restoredHost = previousHost ?? device.host;
        await deviceService.mergeDeviceMetadata(device.id, { tailscale: meta }, { host: restoredHost });
        vscode.window.showInformationMessage(
            `${device.name} will now connect using ${restoredHost}. ` +
            `Tailscale routing is disabled.`
        );
        logger.info('Tailscale disabled for device', { device: device.name, restoredHost });
    } catch (err) {
        logger.error('Failed to disable Tailscale for device', {
            device: device.name,
            error: err instanceof Error ? err.message : String(err),
        });
        vscode.window.showErrorMessage(
            `Failed to disable Tailscale for ${device.name}: ` +
            (err instanceof Error ? err.message : 'Unknown error')
        );
    }
}

// ---------------------------------------------------------------------------
// Command: detectTailscale
// ---------------------------------------------------------------------------

async function detectTailscaleCommand(): Promise<void> {
    logger.debug('detectTailscale command invoked');

    const device = await selectDevice('ZGX Toolkit: Detect Tailscale for Device');
    if (!device) { return; }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Detecting Tailscale for ${device.name}…` },
        async () => {
            try {
                const result = await tailscaleService.detect(device);

                if (!result.tailnetIp && !result.onDevice && !result.onClient) {
                    vscode.window.showInformationMessage(
                        `ZGX Toolkit: Tailscale not detected for ${device.name} on either side.`
                    );
                    return;
                }

                const where = result.onDevice && result.onClient ? 'device and client'
                    : result.onDevice ? 'device' : 'client';
                const ipPart = result.tailnetIp ? ` — tailnet IP: ${result.tailnetIp}` : ' (no tailnet IP resolved)';

                vscode.window.showInformationMessage(
                    `Tailscale detected on ${where}${ipPart}. ` +
                    `Use "ZGX Toolkit: Use Tailscale for Device" to enable routing.`
                );

                logger.info('Tailscale detection reported', {
                    device: device.name,
                    onDevice: result.onDevice,
                    onClient: result.onClient,
                    tailnetIp: result.tailnetIp,
                });
            } catch (err) {
                logger.error('Failed to detect Tailscale for device', {
                    device: device.name,
                    error: err instanceof Error ? err.message : String(err),
                });
                vscode.window.showErrorMessage(
                    `Failed to detect Tailscale for ${device.name}: ` +
                    (err instanceof Error ? err.message : 'Unknown error')
                );
            }
        }
    );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTailscaleCommands(context: vscode.ExtensionContext): void {
    logger.debug('Registering Tailscale commands');

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.ENABLE_TAILSCALE, enableTailscaleForDeviceCommand),
        vscode.commands.registerCommand(COMMANDS.DISABLE_TAILSCALE, disableTailscaleForDeviceCommand),
        vscode.commands.registerCommand(COMMANDS.DETECT_TAILSCALE, detectTailscaleCommand),
    );
}
