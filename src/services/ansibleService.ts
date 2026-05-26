/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Device } from '../types/devices';
import { UserGroup, GroupPolicy } from '../types/userGroup';
import { logger } from '../utils/logger';

const execFile = promisify(cp.execFile);

export interface AnsibleRunResult {
    success: boolean;
    output: string;
    error?: string;
}

export class AnsibleService {
    private readonly sshKeyPath: string;

    constructor(sshKeyPath?: string) {
        this.sshKeyPath = sshKeyPath ?? path.join(os.homedir(), '.ssh', 'id_ed25519');
    }

    /** Returns true if ansible-playbook is present on PATH. */
    async isAvailable(): Promise<boolean> {
        try {
            await execFile('ansible-playbook', ['--version']);
            return true;
        } catch {
            return false;
        }
    }

    /** Run the group policy (required packages, pinned packages, custom playbook) against all devices. */
    async runPolicy(group: UserGroup, devices: Device[], policy: GroupPolicy): Promise<AnsibleRunResult> {
        const tmpDir = os.tmpdir();
        const tag = `zgx-${Date.now()}`;
        const inventoryPath = path.join(tmpDir, `${tag}-inventory`);
        const playbookPath  = path.join(tmpDir, `${tag}-playbook.yml`);

        try {
            fs.writeFileSync(inventoryPath, this.generateInventory(devices), 'utf-8');
            fs.writeFileSync(playbookPath,  this.generatePlaybook(group, policy), 'utf-8');

            const outputs: string[] = [];

            // Run generated playbook for required/pinned packages
            const hasTasks = (policy.requiredPackages?.length ?? 0) + (policy.pinnedPackages?.length ?? 0) > 0;
            if (hasTasks) {
                const r = await this.runPlaybook(inventoryPath, playbookPath);
                outputs.push(r.output);
                if (!r.success) {
                    return { success: false, output: outputs.join('\n'), error: r.error };
                }
            }

            // Run custom playbook if provided
            if (policy.customPlaybookPath) {
                if (!fs.existsSync(policy.customPlaybookPath)) {
                    return {
                        success: false,
                        output: outputs.join('\n'),
                        error: `Custom playbook not found: ${policy.customPlaybookPath}`,
                    };
                }
                const r = await this.runPlaybook(inventoryPath, policy.customPlaybookPath);
                outputs.push(r.output);
                if (!r.success) {
                    return { success: false, output: outputs.join('\n'), error: r.error };
                }
            }

            return { success: true, output: outputs.join('\n') };
        } finally {
            for (const f of [inventoryPath, playbookPath]) {
                try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
            }
        }
    }

    generateInventory(devices: Device[]): string {
        const lines: string[] = ['[zgx_devices]'];
        for (const d of devices) {
            lines.push(
                `${d.name} ansible_host=${d.host} ansible_user=${d.username} ansible_port=${d.port}` +
                ` ansible_ssh_private_key_file=${this.sshKeyPath}` +
                ` ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'`
            );
        }
        lines.push('', '[zgx_devices:vars]', 'ansible_become=yes', 'ansible_become_method=sudo', '');
        return lines.join('\n');
    }

    generatePlaybook(group: UserGroup, policy: GroupPolicy): string {
        const tasks: string[] = [];

        const required = policy.requiredPackages ?? [];
        if (required.length > 0) {
            tasks.push(
                `    - name: Ensure required packages are installed`,
                `      ansible.builtin.apt:`,
                `        name:`,
                ...required.map(p => `          - ${p}`),
                `        state: present`,
                `        update_cache: yes`,
                `        cache_valid_time: 3600`,
            );
        }

        const pinned = policy.pinnedPackages ?? [];
        if (pinned.length > 0) {
            tasks.push(
                `    - name: Install pinned package versions`,
                `      ansible.builtin.apt:`,
                `        name:`,
                ...pinned.map(p => `          - ${p}`),
                `        state: present`,
            );
        }

        if (tasks.length === 0) {
            tasks.push(
                `    - name: No-op (no tasks configured in policy)`,
                `      ansible.builtin.debug:`,
                `        msg: "Policy has no required or pinned packages — nothing to do."`,
            );
        }

        return [
            '---',
            `- name: "ZGX Toolkit group policy — ${group.name}"`,
            '  hosts: zgx_devices',
            '  gather_facts: no',
            '  tasks:',
            ...tasks,
            '',
        ].join('\n');
    }

    private async runPlaybook(inventoryPath: string, playbookPath: string): Promise<AnsibleRunResult> {
        logger.info('AnsibleService: running playbook', { playbookPath, inventoryPath });
        try {
            const { stdout, stderr } = await execFile(
                'ansible-playbook',
                ['-i', inventoryPath, playbookPath],
                { timeout: 300_000 },
            );
            const output = [stdout, stderr].filter(Boolean).join('\n');
            return { success: true, output };
        } catch (err: any) {
            const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
            logger.error('AnsibleService: ansible-playbook failed', { error: err.message });
            return { success: false, output, error: err.message };
        }
    }
}

export const ansibleService = new AnsibleService();
