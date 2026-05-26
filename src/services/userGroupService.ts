/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as crypto from 'node:crypto';
import { UserGroup, CreateUserGroupParams, UpdateUserGroupParams } from '../types/userGroup';
import { UserGroupStore, userGroupStore } from '../store/userGroupStore';
import { logger } from '../utils/logger';

export class UserGroupService {
    constructor(private store: UserGroupStore = userGroupStore) {}

    public createGroup(params: CreateUserGroupParams): UserGroup {
        if (!params.name || !params.name.trim()) {
            throw new Error('Group name is required');
        }
        const now = new Date().toISOString();
        const group: UserGroup = {
            id: this.generateId(),
            name: params.name.trim(),
            description: params.description?.trim() || undefined,
            deviceIds: params.deviceIds ?? [],
            policy: params.policy,
            createdAt: now,
            updatedAt: now,
        };
        this.store.set(group.id, group);
        logger.info('User group created', { id: group.id, name: group.name });
        return group;
    }

    public updateGroup(id: string, updates: UpdateUserGroupParams): UserGroup {
        const group = this.store.get(id);
        if (!group) {
            throw new Error(`User group not found: ${id}`);
        }
        if (updates.name !== undefined && !updates.name.trim()) {
            throw new Error('Group name cannot be empty');
        }
        const patched: Partial<UserGroup> = {};
        if (updates.name !== undefined)        { patched.name = updates.name.trim(); }
        if (updates.description !== undefined) { patched.description = updates.description.trim() || undefined; }
        if (updates.deviceIds !== undefined)   { patched.deviceIds = updates.deviceIds; }
        if (updates.policy !== undefined)      { patched.policy = updates.policy; }
        this.store.update(id, patched);
        logger.info('User group updated', { id });
        return this.store.get(id)!;
    }

    public deleteGroup(id: string): boolean {
        const result = this.store.delete(id);
        if (result) { logger.info('User group deleted', { id }); }
        return result;
    }

    public getGroup(id: string): UserGroup | undefined {
        return this.store.get(id);
    }

    public getAllGroups(): UserGroup[] {
        return this.store.getAll();
    }

    public getGroupsForDevice(deviceId: string): UserGroup[] {
        return this.store.findByDevice(deviceId);
    }

    public subscribe(listener: (groups: UserGroup[]) => void): () => void {
        return this.store.subscribe(listener);
    }

    private generateId(): string {
        const randomBytes = crypto.randomBytes(6).toString('hex');
        return `ugroup-${Date.now()}-${randomBytes}`;
    }
}

export const userGroupService = new UserGroupService();
