/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for TailscaleApiService.
 * Covers SecretStorage credential management, OAuth token exchange,
 * device listing, and error handling.
 */

import { TailscaleApiService } from '../../services/tailscaleApiService';
import * as https from 'https';
import { EventEmitter } from 'events';

jest.mock('https');
jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockHttpsRequest = https.request as jest.MockedFunction<typeof https.request>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSecrets(store: Record<string, string | undefined> = {}) {
    const secrets: Record<string, string | undefined> = { ...store };
    return {
        get:    jest.fn((key: string) => Promise.resolve(secrets[key])),
        store:  jest.fn((key: string, value: string) => { secrets[key] = value; return Promise.resolve(); }),
        delete: jest.fn((key: string) => { delete secrets[key]; return Promise.resolve(); }),
        onDidChange: jest.fn(),
        _internal: secrets,
    };
}

/**
 * Queue up mock https responses in order. Each call to `https.request`
 * consumes the next response from the queue. Pass a plain body object
 * to default to statusCode 200.
 */
function queueHttpResponses(responses: Array<{ statusCode?: number; body: any }>) {
    for (const { statusCode = 200, body } of responses) {
        mockHttpsRequest.mockImplementationOnce((options: any, callback: any) => {
            const res = Object.assign(new EventEmitter(), { statusCode });
            const req: any = Object.assign(new EventEmitter(), {
                write: jest.fn(),
                setTimeout: jest.fn(),
                destroy: jest.fn(),
                end: jest.fn(() => {
                    setImmediate(() => {
                        if (typeof callback === 'function') { callback(res); }
                        setImmediate(() => {
                            res.emit('data', Buffer.from(JSON.stringify(body)));
                            res.emit('end');
                        });
                    });
                }),
            });
            return req;
        });
    }
}

