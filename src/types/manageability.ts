/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * TypeScript interfaces for the ZGX Device Collector (`zgx-collector` CLI).
 * The collector is installed at /usr/local/bin/zgx-collector on each managed device
 * and wraps nvidia-smi, lscpu, /sys/class/dmi/id, dpkg-query, and apt to produce
 * structured JSON envelopes. Field names match the actual collector output.
 */

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

export interface ManageabilityEnvelope<T> {
    tool: string;
    timestamp: string;
    status: 'ok' | 'error' | 'partial';
    data: T;
    /** On-device path to the generated artifact (e.g. diagnostic bundle). */
    evidence_path?: string;
}

// ---------------------------------------------------------------------------
// Collector data shapes
// ---------------------------------------------------------------------------

export interface DeviceIdentity {
    hostname: string;
    product_name: string;
    manufacturer: string;
    board_name: string;
    bios_version: string;
    bios_date: string;
}

export interface OSBuildIdentity {
    os_name: string;
    os_version: string;
    os_pretty: string;
    kernel: string;
    kernel_build: string;
    architecture: string;
}

export interface CpuInfo {
    architecture: string;
    model_names: string[];
    cores: number;
    threads_per_core: number;
}

/** Unified GPU info shape returned by both hardware-config and health subcommands. */
export interface GpuInfo {
    index: number;
    name: string;
    vendor: 'nvidia' | 'amd';
    temp_c: number | null;
    power_w: number | null;
    memory_total_mb: number | null;
    memory_used_mb: number | null;
    /** True for AMD APUs / Strix Halo where GPU and system RAM are the same pool. */
    unified_memory: boolean;
}

export interface NicInfo {
    name: string;
    mac: string;
}

export interface HardwareConfig {
    cpu: CpuInfo;
    /** Detected GPU vendor across all GPUs in this system. */
    gpu_vendor: 'nvidia' | 'amd' | 'none';
    gpus: GpuInfo[];
    total_memory_bytes: number;
    storage: object;
    nics: NicInfo[];
}

export interface FirmwareReport {
    bios_version: string;
    bios_date: string;
    gpu_vbios_version: string;
    gpu_driver_version: string;
}

export interface DriverPackage {
    name: string;
    version: string;
}

export interface DriverInventory {
    gpu_driver_version: string;
    cuda_version: string;
    packages: DriverPackage[];
}

export interface SoftwarePackage {
    name: string;
    version: string;
}

export interface SoftwareInventory {
    packages: SoftwarePackage[];
}

// ---------------------------------------------------------------------------
// Diagnostics / Health
// ---------------------------------------------------------------------------

export interface HealthSignal {
    name: string;
    status: 'ok' | 'degraded' | 'critical';
    value: number;
    unit: string;
}

export interface DiagHealthResult {
    overall_status: 'healthy' | 'degraded' | 'critical' | 'unknown';
    gpu_vendor: 'nvidia' | 'amd' | 'none';
    signals: HealthSignal[];
    /** Same GpuInfo shape as hardware-config for consistent field access. */
    gpus: GpuInfo[];
}

// ---------------------------------------------------------------------------
// Update posture
// ---------------------------------------------------------------------------

export interface PendingUpdate {
    name: string;
    version: string;
    type: 'apt' | 'firmware' | 'hp_firmware' | 'hp_driver';
    /** Set to 'hp_flash_tool' when entry comes from hpflash/hp-flash binary detection. */
    source?: string;
}

export interface UpdatePosture {
    status: string;
    pending_updates: PendingUpdate[];
    hp_count?: number;
    apt_count?: number;
    firmware_count?: number;
    /** True when the HP Software Delivery Repository is configured in apt sources. */
    hp_repo_present?: boolean;
}

// ---------------------------------------------------------------------------
// Aggregated snapshot (cached in Device.metadata.manageabilitySnapshot)
// ---------------------------------------------------------------------------

export interface ManageabilitySnapshot {
    collectedAt: string;
    identity?: ManageabilityEnvelope<DeviceIdentity>;
    osBuild?: ManageabilityEnvelope<OSBuildIdentity>;
    hardware?: ManageabilityEnvelope<HardwareConfig>;
    firmware?: ManageabilityEnvelope<FirmwareReport>;
    drivers?: ManageabilityEnvelope<DriverInventory>;
    software?: ManageabilityEnvelope<SoftwareInventory>;
    health?: ManageabilityEnvelope<DiagHealthResult>;
}

// ---------------------------------------------------------------------------
// Command registry (zgx-collector subcommands installed on managed devices)
// ---------------------------------------------------------------------------

export const DGX_TOOL_COMMANDS = {
    device_identity:             'zgx-collector device-identity',
    os_build_identity:           'zgx-collector os-build',
    hardware_config:             'zgx-collector hardware-config',
    firmware_reporter:           'zgx-collector firmware',
    driver_inventory_reporter:   'zgx-collector drivers',
    software_inventory_reporter: 'zgx-collector software',
    spark_diagctl:               'zgx-collector health',
    reset_reason_reporter:       'zgx-collector health',
    spark_updatectl:             'zgx-collector updates',
} as const;

export type DGXToolKey = keyof typeof DGX_TOOL_COMMANDS;
