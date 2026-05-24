/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * User Group types for organizational device grouping.
 * Devices can belong to multiple user groups simultaneously.
 */

export interface UserGroup {
    /** Unique identifier for the group */
    id: string;
    /** Display name for the group */
    name: string;
    /** Optional description */
    description?: string;
    /** Device IDs belonging to this group (may be empty) */
    deviceIds: string[];
    /** Timestamp when group was created */
    createdAt: string;
    /** Timestamp when group was last updated */
    updatedAt: string;
}

export interface CreateUserGroupParams {
    name: string;
    description?: string;
    deviceIds?: string[];
}

export interface UpdateUserGroupParams {
    name?: string;
    description?: string;
    deviceIds?: string[];
}
