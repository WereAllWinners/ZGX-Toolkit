/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Types for scheduled checkups and the (later) approved-update workflow.
 * Tier 1 (this task) populates AvailableUpdate / CheckupResult only.
 */

/** Which read-only source produced the update list. */
export type UpdateSource = 'apt' | 'dnf' | 'zypper' | 'unavailable';

/** A single available update as reported by the read-only query. */
export interface AvailableUpdate {
    package: string;
    currentVersion: string;     // may be '' for dnf when not enriched
    availableVersion: string;
}

/** Result of one scheduled checkup pass for a device. */
export interface CheckupResult {
    /** ISO 8601 timestamp of the checkup. */
    checkedAt: string;
    /** The package manager that produced the list. */
    source: UpdateSource;
    /** All available updates, UNFILTERED. Ansible/kernel filtering is Task 02. */
    availableUpdates: AvailableUpdate[];
    /** Whether the checkup completed cleanly. */
    status: 'ok' | 'partial' | 'error';
    /** Optional human-readable note (e.g. query error summary). */
    note?: string;
}

// ---------------------------------------------------------------------------
// Task 02: Reconciliation gate types
// ---------------------------------------------------------------------------

/** Why a package was removed from the approvable candidate list. */
export type ExclusionReason = 'ansible-pinned' | 'kernel-held' | 'device-held';

/** An update that passed the gate and can be approved via the review panel. */
export interface UpdateCandidate {
    package: string;
    currentVersion: string;
    availableVersion: string;
    source: UpdateSource;
}

/** An update removed from the candidate list by a policy filter. */
export interface ExcludedUpdate {
    package: string;
    currentVersion: string;
    availableVersion: string;
    reason: ExclusionReason;
    /** For ansible-pinned: the pinned version. For held: the currently-installed version. */
    heldOrPinnedVersion: string;
}

/** Per-device pending update state stored in metadata.pendingUpdates after reconciliation. */
export interface PendingUpdatesState {
    /** ISO 8601 timestamp when reconciliation ran. */
    computedAt: string;
    source: UpdateSource;
    /** Updates that passed all filters and can be approved. */
    candidates: UpdateCandidate[];
    /** Updates excluded because the Ansible policy pins the package. */
    ansibleExclusions: ExcludedUpdate[];
    /** Updates excluded because the package is held on the device (kernel or apt-mark). */
    kernelExclusions: ExcludedUpdate[];
    status: 'available' | 'none' | 'applying' | 'applied' | 'error';
}

// ---------------------------------------------------------------------------
// Task 03: Apply plan and result types
// ---------------------------------------------------------------------------

/** Which subsystem will execute the scoped apply. */
export type ApplyProvider = 'apt' | 'dnf' | 'zypper' | 'spark_updatectl' | 'none';

/** A selected package dropped during TOCTOU re-validation. */
export interface SkippedUpdate {
    package: string;
    reason: 'now-pinned' | 'now-held' | 'no-longer-available';
}

/** Computed apply plan — TOCTOU-safe snapshot ready for user confirmation. */
export interface ApplyPlan {
    provider: ApplyProvider;
    /** Packages that passed re-validation and will be applied. */
    toApply: string[];
    /** Packages selected but dropped during re-validation. */
    skipped: SkippedUpdate[];
    /** Extra packages the PM would pull in as dependencies beyond toApply. */
    additionalChanges: string[];
    /** True when DGX-managed but spark_updatectl absent; apply falls back to native PM. */
    dgxControllerAbsent: boolean;
}

/** Result returned by executeApplyPlan. */
export interface ApplyResult {
    provider: ApplyProvider;
    applied: string[];
    skipped: SkippedUpdate[];
    success: boolean;
    /** Caller should prompt for sudo password and retry when true. */
    requiresPassword?: boolean;
    note?: string;
}

