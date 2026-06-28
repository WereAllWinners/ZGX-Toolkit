/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tailscale detection + connectivity service (Phase 1).
 *
 * Detects Tailscale on the device (over SSH) and on the client (local
 * machine), and provides helpers for the opt-in decision. No Tailscale API
 * access — connectivity flows through the existing SSH path, since a tailnet
 * IP is just a routable host address.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { Device } from '../types/devices';
import {
    TailscaleDeviceMetadata,
    TailscaleDetectionResult,
    TailscalePeer,
} from '../types/tailscale';
import { executeSSHCommand } from '../utils/sshConnection';
import type { DeviceService } from './deviceService';

export class TailscaleService {

    /**
     * Tailscale assigns IPv4 addresses from the CGNAT range 100.64.0.0/10
     * (first octet 100, second octet 64–127 inclusive).
     */
    isTailscaleIP(host: string): boolean {
        const parts = host.trim().split('.');
        if (parts.length !== 4) { return false; }
        const o = parts.map(p => Number(p));
        if (o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) { return false; }
        return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
    }

    isManaged(device: Device): boolean {
        return this.getMetadata(device)?.decision === 'enabled';
    }

    getMetadata(device: Device): TailscaleDeviceMetadata | undefined {
        return device.metadata?.tailscale as TailscaleDeviceMetadata | undefined;
    }

    // ----- Detection: device side (over SSH) -------------------------------

    /**
     * Check whether the DEVICE has Tailscale and is on a tailnet, via SSH.
     * Returns the device's tailnet IPv4 if available.
     */
    async detectOnDevice(device: Device): Promise<{ installed: boolean; tailnetIp?: string }> {
        try {
            const presence = await executeSSHCommand(
                device,
                'command -v tailscale >/dev/null 2>&1 && echo yes || echo no',
                { readyTimeout: 15000 },
                { operationName: 'Tailscale presence check', timeoutSeconds: 15 }
            );
            if (!presence.success || presence.stdout.trim() !== 'yes') {
                return { installed: false };
            }
            const ipResult = await executeSSHCommand(
                device,
                'tailscale ip -4 2>/dev/null | head -1',
                { readyTimeout: 15000 },
                { operationName: 'Tailscale IP lookup', timeoutSeconds: 15 }
            );
            const ip = ipResult.success ? ipResult.stdout.trim() : '';
            return { installed: true, tailnetIp: this.isTailscaleIP(ip) ? ip : undefined };
        } catch (err) {
            logger.debug('Device-side Tailscale detection failed', {
                device: device.name,
                error: err instanceof Error ? err.message : String(err),
            });
            return { installed: false };
        }
    }

    // ----- Detection: client side (local machine) --------------------------

    private clientBinaryCandidates(): string[] {
        const platform = os.platform();
        if (platform === 'win32') {
            return [
                'tailscale.exe',
                'C:\\Program Files\\Tailscale\\tailscale.exe',
            ];
        }
        if (platform === 'darwin') {
            return [
                'tailscale',
                '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
                '/usr/local/bin/tailscale',
                '/opt/homebrew/bin/tailscale',
            ];
        }
        return ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale'];
    }

    /**
     * Run `tailscale status --json` on the CLIENT machine and parse peers.
     * Returns undefined if Tailscale isn't installed/running locally.
     */
    async detectOnClient(): Promise<{ up: boolean; selfIp?: string; peers: TailscalePeer[] } | undefined> {
        for (const bin of this.clientBinaryCandidates()) {
            const json = await this.trySpawnJson(bin, ['status', '--json']);
            if (json) {
                return this.parseClientStatus(json);
            }
        }
        return undefined;
    }

    private trySpawnJson(bin: string, args: string[]): Promise<any | undefined> {
        return new Promise((resolve) => {
            let out = '';
            let proc;
            try {
                proc = spawn(bin, args, { timeout: 10000 });
            } catch {
                resolve(undefined);
                return;
            }
            if (!proc) { resolve(undefined); return; }
            proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            proc.on('error', () => resolve(undefined));
            proc.on('close', (code: number | null) => {
                if (code !== 0 || !out.trim()) { resolve(undefined); return; }
                try { resolve(JSON.parse(out)); } catch { resolve(undefined); }
            });
        });
    }

    parseClientStatus(json: any): { up: boolean; selfIp?: string; peers: TailscalePeer[] } {
        const toPeer = (p: any): TailscalePeer | undefined => {
            const ips: string[] = p?.TailscaleIPs ?? [];
            const ipv4 = ips.find((ip: string) => this.isTailscaleIP(ip));
            if (!ipv4) { return undefined; }
            return {
                hostName: p?.HostName ?? '',
                dnsName: (p?.DNSName ?? '').replace(/\.$/, ''),
                os: p?.OS ?? '',
                tailnetIp: ipv4,
                online: p?.Online === true,
            };
        };
        const selfIps: string[] = json?.Self?.TailscaleIPs ?? [];
        const selfIp = selfIps.find((ip: string) => this.isTailscaleIP(ip));
        const peerMap = json?.Peer ?? {};
        const peers = Object.values(peerMap)
            .map(toPeer)
            .filter((p): p is TailscalePeer => !!p);
        return { up: !!selfIp, selfIp, peers };
    }