const TOKEN_RESPONSE  = { access_token: 'test-token-abc', expires_in: 3600 };
const DEVICE_RESPONSE = {
    devices: [
        {
            id: 'id1',
            nodeId: 'nodeKey:abc',
            hostname: 'spark1',
            addresses: ['100.100.50.10', 'fd7a::1'],
            os: 'linux',
            online: true,
            lastSeen: undefined,
        },
        {
            id: 'id2',
            nodeId: 'nodeKey:def',
            hostname: 'spark2',
            addresses: ['100.100.50.11'],
            os: 'linux',
            online: false,
            lastSeen: '2026-06-28T06:00:00Z',
        },
        {
            id: 'id3',
            nodeId: 'nodeKey:ghi',
            hostname: 'non-tailnet',
            addresses: ['192.168.1.50'],   // NOT a tailnet IP — should be filtered out
            os: 'linux',
            online: true,
        },
    ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TailscaleApiService', () => {
    let svc: TailscaleApiService;

    beforeEach(() => {
        svc = new TailscaleApiService();
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // isConfigured
    // -----------------------------------------------------------------------

    describe('isConfigured', () => {
        it('returns false when not initialized', async () => {
            expect(await svc.isConfigured()).toBe(false);
        });

        it('returns false when secrets are empty', async () => {
            svc.initialize(makeSecrets() as any);
            expect(await svc.isConfigured()).toBe(false);
        });

        it('returns false when only clientId is stored', async () => {
            svc.initialize(makeSecrets({ 'tailscale.oauth.clientId': 'id1' }) as any);
            expect(await svc.isConfigured()).toBe(false);
        });

        it('returns false when only clientSecret is stored', async () => {
            svc.initialize(makeSecrets({ 'tailscale.oauth.clientSecret': 'secret1' }) as any);
            expect(await svc.isConfigured()).toBe(false);
        });

        it('returns true when both credentials are stored', async () => {
            svc.initialize(makeSecrets({
                'tailscale.oauth.clientId':     'id1',
                'tailscale.oauth.clientSecret': 'secret1',
            }) as any);
            expect(await svc.isConfigured()).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // setCredentials / clearCredentials
    // -----------------------------------------------------------------------

    describe('setCredentials / clearCredentials', () => {
        it('stores both credential keys in SecretStorage', async () => {
            const secrets = makeSecrets();
            svc.initialize(secrets as any);
            await svc.setCredentials('my-client-id', 'my-client-secret');

            expect(secrets.store).toHaveBeenCalledWith('tailscale.oauth.clientId', 'my-client-id');
            expect(secrets.store).toHaveBeenCalledWith('tailscale.oauth.clientSecret', 'my-client-secret');
        });

        it('throws if not initialized', async () => {
            await expect(svc.setCredentials('id', 'secret')).rejects.toThrow('not initialized');
        });

        it('clearCredentials deletes both keys', async () => {
            const secrets = makeSecrets({
                'tailscale.oauth.clientId':     'id1',
                'tailscale.oauth.clientSecret': 'secret1',
            });
            svc.initialize(secrets as any);
            await svc.clearCredentials();

            expect(secrets.delete).toHaveBeenCalledWith('tailscale.oauth.clientId');
            expect(secrets.delete).toHaveBeenCalledWith('tailscale.oauth.clientSecret');
        });

        it('clearCredentials is a no-op when not initialized', async () => {
            await expect(svc.clearCredentials()).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // testCredentials
    // -----------------------------------------------------------------------

    describe('testCredentials', () => {
        it('succeeds when token exchange and device list both return 200', async () => {
            svc.initialize(makeSecrets() as any);
            queueHttpResponses([{ body: TOKEN_RESPONSE }, { body: DEVICE_RESPONSE }]);

            await expect(svc.testCredentials('client-id', 'client-secret')).resolves.toBeUndefined();
            expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
        });

        it('throws when token endpoint returns 401', async () => {
            svc.initialize(makeSecrets() as any);
            queueHttpResponses([{ statusCode: 401, body: { message: 'Unauthorized' } }]);

            await expect(svc.testCredentials('bad-id', 'bad-secret')).rejects.toThrow('401');
        });
    });

    // -----------------------------------------------------------------------
    // listDevices
    // -----------------------------------------------------------------------

    describe('listDevices', () => {
        beforeEach(() => {
            svc.initialize(makeSecrets({
                'tailscale.oauth.clientId':     'my-client-id',
                'tailscale.oauth.clientSecret': 'my-client-secret',
            }) as any);
        });



        it('exchanges token then fetches devices', async () => {
            queueHttpResponses([{ body: TOKEN_RESPONSE }, { body: DEVICE_RESPONSE }]);
            const devices = await svc.listDevices();

            expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
            expect(devices).toHaveLength(2);  // third entry filtered (no tailnet IP)
        });

        it('returns correct device fields', async () => {
            queueHttpResponses([{ body: TOKEN_RESPONSE }, { body: DEVICE_RESPONSE }]);
            const devices = await svc.listDevices();

            const spark1 = devices.find(d => d.hostname === 'spark1');
            expect(spark1?.tailnetIp).toBe('100.100.50.10');
            expect(spark1?.online).toBe(true);
            expect(spark1?.lastSeen).toBeUndefined();

            const spark2 = devices.find(d => d.hostname === 'spark2');
            expect(spark2?.tailnetIp).toBe('100.100.50.11');
            expect(spark2?.online).toBe(false);
            expect(spark2?.lastSeen).toBe('2026-06-28T06:00:00Z');
        });

        it('filters out devices with no tailnet IPv4 address', async () => {
            queueHttpResponses([{ body: TOKEN_RESPONSE }, { body: DEVICE_RESPONSE }]);
            const devices = await svc.listDevices();
            expect(devices.every(d => d.tailnetIp.startsWith('100.'))).toBe(true);
        });

        it('throws when devices endpoint returns 403', async () => {
            queueHttpResponses([
                { body: TOKEN_RESPONSE },
                { statusCode: 403, body: { message: 'Forbidden' } },
            ]);
            await expect(svc.listDevices()).rejects.toThrow('403');
        });

        it('reuses cached token on second call', async () => {
            queueHttpResponses([
                { body: TOKEN_RESPONSE },
                { body: DEVICE_RESPONSE },
                { body: DEVICE_RESPONSE },
            ]);
            await svc.listDevices();
            await svc.listDevices();

            // Only one token exchange (first call), second call reuses cache
            const tokenCalls = (mockHttpsRequest.mock.calls as any[]).filter(
                ([opts]) => opts.path?.includes('oauth/token')
            );
            expect(tokenCalls).toHaveLength(1);
        });

        it('throws when credentials are not configured', async () => {
            svc.initialize(makeSecrets() as any);  // no credentials
            await expect(svc.listDevices()).rejects.toThrow('credentials not configured');
        });
    });
});
