/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * User Group types for organizational device grouping.
 * Devices can belong to multiple user groups simultaneously.
 */

/** Ansible-driven policy applied to all devices in a group. */
export interface GroupPolicy {
    /** Packages pinned to a specific version, e.g. "cuda-toolkit=12.3.2-1" */
    pinnedPackages?: string[];
    /** Packages that must be installed on every device in the group */
    requiredPackages?: string[];
    /** Absolute path to a custom Ansible playbook (.yml) on the local machine */
    customPlaybookPath?: string;
}

export interface UserGroup {
    /** Unique identifier for the group */
    id: string;
    /** Display name for the group */
    name: string;
    /** Optional description */
    description?: string;
    /** Device IDs belonging to this group (may be empty) */
    deviceIds: string[];
    /** Ansible-driven group policy */
    policy?: GroupPolicy;
    /** Timestamp when group was created */
    createdAt: string;
    /** Timestamp when group was last updated */
    updatedAt: string;
}

export interface CreateUserGroupParams {
    name: string;
    description?: string;
    deviceIds?: string[];
    policy?: GroupPolicy;
}

export interface UpdateUserGroupParams {
    name?: string;
    description?: string;
    deviceIds?: string[];
    policy?: GroupPolicy;
}
