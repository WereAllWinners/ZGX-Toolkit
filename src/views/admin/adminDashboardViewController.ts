/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { BaseViewController } from '../baseViewController';
import { Logger } from '../../utils/logger';
import { ITelemetryService } from '../../types/telemetry';
import { Message } from '../../types/messages';
import { DeviceService } from '../../services/deviceService';
import { ManageabilityService, ApplyUpdatesResult } from '../../services/manageabilityService';
import { UserGroupService } from '../../services/userGroupService';
import { AnsibleService } from '../../services/ansibleService';
import { ManageabilitySnapshot } from '../../types/manageability';
import { GroupPolicy } from '../../types/userGroup';
import { PendingUpdatesState } from '../../types/scheduledUpdates';
import { DeviceInfoViewController } from '../devices/info/deviceInfoViewController';
import { tailscaleService } from '../../services/tailscaleService';
import { TailscaleDeviceMetadata } from '../../types/tailscale';

const HEALTH_ICONS: Record<string, string> = {
    healthy:  'codicon-pass-filled',
    degraded: 'codicon-warning',
    critical: 'codicon-error',
    unknown:  'codicon-question',
    none:     'codicon-circle-slash',
};

const HEALTH_LABELS: Record<string, string> = {
    healthy:  'Healthy',
    degraded: 'Degraded',
    critical: 'Critical',
    unknown:  'Unknown',
    none:     'No data',
};

export class AdminDashboardViewController extends BaseViewController {
    private deviceService: DeviceService;
    private manageabilityService: ManageabilityService;
    private userGroupService: UserGroupService;
    private ansibleService: AnsibleService;
    private outputChannel: vscode.OutputChannel | undefined;

    public static viewId(): string {
        return 'admin/dashboard';
    }

    constructor(deps: {
        logger: Logger;
        telemetry: ITelemetryService;
        deviceService: DeviceService;
        manageabilityService: ManageabilityService;
        userGroupService: UserGroupService;
        ansibleService?: AnsibleService;
    }) {
        super(deps.logger, deps.telemetry);
        this.deviceService = deps.deviceService;
        this.manageabilityService = deps.manageabilityService;
        this.userGroupService = deps.userGroupService;
        this.ansibleService = deps.ansibleService ?? new AnsibleService();

        this.template     = this.loadTemplate('./adminDashboard.html', __dirname);
        this.styles       = this.loadTemplate('./adminDashboard.css',  __dirname);
        this.clientScript = this.loadTemplate('./adminDashboard.js',   __dirname);
    }

    async render(_params?: any, nonce?: string): Promise<string> {
        const devices = await this.deviceService.getAllDevices();
        const allGroups = this.userGroupService.getAllGroups();

        // Derive collector presence from cached metadata — no SSH on every render.
        // A device has the collector if it was explicitly flagged or has ever produced a snapshot.
        const hasCollectorMap = new Map<string, boolean>(
            devices.map(d => [
                d.id,
                d.isSetup && (
                    d.metadata?.collectorInstalled === true ||
                    d.metadata?.manageabilitySnapshot != null
                ),
            ])
        );

        // Build a map of deviceId → { group names, group IDs } for device cards + form checkboxes
        const deviceGroupNames = new Map<string, string[]>();
        const deviceGroupIds   = new Map<string, string[]>();
        for (const group of allGroups) {
            for (const deviceId of group.deviceIds) {
                const names = deviceGroupNames.get(deviceId) ?? [];
                names.push(group.name);
                deviceGroupNames.set(deviceId, names);
                const ids = deviceGroupIds.get(deviceId) ?? [];
                ids.push(group.id);
                deviceGroupIds.set(deviceId, ids);
            }
        }

        const cardData: Record<string, any>[] = devices.map(d => ({
            ...this.buildCardData(d),
            hasCollector: hasCollectorMap.get(d.id) ?? false,
            groupNames:   deviceGroupNames.get(d.id) ?? [],
            groupIdsCsv:  (deviceGroupIds.get(d.id) ?? []).join(','),
        }));

        // Sort: Tailscale-enabled offline devices sink to the bottom of the grid
        cardData.sort((a, b) =>
            (a.tailscaleIsOffline ? 1 : 0) - (b.tailscaleIsOffline ? 1 : 0)
        );

        const healthyCount  = cardData.filter(c => c.healthStatus === 'healthy').length;
        const degradedCount = cardData.filter(c => c.healthStatus === 'degraded' || c.healthStatus === 'critical').length;

        // Build group template data
        const deviceNameMap = new Map(devices.map(d => [d.id, d.name]));
        const userGroups = allGroups.map(g => {
            const p = g.policy;
            const hasPolicy = !!(
                p && (
                    (p.requiredPackages?.length ?? 0) > 0 ||
                    (p.pinnedPackages?.length  ?? 0) > 0 ||
                    p.customPlaybookPath
                )
            );
            return {
                id:                   g.id,
                name:                 g.name,
                description:          g.description,
                deviceCount:          g.deviceIds.length,
                singleDevice:         g.deviceIds.length === 1,
                deviceNames:          g.deviceIds.map(id => deviceNameMap.get(id) ?? id),
                hasPolicy,
                policyRequired:       p?.requiredPackages?.join(', ') ?? '',
                policyPinned:         p?.pinnedPackages?.join(', ')   ?? '',
                policyPlaybook:       p?.customPlaybookPath            ?? '',
            };
        });

        const body = this.renderTemplate(this.template, {
            devices:       cardData,
            totalDevices:  devices.length,
            hasDevices:    devices.length > 0,
            singleDevice:  devices.length === 1,
            healthyCount:  healthyCount  || undefined,
            degradedCount: degradedCount || undefined,
            userGroups,
            hasUserGroups: userGroups.length > 0,
        });

        return this.wrapHtml(body, nonce);
    }

