/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tests for ManageabilityService.
 * Validates SSH tool execution, JSON envelope parsing, and inventory assembly.
 */

import { ManageabilityService } from '../../services/manageabilityService';
import { Device } from '../../types/devices';
import { ManageabilityEnvelope, DeviceIdentity, DiagHealthResult, UpdatePosture } from '../../types/manageability';

// Mock the SSH utility so no real network calls are made
jest.mock('../../utils/sshConnection', () => ({
    executeSSHCommand: jest.fn(),
    createSSHConnection: jest.fn(),
    executeCommandOnClient: jest.fn(),
}));

// Mock deviceService used by collectInventory to persist the snapshot
jest.mock('../../services/deviceService', () => ({
    deviceService: {
        updateDevice: jest.fn().mockResolvedValue(undefined),
        mergeDeviceMetadata: jest.fn().mockResolvedValue(undefined),
    },
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { executeSSHCommand, createSSHConnection, executeCommandOnClient } from '../../utils/sshConnection';
import { deviceService } from '../../services/deviceService';

const mockExecuteSSHCommand = executeSSHCommand as jest.MockedFunction<typeof executeSSHCommand>;
const mockCreateSSHConnection = createSSHConnection as jest.MockedFunction<typeof createSSHConnection>;
const mockExecuteCommandOnClient = executeCommandOnClient as jest.MockedFunction<typeof executeCommandOnClient>;
const mockMergeDeviceMetadata = deviceService.mergeDeviceMetadata as jest.MockedFunction<typeof deviceService.mergeDeviceMetadata>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
    return {
        id: 'dev-001',
        name: 'DGX Spark Test',
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

function makeEnvelope<T>(tool: string, data: T): ManageabilityEnvelope<T> {
    return {
        tool,
        timestamp: '2026-05-20T10:00:00Z',
        status: 'ok',
        data,
    };
}

function makeSSHSuccess(stdout: string) {
    return { success: true, exitCode: 0, stdout, stderr: '' };
}

function makeSSHFailure(stderr = 'Connection refused') {
    return { success: false, exitCode: 1, stdout: '', stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ManageabilityService', () => {
    let service: ManageabilityService;
    let device: Device;

    beforeEach(() => {
        service = new ManageabilityService();
        device = makeDevice();
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // runTool
    // -----------------------------------------------------------------------

    describe('runTool', () => {
        it('returns a parsed envelope on SSH success with valid JSON', async () => {
            const identityData: DeviceIdentity = {
                hostname:     'dgx-spark-01',
                product_name: 'HP ZGX Nano G1n AI Station',
                manufacturer: 'HP',
                board_name:   '8EA3',
                bios_version: '5.36_0ACUM026',
                bios_date:    '03/23/2026',
            };
            const envelope = makeEnvelope('device_identity', identityData);
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(JSON.stringify(envelope)));

            const result = await service.runTool<DeviceIdentity>(device, 'device_identity');

            expect(result.success).toBe(true);
            expect(result.envelope?.data.hostname).toBe('dgx-spark-01');
            expect(result.envelope?.tool).toBe('device_identity');
            expect(mockExecuteSSHCommand).toHaveBeenCalledWith(
                device,
                'PATH=/usr/local/bin:$HOME/.local/bin:$PATH zgx-collector device-identity',
                { readyTimeout: 5000 },
                expect.objectContaining({ operationName: 'manageability:device_identity', timeoutSeconds: 30 }),
            );
        });

        it('parses the superset envelope shape (F-10) without breaking status/data extraction', async () => {
            // Mirrors what resources/zgx-collector v1.3.0 / _envelope.py actually emit —
            // the canonical fields plus the tool/timestamp TS-compat aliases.
            const rawEnvelope = {
                tool_name: 'device_identity',
                tool_version: '1.3.0',
                timestamp_utc: '2026-07-13T00:00:00Z',
                device_id: { serial: '', uuid: '', hostname: 'dgx-spark-01' },
                status: 'ok',
                summary: 'device_identity collected successfully',
                data: {
                    hostname: 'dgx-spark-01',
                    product_name: 'HP ZGX Nano G1n AI Station',
                    manufacturer: 'HP',
                    board_name: '8EA3',
                    bios_version: '5.36_0ACUM026',
                    bios_date: '03/23/2026',
                },
                artifacts: [],
                errors: [],
                tool: 'device_identity',
                timestamp: '2026-07-13T00:00:00Z',
            };
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(JSON.stringify(rawEnvelope)));

            const result = await service.runTool<DeviceIdentity>(device, 'device_identity');

            expect(result.success).toBe(true);
            expect(result.envelope?.status).toBe('ok');
            expect(result.envelope?.data.hostname).toBe('dgx-spark-01');
            expect(result.envelope?.data.bios_version).toBe('5.36_0ACUM026');
        });

        it('returns failure with error when SSH command fails', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHFailure('Permission denied'));

            const result = await service.runTool<DeviceIdentity>(device, 'device_identity');

            expect(result.success).toBe(false);
            expect(result.envelope).toBeUndefined();
            expect(result.error).toContain('Permission denied');
        });

        it('returns failure with error when stdout is not valid JSON', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess('not-json-output'));

            const result = await service.runTool<DeviceIdentity>(device, 'device_identity');

            expect(result.success).toBe(false);
            expect(result.rawOutput).toBe('not-json-output');
            expect(result.error).toMatch(/JSON parse failed/);
        });

        it('passes extra args to the command string', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess('{}'));

            await service.runTool(device, 'spark_updatectl', { args: ['--verbose'] });

            expect(mockExecuteSSHCommand).toHaveBeenCalledWith(
                device,
                'PATH=/usr/local/bin:$HOME/.local/bin:$PATH zgx-collector updates --verbose',
                { readyTimeout: 5000 },
                expect.anything(),
            );
        });

        it('uses custom timeout when provided', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess('{}'));

            await service.runTool(device, 'spark_updatectl', { timeoutSeconds: 300 });

            expect(mockExecuteSSHCommand).toHaveBeenCalledWith(
                device,
                expect.any(String),
                { readyTimeout: 5000 },
                expect.objectContaining({ timeoutSeconds: 300 }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // collectInventory
    // -----------------------------------------------------------------------

    describe('collectInventory', () => {
        let mockClient: { end: jest.Mock };

        beforeEach(() => {
            mockClient = { end: jest.fn() };
            mockCreateSSHConnection.mockResolvedValue(mockClient as any);
        });

        it('assembles a snapshot from all 7 parallel tool results', async () => {
            // Return valid JSON for each tool call (7 calls)
            const stubEnvelope = (tool: string) => JSON.stringify(makeEnvelope(tool, { stub: true }));
            mockExecuteCommandOnClient
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('device_identity')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('os_build_identity')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('hardware_config')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('firmware_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('driver_inventory_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('software_inventory_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('spark_diagctl')));

            const snapshot = await service.collectInventory(device);

            expect(snapshot.collectedAt).toBeTruthy();
            expect(snapshot.identity).toBeDefined();
            expect(snapshot.osBuild).toBeDefined();
            expect(snapshot.hardware).toBeDefined();
            expect(snapshot.firmware).toBeDefined();
            expect(snapshot.drivers).toBeDefined();
            expect(snapshot.software).toBeDefined();
            expect(snapshot.health).toBeDefined();

            // Snapshot persisted to device store via the atomic metadata merge
            expect(mockMergeDeviceMetadata).toHaveBeenCalledWith(
                device.id,
                { manageabilitySnapshot: snapshot },
            );
        });

        it('tolerates partial failures — missing tools do not abort the others', async () => {
            // identity fails (SSH error), the rest succeed
            const stubEnvelope = (tool: string) => JSON.stringify(makeEnvelope(tool, {}));
            mockExecuteCommandOnClient
                .mockResolvedValueOnce(makeSSHFailure())                              // device_identity fails
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('os_build_identity')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('hardware_config')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('firmware_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('driver_inventory_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('software_inventory_reporter')))
                .mockResolvedValueOnce(makeSSHSuccess(stubEnvelope('spark_diagctl')));

            const snapshot = await service.collectInventory(device);

            expect(snapshot.identity).toBeUndefined();
            expect(snapshot.osBuild).toBeDefined();
            expect(snapshot.hardware).toBeDefined();
        });

        it('still returns a snapshot when all tools fail', async () => {
            mockExecuteCommandOnClient.mockResolvedValue(makeSSHFailure());

            const snapshot = await service.collectInventory(device);

            expect(snapshot).toBeDefined();
            expect(snapshot.identity).toBeUndefined();
            expect(snapshot.collectedAt).toBeTruthy();
        });

        // F-6: connection reuse — one connection for the whole collection,
        // not one per tool.

        it('opens exactly one SSH connection and runs all 7 tools on it', async () => {
            mockExecuteCommandOnClient.mockResolvedValue(makeSSHFailure());

            await service.collectInventory(device);

            expect(mockCreateSSHConnection).toHaveBeenCalledTimes(1);
            expect(mockExecuteCommandOnClient).toHaveBeenCalledTimes(7);
            expect(mockExecuteSSHCommand).not.toHaveBeenCalled();
        });

        it('closes the shared connection even when a tool call rejects', async () => {
            mockExecuteCommandOnClient
                .mockRejectedValueOnce(new Error('stream error'))
                .mockResolvedValue(makeSSHSuccess(JSON.stringify(makeEnvelope('x', {}))));

            const snapshot = await service.collectInventory(device);

            expect(snapshot).toBeDefined();
            expect(mockClient.end).toHaveBeenCalledTimes(1);
        });

        it('closes the shared connection exactly once on the happy path', async () => {
            mockExecuteCommandOnClient.mockResolvedValue(makeSSHSuccess(JSON.stringify(makeEnvelope('x', {}))));

            await service.collectInventory(device);

            expect(mockClient.end).toHaveBeenCalledTimes(1);
        });

        it('returns an empty-but-defined snapshot (no throw) when the connection itself fails', async () => {
            mockCreateSSHConnection.mockRejectedValue(new Error('ECONNREFUSED'));

            const snapshot = await service.collectInventory(device);

            expect(snapshot).toBeDefined();
            expect(snapshot.collectedAt).toBeTruthy();
            expect(snapshot.identity).toBeUndefined();
            expect(mockExecuteCommandOnClient).not.toHaveBeenCalled();
            expect(mockMergeDeviceMetadata).toHaveBeenCalledWith(device.id, { manageabilitySnapshot: snapshot });
        });
    });

    // -----------------------------------------------------------------------
    // getUpdatePosture
    // -----------------------------------------------------------------------

    describe('getUpdatePosture', () => {
        it('invokes zgx-collector updates and does not mutate device state', async () => {
            const data: UpdatePosture = { status: 'up_to_date', pending_updates: [] };
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess(JSON.stringify(makeEnvelope('updates', data))),
            );

            const result = await service.getUpdatePosture(device);

            expect(result.success).toBe(true);
            expect(mockExecuteSSHCommand).toHaveBeenCalledWith(
                device,
                'PATH=/usr/local/bin:$HOME/.local/bin:$PATH zgx-collector updates',
                { readyTimeout: 5000 },
                expect.anything(),
            );
            // Must NOT call updateDevice/mergeDeviceMetadata — read-only posture check
            expect(mockMergeDeviceMetadata).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // applyUpdates — uses 300s timeout
    // -----------------------------------------------------------------------

    describe('applyUpdates', () => {
        it('tries full-upgrade first and returns success', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess('Reading package lists...\nCalculating upgrade...\n0 upgraded, 0 newly installed.'),
            );
            // fwupdmgr step
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess('No updatable devices found.'));

            const result = await service.applyUpdates(device);

            expect(result.success).toBe(true);
            expect(mockExecuteSSHCommand).toHaveBeenNthCalledWith(
                1,
                device,
                `sudo -n apt-get full-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1`,
                { readyTimeout: 5000 },
                expect.objectContaining({ timeoutSeconds: 300 }),
            );
        });

        it('falls back to upgrade when full-upgrade is denied by sudoers (no password)', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHFailure('sudo: sorry, you are not allowed to run this command'),
            );
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess('0 upgraded, 0 newly installed.'),
            );
            // fwupdmgr step
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(''));

            const result = await service.applyUpdates(device);

            expect(result.success).toBe(true);
            expect(mockExecuteSSHCommand).toHaveBeenCalledTimes(3);
            expect(mockExecuteSSHCommand).toHaveBeenNthCalledWith(
                2,
                device,
                `sudo -n apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1`,
                { readyTimeout: 5000 },
                expect.objectContaining({ timeoutSeconds: 300 }),
            );
        });

        it('falls back to upgrade when full-upgrade is denied even with a password supplied', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHFailure('sudo: sorry, you are not allowed to run this command'),
            );
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess('0 upgraded, 0 newly installed.'),
            );
            // fwupdmgr step
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(''));

            const result = await service.applyUpdates(device, 'correctpassword');

            expect(result.success).toBe(true);
            expect(mockExecuteSSHCommand).toHaveBeenCalledTimes(3);
        });

        it('returns requiresPassword when both apt commands are denied without a password', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHFailure('sudo: sorry, you are not allowed to run this command'),
            );
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHFailure('sudo: sorry, you are not allowed to run this command'),
            );

            const result = await service.applyUpdates(device);

            expect(result.success).toBe(false);
            expect(result.requiresPassword).toBe(true);
        });

        it('returns requiresPassword:true when sudo needs a password', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess('sudo: a password is required'),
            );

            const result = await service.applyUpdates(device);

            expect(result.success).toBe(false);
            expect(result.requiresPassword).toBe(true);
        });

        it('returns failure when SSH command fails', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHFailure('connection refused'),
            );

            const result = await service.applyUpdates(device);

            expect(result.success).toBe(false);
            expect(result.error).toBeTruthy();
        });

        it('passes sendSudoPassword:true when a password is supplied (F-2)', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess('0 upgraded.'));
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(''));

            await service.applyUpdates(device, 'correctpassword');

            expect(mockExecuteSSHCommand).toHaveBeenNthCalledWith(
                1,
                device,
                expect.stringContaining('sudo -S'),
                { readyTimeout: 5000 },
                expect.objectContaining({ sudoPassword: 'correctpassword', sendSudoPassword: true }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // installCollector — F-2 regression: the system-install path is piped
    // through base64/tee and never starts with the literal text 'sudo -S', so
    // it must receive sendSudoPassword explicitly rather than relying on
    // executeCommandOnClient to infer it from the command string.
    // -----------------------------------------------------------------------

    describe('installCollector', () => {
        it('passes sendSudoPassword:true on the system-install call when a password is supplied', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(''));

            await service.installCollector(device, 'correctpassword');

            expect(mockExecuteSSHCommand).toHaveBeenNthCalledWith(
                1,
                device,
                expect.any(String),
                expect.anything(),
                expect.objectContaining({
                    operationName: 'manageability:installCollector:system',
                    sudoPassword: 'correctpassword',
                    sendSudoPassword: true,
                }),
            );
        });

        it('does not pass sudoPassword/sendSudoPassword when no password is supplied', async () => {
            mockExecuteSSHCommand.mockResolvedValueOnce(makeSSHSuccess(''));

            await service.installCollector(device);

            const [, , , execOpts] = mockExecuteSSHCommand.mock.calls[0];
            expect(execOpts).not.toHaveProperty('sudoPassword');
            expect(execOpts).not.toHaveProperty('sendSudoPassword');
        });
    });

    // -----------------------------------------------------------------------
    // getHealthPosture
    // -----------------------------------------------------------------------

    describe('getHealthPosture', () => {
        it('returns parsed health result', async () => {
            const healthData: DiagHealthResult = {
                overall_status: 'healthy',
                gpu_vendor: 'nvidia',
                signals: [{ name: 'gpu_temp', status: 'ok', value: 33, unit: 'C' }],
                gpus: [],
            };
            mockExecuteSSHCommand.mockResolvedValueOnce(
                makeSSHSuccess(JSON.stringify(makeEnvelope('health', healthData))),
            );

            const result = await service.getHealthPosture(device);

            expect(result.success).toBe(true);
            expect(result.envelope?.data.overall_status).toBe('healthy');
        });
    });
});
