/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for TailscaleService.
 * Covers IP range detection, client-status parsing, peer matching,
 * device-side detection, combined detection, and metadata building.
 */

import { TailscaleService, tailscaleService, pollManagedDeviceStatus } from '../../services/tailscaleService';
import { Device } from '../../types/devices';
import { TailscaleDetectionResult } from '../../types/tailscale';
import * as vscode from 'vscode';

// Mock SSH utility so no real network calls happen
jest.mock('../../utils/sshConnection', () => ({
    executeSSHCommand: jest.fn(),
}));

// Mock child_process.spawn for client-side detection
jest.mock('child_process', () => ({
    spawn: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { executeSSHCommand } from '../../utils/sshConnection';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const mockExecuteSSHCommand = executeSSHCommand as jest.MockedFunction<typeof executeSSHCommand>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
    return {
        id: 'dev-001',
        name: 'dgx-spark-test',
        host: '192.168.1.50',
        username: 'nvidia',
        port: 22,
        isSetup: true,
        useKeyAuth: true,
        keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt: new Date().toISOString(),
        ...overrides,
    } as Device;
}

function makeSSHResult(stdout: string, success = true) {
    return { success, stdout, stderr: '', exitCode: success ? 0 : 1 };
}

function makeSpawnProcess(exitCode: number, output: string) {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // Emit data and close asynchronously
    setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(output));
        proc.emit('close', exitCode);
    });
    return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TailscaleService', () => {
    let svc: TailscaleService;

    beforeEach(() => {
        svc = new TailscaleService();
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // isTailscaleIP
    // -----------------------------------------------------------------------

    describe('isTailscaleIP', () => {
        it('returns true for addresses in 100.64.0.0/10', () => {
            expect(svc.isTailscaleIP('100.64.0.0')).toBe(true);
            expect(svc.isTailscaleIP('100.100.50.25')).toBe(true);
            expect(svc.isTailscaleIP('100.127.255.255')).toBe(true);
            expect(svc.isTailscaleIP('100.64.0.1')).toBe(true);
        });

        it('returns false for second octet below 64 (boundary)', () => {
            expect(svc.isTailscaleIP('100.63.255.255')).toBe(false);
        });

        it('returns false for second octet above 127 (boundary)', () => {
            expect(svc.isTailscaleIP('100.128.0.0')).toBe(false);
        });

        it('returns false for LAN and public addresses', () => {
            expect(svc.isTailscaleIP('192.168.1.10')).toBe(false);
            expect(svc.isTailscaleIP('8.8.8.8')).toBe(false);
            expect(svc.isTailscaleIP('10.0.0.1')).toBe(false);
            expect(svc.isTailscaleIP('172.16.0.1')).toBe(false);
        });

        it('returns false for non-IP strings', () => {
            expect(svc.isTailscaleIP('not-an-ip')).toBe(false);
            expect(svc.isTailscaleIP('100.64')).toBe(false);
            expect(svc.isTailscaleIP('100.64.0.0.0')).toBe(false);
            expect(svc.isTailscaleIP('')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // parseClientStatus
    // -----------------------------------------------------------------------

    describe('parseClientStatus', () => {
        const sampleJson = {
            Self: {
                TailscaleIPs: ['100.99.0.1', 'fd7a::1'],
            },
            Peer: {
                'nodekey:abc': {
                    HostName: 'dgx-spark-test',
                    DNSName: 'dgx-spark-test.tail1234.ts.net.',
                    OS: 'linux',
                    TailscaleIPs: ['100.100.50.1', 'fd7a::2'],
                    Online: true,
                },
                'nodekey:def': {
                    HostName: 'offline-device',
                    DNSName: 'offline-device.tail1234.ts.net.',
                    OS: 'linux',
                    TailscaleIPs: ['100.100.50.2', 'fd7a::3'],
                    Online: false,
                },
            },
        };

        it('returns up:true when Self has a tailnet IPv4', () => {
            const result = svc.parseClientStatus(sampleJson);
            expect(result.up).toBe(true);
        });

        it('returns the self tailnet IPv4', () => {
            const result = svc.parseClientStatus(sampleJson);
            expect(result.selfIp).toBe('100.99.0.1');
        });

        it('parses all peers with correct fields', () => {
            const result = svc.parseClientStatus(sampleJson);
            expect(result.peers).toHaveLength(2);
        });

        it('picks the first IPv4 from TailscaleIPs for each peer', () => {
            const result = svc.parseClientStatus(sampleJson);
            const peer = result.peers.find(p => p.hostName === 'dgx-spark-test');
            expect(peer?.tailnetIp).toBe('100.100.50.1');
        });

        it('strips trailing dot from DNSName', () => {
            const result = svc.parseClientStatus(sampleJson);
            const peer = result.peers.find(p => p.hostName === 'dgx-spark-test');
            expect(peer?.dnsName).toBe('dgx-spark-test.tail1234.ts.net');
        });

        it('maps Online field correctly', () => {
            const result = svc.parseClientStatus(sampleJson);
            const online = result.peers.find(p => p.hostName === 'dgx-spark-test');
            const offline = result.peers.find(p => p.hostName === 'offline-device');
            expect(online?.online).toBe(true);
            expect(offline?.online).toBe(false);
        });

        it('returns up:false when Self has no tailnet IPv4', () => {
            const noSelf = { Self: { TailscaleIPs: ['fd7a::1'] }, Peer: {} };
            const result = svc.parseClientStatus(noSelf);
            expect(result.up).toBe(false);
            expect(result.selfIp).toBeUndefined();
        });

        it('returns empty peers when Peer is empty', () => {
            const noPeers = { Self: { TailscaleIPs: ['100.99.0.1'] }, Peer: {} };
            const result = svc.parseClientStatus(noPeers);
            expect(result.peers).toHaveLength(0);
        });

        it('propagates LastSeen for offline peers', () => {
            const withLastSeen = {
                Self: { TailscaleIPs: ['100.99.0.1'] },
                Peer: {
                    key: {
                        HostName: 'old-device',
                        DNSName: 'old-device.ts.net.',
                        OS: 'linux',
                        TailscaleIPs: ['100.100.50.5'],
                        Online: false,
                        LastSeen: '2026-06-28T10:00:00Z',
                    },
                },
            };
            const result = svc.parseClientStatus(withLastSeen);
            expect(result.peers[0].lastSeen).toBe('2026-06-28T10:00:00Z');
            expect(result.peers[0].online).toBe(false);
        });

        it('leaves lastSeen undefined for online peers', () => {
            const result = svc.parseClientStatus(sampleJson);
            const online = result.peers.find(p => p.hostName === 'dgx-spark-test');
            expect(online?.lastSeen).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // matchPeerForDevice
    // -----------------------------------------------------------------------

    describe('matchPeerForDevice', () => {
        const peers = [
            {
                hostName: 'dgx-spark-test',
                dnsName: 'dgx-spark-test.tail1234.ts.net',
                os: 'linux',
                tailnetIp: '100.100.50.1',
                online: true,
            },
            {
                hostName: 'other-device',
                dnsName: 'other-device.tail1234.ts.net',
                os: 'linux',
                tailnetIp: '100.100.50.2',
                online: true,
            },
        ];

        it('matches by HostName equal to device name', () => {
            const device = makeDevice({ name: 'dgx-spark-test' });
            const peer = svc.matchPeerForDevice(device, peers);
            expect(peer?.tailnetIp).toBe('100.100.50.1');
        });

        it('matches by HostName equal to device host (when host is a hostname)', () => {
            const device = makeDevice({ name: 'myname', host: 'other-device' });
            const peer = svc.matchPeerForDevice(device, peers);
            expect(peer?.tailnetIp).toBe('100.100.50.2');
        });

        it('matches by DNSName prefix equal to device name', () => {
            const device = makeDevice({ name: 'dgx-spark-test', host: '192.168.1.50' });
            const peer = svc.matchPeerForDevice(device, peers);
            expect(peer?.tailnetIp).toBe('100.100.50.1');
        });

        it('returns undefined when no peer matches', () => {
            const device = makeDevice({ name: 'unknown-device', host: '10.0.0.1' });
            const peer = svc.matchPeerForDevice(device, peers);
            expect(peer).toBeUndefined();
        });

        it('returns undefined for empty peer list', () => {
            const device = makeDevice({ name: 'dgx-spark-test' });
            const peer = svc.matchPeerForDevice(device, []);
            expect(peer).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // detectOnDevice
    // -----------------------------------------------------------------------

    describe('detectOnDevice', () => {
        it('returns installed:false when tailscale is not found on device', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHResult('no', true));
            const result = await svc.detectOnDevice(makeDevice());
            expect(result.installed).toBe(false);
            expect(result.tailnetIp).toBeUndefined();
        });

        it('returns installed:false when SSH fails', async () => {
            mockExecuteSSHCommand.mockRejectedValueOnce(new Error('Connection refused'));
            const result = await svc.detectOnDevice(makeDevice());
            expect(result.installed).toBe(false);
        });

        it('returns installed:true and tailnetIp when tailscale is present with valid IP', async () => {
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('yes', true))  // presence check
                .mockResolvedValueOnce(makeSSHResult('100.100.50.5\n', true));  // ip lookup
            const result = await svc.detectOnDevice(makeDevice());
            expect(result.installed).toBe(true);
            expect(result.tailnetIp).toBe('100.100.50.5');
        });

        it('returns installed:true but no tailnetIp when IP is not in tailnet range', async () => {
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('yes', true))
                .mockResolvedValueOnce(makeSSHResult('10.0.0.1\n', true));
            const result = await svc.detectOnDevice(makeDevice());
            expect(result.installed).toBe(true);
            expect(result.tailnetIp).toBeUndefined();
        });

        it('returns installed:true but no tailnetIp when ip lookup fails', async () => {
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('yes', true))
                .mockResolvedValueOnce(makeSSHResult('', false));
            const result = await svc.detectOnDevice(makeDevice());
            expect(result.installed).toBe(true);
            expect(result.tailnetIp).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // detect (combined)
    // -----------------------------------------------------------------------

    describe('detect', () => {
        it('prefers device-side IP (ipSource: device) over client peer match', async () => {
            // Device side returns a tailnet IP
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('yes', true))
                .mockResolvedValueOnce(makeSSHResult('100.100.50.5\n', true));
            // Client side also up with a peer for the device
            mockSpawn.mockReturnValueOnce(makeSpawnProcess(0, JSON.stringify({
                Self: { TailscaleIPs: ['100.99.0.1'] },
                Peer: {
                    key: {
                        HostName: 'dgx-spark-test',
                        DNSName: 'dgx-spark-test.ts.net.',
                        OS: 'linux',
                        TailscaleIPs: ['100.100.50.99'],
                        Online: true,
                    },
                },
            })));

            const result = await svc.detect(makeDevice());
            expect(result.tailnetIp).toBe('100.100.50.5');
            expect(result.ipSource).toBe('device');
            expect(result.onDevice).toBe(true);
            expect(result.onClient).toBe(true);
        });

        it('falls back to client peer match (ipSource: client) when device side has no IP', async () => {
            // Device: installed but no tailnet IP
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('yes', true))
                .mockResolvedValueOnce(makeSSHResult('', false));
            // Client: up with peer matching by hostname
            mockSpawn.mockReturnValueOnce(makeSpawnProcess(0, JSON.stringify({
                Self: { TailscaleIPs: ['100.99.0.1'] },
                Peer: {
                    key: {
                        HostName: 'dgx-spark-test',
                        DNSName: 'dgx-spark-test.ts.net.',
                        OS: 'linux',
                        TailscaleIPs: ['100.100.50.99'],
                        Online: true,
                    },
                },
            })));

            const result = await svc.detect(makeDevice());
            expect(result.tailnetIp).toBe('100.100.50.99');
            expect(result.ipSource).toBe('client');
            expect(result.onClient).toBe(true);
        });

        it('returns onClient:false when client Tailscale is not running', async () => {
            mockExecuteSSHCommand
                .mockResolvedValueOnce(makeSSHResult('no', true));
            // All spawn calls fail (no tailscale on client) — use mockImplementation
            // so all candidate binary attempts return a failed process
            mockSpawn.mockImplementation(() => makeSpawnProcess(1, ''));

            const result = await svc.detect(makeDevice());
            expect(result.onClient).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // buildMetadata
    // -----------------------------------------------------------------------

    describe('buildMetadata', () => {
        const baseResult: TailscaleDetectionResult = {
            onDevice: true,
            onClient: false,
            tailnetIp: '100.100.50.5',
            ipSource: 'device',
        };

        it('sets detectedOn:device when only device detected', () => {
            const meta = svc.buildMetadata('enabled', { ...baseResult, onDevice: true, onClient: false }, true);
            expect(meta.detectedOn).toBe('device');
        });

        it('sets detectedOn:client when only client detected', () => {
            const meta = svc.buildMetadata('undecided', { ...baseResult, onDevice: false, onClient: true }, false);
            expect(meta.detectedOn).toBe('client');
        });

        it('sets detectedOn:both when both sides detected', () => {
            const meta = svc.buildMetadata('enabled', { ...baseResult, onDevice: true, onClient: true }, true);
            expect(meta.detectedOn).toBe('both');
        });

        it('sets detectedOn:undefined when neither detected', () => {
            const meta = svc.buildMetadata('undecided', { onDevice: false, onClient: false }, false);
            expect(meta.detectedOn).toBeUndefined();
        });

        it('propagates tailnetIp', () => {
            const meta = svc.buildMetadata('enabled', baseResult, true);
            expect(meta.tailnetIp).toBe('100.100.50.5');
        });

        it('sets promptShown correctly', () => {
            expect(svc.buildMetadata('enabled', baseResult, true).promptShown).toBe(true);
            expect(svc.buildMetadata('undecided', baseResult, false).promptShown).toBe(false);
        });

        it('sets decision correctly', () => {
            expect(svc.buildMetadata('enabled', baseResult, true).decision).toBe('enabled');
            expect(svc.buildMetadata('disabled', baseResult, true).decision).toBe('disabled');
        });

        it('includes lastDetectedAt and decisionChangedAt as ISO 8601', () => {
            const meta = svc.buildMetadata('enabled', baseResult, true);
            expect(meta.lastDetectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(meta.decisionChangedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('includes previousHost when provided', () => {
            const meta = svc.buildMetadata('enabled', baseResult, true, '192.168.1.50');
            expect(meta.previousHost).toBe('192.168.1.50');
        });

        it('omits previousHost when not provided', () => {
            const meta = svc.buildMetadata('enabled', baseResult, true);
            expect(meta.previousHost).toBeUndefined();
        });
    });
});

// ---------------------------------------------------------------------------
// pollManagedDeviceStatus
// ---------------------------------------------------------------------------

describe('pollManagedDeviceStatus', () => {
    const managedDevice: Device = {
        id: 'dev-001',
        name: 'spark1',
        host: '100.100.50.10',
        username: 'nvidia',
        port: 22,
        isSetup: true,
        useKeyAuth: true,
        keySetup: { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt: new Date().toISOString(),
        metadata: {
            tailscale: {
                decision: 'enabled',
                promptShown: true,
                tailnetIp: '100.100.50.10',
            },
        },
    } as any;

    let detectSpy: jest.SpyInstance;
    let mockDeviceSvc: any;
    let mockApiSvc: any;

    beforeEach(() => {
        detectSpy = jest.spyOn(tailscaleService, 'detectOnClient');
        mockDeviceSvc = {
            getAllDevices:  jest.fn().mockResolvedValue([managedDevice]),
            updateDevice:  jest.fn().mockResolvedValue(undefined),
        };
        mockApiSvc = {
            isConfigured: jest.fn().mockResolvedValue(false),
            listDevices:  jest.fn().mockResolvedValue([]),
        };
        // Make getConfiguration return real-looking defaults
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, def?: any) => def),
        });
    });

    afterEach(() => {
        detectSpy.mockRestore();
    });

    it('skips poll when tailscale.enabled is false', async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockReturnValue(false),
        });
        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);
        expect(mockDeviceSvc.getAllDevices).not.toHaveBeenCalled();
    });

    it('skips poll when no managed devices exist', async () => {
        mockDeviceSvc.getAllDevices.mockResolvedValue([]);
        detectSpy.mockResolvedValue({ up: true, peers: [] });
        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);
        expect(mockDeviceSvc.updateDevice).not.toHaveBeenCalled();
    });

    it('CLI path: updates device status with source:cli when client is up', async () => {
        detectSpy.mockResolvedValue({
            up: true,
            selfIp: '100.99.0.1',
            peers: [{
                hostName: 'spark1',
                dnsName: 'spark1.ts.net',
                os: 'linux',
                tailnetIp: '100.100.50.10',
                online: true,
            }],
        });

        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);

        expect(mockDeviceSvc.updateDevice).toHaveBeenCalledTimes(1);
        const [, updates] = mockDeviceSvc.updateDevice.mock.calls[0];
        expect(updates.metadata.tailscale.status.source).toBe('cli');
        expect(updates.metadata.tailscale.status.online).toBe(true);
        expect(updates.metadata.tailscale.status.polledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('CLI path: propagates lastSeen for offline peer', async () => {
        detectSpy.mockResolvedValue({
            up: true,
            selfIp: '100.99.0.1',
            peers: [{
                hostName: 'spark1',
                dnsName: 'spark1.ts.net',
                os: 'linux',
                tailnetIp: '100.100.50.10',
                online: false,
                lastSeen: '2026-06-28T08:00:00Z',
            }],
        });

        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);

        const [, updates] = mockDeviceSvc.updateDevice.mock.calls[0];
        expect(updates.metadata.tailscale.status.online).toBe(false);
        expect(updates.metadata.tailscale.status.lastSeen).toBe('2026-06-28T08:00:00Z');
    });

    it('CLI path: skips device when no matching peer found', async () => {
        detectSpy.mockResolvedValue({
            up: true,
            selfIp: '100.99.0.1',
            peers: [{ hostName: 'other', dnsName: 'other.ts.net', os: 'linux', tailnetIp: '100.100.99.99', online: true }],
        });

        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);
        expect(mockDeviceSvc.updateDevice).not.toHaveBeenCalled();
    });

    it('API fallback: updates device when client not on tailnet and API is configured', async () => {
        detectSpy.mockResolvedValue({ up: false, peers: [] });
        mockApiSvc.isConfigured.mockResolvedValue(true);
        mockApiSvc.listDevices.mockResolvedValue([{
            nodeId: 'node1',
            hostname: 'spark1',
            tailnetIp: '100.100.50.10',
            online: false,
            lastSeen: '2026-06-28T07:00:00Z',
        }]);

        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);

        expect(mockDeviceSvc.updateDevice).toHaveBeenCalledTimes(1);
        const [, updates] = mockDeviceSvc.updateDevice.mock.calls[0];
        expect(updates.metadata.tailscale.status.source).toBe('api');
        expect(updates.metadata.tailscale.status.online).toBe(false);
        expect(updates.metadata.tailscale.status.lastSeen).toBe('2026-06-28T07:00:00Z');
    });

    it('API fallback: skips when client not on tailnet and API not configured', async () => {
        detectSpy.mockResolvedValue(undefined);
        mockApiSvc.isConfigured.mockResolvedValue(false);

        await pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc);
        expect(mockDeviceSvc.updateDevice).not.toHaveBeenCalled();
    });

    it('API fallback: logs warning and skips on API error', async () => {
        detectSpy.mockResolvedValue(undefined);
        mockApiSvc.isConfigured.mockResolvedValue(true);
        mockApiSvc.listDevices.mockRejectedValue(new Error('Network error'));

        await expect(pollManagedDeviceStatus(mockDeviceSvc, mockApiSvc)).resolves.toBeUndefined();
        expect(mockDeviceSvc.updateDevice).not.toHaveBeenCalled();
    });
});
