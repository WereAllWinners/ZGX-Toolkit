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