    async handleMessage(message: Message): Promise<void> {
        await super.handleMessage(message);

        const msg = message as any;

        switch (msg.type) {
            case 'refreshAll':
                try {
                    await this.refresh();
                } finally {
                    // Re-enable the button if render failed and the DOM was never replaced.
                    this.sendMessageToWebview({ type: 'clearLoading' });
                }
                break;

            case 'runInventory':
                await this.handleRunInventory(msg.deviceId);
                break;

            case 'viewDetails':
                await this.navigateTo(DeviceInfoViewController.viewId(), { deviceId: msg.deviceId }, 'editor');
                break;

            case 'checkUpdates':
                await this.handleCheckUpdates(msg.deviceId);
                break;

            case 'createGroup':
                await this.handleCreateGroup(msg.name, msg.description, msg.deviceIds, msg.policy);
                break;

            case 'updateGroup':
                await this.handleUpdateGroup(msg.groupId, msg.name, msg.description, msg.deviceIds, msg.policy);
                break;

            case 'deleteGroup':
                await this.handleDeleteGroup(msg.groupId);
                break;

            case 'setupManageability':
                await this.handleSetupManageability(msg.deviceId);
                break;

            case 'applyUpdates':
                await this.handleApplyUpdates(msg.deviceId);
                break;

            case 'groupApplyUpdates':
                await this.handleGroupApplyUpdates(msg.groupId);
                break;

            case 'groupRunPolicy':
                await this.handleGroupRunPolicy(msg.groupId);
                break;

            case 'groupSetup':
                await this.handleGroupSetup(msg.groupId);
                break;

            case 'groupInventory':
                await this.handleGroupInventory(msg.groupId);
                break;

            case 'groupHealth':
                await this.handleGroupHealth(msg.groupId);
                break;

            case 'groupUpdates':
                await this.handleGroupUpdates(msg.groupId);
                break;

            case 'tailscaleEnable':
                await this.handleTailscaleEnable(msg.deviceId);
                break;

            case 'tailscaleDisable':
                await this.handleTailscaleDisable(msg.deviceId);
                break;

            case 'tailscaleDetect':
                await this.handleTailscaleDetect(msg.deviceId);
                break;

            case 'openUpdateReview':
                await this.navigateTo('devices/updates', { deviceId: msg.deviceId }, 'editor');
                break;
        }
    }

    // ── Tailscale handlers ─────────────────────────────────────────────────

