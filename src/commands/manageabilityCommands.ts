/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Command handlers for NVIDIA DGX Spark Manageability Engine features.
 * All handlers follow the same pattern as the existing commands in index.ts:
 * device selection via QuickPick, progress notifications, and try/catch with
 * user-facing error messages.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../constants/commands';
import { deviceService, manageabilityService } from '../services';
import { ZgxToolkitProvider } from '../providers';
import { Device } from '../types/devices';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Present a QuickPick to select a device. Returns undefined if cancelled or
 * no devices are registered.
 */
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

// Output channel shared across diagnostics / health commands (created lazily).
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('ZGX Toolkit — Manageability');
    }
    return outputChannel;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Run full inventory collection on a device and open the Device Info panel.
 */
async function runInventoryCommand(commandProvider: ZgxToolkitProvider): Promise<void> {
    logger.debug('runInventory command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Run Device Inventory');
        if (!device) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Collecting inventory for ${device.name}…`,
                cancellable: false,
            },
            async () => {
                await manageabilityService.collectInventory(device);
            },
        );

        vscode.window.showInformationMessage(`ZGX Toolkit: Inventory collected for ${device.name}`);

        await commandProvider.openInEditor('devices/info', { deviceId: device.id });

        logger.info('Inventory collected and device info panel opened', { device: device.name });
    } catch (error) {
        logger.error('Failed to run inventory', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Inventory failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Fetch and display device health posture in the output channel.
 */
async function showHealthCommand(): Promise<void> {
    logger.debug('showHealth command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Show Device Health');
        if (!device) {
            return;
        }

        const channel = getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Health posture — ${device.name}`);
        channel.appendLine('Running spark_diagctl.py …');

        const result = await manageabilityService.getHealthPosture(device);

        if (!result.success || !result.envelope) {
            channel.appendLine(`ERROR: ${result.error ?? 'Tool returned no data'}`);
            vscode.window.showErrorMessage(`ZGX Toolkit: Health check failed — ${result.error}`);
            return;
        }

        const { overall_status, signals } = result.envelope.data;
        channel.appendLine(`Overall status: ${overall_status.toUpperCase()}`);
        channel.appendLine('');
        for (const signal of signals) {
            const detail = signal.value !== undefined ? `${signal.value} ${signal.unit}` : '';
            channel.appendLine(`  [${signal.status.toUpperCase().padEnd(7)}] ${signal.name}${detail ? ` — ${detail}` : ''}`);
        }

        logger.info('Health posture displayed', { device: device.name, overall_status });
    } catch (error) {
        logger.error('Failed to show health', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Health check failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Run L1 (quick health) or L2 (full diagnostic bundle) diagnostics.
 */
async function runDiagnosticsCommand(): Promise<void> {
    logger.debug('runDiagnostics command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Run Diagnostics');
        if (!device) {
            return;
        }

        const levelItems = [
            { label: 'L1 — Quick health check', description: '~30 seconds', level: 'l1' },
            { label: 'L2 — Full diagnostic bundle', description: 'Up to 2 minutes; generates artifact on device', level: 'l2' },
        ];

        const levelSelection = await vscode.window.showQuickPick(levelItems, {
            placeHolder: 'Select diagnostic level',
            title: 'ZGX Toolkit: Run Diagnostics',
        });

        if (!levelSelection) {
            return;
        }

        const channel = getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Diagnostics (${levelSelection.level.toUpperCase()}) — ${device.name}`);
        channel.appendLine('Running …');

        const result = levelSelection.level === 'l2'
            ? await manageabilityService.generateDiagBundle(device)
            : await manageabilityService.getHealthPosture(device);

        if (!result.success || !result.envelope) {
            channel.appendLine(`ERROR: ${result.error ?? 'Tool returned no data'}`);
            vscode.window.showErrorMessage(`ZGX Toolkit: Diagnostics failed — ${result.error}`);
            return;
        }

        const { overall_status, signals } = result.envelope.data;
        channel.appendLine(`Overall status: ${overall_status.toUpperCase()}`);
        for (const signal of signals) {
            const detail = signal.value !== undefined ? `${signal.value} ${signal.unit}` : '';
            channel.appendLine(`  [${signal.status.toUpperCase().padEnd(7)}] ${signal.name}${detail ? ` — ${detail}` : ''}`);
        }

        if (result.envelope.evidence_path) {
            channel.appendLine(`\nDiagnostic bundle saved on device at:\n  ${result.envelope.evidence_path}`);
            vscode.window.showInformationMessage(
                `ZGX Toolkit: Diagnostic bundle generated at ${result.envelope.evidence_path}`
            );
        }

        logger.info('Diagnostics complete', { device: device.name, level: levelSelection.level, overall_status });
    } catch (error) {
        logger.error('Failed to run diagnostics', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Diagnostics failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Check for available updates and display them; offer apply with confirmation.
 */
async function checkUpdatesCommand(commandProvider: ZgxToolkitProvider): Promise<void> {
    logger.debug('checkUpdates command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Check for Updates');
        if (!device) {
            return;
        }

        const channel = getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Update posture — ${device.name}`);
        channel.appendLine('Running spark_updatectl.py --check …');

        const result = await manageabilityService.getUpdatePosture(device);

        if (!result.success || !result.envelope) {
            channel.appendLine(`ERROR: ${result.error ?? 'Tool returned no data'}`);
            vscode.window.showErrorMessage(`ZGX Toolkit: Update check failed — ${result.error}`);
            return;
        }

        const { status, pending_updates } = result.envelope.data;
        channel.appendLine(`Status: ${status}`);

        if (pending_updates.length === 0) {
            channel.appendLine('All packages are up to date.');
            vscode.window.showInformationMessage(`ZGX Toolkit: ${device.name} is up to date`);
            return;
        }

        channel.appendLine(`\nPending updates (${pending_updates.length}):`);
        for (const u of pending_updates) {
            channel.appendLine(`  ${u.name}  →  ${u.version}`);
        }

        const applyLabel = 'Apply Updates';
        const chosen = await vscode.window.showWarningMessage(
            `${pending_updates.length} update(s) available for ${device.name}. Apply now?`,
            { modal: false },
            applyLabel,
        );

        if (chosen !== applyLabel) {
            return;
        }

        // Second confirmation before mutating device state.
        const confirmed = await vscode.window.showWarningMessage(
            `This will apply ${pending_updates.length} update(s) to ${device.name}. The device may reboot. Continue?`,
            { modal: true },
            'Apply',
        );

        if (confirmed !== 'Apply') {
            logger.debug('Update apply cancelled by user', { device: device.name });
            return;
        }

        channel.appendLine('\nApplying updates …');
        logger.info('User confirmed update apply', { device: device.name });

        const applyResult = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Applying updates on ${device.name}…`,
                cancellable: false,
            },
            async () => manageabilityService.applyUpdates(device),
        );

        if (!applyResult.success) {
            channel.appendLine(`ERROR: ${applyResult.error}`);
            vscode.window.showErrorMessage(`ZGX Toolkit: Update failed — ${applyResult.error}`);
        } else {
            channel.appendLine('Updates applied successfully.');
            vscode.window.showInformationMessage(`ZGX Toolkit: Updates applied to ${device.name}`);
        }

        logger.info('Update apply complete', { device: device.name, success: applyResult.success });
    } catch (error) {
        logger.error('Failed to check/apply updates', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Update check failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Open the Device Info panel for the selected device.
 */
async function showDeviceInfoCommand(commandProvider: ZgxToolkitProvider): Promise<void> {
    logger.debug('showDeviceInfo command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Show Device Info');
        if (!device) {
            return;
        }

        await commandProvider.openInEditor('devices/info', { deviceId: device.id });

        logger.info('Opened device info panel', { device: device.name });
    } catch (error) {
        logger.error('Failed to open device info', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Could not open device info — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

// ---------------------------------------------------------------------------
// Internal programmatic command (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Open the Device Info panel directly from a deviceId argument.
 * Unlike showDeviceInfoCommand this skips the picker and is suitable for
 * programmatic callers (webviews, other commands, tests).
 */
async function openDeviceInfoPanelCommand(commandProvider: ZgxToolkitProvider, deviceId?: string): Promise<void> {
    logger.debug('openDeviceInfoPanel command invoked', { deviceId });

    if (!deviceId) {
        logger.warn('openDeviceInfoPanel called without deviceId — falling back to picker');
        await showDeviceInfoCommand(commandProvider);
        return;
    }

    try {
        await commandProvider.openInEditor('devices/info', { deviceId });
        logger.info('Opened device info panel via programmatic command', { deviceId });
    } catch (error) {
        logger.error('Failed to open device info panel', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Could not open device info — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

// ---------------------------------------------------------------------------
// Phase 2 handlers
// ---------------------------------------------------------------------------

/**
 * Notification-style health check. Shows a single info/error message when done,
 * distinct from showHealthCommand which writes to the output channel.
 */
async function runHealthCheckCommand(): Promise<void> {
    logger.debug('runHealthCheck command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Run Health Check');
        if (!device) { return; }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Health check: ${device.name}…`,
                cancellable: false,
            },
            async () => {
                const result = await manageabilityService.getHealthPosture(device);

                if (!result.success || !result.envelope) {
                    vscode.window.showErrorMessage(
                        `ZGX Toolkit: Health check failed — ${result.error ?? 'No data returned'}`
                    );
                    return;
                }

                const { overall_status } = result.envelope.data;
                const icon = overall_status === 'healthy' ? '✓'
                           : overall_status === 'degraded' ? '⚠️' : '✗';
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: ${icon} ${device.name} — ${overall_status}`
                );
            },
        );

        logger.info('Health check complete', { device: device.name });
    } catch (error) {
        logger.error('Failed to run health check', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Health check failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Collect full inventory snapshot with step-by-step progress, then open
 * the Device Info panel. Distinct from runInventoryCommand.
 */
async function collectInventoryCommand(commandProvider: ZgxToolkitProvider): Promise<void> {
    logger.debug('collectInventory command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Collect Device Inventory');
        if (!device) { return; }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Collecting inventory: ${device.name}`,
                cancellable: false,
            },
            async (progress) => {
                const steps = ['Device identity', 'OS build', 'Hardware', 'Firmware', 'Drivers', 'Software'];
                let step = 0;
                const advance = () => {
                    progress.report({ message: steps[step] ?? 'Done…', increment: 100 / steps.length });
                    step++;
                };

                advance();
                const snapshot = await manageabilityService.collectInventory(device);
                advance();

                const collected = [
                    snapshot.identity, snapshot.osBuild, snapshot.hardware,
                    snapshot.firmware, snapshot.drivers, snapshot.software,
                ].filter(Boolean).length;

                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Inventory collected for ${device.name} (${collected}/6 tools)`
                );
            },
        );

        await commandProvider.openInEditor('devices/info', { deviceId: device.id });
        logger.info('Inventory collected and device info panel opened', { device: device.name });
    } catch (error) {
        logger.error('Failed to collect inventory', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Inventory failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Notification-only update posture check (no apply button).
 * Distinct from checkUpdatesCommand which also offers "Apply Updates".
 */
async function checkForUpdatesCommand(): Promise<void> {
    logger.debug('checkForUpdates command invoked');

    try {
        const device = await selectDevice('ZGX Toolkit: Check for Updates');
        if (!device) { return; }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Checking updates: ${device.name}…`,
                cancellable: false,
            },
            async () => {
                const result = await manageabilityService.getUpdatePosture(device);

                if (!result.success || !result.envelope) {
                    vscode.window.showErrorMessage(
                        `ZGX Toolkit: Update check failed — ${result.error ?? 'No data returned'}`
                    );
                    return;
                }

                const { pending_updates } = result.envelope.data;
                if (pending_updates.length === 0) {
                    vscode.window.showInformationMessage(
                        `ZGX Toolkit: ✓ ${device.name} is up to date`
                    );
                } else {
                    vscode.window.showInformationMessage(
                        `ZGX Toolkit: ⬆️ ${pending_updates.length} update(s) available for ${device.name}`
                    );
                }
            },
        );

        logger.info('Update check complete', { device: device.name });
    } catch (error) {
        logger.error('Failed to check for updates', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Update check failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Check Ansible policy drift against the configured inventory path.
 * Requires zgxToolkit.manageability.ansibleInventoryPath to be set.
 * Uses device health posture as the configuration-state signal.
 */
async function checkAnsibleDriftCommand(): Promise<void> {
    logger.debug('checkAnsiblePolicyDrift command invoked');

    try {
        const config = vscode.workspace.getConfiguration('zgxToolkit');
        const inventoryPath = config.get<string>('manageability.ansibleInventoryPath', '');

        if (!inventoryPath) {
            const action = await vscode.window.showWarningMessage(
                'ZGX Toolkit: No Ansible inventory path configured.',
                'Open Settings'
            );
            if (action === 'Open Settings') {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'zgxToolkit.manageability.ansibleInventoryPath'
                );
            }
            return;
        }

        const device = await selectDevice('ZGX Toolkit: Check Ansible Policy Drift');
        if (!device) { return; }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Checking Ansible drift: ${device.name}…`,
                cancellable: false,
            },
            async () => {
                const result = await manageabilityService.getHealthPosture(device);

                if (!result.success || !result.envelope) {
                    vscode.window.showErrorMessage(
                        `ZGX Toolkit: Drift check failed — ${result.error ?? 'No data returned'}`
                    );
                    return;
                }

                const driftDetected = result.envelope.data.overall_status !== 'healthy';
                const icon = driftDetected ? '⚠️' : '✓';
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: ${icon} ${device.name} — ` +
                    (driftDetected ? 'Configuration drift detected' : 'No drift detected')
                );
            },
        );

        logger.info('Ansible drift check complete', { device: device.name });
    } catch (error) {
        logger.error('Failed to check Ansible drift', { error });
        vscode.window.showErrorMessage(
            `ZGX Toolkit: Drift check failed — ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all manageability commands.
 * Called from registerCommands() in commands/index.ts.
 */
export function registerManageabilityCommands(
    context: vscode.ExtensionContext,
    zgxProvider: ZgxToolkitProvider,
): void {
    logger.debug('Registering manageability commands');

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.RUN_INVENTORY,    () => runInventoryCommand(zgxProvider)),
        vscode.commands.registerCommand(COMMANDS.SHOW_HEALTH,      showHealthCommand),
        vscode.commands.registerCommand(COMMANDS.RUN_DIAGNOSTICS,  runDiagnosticsCommand),
        vscode.commands.registerCommand(COMMANDS.CHECK_UPDATES,    () => checkUpdatesCommand(zgxProvider)),
        vscode.commands.registerCommand(COMMANDS.SHOW_DEVICE_INFO, () => showDeviceInfoCommand(zgxProvider)),
        // Phase 2 commands
        vscode.commands.registerCommand(COMMANDS.RUN_HEALTH_CHECK,    runHealthCheckCommand),
        vscode.commands.registerCommand(COMMANDS.COLLECT_INVENTORY,   () => collectInventoryCommand(zgxProvider)),
        vscode.commands.registerCommand(COMMANDS.CHECK_FOR_UPDATES,   checkForUpdatesCommand),
        vscode.commands.registerCommand(COMMANDS.CHECK_ANSIBLE_DRIFT, checkAnsibleDriftCommand),
        // Phase 3 internal command (programmatic — not in contributes.commands)
        vscode.commands.registerCommand(COMMANDS.OPEN_DEVICE_INFO_PANEL, (deviceId?: string) =>
            openDeviceInfoPanelCommand(zgxProvider, deviceId)),
    );
}
