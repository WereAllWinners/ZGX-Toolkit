/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { Device } from '../types/devices';
import {
    AvailableUpdate,
    CheckupResult,
    UpdateSource,
} from '../types/scheduledUpdates';
import { UpdateAvailabilityData } from '../types/manageability';
import { logger } from '../utils/logger';
import { manageabilityService } from './manageabilityService';
import { platformProfileService } from './platformProfileService';
import { deviceService } from './deviceService';

export class ScheduledCheckupService {
    private timer: NodeJS.Timeout | undefined;

    start(context: vscode.ExtensionContext): void {
        if (this.isEnabled()) {
            this.scheduleTimer();
        }

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('zgxToolkit.scheduledCheckups')) {
                    this.stop();
                    if (this.isEnabled()) {
                        this.scheduleTimer();
                    }
                }
            })
        );
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    async runCheckupNow(device: Device): Promise<CheckupResult> {
        try {
            await platformProfileService.detect(device);
        } catch (err) {
            logger.debug('Checkup: platform detection skipped', {
                device: device.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        try {
            await manageabilityService.collectInventory(device);
        } catch (err) {
            logger.debug('Checkup: inventory collection skipped', {
                device: device.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        const checkupResult = await this.runUpdateAvailability(device);

        await deviceService.updateDevice(device.id, {
            metadata: { ...device.metadata, lastCheckup: checkupResult },
        });

        logger.info('Checkup complete', {
            device: device.name,
            source: checkupResult.source,
            updateCount: checkupResult.availableUpdates.length,
        });

        return checkupResult;
    }

    private isEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('zgxToolkit.scheduledCheckups')
            .get<boolean>('enabled', false);
    }

    private scheduleTimer(): void {
        const intervalHours = vscode.workspace
            .getConfiguration('zgxToolkit.scheduledCheckups')
            .get<number>('intervalHours', 24);
        const intervalMs = intervalHours * 60 * 60 * 1000;
        this.timer = setInterval(() => {
            this.runAllDevices().catch(err => {
                logger.debug('Scheduled checkup tick failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }, intervalMs);
    }

    private async runAllDevices(): Promise<void> {
        let devices: Device[];
        try {
            devices = await deviceService.getAllDevices();
        } catch (err) {
            logger.debug('Scheduled checkup: failed to get devices', {
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        for (const device of devices.filter(d => d.isSetup)) {
            try {
                await this.runCheckupNow(device);
            } catch (err) {
                logger.debug('Scheduled checkup: device skipped', {
                    device: device.name,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    private async runUpdateAvailability(device: Device): Promise<CheckupResult> {
        const now = new Date().toISOString();

        try {
            const result = await manageabilityService.runTool<UpdateAvailabilityData>(
                device,
                'update_availability',
            );

            if (!result.success || !result.envelope) {
                return {
                    checkedAt: now,
                    source: 'unavailable',
                    availableUpdates: [],
                    status: 'error',
                    note: result.error ?? 'Update availability query failed',
                };
            }

            const data = result.envelope.data;
            const source: UpdateSource = data.source ?? 'unavailable';
            const availableUpdates: AvailableUpdate[] = (data.updates ?? []).map(u => ({
                package: u.package,
                currentVersion: u.current_version,
                availableVersion: u.available_version,
            }));

            const envelopeStatus = result.envelope.status;
            const status: CheckupResult['status'] =
                envelopeStatus === 'ok' ? 'ok'
                : envelopeStatus === 'partial' ? 'partial'
                : 'error';

            return { checkedAt: now, source, availableUpdates, status };
        } catch (err) {
            logger.debug('Update availability query threw', {
                device: device.name,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                checkedAt: now,
                source: 'unavailable',
                availableUpdates: [],
                status: 'error',
                note: err instanceof Error ? err.message : String(err),
            };
        }
    }
}

export const scheduledCheckupService = new ScheduledCheckupService();