    private async handleTailscaleEnable(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Detecting Tailscale for ${device.name}…` },
                () => tailscaleService.detect(device)
            );

            if (!result.tailnetIp) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Tailscale not detected for ${device.name}. ` +
                    `Ensure Tailscale is installed and connected on the device.`
                );
                return;
            }

            const meta = tailscaleService.buildMetadata('enabled', result, true, device.host);
            await this.deviceService.updateDevice(device.id, {
                host: result.tailnetIp,
                metadata: { ...(device.metadata ?? {}), tailscale: meta },
            });
            vscode.window.showInformationMessage(
                `✓ ${device.name} is now routing over Tailscale (${result.tailnetIp}).`
            );
            this.logger.info('Tailscale enabled via dashboard', { device: device.name, tailnetIp: result.tailnetIp });
        } catch (err) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Failed to enable Tailscale for ${device.name} — ` +
                (err instanceof Error ? err.message : String(err))
            );
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    private async handleTailscaleDisable(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            const existing = device.metadata?.tailscale as TailscaleDeviceMetadata | undefined;
            const previousHost = existing?.previousHost;
            const now = new Date().toISOString();

            const meta: TailscaleDeviceMetadata = {
                ...(existing ?? { decision: 'disabled', promptShown: true }),
                decision: 'disabled',
                decisionChangedAt: now,
            };

            await this.deviceService.updateDevice(device.id, {
                host: previousHost ?? device.host,
                metadata: { ...(device.metadata ?? {}), tailscale: meta },
            });

            const restoredHost = previousHost ?? device.host;
            vscode.window.showInformationMessage(
                `${device.name} is now connecting via ${restoredHost}. Tailscale routing disabled.`
            );
            this.logger.info('Tailscale disabled via dashboard', { device: device.name, restoredHost });
        } catch (err) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Failed to disable Tailscale for ${device.name} — ` +
                (err instanceof Error ? err.message : String(err))
            );
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    private async handleTailscaleDetect(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Detecting Tailscale for ${device.name}…` },
                () => tailscaleService.detect(device)
            );

            if (!result.tailnetIp && !result.onDevice && !result.onClient) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Tailscale not detected for ${device.name} on either side.`
                );
                return;
            }

            // Persist detection result without changing the decision
            const existing = device.metadata?.tailscale as TailscaleDeviceMetadata | undefined;
            const meta = tailscaleService.buildMetadata(
                existing?.decision ?? 'undecided',
                result,
                existing?.promptShown ?? false,
                existing?.previousHost
            );
            await this.deviceService.updateDevice(device.id, {
                metadata: { ...(device.metadata ?? {}), tailscale: meta },
            });

            const where = result.onDevice && result.onClient ? 'device and client'
                : result.onDevice ? 'device' : 'client';
            const ipPart = result.tailnetIp ? ` — tailnet IP: ${result.tailnetIp}` : '';
            vscode.window.showInformationMessage(
                `Tailscale detected on ${where}${ipPart}. Use "Enable Tailscale" on the dashboard to activate routing.`
            );
            this.logger.info('Tailscale detect run via dashboard', { device: device.name, ...result });
        } catch (err) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Tailscale detection failed for ${device.name} — ` +
                (err instanceof Error ? err.message : String(err))
            );
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    // ── Group handlers ─────────────────────────────────────────────────────

    private async handleCreateGroup(name: string, description: string, deviceIds: string[], policy?: GroupPolicy): Promise<void> {
        try {
            const normalizedPolicy = this.normalizePolicy(policy);
            const group = this.userGroupService.createGroup({
                name,
                description: description || undefined,
                deviceIds,
                policy: normalizedPolicy,
            });
            this.logger.info('User group created via dashboard', { id: group.id, name: group.name });
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Failed to create group — ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            await this.refresh();
        }
    }

    private async handleUpdateGroup(groupId: string, name: string, description: string, deviceIds: string[], policy?: GroupPolicy): Promise<void> {
        try {
            const normalizedPolicy = this.normalizePolicy(policy);
            this.userGroupService.updateGroup(groupId, {
                name,
                description: description || undefined,
                deviceIds,
                policy: normalizedPolicy,
            });
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Failed to update group — ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            await this.refresh();
        }
    }

    private async handleDeleteGroup(groupId: string): Promise<void> {
        const group = this.userGroupService.getGroup(groupId);
        const label = group?.name ?? groupId;
        const answer = await vscode.window.showWarningMessage(
            `Delete group "${label}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );
        if (answer !== 'Delete') { return; }
        this.userGroupService.deleteGroup(groupId);
        await this.refresh();
    }

    // ── Setup manageability ────────────────────────────────────────────────

    private async handleSetupManageability(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            let result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Installing collector on ${device.name}…`, cancellable: false },
                () => this.manageabilityService.installCollector(device),
            );

            // Sudo password required for system-wide install — prompt and retry.
            if (result.requiresPassword) {
                const password = await vscode.window.showInputBox({
                    prompt: `Enter sudo password for ${device.name} (needed to install to /usr/local/bin)`,
                    password: true,
                    ignoreFocusOut: true,
                    placeHolder: 'sudo password',
                });
                if (password) {
                    result = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Installing collector on ${device.name}…`, cancellable: false },
                        () => this.manageabilityService.installCollector(device, password),
                    );
                }
            }

            if (result.success) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Manageability tools installed on ${device.name}. Running initial inventory…`
                );
                await this.manageabilityService.collectInventory(device);
            } else {
                vscode.window.showErrorMessage(`ZGX Toolkit: Setup failed on ${device.name} — ${result.error}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`ZGX Toolkit: Setup failed — ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error('Admin dashboard: setupManageability failed', { deviceId, error });
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    // ── Apply updates handlers ─────────────────────────────────────────────

    private async handleApplyUpdates(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            // Check first so the confirmation dialog is informative
            const checkResult = await this.manageabilityService.getUpdatePosture(device);
            const pending = checkResult.success ? (checkResult.envelope?.data?.pending_updates ?? []) : [];

            if (checkResult.success && pending.length === 0) {
                vscode.window.showInformationMessage(`ZGX Toolkit: ${device.name} is already up to date.`);
                return;
            }

            const countLabel = checkResult.success
                ? `${pending.length} update${pending.length === 1 ? '' : 's'}`
                : 'available updates (count unavailable)';

            const answer = await vscode.window.showWarningMessage(
                `Apply ${countLabel} on "${device.name}"? The device may restart services during the upgrade.`,
                { modal: true },
                'Apply Updates'
            );
            if (answer !== 'Apply Updates') { return; }

            // First attempt — works for NOPASSWD systems, fast-fails otherwise
            let result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Applying updates on ${device.name}…`, cancellable: false },
                () => this.manageabilityService.applyUpdates(device),
            );

            // Sudo password required — prompt and retry once
            if (result.requiresPassword) {
                const password = await vscode.window.showInputBox({
                    prompt: `Enter sudo password for ${device.name}`,
                    password: true,
                    ignoreFocusOut: true,
                    placeHolder: 'sudo password',
                });
                if (!password) { return; }

                result = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Applying updates on ${device.name}…`, cancellable: false },
                    () => this.manageabilityService.applyUpdates(device, password),
                );
            }

            this.handleApplyResult(result, device.name);
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Update failed — ${error instanceof Error ? error.message : String(error)}`
            );
            this.logger.error('Admin dashboard: applyUpdates failed', { deviceId, error });
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    private async handleGroupApplyUpdates(groupId: string): Promise<void> {
        const { group, devices } = await this.resolveGroup(groupId);
        if (!group || devices.length === 0) { return; }

        try {
            // Check all devices first to give an accurate count in the confirmation
            const checkResults = await Promise.allSettled(
                devices.map(d => this.manageabilityService.getUpdatePosture(d).then(r => ({ device: d, result: r })))
            );

            let totalPending = 0;
            const devicesNeedingUpdates: typeof devices = [];

            for (const r of checkResults) {
                if (r.status === 'fulfilled' && r.value.result.success) {
                    const count = r.value.result.envelope?.data?.pending_updates?.length ?? 0;
                    if (count > 0) {
                        totalPending += count;
                        devicesNeedingUpdates.push(r.value.device);
                    }
                }
            }

            if (devicesNeedingUpdates.length === 0) {
                vscode.window.showInformationMessage(`ZGX Toolkit: All devices in "${group.name}" are already up to date.`);
                return;
            }

            const answer = await vscode.window.showWarningMessage(
                `Apply ${totalPending} update${totalPending === 1 ? '' : 's'} across ${devicesNeedingUpdates.length} device${devicesNeedingUpdates.length === 1 ? '' : 's'} in "${group.name}"? Services may restart during the upgrade.`,
                { modal: true },
                'Apply Updates'
            );
            if (answer !== 'Apply Updates') { return; }

            // First attempt without password — works for NOPASSWD systems
            const firstPass = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `ZGX Toolkit: Applying updates across "${group.name}"…`,
                    cancellable: false,
                },
                () => Promise.allSettled(devicesNeedingUpdates.map(d =>
                    this.manageabilityService.applyUpdates(d).then(r => ({ device: d, result: r }))
                )),
            );

            // Collect devices that need a sudo password
            type DeviceResult = { device: typeof devicesNeedingUpdates[0]; result: import('../../services/manageabilityService').ApplyUpdatesResult };
            const resultMap = new Map<string, DeviceResult>();
            const needsPassword: typeof devicesNeedingUpdates = [];

            for (const r of firstPass) {
                if (r.status === 'fulfilled') {
                    resultMap.set(r.value.device.id, r.value);
                    if (r.value.result.requiresPassword) { needsPassword.push(r.value.device); }
                }
            }

            // If any device needs a password, prompt once and retry those devices
            if (needsPassword.length > 0) {
                const password = await vscode.window.showInputBox({
                    prompt: `Enter sudo password for ${needsPassword.length === 1 ? needsPassword[0].name : `${needsPassword.length} devices in "${group.name}"`}`,
                    password: true,
                    ignoreFocusOut: true,
                    placeHolder: 'sudo password',
                });
                if (password) {
                    const retryPass = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Retrying updates with password…`, cancellable: false },
                        () => Promise.allSettled(needsPassword.map(d =>
                            this.manageabilityService.applyUpdates(d, password).then(r => ({ device: d, result: r }))
                        )),
                    );
                    for (const r of retryPass) {
                        if (r.status === 'fulfilled') { resultMap.set(r.value.device.id, r.value); }
                    }
                }
            }

            const channel = this.getOutputChannel();
            channel.show(true);
            channel.appendLine(`\n[${new Date().toISOString()}] Apply updates — "${group.name}"`);

            let successCount = 0;
            let failCount = 0;
            for (const { device, result } of resultMap.values()) {
                if (result.success) {
                    channel.appendLine(`  ${device.name}: OK`);
                    successCount++;
                } else {
                    channel.appendLine(`  ${device.name}: FAILED — ${result.error}`);
                    failCount++;
                }
            }

            if (failCount === 0) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Updates applied to all ${successCount} device${successCount === 1 ? '' : 's'} in "${group.name}".`
                );
            } else {
                vscode.window.showWarningMessage(
                    `ZGX Toolkit: ${successCount} succeeded, ${failCount} failed in "${group.name}". See output for details.`
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Group update failed — ${error instanceof Error ? error.message : String(error)}`
            );
            this.logger.error('Admin dashboard: groupApplyUpdates failed', { groupId, error });
        } finally {
            this.postGroupMessage('clearLoading', groupId);
            await this.refresh();
        }
    }

    private async handleGroupRunPolicy(groupId: string): Promise<void> {
        const group = this.userGroupService.getGroup(groupId);
        if (!group) {
            vscode.window.showErrorMessage('ZGX Toolkit: Group not found.');
            return;
        }

        const policy = group.policy;
        if (!policy || (
            (policy.requiredPackages?.length ?? 0) === 0 &&
            (policy.pinnedPackages?.length  ?? 0) === 0 &&
            !policy.customPlaybookPath
        )) {
            vscode.window.showWarningMessage(
                `ZGX Toolkit: No policy configured for "${group.name}". Edit the group to add required packages, pinned versions, or a custom playbook.`
            );
            this.postGroupMessage('clearLoading', groupId);
            return;
        }

        const available = await this.ansibleService.isAvailable();
        if (!available) {
            vscode.window.showErrorMessage(
                'ZGX Toolkit: ansible-playbook is not installed or not on PATH. Install Ansible to use group policies.'
            );
            this.postGroupMessage('clearLoading', groupId);
            return;
        }

        const { devices } = await this.resolveGroup(groupId);
        if (devices.length === 0) { return; }

        const policyDesc: string[] = [];
        if (policy.requiredPackages?.length)  { policyDesc.push(`${policy.requiredPackages.length} required package(s)`); }
        if (policy.pinnedPackages?.length)     { policyDesc.push(`${policy.pinnedPackages.length} pinned version(s)`); }
        if (policy.customPlaybookPath)         { policyDesc.push('custom playbook'); }

        const answer = await vscode.window.showWarningMessage(
            `Run policy (${policyDesc.join(', ')}) on ${devices.length} device${devices.length === 1 ? '' : 's'} in "${group.name}"?`,
            { modal: true },
            'Run Policy'
        );
        if (answer !== 'Run Policy') {
            this.postGroupMessage('clearLoading', groupId);
            return;
        }

        const channel = this.getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Run policy — "${group.name}" (${devices.length} device${devices.length === 1 ? '' : 's'})`);
        if (policy.requiredPackages?.length) { channel.appendLine(`  Required:  ${policy.requiredPackages.join(', ')}`); }
        if (policy.pinnedPackages?.length)   { channel.appendLine(`  Pinned:    ${policy.pinnedPackages.join(', ')}`); }
        if (policy.customPlaybookPath)        { channel.appendLine(`  Playbook:  ${policy.customPlaybookPath}`); }

        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `ZGX Toolkit: Running policy on "${group.name}"…`,
                    cancellable: false,
                },
                () => this.ansibleService.runPolicy(group, devices, policy),
            );

            if (result.output) { channel.appendLine(result.output); }

            if (result.success) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Policy applied to all ${devices.length} device${devices.length === 1 ? '' : 's'} in "${group.name}".`
                );
            } else {
                channel.appendLine(`\nERROR: ${result.error}`);
                vscode.window.showErrorMessage(
                    `ZGX Toolkit: Policy run failed for "${group.name}" — ${result.error}. See output for details.`
                );
            }
        } catch (error) {
            channel.appendLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error('Admin dashboard: groupRunPolicy failed', { groupId, error });
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Policy run failed — ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            this.postGroupMessage('clearLoading', groupId);
            await this.refresh();
        }
    }

    /** Strip empty arrays / empty strings so the stored policy stays clean. */
    private normalizePolicy(policy?: GroupPolicy): GroupPolicy | undefined {
        if (!policy) { return undefined; }
        const normalized: GroupPolicy = {};
        const req = policy.requiredPackages?.filter(Boolean);
        const pin = policy.pinnedPackages?.filter(Boolean);
        if (req?.length)              { normalized.requiredPackages   = req; }
        if (pin?.length)              { normalized.pinnedPackages     = pin; }
        if (policy.customPlaybookPath?.trim()) { normalized.customPlaybookPath = policy.customPlaybookPath.trim(); }
        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }

    private handleApplyResult(result: ApplyUpdatesResult, deviceName: string): void {
        const channel = this.getOutputChannel();
        if (result.success) {
            vscode.window.showInformationMessage(
                `ZGX Toolkit: Updates applied on ${deviceName}. See the ZGX Toolkit output channel for details.`
            );
            channel.appendLine(`\n[${new Date().toISOString()}] Apply updates complete — ${deviceName}`);
            if (result.output) { channel.appendLine(result.output); }
            channel.show(true);
        } else {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Update failed on ${deviceName} — ${result.error ?? 'unknown error'}. See the ZGX Toolkit output channel for details.`
            );
            channel.appendLine(`\n[${new Date().toISOString()}] Apply updates failed — ${deviceName}`);
            if (result.output) { channel.appendLine(result.output); }
            channel.show(true);
        }
    }

    // ── Bulk group operation handlers ──────────────────────────────────────

    private async handleGroupSetup(groupId: string): Promise<void> {
        const { group, devices } = await this.resolveGroup(groupId);
        if (!group || devices.length === 0) { return; }

        // Only target devices that don't already have the collector installed
        const collectorChecks = await Promise.allSettled(
            devices.map(d => this.manageabilityService.hasCollector(d).then(has => ({ device: d, has })))
        );
        const needsSetup = collectorChecks
            .filter((r): r is PromiseFulfilledResult<{ device: any; has: boolean }> => r.status === 'fulfilled' && !r.value.has)
            .map(r => r.value.device);

        if (needsSetup.length === 0) {
            vscode.window.showInformationMessage(
                `ZGX Toolkit: All devices in "${group.name}" already have manageability tools installed.`
            );
            this.postGroupMessage('clearLoading', groupId);
            return;
        }

        try {
            // First attempt — works for NOPASSWD systems
            const firstPass = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `ZGX Toolkit: Installing collector on ${needsSetup.length} device${needsSetup.length === 1 ? '' : 's'} in "${group.name}"…`,
                    cancellable: false,
                },
                () => Promise.allSettled(
                    needsSetup.map(d =>
                        this.manageabilityService.installCollector(d).then(r => ({ device: d, result: r }))
                    )
                ),
            );

            type DeviceInstallResult = { device: any; result: import('../../services/manageabilityService').InstallCollectorResult };
            const resultMap = new Map<string, DeviceInstallResult>();
            const needsPassword: any[] = [];

            for (const r of firstPass) {
                if (r.status === 'fulfilled') {
                    resultMap.set(r.value.device.id, r.value);
                    if (r.value.result.requiresPassword) { needsPassword.push(r.value.device); }
                }
            }

            // Prompt once if any device needs a sudo password
            if (needsPassword.length > 0) {
                const password = await vscode.window.showInputBox({
                    prompt: `Enter sudo password for ${needsPassword.length === 1 ? needsPassword[0].name : `${needsPassword.length} devices in "${group.name}"`} (needed to install to /usr/local/bin)`,
                    password: true,
                    ignoreFocusOut: true,
                    placeHolder: 'sudo password',
                });
                if (password) {
                    const retryPass = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `ZGX Toolkit: Retrying setup with password…`, cancellable: false },
                        () => Promise.allSettled(
                            needsPassword.map(d =>
                                this.manageabilityService.installCollector(d, password).then(r => ({ device: d, result: r }))
                            )
                        ),
                    );
                    for (const r of retryPass) {
                        if (r.status === 'fulfilled') { resultMap.set(r.value.device.id, r.value); }
                    }
                }
            }

            const channel = this.getOutputChannel();
            channel.show(true);
            channel.appendLine(`\n[${new Date().toISOString()}] Setup manageability — "${group.name}" (${needsSetup.length} device${needsSetup.length === 1 ? '' : 's'})`);

            let successCount = 0;
            let failCount = 0;
            const succeededDevices: any[] = [];

            for (const { device, result } of resultMap.values()) {
                if (result.success) {
                    channel.appendLine(`  ${device.name}: installed`);
                    successCount++;
                    succeededDevices.push(device);
                } else {
                    channel.appendLine(`  ${device.name}: FAILED — ${result.error}`);
                    failCount++;
                }
            }

            // Run initial inventory on newly set-up devices
            if (succeededDevices.length > 0) {
                channel.appendLine(`\nRunning initial inventory on ${succeededDevices.length} device${succeededDevices.length === 1 ? '' : 's'}…`);
                await Promise.allSettled(succeededDevices.map(d => this.manageabilityService.collectInventory(d)));
            }

            if (failCount === 0) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Manageability tools installed on all ${successCount} device${successCount === 1 ? '' : 's'} in "${group.name}".`
                );
            } else {
                vscode.window.showWarningMessage(
                    `ZGX Toolkit: ${successCount} succeeded, ${failCount} failed in "${group.name}". See output for details.`
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Group setup failed — ${error instanceof Error ? error.message : String(error)}`
            );
            this.logger.error('Admin dashboard: groupSetup failed', { groupId, error });
        } finally {
            this.postGroupMessage('clearLoading', groupId);
            await this.refresh();
        }
    }

    private async handleGroupInventory(groupId: string): Promise<void> {
        const { group, devices } = await this.resolveGroup(groupId);
        if (!group || devices.length === 0) { return; }

        const label = `${group.name} (${devices.length} device${devices.length === 1 ? '' : 's'})`;

        try {
            const results = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `ZGX Toolkit: Running inventory on ${label}…`,
                    cancellable: false,
                },
                () => Promise.allSettled(devices.map(d => this.manageabilityService.collectInventory(d))),
            );

            const failed = results.filter(r => r.status === 'rejected');
            if (failed.length === 0) {
                vscode.window.showInformationMessage(
                    `ZGX Toolkit: Inventory complete for all ${devices.length} device${devices.length === 1 ? '' : 's'} in "${group.name}".`
                );
            } else {
                vscode.window.showWarningMessage(
                    `ZGX Toolkit: Inventory finished — ${devices.length - failed.length}/${devices.length} succeeded in "${group.name}".`
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Group inventory failed — ${error instanceof Error ? error.message : String(error)}`
            );
            this.logger.error('Admin dashboard: groupInventory failed', { groupId, error });
        } finally {
            this.postGroupMessage('clearLoading', groupId);
            await this.refresh();
        }
    }

    private async handleGroupHealth(groupId: string): Promise<void> {
        const { group, devices } = await this.resolveGroup(groupId);
        if (!group || devices.length === 0) { return; }

        const channel = this.getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Health check — "${group.name}" (${devices.length} devices)`);

        try {
            const results = await Promise.allSettled(
                devices.map(d => this.manageabilityService.getHealthPosture(d).then(r => ({ device: d, result: r })))
            );

            let healthyCount = 0;
            let problemCount = 0;

            for (const r of results) {
                if (r.status === 'rejected') {
                    channel.appendLine(`  ERROR fetching health for a device: ${r.reason}`);
                    problemCount++;
                    continue;
                }
                const { device, result } = r.value;
                if (!result.success || !result.envelope) {
                    channel.appendLine(`  ${device.name}: ERROR — ${result.error ?? 'no data'}`);
                    problemCount++;
                } else {
                    const status = result.envelope.data.overall_status;
                    channel.appendLine(`  ${device.name}: ${status.toUpperCase()}`);
                    if (status === 'healthy') { healthyCount++; } else { problemCount++; }
                }
            }

            channel.appendLine(`\nSummary: ${healthyCount} healthy, ${problemCount} with issues.`);

            if (problemCount === 0) {
                vscode.window.showInformationMessage(`ZGX Toolkit: All ${devices.length} devices in "${group.name}" are healthy.`);
            } else {
                vscode.window.showWarningMessage(`ZGX Toolkit: ${problemCount} device${problemCount === 1 ? '' : 's'} in "${group.name}" need attention. See output for details.`);
            }
        } catch (error) {
            channel.appendLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error('Admin dashboard: groupHealth failed', { groupId, error });
        } finally {
            this.postGroupMessage('clearLoading', groupId);
        }
    }

    private async handleGroupUpdates(groupId: string): Promise<void> {
        const { group, devices } = await this.resolveGroup(groupId);
        if (!group || devices.length === 0) { return; }

        const channel = this.getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Update check — "${group.name}" (${devices.length} devices)`);

        try {
            const results = await Promise.allSettled(
                devices.map(d => this.manageabilityService.getUpdatePosture(d).then(r => ({ device: d, result: r })))
            );

            let upToDate = 0;
            let totalPending = 0;
            let errorCount = 0;

            for (const r of results) {
                if (r.status === 'rejected') {
                    channel.appendLine(`  ERROR checking updates for a device: ${r.reason}`);
                    errorCount++;
                    continue;
                }
                const { device, result } = r.value;
                if (!result.success || !result.envelope) {
                    channel.appendLine(`  ${device.name}: ERROR — ${result.error ?? 'no data'}`);
                    errorCount++;
                } else {
                    const pending = result.envelope.data.pending_updates;
                    if (pending.length === 0) {
                        channel.appendLine(`  ${device.name}: up to date`);
                        upToDate++;
                    } else {
                        const aptPending = pending.filter(u => u.type === 'apt');
                        const fwPending  = pending.filter(u => u.type === 'firmware');
                        const label = [
                            aptPending.length > 0 ? `${aptPending.length} apt` : '',
                            fwPending.length  > 0 ? `${fwPending.length} firmware` : '',
                        ].filter(Boolean).join(', ');
                        channel.appendLine(`  ${device.name}: ${label} update${pending.length === 1 ? '' : 's'} pending`);
                        for (const u of pending) {
                            channel.appendLine(`    [${u.type}] ${u.name}  →  ${u.version}`);
                        }
                        totalPending += pending.length;
                    }
                }
            }

            channel.appendLine(`\nSummary: ${upToDate} up to date, ${totalPending} update(s) pending across ${devices.length - errorCount} reachable devices.`);

            if (totalPending === 0 && errorCount === 0) {
                vscode.window.showInformationMessage(`ZGX Toolkit: All devices in "${group.name}" are up to date.`);
            } else if (totalPending > 0) {
                vscode.window.showWarningMessage(`ZGX Toolkit: ${totalPending} update(s) available across "${group.name}". See output for details.`);
            } else {
                vscode.window.showWarningMessage(`ZGX Toolkit: Update check incomplete — ${errorCount} device${errorCount === 1 ? '' : 's'} unreachable.`);
            }
        } catch (error) {
            channel.appendLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error('Admin dashboard: groupUpdates failed', { groupId, error });
        } finally {
            this.postGroupMessage('clearLoading', groupId);
        }
    }

    /** Resolve a group and its live Device objects in one call. */
    private async resolveGroup(groupId: string): Promise<{ group: import('../../types/userGroup').UserGroup | undefined; devices: any[] }> {
        const group = this.userGroupService.getGroup(groupId);
        if (!group) {
            vscode.window.showErrorMessage(`ZGX Toolkit: Group not found.`);
            return { group: undefined, devices: [] };
        }
        const deviceResults = await Promise.allSettled(
            group.deviceIds.map(id => this.deviceService.getDevice(id))
        );
        const devices = deviceResults
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null)
            .map(r => r.value);

        if (devices.length === 0) {
            vscode.window.showWarningMessage(`ZGX Toolkit: No reachable devices in "${group.name}".`);
        }
        return { group, devices };
    }

    /** Send a message to the webview (used to clear loading states after async ops). */
    private postGroupMessage(type: string, groupId: string): void {
        try {
            this.sendMessageToWebview({ type, groupId });
        } catch {
            // webview may have been disposed; ignore
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private async handleRunInventory(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title:    `ZGX Toolkit: Running inventory on ${device.name}…`,
                    cancellable: false,
                },
                () => this.manageabilityService.collectInventory(device),
            );
            vscode.window.showInformationMessage(`ZGX Toolkit: Inventory complete for ${device.name}`);
        } catch (error) {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Inventory failed — ${error instanceof Error ? error.message : String(error)}`,
            );
            this.logger.error('Admin dashboard: runInventory failed', { device: device.name, error });
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    private async handleCheckUpdates(deviceId: string): Promise<void> {
        const device = await this.deviceService.getDevice(deviceId);
        if (!device) { return; }

        const channel = this.getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n[${new Date().toISOString()}] Update check — ${device.name}`);

        try {
            const result = await this.manageabilityService.getUpdatePosture(device);

            if (!result.success || !result.envelope) {
                channel.appendLine(`ERROR: ${result.error ?? 'No data returned'}`);
                vscode.window.showErrorMessage(`ZGX Toolkit: Update check failed for ${device.name}`);
                return;
            }

            const { status, pending_updates, hp_count, apt_count, firmware_count, hp_repo_present } = result.envelope.data;
            channel.appendLine(`Status: ${status}`);
            if (hp_repo_present !== undefined) {
                channel.appendLine(`HP SDR: ${hp_repo_present ? 'configured' : 'not configured'}`);
            }

            if (pending_updates.length === 0) {
                channel.appendLine('All packages and firmware are up to date.');
                vscode.window.showInformationMessage(`ZGX Toolkit: ${device.name} is up to date`);
            } else {
                const hpFwUpdates  = pending_updates.filter(u => u.type === 'hp_firmware');
                const hpDrvUpdates = pending_updates.filter(u => u.type === 'hp_driver');
                const aptUpdates   = pending_updates.filter(u => u.type === 'apt');
                const fwUpdates    = pending_updates.filter(u => u.type === 'firmware');

                if (hpFwUpdates.length > 0) {
                    channel.appendLine(`\nHP Firmware (${hpFwUpdates.length}):`);
                    for (const u of hpFwUpdates) { channel.appendLine(`  ${u.name}  →  ${u.version}`); }
                }
                if (hpDrvUpdates.length > 0) {
                    channel.appendLine(`\nHP Drivers (${hpDrvUpdates.length}):`);
                    for (const u of hpDrvUpdates) { channel.appendLine(`  ${u.name}  →  ${u.version}`); }
                }
                if (aptUpdates.length > 0) {
                    channel.appendLine(`\nApt packages (${aptUpdates.length}):`);
                    for (const u of aptUpdates) { channel.appendLine(`  ${u.name}  →  ${u.version}`); }
                }
                if (fwUpdates.length > 0) {
                    channel.appendLine(`\nFirmware (${fwUpdates.length}):`);
                    for (const u of fwUpdates) { channel.appendLine(`  ${u.name}  →  ${u.version}`); }
                }

                const parts: string[] = [];
                if ((hp_count ?? (hpFwUpdates.length + hpDrvUpdates.length)) > 0) {
                    parts.push(`${hp_count ?? (hpFwUpdates.length + hpDrvUpdates.length)} HP`);
                }
                if ((apt_count ?? aptUpdates.length) > 0)     { parts.push(`${apt_count ?? aptUpdates.length} apt`); }
                if ((firmware_count ?? fwUpdates.length) > 0) { parts.push(`${firmware_count ?? fwUpdates.length} firmware`); }
                vscode.window.showWarningMessage(
                    `${device.name}: ${parts.join(', ')} update(s) available`,
                );
            }
        } catch (error) {
            channel.appendLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error('Admin dashboard: checkUpdates failed', { device: device.name, error });
        } finally {
            this.sendMessageToWebview({ type: 'clearLoading', deviceId });
            await this.refresh();
        }
    }

    private getOutputChannel(): vscode.OutputChannel {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('ZGX Toolkit');
        }
        return this.outputChannel;
    }

    private buildCardData(device: any): Record<string, any> {
        const base = {
            id:      device.id,
            name:    device.name,
            host:    device.host,
            port:    device.port,
            isSetup: device.isSetup,
        };

        // Tailscale state (from cached metadata — no SSH on render)
        const tsMeta = device.metadata?.tailscale as TailscaleDeviceMetadata | undefined;
        const tailscaleEnabled  = tsMeta?.decision === 'enabled';
        const tailscaleHasIp    = !!tsMeta?.tailnetIp;
        const tsStatus          = tsMeta?.status;
        const tailscaleIsOffline = tailscaleEnabled && !!tsStatus && !tsStatus.online;
        const tailscaleLastSeen  = tailscaleIsOffline && tsStatus?.lastSeen
            ? this.formatAge(tsStatus.lastSeen)
            : undefined;
        const tailscaleBase = {
            tailscaleEnabled,
            tailscaleHasIp,
            tailscaleIp: tsMeta?.tailnetIp ?? '',
            tailscaleIsOffline,
            tailscaleLastSeen,
        };

        const snapshot = device.metadata?.manageabilitySnapshot as ManageabilitySnapshot | undefined;
        if (!snapshot) {
            return {
                ...base,
                ...tailscaleBase,
                hasSnapshot:       false,
                healthStatus:      'none',
                healthStatusLabel: HEALTH_LABELS['none'],
                healthIcon:        HEALTH_ICONS['none'],
            };
        }

        const id   = snapshot.identity?.data as any;
        const hw   = snapshot.hardware?.data as any;
        const hlth = snapshot.health?.data   as any;

        const healthStatus = (hlth?.overall_status as string | undefined) ?? 'unknown';

        // ── GPU summary ──────────────────────────────────────────────────────
        // Prefer health gpus (fresher temp/power) then fall back to hardware gpus
        const gpus: any[] = (hlth?.gpus?.length ? hlth.gpus : hw?.gpus) ?? [];
        const gpuVendor: string = hw?.gpu_vendor ?? hlth?.gpu_vendor ?? 'none';

        let gpuSummary: string | null = null;
        let unifiedMemory = false;

        if (gpus.length > 0) {
            // Hottest GPU drives the summary temp/power
            const hottest = gpus.reduce((a: any, b: any) =>
                (b.temp_c ?? 0) > (a.temp_c ?? 0) ? b : a, gpus[0]);

            const tempVal   = hottest.temp_c  != null && hottest.temp_c  > 0 ? hottest.temp_c  : null;
            const powerVal  = hottest.power_w != null && hottest.power_w > 0 ? hottest.power_w : null;
            const tempClass = tempVal != null ? (tempVal >= 80 ? 'temp-hot' : tempVal >= 65 ? 'temp-warm' : '') : '';

            const displayName = gpus.length > 1
                ? `${gpus.length}× ${hottest.name ?? gpuVendor.toUpperCase()}`
                : (hottest.name ?? '');

            const tempStr  = tempVal  != null ? ` · <span class="metric ${tempClass}">${tempVal}°C</span>` : '';
            const powerStr = powerVal != null ? ` · ${Math.round(powerVal * 10) / 10} W` : '';

            gpuSummary = `${displayName}${tempStr}${powerStr}`;

            // Unified memory: any GPU in the list flagged as unified
            unifiedMemory = gpus.some((g: any) => g.unified_memory === true);
        }

        const totalMemoryGb = hw?.total_memory_bytes
            ? Math.round(hw.total_memory_bytes / (1024 ** 3))
            : null;

        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;
        const hasPendingUpdates =
            pending?.status === 'available' && (pending?.candidates.length ?? 0) > 0;
        const pendingUpdatesCount = hasPendingUpdates ? pending!.candidates.length : 0;

        return {
            ...base,
            ...tailscaleBase,
            hasSnapshot:       true,
            collectedAt:       snapshot.collectedAt,
            snapshotAge:       this.formatAge(snapshot.collectedAt),
            healthStatus,
            healthStatusLabel: HEALTH_LABELS[healthStatus] ?? healthStatus,
            healthIcon:        HEALTH_ICONS[healthStatus]  ?? 'codicon-question',
            productName:       id?.product_name ?? '',
            gpuSummary,
            unifiedMemory,
            totalMemoryGb,
            hasPendingUpdates,
            pendingUpdatesCount,
        };
    }

    private formatAge(iso: string): string {
        const ms = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(ms / 60_000);
        if (mins < 1)   { return 'just now'; }
        if (mins < 60)  { return `${mins}m ago`; }
        const hrs = Math.floor(mins / 60);
        if (hrs < 24)   { return `${hrs}h ago`; }
        return `${Math.floor(hrs / 24)}d ago`;
    }
}
