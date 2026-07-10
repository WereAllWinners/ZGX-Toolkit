/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { BaseViewController } from '../../baseViewController';
import { Logger } from '../../../utils/logger';
import { ITelemetryService } from '../../../types/telemetry';
import { Message } from '../../../types/messages';
import { DeviceService } from '../../../services/deviceService';
import { Device } from '../../../types/devices';
import { ApplyPlan, ApplyResult, ApplyScope, PendingUpdatesState } from '../../../types/scheduledUpdates';
import { updateReconciliationService } from '../../../services/updateReconciliationService';
import { scheduledCheckupService } from '../../../services/scheduledCheckupService';

export class UpdateReviewViewController extends BaseViewController {
    private deviceService: DeviceService;
    private currentDevice: Device | undefined;

    public static viewId(): string {
        return 'devices/updates';
    }

    constructor(deps: {
        logger: Logger;
        telemetry: ITelemetryService;
        deviceService: DeviceService;
    }) {
        super(deps.logger, deps.telemetry);

        this.deviceService = deps.deviceService;

        this.template     = this.loadTemplate('./updateReview.html', __dirname);
        this.styles       = this.loadTemplate('./updateReview.css', __dirname);
        this.clientScript = this.loadTemplate('./updateReview.js', __dirname);
    }

    async render(params?: { deviceId?: string }, nonce?: string): Promise<string> {
        const deviceId = params?.deviceId;

        if (!deviceId) {
            this.logger.warn('UpdateReviewViewController.render called without deviceId');
            return this.wrapHtml('<p>No device selected.</p>', nonce);
        }

        const device = await this.deviceService.getDevice(deviceId);
        if (!device) {
            this.logger.warn('UpdateReviewViewController: device not found', { deviceId });
            return this.wrapHtml('<p>Device not found.</p>', nonce);
        }

        this.currentDevice = device;

        const pending = device.metadata?.pendingUpdates as PendingUpdatesState | undefined;

        if (!pending) {
            return this.wrapHtml(
                `<div class="empty-state">
                    <p>No checkup data yet for <strong>${this.escape(device.name)}</strong>.</p>
                    <p>Run <em>ZGX Toolkit: Run Checkup Now</em> to populate update candidates.</p>
                </div>`,
                nonce,
            );
        }

        const firmwareCandidates = pending.firmwareCandidates ?? [];
        const firmwareExclusions = pending.firmwareExclusions ?? [];

        const totalAvailable =
            pending.candidates.length +
            pending.ansibleExclusions.length +
            pending.kernelExclusions.length +
            firmwareCandidates.length;

        const firmwareRequiresReboot = firmwareCandidates.some(f => f.requiresReboot);

        const templateData = {
            deviceName:              device.name,
            source:                  pending.source,
            computedAt:              this.formatAge(pending.computedAt),
            totalAvailable,
            candidateCount:          pending.candidates.length,
            ansibleCount:            pending.ansibleExclusions.length,
            kernelCount:             pending.kernelExclusions.length,
            hasCandidates:           pending.candidates.length > 0,
            hasAnsibleExclusions:    pending.ansibleExclusions.length > 0,
            hasKernelExclusions:     pending.kernelExclusions.length > 0,
            candidates:              pending.candidates,
            ansibleExclusions:       pending.ansibleExclusions,
            kernelExclusions:        pending.kernelExclusions,
            isApplied:               pending.status === 'applied',
            hasApplyError:           pending.status === 'error',
            firmwareCandidates,
            firmwareExclusions,
            hasFirmwareCandidates:   firmwareCandidates.length > 0,
            hasFirmwareExclusions:   firmwareExclusions.length > 0,
            firmwareRequiresReboot,
            firmwareCandidateCount:  firmwareCandidates.length,
            isFirmwareApplied:       pending.firmwareStatus === 'applied',
            hasFirmwareApplyError:   pending.firmwareStatus === 'error',
            hasBothSections:         pending.candidates.length > 0 && firmwareCandidates.length > 0,
        };

        const html = this.renderTemplate(this.template, templateData);
        return this.wrapHtml(html, nonce);
    }

    async handleMessage(message: Message): Promise<void> {
        await super.handleMessage(message);

        const msg = message as any;
        switch (msg.type) {
            case 'apply-selected':
                if (this.currentDevice) {
                    await this.applyScoped(this.currentDevice, msg.packages ?? [], [], 'packages');
                }
                break;

            case 'apply-firmware-selected':
                if (this.currentDevice) {
                    await this.applyScoped(this.currentDevice, [], msg.packages ?? [], 'firmware');
                }
                break;

            case 'apply-all-selected':
                if (this.currentDevice) {
                    await this.applyScoped(
                        this.currentDevice,
                        msg.packages ?? [],
                        msg.firmwarePackages ?? [],
                        'all',
                    );
                }
                break;

            case 'runCheckupNow':
                if (this.currentDevice) {
                    await this.runCheckupFromPanel(this.currentDevice);
                }
                break;

            case 'goBack':
                await this.navigateTo('admin/dashboard', {}, 'sidebar');
                break;
        }
    }

    // ── Checkup trigger ─────────────────────────────────────────────────────

