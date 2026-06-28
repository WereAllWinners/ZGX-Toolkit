/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Detected platform/capability profile for a device. Stored under
 * Device.metadata.platformProfile. Read-only; gathered by
 * platform_profile_reporter.py / zgx-collector platform-profile.
 * Downstream features (updates, collector dispatch) branch on these facts
 * rather than hard-coding NVIDIA/DGX assumptions.
 */

export type Arch = 'arm64' | 'x86_64' | string;
export type CpuVendor = 'intel' | 'amd' | 'arm' | 'nvidia-grace' | 'unknown';
export type OsFamily = 'debian' | 'rhel' | 'suse' | 'unknown';
export type PackageManager = 'apt' | 'dnf' | 'zypper' | 'unknown';
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'none';
export type GpuComputeStack = 'cuda' | 'rocm' | 'oneapi' | 'none';
export type GpuMemoryModel = 'unified' | 'discrete' | 'integrated' | 'none';

export interface PlatformProfile {
    detectedAt: string;

    manufacturer: string;
    productName: string;
    isHpDevice: boolean;

    arch: Arch;
    cpu: {
        vendor: CpuVendor;
        model: string;
        coresLogical: number;
    };

    os: {
        id: string;
        idLike: string;
        versionId: string;
        prettyName: string;
        family: OsFamily;
    };

    isDgxOs: boolean;
    dgxRelease: string;

    packageManager: PackageManager;

    kernel: {
        release: string;
        flavor: string;
    };

    gpu: {
        vendor: GpuVendor;
        computeStack: GpuComputeStack;
        computeStackVersion: string;
        memoryModel: GpuMemoryModel;
        driverBranch: string;
    };

    heldPackages: string[];
    heldKernelPackages: string[];

    vendorController: {
        sparkUpdatectl: boolean;
    };
}

/**
 * Raw snake_case data shape emitted by the Python collector.
 * Used only inside PlatformProfileService._mapToProfile().
 */
export interface PlatformProfileData {
    manufacturer: string;
    product_name: string;
    is_hp_device: boolean;
    arch: string;
    cpu_vendor: string;
    cpu_model: string;
    cpu_cores_logical: number;
    os_id: string;
    os_id_like: string;
    os_family: string;
    os_version_id: string;
    os_pretty_name: string;
    is_dgx_os: boolean;
    dgx_release: string;
    package_manager: string;
    kernel_release: string;
    kernel_flavor: string;
    gpu_vendor: string;
    gpu_compute_stack: string;
    gpu_compute_stack_version: string;
    gpu_memory_model: string;
    gpu_driver_branch: string;
    held_packages: string[];
    held_kernel_packages: string[];
    vendor_controller_spark_updatectl: boolean;
}

export interface KernelApprovalSignals {
    isDgxManaged: boolean;
    kernelFlavor: string;
    kernelHeld: boolean;
    dgxRelease: string;
    isHpDevice: boolean;
}
