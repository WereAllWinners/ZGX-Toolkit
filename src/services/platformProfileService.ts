/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Platform profile service — detects what a device *is* and stores the result
 * under Device.metadata.platformProfile. Downstream features (updates, collector
 * dispatch) branch on the profile instead of hard-coding NVIDIA/DGX assumptions.
 *
 * Detection is read-only: it runs zgx-collector platform-profile over SSH and
 * persists the result. No device state is changed.
 */

import { Device } from '../types/devices';
import { logger } from '../utils/logger';
import {
    Arch,
    CpuVendor,
    GpuComputeStack,
    GpuMemoryModel,
    GpuVendor,
    KernelApprovalSignals,
    PackageManager,
    PlatformProfile,
    PlatformProfileData,
} from '../types/platformProfile';
import { manageabilityService } from './manageabilityService';
import { deviceService } from './deviceService';

export class PlatformProfileService {

    // -------------------------------------------------------------------------
    // Core API
    // -------------------------------------------------------------------------

    async detect(device: Device): Promise<PlatformProfile> {
        logger.debug('Detecting platform profile', { device: device.name });

        const result = await manageabilityService.runTool<PlatformProfileData>(
            device,
            'platform_profile',
        );

        if (!result.success || !result.envelope) {
            const msg = result.error ?? 'Platform profile collector returned no data';
            logger.error('Platform profile detection failed', { device: device.name, error: msg });
            throw new Error(msg);
        }

        const profile = this._mapToProfile(result.envelope.data);
        await this.persist(device, profile);

        logger.info('Platform profile detected', {
            device: device.name,
            arch: profile.arch,
            gpuVendor: profile.gpu.vendor,
            packageManager: profile.packageManager,
        });

        return profile;
    }

    getProfile(device: Device): PlatformProfile | undefined {
        return device.metadata?.platformProfile as PlatformProfile | undefined;
    }

    async persist(device: Device, profile: PlatformProfile): Promise<void> {
        await deviceService.updateDevice(device.id, {
            metadata: { ...device.metadata, platformProfile: profile },
        });
    }

    // -------------------------------------------------------------------------
    // Convenience helpers — all return safe defaults when profile is absent
    // -------------------------------------------------------------------------

    getPackageManager(device: Device): PackageManager {
        return (this.getProfile(device)?.packageManager as PackageManager) ?? 'unknown';
    }

    getArch(device: Device): Arch {
        return this.getProfile(device)?.arch ?? 'unknown';
    }

    getCpuVendor(device: Device): CpuVendor {
        return (this.getProfile(device)?.cpu.vendor as CpuVendor) ?? 'unknown';
    }

    getGpuVendor(device: Device): GpuVendor {
        return (this.getProfile(device)?.gpu.vendor as GpuVendor) ?? 'none';
    }

    getGpuComputeStack(device: Device): GpuComputeStack {
        return (this.getProfile(device)?.gpu.computeStack as GpuComputeStack) ?? 'none';
    }

    getGpuMemoryModel(device: Device): GpuMemoryModel {
        return (this.getProfile(device)?.gpu.memoryModel as GpuMemoryModel) ?? 'none';
    }

    isHpDevice(device: Device): boolean {
        return this.getProfile(device)?.isHpDevice ?? false;
    }

    /** True when the device runs DGX OS or uses the NVIDIA-optimised kernel. */
    isDgxManaged(device: Device): boolean {
        const p = this.getProfile(device);
        if (!p) { return false; }
        return p.isDgxOs || p.kernel.flavor === 'nvidia';
    }

    getKernelFlavor(device: Device): string {
        return this.getProfile(device)?.kernel.flavor ?? '';
    }

    isKernelHeld(device: Device): boolean {
        return (this.getProfile(device)?.heldKernelPackages.length ?? 0) > 0;
    }

    hasVendorController(device: Device): boolean {
        return this.getProfile(device)?.vendorController.sparkUpdatectl ?? false;
    }

    // -------------------------------------------------------------------------
    // Kernel-approval signals stub
    //
    // Returns the inputs an approved-kernel policy will consume. The POLICY
    // itself (what to allow) is implemented in the revised update-gate task.
    // Sources, in priority order, will be:
    //   1. A user-configured approved-kernel list (parallel to Ansible pins)
    //   2. Derived-from-device defaults (this profile: kernelFlavor, held
    //      kernels, DGX release, NVIDIA metapackage) — works today, no external
    //      dependency
    //   3. (Future) an HP-published feed, if one ever exists — drop-in source
    // -------------------------------------------------------------------------

    getKernelApprovalSignals(device: Device): KernelApprovalSignals {
        return {
            isDgxManaged: this.isDgxManaged(device),
            kernelFlavor: this.getKernelFlavor(device),
            kernelHeld:   this.isKernelHeld(device),
            dgxRelease:   this.getProfile(device)?.dgxRelease ?? '',
            isHpDevice:   this.isHpDevice(device),
        };
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private _mapToProfile(raw: PlatformProfileData): PlatformProfile {
        return {
            detectedAt:   new Date().toISOString(),
            manufacturer: raw.manufacturer,
            productName:  raw.product_name,
            isHpDevice:   raw.is_hp_device,
            arch:         raw.arch as Arch,
            cpu: {
                vendor:       raw.cpu_vendor as CpuVendor,
                model:        raw.cpu_model,
                coresLogical: raw.cpu_cores_logical,
            },
            os: {
                id:          raw.os_id,
                idLike:      raw.os_id_like,
                versionId:   raw.os_version_id,
                prettyName:  raw.os_pretty_name,
                family:      raw.os_family as any,
            },
            isDgxOs:        raw.is_dgx_os,
            dgxRelease:     raw.dgx_release,
            packageManager: raw.package_manager as PackageManager,
            kernel: {
                release: raw.kernel_release,
                flavor:  raw.kernel_flavor,
            },
            gpu: {
                vendor:              raw.gpu_vendor as GpuVendor,
                computeStack:        raw.gpu_compute_stack as GpuComputeStack,
                computeStackVersion: raw.gpu_compute_stack_version,
                memoryModel:         raw.gpu_memory_model as GpuMemoryModel,
                driverBranch:        raw.gpu_driver_branch,
            },
            heldPackages:       raw.held_packages,
            heldKernelPackages: raw.held_kernel_packages,
            vendorController: {
                sparkUpdatectl: raw.vendor_controller_spark_updatectl,
            },
        };
    }
}

export const platformProfileService = new PlatformProfileService();