    private async runCheckupFromPanel(device: Device): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `ZGX Toolkit: Checking updates for ${device.name}…`,
                cancellable: false,
            },
            async () => { await scheduledCheckupService.runCheckupNow(device); },
        );
        await this.render({ deviceId: device.id });
    }

    // ── Apply handler ────────────────────────────────────────────────────────

    private async applyScoped(
        device: Device,
        packages: string[],
        firmwarePackages: string[],
        scope: ApplyScope,
    ): Promise<void> {
        if (packages.length === 0 && firmwarePackages.length === 0) {
            vscode.window.showWarningMessage('ZGX Toolkit: No items selected.');
            return;
        }

        // TOCTOU re-validation: re-run all filters before showing confirmation
        const plan = await updateReconciliationService.buildApplyPlan(
            device, packages, firmwarePackages, scope,
        );

        const toApplyFirmware = plan.toApplyFirmware ?? [];
        const hasPackages = plan.toApply.length > 0;
        const hasFirmware = toApplyFirmware.length > 0;

        if (!hasPackages && !hasFirmware) {
            const reasons = plan.skipped.map(s => `${s.package} (${s.reason})`).join(', ');
            vscode.window.showInformationMessage(
                `ZGX Toolkit: All selected items were dropped during re-validation${reasons ? `: ${reasons}` : '.'}`,
            );
            return;
        }

        // Build confirmation modal content
        const lines: string[] = [];

        if (hasPackages) {
            lines.push(`Apply ${plan.toApply.length} package update(s) to ${device.name} via ${plan.provider}:`);
            lines.push(...plan.toApply);
            if (plan.additionalChanges.length > 0) {
                lines.push('', `Also pulls in: ${plan.additionalChanges.join(', ')}`);
            }
            if (plan.dgxControllerAbsent) {
                lines.push('', 'Note: spark_updatectl is not present; applying via the native package manager.');
            }
        }

        if (hasFirmware) {
            if (hasPackages) { lines.push(''); }
            lines.push(
                `Apply ${toApplyFirmware.length} firmware update(s) to ${device.name}:`,
                ...toApplyFirmware.map(f => f.deviceLabel || f.package),
            );
            if (plan.firmwareRequiresReboot) {
                lines.push('', 'WARNING: Firmware updates require a device restart to take effect.');
            }
        }

        if (plan.skipped.length > 0) {
            lines.push(
                '',
                `Dropped since last checkup: ${plan.skipped.map(s => `${s.package} (${s.reason})`).join(', ')}`,
            );
        }

        lines.push('', 'This changes the device and may require a reboot.');

        const confirmLabel = hasFirmware && !hasPackages ? 'Apply firmware' : 'Apply updates';

        const confirm = await vscode.window.showWarningMessage(
            lines.join('\n'),
            { modal: true },
            confirmLabel,
        );
        if (confirm !== confirmLabel) { return; }

        // First attempt (no password)
        let result = await this.executeWithProgress(device, plan);

        // Retry with password if required
        if (result.requiresPassword) {
            const password = await vscode.window.showInputBox({
                prompt: `Sudo password for ${device.name}`,
                password: true,
                ignoreFocusOut: true,
            });
            if (!password) { return; }
            result = await this.executeWithProgress(device, plan, password);
        }

        const parts: string[] = [];
        if (result.applied.length > 0) {
            parts.push(`${result.applied.length} update(s)`);
        }
        const fwApplied = result.firmwareApplied ?? [];
        if (fwApplied.length > 0) {
            parts.push(`${fwApplied.length} firmware update(s)`);
        }

        const firmwareOk = result.firmwareSuccess !== false; // undefined = not attempted → ok
        if (result.success && firmwareOk) {
            vscode.window.showInformationMessage(
                `ZGX Toolkit: Applied ${parts.join(' and ')} to ${device.name}.`,
            );
        } else if (result.success && !firmwareOk) {
            vscode.window.showWarningMessage(
                `ZGX Toolkit: Packages applied but firmware update failed for ${device.name}: ${result.note ?? 'Unknown error'}`,
            );
        } else {
            vscode.window.showErrorMessage(
                `ZGX Toolkit: Apply failed for ${device.name}: ${result.note ?? 'Unknown error'}`,
            );
        }

        // Refresh panel to reflect new status
        await this.render({ deviceId: device.id });
    }

    private async executeWithProgress(
        device: Device,
        plan: ApplyPlan,
        sudoPassword?: string,
    ): Promise<ApplyResult> {
        let result!: ApplyResult;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Applying updates to ${device.name}…`,
                cancellable: false,
            },
            async () => {
                result = await updateReconciliationService.executeApplyPlan(
                    device, plan, sudoPassword,
                );
            },
        );
        return result;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private formatAge(iso: string): string {
        try {
            const ms = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(ms / 60_000);
            if (mins < 1)  { return 'just now'; }
            if (mins < 60) { return `${mins}m ago`; }
            const hrs = Math.floor(mins / 60);
            if (hrs < 24)  { return `${hrs}h ago`; }
            return `${Math.floor(hrs / 24)}d ago`;
        } catch {
            return iso;
        }
    }

    private escape(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
