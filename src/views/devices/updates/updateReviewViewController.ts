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
import { PendingUpdatesState } from '../../../types/scheduledUpdates';

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

        const totalAvailable =
            pending.candidates.length +
            pending.ansibleExclusions.length +
            pending.kernelExclusions.length;

        const templateData = {
            deviceName:          device.name,
            source:              pending.source,
            computedAt:          this.formatAge(pending.computedAt),
            totalAvailable,
            candidateCount:      pending.candidates.length,
            ansibleCount:        pending.ansibleExclusions.length,
            kernelCount:         pending.kernelExclusions.length,
            hasCandidates:       pending.candidates.length > 0,
            hasAnsibleExclusions: pending.ansibleExclusions.length > 0,
            hasKernelExclusions:  pending.kernelExclusions.length > 0,
            candidates:          pending.candidates,
            ansibleExclusions:   pending.ansibleExclusions,
            kernelExclusions:    pending.kernelExclusions,
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
                    await this.applySelectedStub(this.currentDevice, msg.packages ?? []);
                }
                break;

            case 'goBack':
                await this.navigateTo('admin/dashboard', {}, 'sidebar');
                break;
        }
    }

    // ── Stub — replaced in Task 03 ──────────────────────────────────────────

    private async applySelectedStub(device: Device, packages: string[]): Promise<void> {
        this.logger.info('[STUB] Approve & Apply requested', { device: device.name, packages });
        if (packages.length === 0) {
            vscode.window.showWarningMessage('ZGX Toolkit: No packages selected.');
            return;
        }
        vscode.window.showInformationMessage(
            `ZGX Toolkit (Preview): Would apply ${packages.length} update(s) to ${device.name}: ` +
            `${packages.join(', ')}. Actual applying is enabled in a later step.`,
        );
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
