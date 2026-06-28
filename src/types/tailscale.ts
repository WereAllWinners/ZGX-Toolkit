/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Tailscale integration types for the ZGX Toolkit extension.
 */

/**
 * Per-device Tailscale state, stored under Device.metadata.tailscale.
 *
 * Phase 1: connectivity + the user's opt-in decision. Phase 2 will add
 * API-sourced status fields.
 */
export interface TailscaleDeviceMetadata {
    /**
     * The user's decision for this device:
     *  - 'enabled'  : route SSH over the tailnet IP
     *  - 'disabled' : do not use Tailscale for this device
     *  - 'undecided': detected but no choice made yet (prompt not yet answered)
     */
    decision: 'enabled' | 'disabled' | 'undecided';
    /** Whether the one-time prompt has been shown for this device. */
    promptShown: boolean;
    /** The device's tailnet IPv4 (100.x.y.z), if detected. */
    tailnetIp?: string;
    /** Where Tailscale was detected: 'device', 'client', or 'both'. */
    detectedOn?: 'device' | 'client' | 'both';
    /** ISO 8601 timestamp of the last detection run for this device. */
    lastDetectedAt?: string;
    /** ISO 8601 timestamp when the decision was last changed. */
    decisionChangedAt?: string;
    /** The device's previous host before Tailscale was enabled (used for revert on disable). */
    previousHost?: string;
}

/**
 * Result of a single Tailscale detection pass for a device.
 */
export interface TailscaleDetectionResult {
    /** True if Tailscale was found on the device (over SSH). */
    onDevice: boolean;
    /** True if Tailscale was found on the client (local machine). */
    onClient: boolean;
    /** The device's tailnet IPv4, if it could be determined. */
    tailnetIp?: string;
    /** How the IP was determined: 'device' (direct) or 'client' (peer match). */
    ipSource?: 'device' | 'client';
}

/**
 * A peer entry parsed from `tailscale status --json`.
 */
export interface TailscalePeer {
    hostName: string;
    dnsName: string;      // FQDN, trailing dot stripped
    os: string;
    tailnetIp: string;    // first IPv4 from TailscaleIPs
    online: boolean;
}
