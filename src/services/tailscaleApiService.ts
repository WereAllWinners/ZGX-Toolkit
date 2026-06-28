/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tailscale API service (Phase 2).
 *
 * Handles OAuth client-credentials token exchange and read-only device listing
 * via the Tailscale API. Used as a fallback when the local tailscale CLI shows
 * the client is not on the tailnet.
 *
 * Security invariants:
 *  - Credentials stored exclusively in VS Code SecretStorage; never in settings.
 *  - Access tokens cached in memory only; never persisted.
 *  - Only requests devices:core:read scope.
 *  - Secrets and tokens are never logged.
 */

import * as https from 'https';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface TailscaleApiDevice {
    nodeId: string;
    hostname: string;
    /** First IPv4 address in the CGNAT range (100.64.0.0/10). */
    tailnetIp: string;
    online: boolean;
    /** ISO 8601; present when the device has been seen but is currently offline. */
    lastSeen?: string;
}

export class TailscaleApiService {
    private secrets?: vscode.SecretStorage;
    private cachedToken?: { token: string; expiresAt: number };

    private static readonly CLIENT_ID_KEY     = 'tailscale.oauth.clientId';
    private static readonly CLIENT_SECRET_KEY = 'tailscale.oauth.clientSecret';
    private static readonly API_HOST          = 'api.tailscale.com';
    private static readonly OAUTH_PATH        = '/api/v2/oauth/token';
    private static readonly DEVICES_PATH      = '/api/v2/tailnet/-/devices?fields=all';

    initialize(secrets: vscode.SecretStorage): void {
        this.secrets = secrets;
    }

    async isConfigured(): Promise<boolean> {
        if (!this.secrets) { return false; }
        const [id, secret] = await Promise.all([
            this.secrets.get(TailscaleApiService.CLIENT_ID_KEY),
            this.secrets.get(TailscaleApiService.CLIENT_SECRET_KEY),
        ]);
        return !!(id && secret);
    }

    async setCredentials(clientId: string, clientSecret: string): Promise<void> {
        if (!this.secrets) { throw new Error('TailscaleApiService not initialized'); }
        await this.secrets.store(TailscaleApiService.CLIENT_ID_KEY, clientId);
        await this.secrets.store(TailscaleApiService.CLIENT_SECRET_KEY, clientSecret);
        this.cachedToken = undefined;
        logger.debug('Tailscale API: OAuth credentials stored');
    }

    async clearCredentials(): Promise<void> {
        if (!this.secrets) { return; }
        await Promise.all([
            this.secrets.delete(TailscaleApiService.CLIENT_ID_KEY),
            this.secrets.delete(TailscaleApiService.CLIENT_SECRET_KEY),
        ]);
        this.cachedToken = undefined;
        logger.debug('Tailscale API: OAuth credentials cleared');
    }

    /**
     * Validate credentials without storing them.
     * Throws if the token exchange or device list call fails.
     */
    async testCredentials(clientId: string, clientSecret: string): Promise<void> {
        const token = await this.exchangeToken(clientId, clientSecret);
        await this.fetchDevices(token);
    }

    async listDevices(): Promise<TailscaleApiDevice[]> {
        const token = await this.getAccessToken();
        return this.fetchDevices(token);
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
        if (!this.secrets) { throw new Error('TailscaleApiService not initialized'); }
        const [clientId, clientSecret] = await Promise.all([
            this.secrets.get(TailscaleApiService.CLIENT_ID_KEY),
            this.secrets.get(TailscaleApiService.CLIENT_SECRET_KEY),
        ]);
        if (!clientId || !clientSecret) {
            throw new Error('Tailscale API credentials not configured');
        }
        return { clientId, clientSecret };
    }

    private async getAccessToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
            return this.cachedToken.token;
        }
        const { clientId, clientSecret } = await this.getCredentials();
        return this.exchangeToken(clientId, clientSecret);
    }

    private async exchangeToken(clientId: string, clientSecret: string): Promise<string> {
        const body = new URLSearchParams({
            grant_type:    'client_credentials',
            client_id:     clientId,
            client_secret: clientSecret,
            scope:         'devices:core:read',
        }).toString();

        const response = await this.httpsRequest('POST', TailscaleApiService.OAUTH_PATH, {
            'Content-Type':   'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(body)),
        }, body);

        const expiresIn: number = response.expires_in ?? 3600;
        this.cachedToken = {
            token:     response.access_token,
            expiresAt: Date.now() + expiresIn * 1000,
        };
        return this.cachedToken.token;
    }

    private async fetchDevices(token: string): Promise<TailscaleApiDevice[]> {
        const response = await this.httpsRequest('GET', TailscaleApiService.DEVICES_PATH, {
            'Authorization': `Bearer ${token}`,
        });

        const raw: any[] = response.devices ?? [];
        return raw
            .map(d => {
                const addresses: string[] = d.addresses ?? [];
                const tailnetIp = addresses.find(a => {
                    const parts = a.split('.');
                    if (parts.length !== 4) { return false; }
                    const o = parts.map(Number);
                    return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
                }) ?? '';
                return {
                    nodeId:   d.nodeId ?? d.id ?? '',
                    hostname: d.hostname ?? '',
                    tailnetIp,
                    online:   d.online === true,
                    lastSeen: d.lastSeen as string | undefined,
                };
            })
            .filter(d => !!d.tailnetIp);
    }

    private httpsRequest(
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: string
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: TailscaleApiService.API_HOST,
                port:     443,
                path,
                method,
                headers: { Accept: 'application/json', ...headers },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(
                            `Tailscale API error ${res.statusCode}: ${data.slice(0, 200)}`
                        ));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error('Tailscale API returned invalid JSON'));
                    }
                });
            });

            req.setTimeout(15_000, () => {
                req.destroy();
                reject(new Error('Tailscale API request timed out'));
            });
            req.on('error', reject);

            if (body) { req.write(body); }
            req.end();
        });
    }
}

export const tailscaleApiService = new TailscaleApiService();