    /**
     * Try to match a configured device to a client-side tailnet peer by
     * hostname. Used only when device-side detection didn't yield an IP.
     */
    matchPeerForDevice(device: Device, peers: TailscalePeer[]): TailscalePeer | undefined {
        const name = device.name.toLowerCase();
        const host = device.host.toLowerCase();
        return peers.find(p => {
            const h = p.hostName.toLowerCase();
            const d = p.dnsName.toLowerCase();
            return h === name || h === host || d.startsWith(name + '.') || d.startsWith(host + '.');
        });
    }

    // ----- Combined detection ---------------------------------------------

    /**
     * Run both-side detection and return a combined result.
     * Device-side IP is preferred; client-side peer match is a fallback.
     */
    async detect(device: Device): Promise<TailscaleDetectionResult> {
        const deviceResult = await this.detectOnDevice(device);
        const client = await this.detectOnClient();
        const onClient = !!client?.up;

        let tailnetIp = deviceResult.tailnetIp;
        let ipSource: 'device' | 'client' | undefined = tailnetIp ? 'device' : undefined;

        if (!tailnetIp && client) {
            const peer = this.matchPeerForDevice(device, client.peers);
            if (peer) { tailnetIp = peer.tailnetIp; ipSource = 'client'; }
        }

        return {
            onDevice: deviceResult.installed,
            onClient,
            tailnetIp,
            ipSource,
        };
    }

    // ----- Metadata builder (caller persists via DeviceService) ------------

    buildMetadata(
        decision: TailscaleDeviceMetadata['decision'],
        result: TailscaleDetectionResult,
        promptShown: boolean,
        previousHost?: string
    ): TailscaleDeviceMetadata {
        const now = new Date().toISOString();
        const detectedOn =
            result.onDevice && result.onClient ? 'both'
            : result.onDevice ? 'device'
            : result.onClient ? 'client'
            : undefined;
        return {
            decision,
            promptShown,
            tailnetIp: result.tailnetIp,
            detectedOn,
            lastDetectedAt: now,
            decisionChangedAt: now,
            ...(previousHost !== undefined ? { previousHost } : {}),
        };
    }
}

export const tailscaleService = new TailscaleService();

// ---------------------------------------------------------------------------
// Detection flow (exported standalone function — triggered after device setup)
// ---------------------------------------------------------------------------

/**
 * Run both-side Tailscale detection for a newly set-up device and, if a
 * tailnet IP is found and prompting is enabled, show a one-time opt-in prompt.
 *
 * This is intentionally fire-and-forget: callers should not await it, so the
 * setup flow is never blocked by detection latency.
 */
export async function runTailscaleDetectionFlow(
    device: Device,
    svc: TailscaleService,
    deviceSvc: DeviceService
): Promise<void> {
    const config = vscode.workspace.getConfiguration('zgxToolkit');
    if (!config.get<boolean>('tailscale.enabled', true)) { return; }

    const existing = svc.getMetadata(device);
    if (existing?.promptShown) { return; }

    const result = await svc.detect(device);

    if (!result.tailnetIp) {
        if (result.onDevice || result.onClient) {
            const meta = svc.buildMetadata('undecided', result, false);
            await deviceSvc.updateDevice(device.id, {
                metadata: { ...(device.metadata ?? {}), tailscale: meta },
            });
        }
        return;
    }

    if (!config.get<boolean>('tailscale.promptOnDetect', true)) {
        const meta = svc.buildMetadata('undecided', result, false);
        await deviceSvc.updateDevice(device.id, {
            metadata: { ...(device.metadata ?? {}), tailscale: meta },
        });
        return;
    }

    const where = result.onDevice && result.onClient
        ? 'on this device and your computer'
        : result.onDevice ? 'on this device' : 'on your computer';

    const choice = await vscode.window.showInformationMessage(
        `Tailscale was detected ${where}. Route SSH to ${device.name} over its ` +
        `tailnet IP (${result.tailnetIp})? You can change this anytime via the command palette.`,
        'Use Tailscale',
        'Not now'
    );

    const decision = choice === 'Use Tailscale' ? 'enabled' : 'disabled';
    const previousHost = decision === 'enabled' ? device.host : undefined;
    const meta = svc.buildMetadata(decision, result, true, previousHost);

    await deviceSvc.updateDevice(device.id, {
        host: decision === 'enabled' ? result.tailnetIp! : device.host,
        metadata: { ...(device.metadata ?? {}), tailscale: meta },
    });

    vscode.window.showInformationMessage(
        decision === 'enabled'
            ? `✓ ${device.name} will now connect over Tailscale (${result.tailnetIp}).`
            : `${device.name} will keep using its current address. You can enable ` +
              `Tailscale later from the command palette.`
    );
}
