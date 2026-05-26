/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Device Info view — displays the cached ManageabilitySnapshot for a DGX Spark device.
 * When no snapshot exists, prompts the user to run inventory.
 * A "Refresh" button re-runs collectInventory and re-renders.
 */

import { BaseViewController } from '../../baseViewController';
import { Logger } from '../../../utils/logger';
import { ITelemetryService } from '../../../types/telemetry';
import { Message } from '../../../types/messages';
import { DeviceService } from '../../../services/deviceService';
import { ManageabilityService } from '../../../services/manageabilityService';
import { ManageabilitySnapshot } from '../../../types/manageability';

/** Health status → codicon name */
const HEALTH_ICONS: Record<string, string> = {
    healthy:  'codicon-pass-filled',
    degraded: 'codicon-warning',
    critical: 'codicon-error',
    unknown:  'codicon-question',
};

export class DeviceInfoViewController extends BaseViewController {
    private deviceService: DeviceService;
    private manageabilityService: ManageabilityService;

    public static viewId(): string {
        return 'devices/info';
    }

    constructor(deps: {
        logger: Logger;
        telemetry: ITelemetryService;
        deviceService: DeviceService;
        manageabilityService: ManageabilityService;
    }) {
        super(deps.logger, deps.telemetry);

        this.deviceService = deps.deviceService;
        this.manageabilityService = deps.manageabilityService;

        this.template    = this.loadTemplate('./deviceInfo.html', __dirname);
        this.styles      = this.loadTemplate('./deviceInfo.css', __dirname);
        this.clientScript = this.loadTemplate('./deviceInfo.js', __dirname);
    }

    async render(params?: { deviceId?: string }, nonce?: string): Promise<string> {
        const deviceId = params?.deviceId;

        if (!deviceId) {
            this.logger.warn('DeviceInfoViewController.render called without deviceId');
            return this.wrapHtml('<p>No device selected.</p>', nonce);
        }

        const device = await this.deviceService.getDevice(deviceId);

        if (!device) {
            this.logger.warn('DeviceInfoViewController: device not found', { deviceId });
            return this.wrapHtml('<p>Device not found.</p>', nonce);
        }

        const snapshot = device.metadata?.manageabilitySnapshot as ManageabilitySnapshot | undefined;

        const templateData = this.buildTemplateData(device, snapshot);
        const body = this.renderTemplate(this.template, templateData);
        return this.wrapHtml(body, nonce);
    }

    async handleMessage(message: Message): Promise<void> {
        await super.handleMessage(message);

        const rawMessage = message as any;

        if (rawMessage.type === 'goBack') {
            await this.navigateTo('admin/dashboard', undefined, 'editor');
            return;
        }

        if (rawMessage.type === 'runInventory') {
            const resolvedId: string | undefined = rawMessage.deviceId ?? rawMessage.params?.deviceId;

            if (!resolvedId) {
                this.logger.warn('runInventory message missing deviceId');
                return;
            }

            const device = await this.deviceService.getDevice(resolvedId);
            if (!device) {
                this.logger.warn('DeviceInfoViewController: runInventory — device not found', { resolvedId });
                return;
            }

            try {
                await this.manageabilityService.collectInventory(device);
            } catch (error) {
                this.logger.error('DeviceInfoViewController: collectInventory failed', {
                    device: device.name,
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                this.sendMessageToWebview({ type: 'inventoryComplete' });
                await this.refresh({ deviceId: resolvedId });
            }
        }
    }

    private buildTemplateData(device: { id: string; name: string; host: string; port: number }, snapshot: ManageabilitySnapshot | undefined): Record<string, any> {
        const base = {
            deviceId:   device.id,
            deviceName: device.name,
            deviceHost: device.host,
            devicePort: device.port,
        };

        if (!snapshot) {
            return { ...base, hasSnapshot: false };
        }

        // Normalize raw collector output to the shapes the template expects.
        const id  = snapshot.identity?.data  as any;
        const os  = snapshot.osBuild?.data   as any;
        const hw  = snapshot.hardware?.data  as any;
        const fw  = snapshot.firmware?.data  as any;
        const drv = snapshot.drivers?.data   as any;
        const hlth = snapshot.health?.data   as any;

        const identity = id ? {
            product_name:  id.product_name,
            manufacturer:  id.manufacturer,
            hostname:      id.hostname,
            serial_number: id.board_name ?? 'N/A',
            uuid:          id.bios_version ?? 'N/A',
        } : undefined;

        const osBuild = os ? {
            os_version:    os.os_pretty ?? os.os_version,
            kernel_version: os.kernel ?? os.kernel_version,
            build_string:  os.kernel_build ?? os.build_string,
            build_date:    os.architecture ?? os.build_date,
        } : undefined;

        const firstGpu = hw?.gpus?.[0];
        const cpuName = Array.isArray(hw?.cpu?.model_names) && hw.cpu.model_names.length
            ? hw.cpu.model_names[0]
            : (typeof hw?.cpu === 'string' ? hw.cpu : 'N/A');
        const hardware = hw ? {
            gpu_name:       firstGpu?.name ?? 'N/A',
            gpu_vram_gb:    firstGpu ? Math.round((firstGpu.vram_mb ?? 0) / 1024) : 0,
            cpu:            cpuName,
            total_memory_gb: Math.round((hw.total_memory_bytes ?? 0) / (1024 ** 3)),
        } : undefined;

        const firmware = fw ? {
            uefi_version: fw.bios_version ?? 'N/A',
            bmc_version:  'N/A',
            entries: [
                { component: 'GPU VBIOS', version: fw.gpu_vbios_version ?? 'N/A' },
                { component: 'GPU Driver', version: fw.gpu_driver_version ?? 'N/A' },
                { component: 'BIOS Date',  version: fw.bios_date ?? 'N/A' },
            ],
        } : undefined;

        const drivers = drv ? {
            gpu_driver_version: drv.gpu_driver_version,
            entries: (drv.packages ?? []).slice(0, 20),
        } : undefined;

        const health = hlth ? {
            overall_status: hlth.overall_status,
            signals: (hlth.signals ?? []).map((s: any) => ({
                name:    s.name,
                status:  s.status,
                message: s.value !== undefined ? `${s.value}${s.unit ? ' ' + s.unit : ''}` : s.message,
            })),
        } : undefined;

        const healthIcon = health
            ? (HEALTH_ICONS[health.overall_status] ?? 'codicon-question')
            : undefined;

        return {
            ...base,
            hasSnapshot:  true,
            collectedAt:  snapshot.collectedAt,
            productName:  id?.product_name ?? '',
            identity,
            osBuild,
            hardware,
            firmware,
            drivers,
            health,
            healthIcon,
        };
    }
}
