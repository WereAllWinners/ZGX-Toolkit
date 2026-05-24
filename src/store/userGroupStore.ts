/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import { UserGroup } from '../types/userGroup';
import { IStore, StoreListener, Unsubscribe } from '../types/store';
import { logger } from '../utils/logger';

export class UserGroupStore implements IStore<UserGroup[]> {
    private readonly groups = new Map<string, UserGroup>();
    private readonly listeners = new Set<StoreListener<UserGroup[]>>();

    public get(id: string): UserGroup | undefined {
        return this.groups.get(id);
    }

    public getAll(): UserGroup[] {
        return Array.from(this.groups.values());
    }

    public getState(): UserGroup[] {
        return this.getAll();
    }

    public set(id: string, group: UserGroup): void {
        const isUpdate = this.groups.has(id);
        this.groups.set(id, group);
        logger.debug(`UserGroup ${isUpdate ? 'updated' : 'added'} in store`, { id });
        this.notify();
    }

    public update(id: string, updates: Partial<UserGroup>): boolean {
        const group = this.groups.get(id);
        if (!group) {
            logger.warn('Attempted to update non-existent user group', { id });
            return false;
        }
        this.groups.set(id, { ...group, ...updates, updatedAt: new Date().toISOString() });
        logger.debug('UserGroup updated in store', { id });
        this.notify();
        return true;
    }

    public delete(id: string): boolean {
        const existed = this.groups.delete(id);
        if (existed) {
            logger.debug('UserGroup deleted from store', { id });
            this.notify();
        } else {
            logger.warn('Attempted to delete non-existent user group', { id });
        }
        return existed;
    }

    public has(id: string): boolean {
        return this.groups.has(id);
    }

    public subscribe(listener: StoreListener<UserGroup[]>): Unsubscribe {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    public clear(): void {
        this.groups.clear();
        this.notify();
    }

    public count(): number {
        return this.groups.size;
    }

    /** Returns all groups that contain the given device. */
    public findByDevice(deviceId: string): UserGroup[] {
        return this.getAll().filter(g => g.deviceIds.includes(deviceId));
    }

    public setMany(groups: UserGroup[]): void {
        for (const group of groups) {
            this.groups.set(group.id, group);
        }
        logger.debug('Bulk user groups added to store', { count: groups.length });
        this.notify();
    }

    private notify(): void {
        const groups = this.getAll();
        for (const listener of this.listeners) {
            try { listener(groups); } catch (error) {
                logger.error('Error in user group store listener', { error });
            }
        }
    }
}

export const userGroupStore = new UserGroupStore();
