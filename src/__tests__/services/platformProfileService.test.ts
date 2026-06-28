/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tests for PlatformProfileService.
 * Validates collector invocation, snake_case→camelCase mapping, helper methods,
 * and metadata persistence.
 */

import { PlatformProfileService } from '../../services/platformProfileService';
import { Device } from '../../types/devices';
import { ManageabilityEnvelope } from '../../types/manageability';
import { PlatformProfileData } from '../../types/platformProfile';

// Mock manageabilityService (used by detect())
jest.mock('../../services/manageabilityService', () => ({
    manageabilityService: {
        runTool: jest.fn(),
    },
}));

// Mock deviceService (used by persist())
jest.mock('../../services/deviceService', () => ({
    deviceService: {
        updateDevice: jest.fn().mockResolvedValue(undefined),
    },
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info:  jest.fn(),
        warn:  jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

import { manageabilityService } from '../../services/manageabilityService';
import { deviceService } from '../../services/deviceService';

const mockRunTool    = manageabilityService.runTool as jest.MockedFunction<typeof manageabilityService.runTool>;
const mockUpdateDevice = deviceService.updateDevice as jest.MockedFunction<typeof deviceService.updateDevice>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
    return {
        id:          'dev-001',
        name:        'ZGX Test',
        host:        '192.168.1.50',
        username:    'nvidia',
        port:        22,
        isSetup:     true,
        useKeyAuth:  true,
        keySetup:    { keyGenerated: true, keyCopied: true, connectionTested: true },
        createdAt:   new Date().toISOString(),
        ...overrides,
    } as Device;
}

function makePlatformData(overrides: Partial<PlatformProfileData> = {}): PlatformProfileData {
    return {
        manufacturer:                      'HP',
        product_name:                      'HP ZGX Nano G1n AI Station',
        is_hp_device:                      true,
        arch:                              'arm64',
        cpu_vendor:                        'nvidia-grace',
        cpu_model:                         'NVIDIA Grace',
        cpu_cores_logical:                 20,
        os_id:                             'ubuntu',
        os_id_like:                        'debian',
        os_family:                         'debian',
        os_version_id:                     '24.04',
        os_pretty_name:                    'Ubuntu 24.04.2 LTS',
        is_dgx_os:                         true,
        dgx_release:                       '7.1',
        package_manager:                   'apt',
        kernel_release:                    '6.17.0-1018-nvidia',
        kernel_flavor:                     'nvidia',
        gpu_vendor:                        'nvidia',
        gpu_compute_stack:                 'cuda',
        gpu_compute_stack_version:         '12.4',
        gpu_memory_model:                  'unified',
        gpu_driver_branch:                 '580',
        held_packages:                     ['linux-image-6.17.0-1018-nvidia', 'linux-headers-6.17.0-1018-nvidia'],
        held_kernel_packages:              ['linux-image-6.17.0-1018-nvidia', 'linux-headers-6.17.0-1018-nvidia'],
        vendor_controller_spark_updatectl: false,
        ...overrides,
    };
}

function makeEnvelope<T>(tool: string, data: T): ManageabilityEnvelope<T> {
    return { tool, timestamp: '2026-06-28T10:00:00Z', status: 'ok', data };
}

function makeRunToolSuccess(data: PlatformProfileData) {
    return {
        success:  true,
        envelope: makeEnvelope('platform-profile', data),
        rawOutput: '',
    };
}

function makeRunToolFailure(error: string) {
    return { success: false, rawOutput: '', error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformProfileService', () => {
    let service: PlatformProfileService;
    let device: Device;

    beforeEach(() => {
        service = new PlatformProfileService();
        device  = makeDevice();
        jest.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // detect()
    // -------------------------------------------------------------------------

    describe('detect', () => {
        it('returns a mapped PlatformProfile with camelCase fields', async () => {
            mockRunTool.mockResolvedValueOnce(makeRunToolSuccess(makePlatformData()) as any);

            const profile = await service.detect(device);

            expect(profile.manufacturer).toBe('HP');
            expect(profile.productName).toBe('HP ZGX Nano G1n AI Station');
            expect(profile.isHpDevice).toBe(true);
            expect(profile.arch).toBe('arm64');
            expect(profile.cpu.vendor).toBe('nvidia-grace');
            expect(profile.cpu.coresLogical).toBe(20);
            expect(profile.os.id).toBe('ubuntu');
            expect(profile.os.family).toBe('debian');
            expect(profile.packageManager).toBe('apt');
            expect(profile.kernel.release).toBe('6.17.0-1018-nvidia');
            expect(profile.kernel.flavor).toBe('nvidia');
            expect(profile.gpu.vendor).toBe('nvidia');
            expect(profile.gpu.computeStack).toBe('cuda');
            expect(profile.gpu.memoryModel).toBe('unified');
            expect(profile.gpu.driverBranch).toBe('580');
            expect(profile.heldKernelPackages).toHaveLength(2);
            expect(profile.vendorController.sparkUpdatectl).toBe(false);
        });

        it('stamps detectedAt as a valid ISO 8601 string', async () => {
            mockRunTool.mockResolvedValueOnce(makeRunToolSuccess(makePlatformData()) as any);

            const before = new Date().toISOString();
            const profile = await service.detect(device);
            const after  = new Date().toISOString();

            expect(profile.detectedAt >= before).toBe(true);
            expect(profile.detectedAt <= after).toBe(true);
        });

        it('persists the profile under metadata.platformProfile without clobbering other metadata', async () => {
            const deviceWithMeta = makeDevice({ metadata: { existingKey: 'existingValue' } });
            mockRunTool.mockResolvedValueOnce(makeRunToolSuccess(makePlatformData()) as any);

            await service.detect(deviceWithMeta);

            expect(mockUpdateDevice).toHaveBeenCalledWith(
                deviceWithMeta.id,
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        existingKey: 'existingValue',
                        platformProfile: expect.objectContaining({ manufacturer: 'HP' }),
                    }),
                }),
            );
        });

        it('throws when runTool returns success: false', async () => {
            mockRunTool.mockResolvedValueOnce(makeRunToolFailure('SSH connection refused') as any);

            await expect(service.detect(device)).rejects.toThrow('SSH connection refused');
        });

        it('throws when runTool returns no envelope', async () => {
            mockRunTool.mockResolvedValueOnce({ success: false, rawOutput: '' } as any);

            await expect(service.detect(device)).rejects.toThrow();
        });

        it('invokes runTool with the platform_profile key', async () => {
            mockRunTool.mockResolvedValueOnce(makeRunToolSuccess(makePlatformData()) as any);

            await service.detect(device);

            expect(mockRunTool).toHaveBeenCalledWith(device, 'platform_profile');
        });
    });

    // -------------------------------------------------------------------------
    // getProfile()
    // -------------------------------------------------------------------------

    describe('getProfile', () => {
        it('returns the stored profile when metadata.platformProfile is present', () => {
            const data = makePlatformData();
            const profile = (service as any)._mapToProfile(data);
            const deviceWithProfile = makeDevice({ metadata: { platformProfile: profile } });

            expect(service.getProfile(deviceWithProfile)).toEqual(profile);
        });

        it('returns undefined when metadata.platformProfile is absent', () => {
            expect(service.getProfile(device)).toBeUndefined();
        });

        it('returns undefined when metadata is absent', () => {
            const d = makeDevice({ metadata: undefined });
            expect(service.getProfile(d)).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // Convenience helpers
    // -------------------------------------------------------------------------

    describe('convenience helpers — with profile', () => {
        let deviceWithProfile: Device;

        beforeEach(() => {
            const profile = (service as any)._mapToProfile(makePlatformData());
            deviceWithProfile = makeDevice({ metadata: { platformProfile: profile } });
        });

        it('isHpDevice returns true when manufacturer is HP', () => {
            expect(service.isHpDevice(deviceWithProfile)).toBe(true);
        });

        it('isDgxManaged returns true when isDgxOs is true', () => {
            expect(service.isDgxManaged(deviceWithProfile)).toBe(true);
        });

        it('isDgxManaged returns true when kernelFlavor is nvidia even if isDgxOs is false', () => {
            const data = makePlatformData({ is_dgx_os: false, kernel_flavor: 'nvidia' });
            const profile = (service as any)._mapToProfile(data);
            const d = makeDevice({ metadata: { platformProfile: profile } });
            expect(service.isDgxManaged(d)).toBe(true);
        });

        it('isDgxManaged returns false when isDgxOs is false and kernel is not nvidia', () => {
            const data = makePlatformData({ is_dgx_os: false, kernel_flavor: 'generic' });
            const profile = (service as any)._mapToProfile(data);
            const d = makeDevice({ metadata: { platformProfile: profile } });
            expect(service.isDgxManaged(d)).toBe(false);
        });

        it('isKernelHeld returns true when heldKernelPackages is non-empty', () => {
            expect(service.isKernelHeld(deviceWithProfile)).toBe(true);
        });

        it('isKernelHeld returns false when heldKernelPackages is empty', () => {
            const data = makePlatformData({ held_kernel_packages: [] });
            const profile = (service as any)._mapToProfile(data);
            const d = makeDevice({ metadata: { platformProfile: profile } });
            expect(service.isKernelHeld(d)).toBe(false);
        });

        it('getPackageManager returns apt', () => {
            expect(service.getPackageManager(deviceWithProfile)).toBe('apt');
        });

        it('getGpuVendor returns nvidia', () => {
            expect(service.getGpuVendor(deviceWithProfile)).toBe('nvidia');
        });

        it('getGpuMemoryModel returns unified', () => {
            expect(service.getGpuMemoryModel(deviceWithProfile)).toBe('unified');
        });

        it('getKernelFlavor returns nvidia', () => {
            expect(service.getKernelFlavor(deviceWithProfile)).toBe('nvidia');
        });
    });

    describe('convenience helpers — safe defaults without profile', () => {
        it('getPackageManager returns unknown', () => {
            expect(service.getPackageManager(device)).toBe('unknown');
        });

        it('getArch returns unknown', () => {
            expect(service.getArch(device)).toBe('unknown');
        });

        it('getCpuVendor returns unknown', () => {
            expect(service.getCpuVendor(device)).toBe('unknown');
        });

        it('getGpuVendor returns none', () => {
            expect(service.getGpuVendor(device)).toBe('none');
        });

        it('getGpuComputeStack returns none', () => {
            expect(service.getGpuComputeStack(device)).toBe('none');
        });

        it('getGpuMemoryModel returns none', () => {
            expect(service.getGpuMemoryModel(device)).toBe('none');
        });

        it('isHpDevice returns false', () => {
            expect(service.isHpDevice(device)).toBe(false);
        });

        it('isDgxManaged returns false', () => {
            expect(service.isDgxManaged(device)).toBe(false);
        });

        it('isKernelHeld returns false', () => {
            expect(service.isKernelHeld(device)).toBe(false);
        });

        it('hasVendorController returns false', () => {
            expect(service.hasVendorController(device)).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // getKernelApprovalSignals()
    // -------------------------------------------------------------------------

    describe('getKernelApprovalSignals', () => {
        it('returns the correct shape for a DGX HP device', () => {
            const profile = (service as any)._mapToProfile(makePlatformData());
            const d = makeDevice({ metadata: { platformProfile: profile } });

            const signals = service.getKernelApprovalSignals(d);

            expect(signals).toEqual({
                isDgxManaged: true,
                kernelFlavor: 'nvidia',
                kernelHeld:   true,
                dgxRelease:   '7.1',
                isHpDevice:   true,
            });
        });

        it('returns safe defaults when profile is absent', () => {
            const signals = service.getKernelApprovalSignals(device);

            expect(signals.isDgxManaged).toBe(false);
            expect(signals.kernelFlavor).toBe('');
            expect(signals.kernelHeld).toBe(false);
            expect(signals.dgxRelease).toBe('');
            expect(signals.isHpDevice).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // _mapToProfile — additional field coverage
    // -------------------------------------------------------------------------

    describe('_mapToProfile field coverage', () => {
        it('maps a generic AMD/dnf device correctly', () => {
            const data = makePlatformData({
                manufacturer:            'AMD',
                is_hp_device:            false,
                arch:                    'x86_64',
                cpu_vendor:              'amd',
                os_id:                   'fedora',
                os_id_like:              'rhel',
                os_family:               'rhel',
                package_manager:         'dnf',
                kernel_release:          '6.8.0-generic',
                kernel_flavor:           'generic',
                gpu_vendor:              'amd',
                gpu_compute_stack:       'rocm',
                gpu_memory_model:        'unified',
                is_dgx_os:               false,
                dgx_release:             '',
                held_packages:           [],
                held_kernel_packages:    [],
            });
            const profile = (service as any)._mapToProfile(data);

            expect(profile.isHpDevice).toBe(false);
            expect(profile.arch).toBe('x86_64');
            expect(profile.cpu.vendor).toBe('amd');
            expect(profile.os.family).toBe('rhel');
            expect(profile.packageManager).toBe('dnf');
            expect(profile.kernel.flavor).toBe('generic');
            expect(profile.gpu.vendor).toBe('amd');
            expect(profile.gpu.computeStack).toBe('rocm');
            expect(service.isDgxManaged({ metadata: { platformProfile: profile } } as any)).toBe(false);
        });

        it('maps a CPU-only Intel/apt device correctly', () => {
            const data = makePlatformData({
                cpu_vendor:          'intel',
                gpu_vendor:          'none',
                gpu_compute_stack:   'none',
                gpu_memory_model:    'none',
                gpu_driver_branch:   '',
                is_dgx_os:           false,
            });
            const profile = (service as any)._mapToProfile(data);

            expect(profile.gpu.vendor).toBe('none');
            expect(profile.gpu.computeStack).toBe('none');
            expect(profile.gpu.memoryModel).toBe('none');
        });
    });
});
