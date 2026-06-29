/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import { BaseViewController } from '../../baseViewController';
import { Logger } from '../../../utils/logger';
import { ITelemetryService } from '../../../types/telemetry';
import { Message } from '../../../types/messages';
import { DeviceService } from '../../../services/deviceService';
import { CheckupResult, PendingUpdatesState } from '../../../types/scheduledUpdates';

export class UpdateReportViewController extends BaseViewController {
    private deviceService: DeviceService;

    public static viewId(): string {
        return 'admin/update-report';
    }

    constructor(deps: {
        logger: Logger;
        telemetry: ITelemetryService;
        deviceService: DeviceService;
    }) {
        super(deps.logger, deps.telemetry);
        this.deviceService = deps.deviceService;
        this.template     = this.loadTemplate('./updateReport.html', __dirname);
        this.styles       = this.loadTemplate('./updateReport.css',  __dirname);
        this.clientScript = this.loadTemplate('./updateReport.js',   __dirname);
    }

    async render(_params?: any, nonce?: string): Promise<string> {
        const devices = await this.deviceService.getAllDevices();

        const rows = devices.map(d => {
            const pending    = d.metadata?.pendingUpdates as PendingUpdatesState | undefined;
            const lastCheckup = d.metadata?.lastCheckup   as CheckupResult       | undefined;

            const status     = pending?.status ?? 'unchecked';
            const hasUpdates = status === 'available' && (pending?.candidates.length ?? 0) > 0;
            const updateCount = hasUpdates ? pending!.candidates.length : 0;

            const topUpdates = hasUpdates
                ? pending!.candidates.slice(0, 5).map(u => ({
                    package:          u.package,
                    currentVersion:   u.currentVersion,
                    availableVersion: u.availableVersion,
                }))
                : [];

            return {
                id:             d.id,
                name:           d.name,
                host:           d.host,
                isSetup:        d.isSetup,
                lastCheckedAt:  lastCheckup?.checkedAt ? this.formatAge(lastCheckup.checkedAt) : null,
                source:         lastCheckup?.source ?? '—',
                status,
                hasUpdates,
                updateCount,
                topUpdates,
                moreCount:      hasUpdates && pending!.candidates.length > 5
                    ? pending!.candidates.length - 5
                    : 0,
                isApplied:      status === 'applied',
                isError:        status === 'error',
                isUpToDate:     status === 'none',
                unchecked:      !lastCheckup,
            };
        });

        // Sort: updates first, then errors, then applied, then up-to-date, then unchecked
        const order: Record<string, number> = {
            available: 0, error: 1, applied: 2, none: 3, unchecked: 4,
        };
        rows.sort((a, b) => {
            const oa = order[a.status] ?? 5;
            const ob = order[b.status] ?? 5;
            if (oa !== ob) { return oa - ob; }
            return b.updateCount - a.updateCount;
        });

        const totalAvailable  = rows.reduce((s, r) => s + r.updateCount, 0);
        const devicesWithUpdates = rows.filter(r => r.hasUpdates).length;
        const checkedDevices  = rows.filter(r => !r.unchecked).length;

        const body = this.renderTemplate(this.template, {
            generatedAt:       new Date().toLocaleString(),
            totalDevices:      devices.length,
            checkedDevices,
            totalAvailable,
            devicesWithUpdates,
            hasRows:           rows.length > 0,
            rows,
        });

        return this.wrapHtml(body, nonce);
    }

    async handleMessage(message: Message): Promise<void> {
        await super.handleMessage(message);
        const msg = message as any;

        switch (msg.type) {
            case 'goBack':
                await this.navigateTo('admin/dashboard', undefined, 'editor');
                break;

            case 'openUpdateReview':
                if (msg.deviceId) {
                    await this.navigateTo('devices/updates', { deviceId: msg.deviceId }, 'editor');
                }
                break;

            case 'refresh':
                await this.refresh();
                break;
        }
    }

    private formatAge(iso: string): string {
        const diffMs  = Date.now() - new Date(iso).getTime();
        const diffMin = Math.floor(diffMs / 60_000);
        if (diffMin < 1)   { return 'just now'; }
        if (diffMin < 60)  { return `${diffMin}m ago`; }
        const diffH = Math.floor(diffMin / 60);
        if (diffH   < 24)  { return `${diffH}h ago`; }
        return `${Math.floor(diffH / 24)}d ago`;
    }
}
