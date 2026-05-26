/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

(function () {
    const vscode = window.vscodeApi || acquireVsCodeApi();
    window.vscodeApi = vscode;

    document.addEventListener('DOMContentLoaded', function () {
        // Refresh All button
        const refreshAllBtn = document.getElementById('refreshAllBtn');
        if (refreshAllBtn) {
            refreshAllBtn.addEventListener('click', function () {
                setRefreshAllLoading(true);
                vscode.postMessage({ type: 'refreshAll' });
            });
        }

        // Per-device / per-group action buttons
        document.querySelectorAll('[data-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const action = btn.getAttribute('data-action');
                const deviceId = btn.getAttribute('data-device-id');
                const groupId = btn.getAttribute('data-group-id');

                switch (action) {
                    case 'run-inventory':
                        if (!deviceId) { return; }
                        setCardLoading(deviceId, true);
                        vscode.postMessage({ type: 'runInventory', deviceId });
                        break;
                    case 'view-details':
                        if (!deviceId) { return; }
                        vscode.postMessage({ type: 'viewDetails', deviceId });
                        break;
                    case 'check-updates':
                        if (!deviceId) { return; }
                        setCardLoading(deviceId, true);
                        vscode.postMessage({ type: 'checkUpdates', deviceId });
                        break;
                    case 'edit-group':
                        if (!groupId) { return; }
                        openGroupForm(groupId);
                        break;
                    case 'delete-group':
                        if (!groupId) { return; }
                        vscode.postMessage({ type: 'deleteGroup', groupId });
                        break;
                    case 'group-setup':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupSetup', groupId });
                        break;
                    case 'group-inventory':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupInventory', groupId });
                        break;
                    case 'group-health':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupHealth', groupId });
                        break;
                    case 'group-updates':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupUpdates', groupId });
                        break;
                    case 'apply-updates':
                        if (!deviceId) { return; }
                        setCardLoading(deviceId, true);
                        vscode.postMessage({ type: 'applyUpdates', deviceId });
                        break;
                    case 'setup-manageability':
                        if (!deviceId) { return; }
                        setCardLoading(deviceId, true);
                        vscode.postMessage({ type: 'setupManageability', deviceId });
                        break;
                    case 'group-apply-updates':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupApplyUpdates', groupId });
                        break;
                    case 'group-run-policy':
                        if (!groupId) { return; }
                        setGroupLoading(groupId, true);
                        vscode.postMessage({ type: 'groupRunPolicy', groupId });
                        break;
                }
            });
        });

        // Create Group button
        const createGroupBtn = document.getElementById('createGroupBtn');
        if (createGroupBtn) {
            createGroupBtn.addEventListener('click', function () { openGroupForm(null); });
        }

        // Form close / cancel buttons
        const overlay = document.getElementById('groupFormOverlay');
        const closeBtn = document.getElementById('groupFormCloseBtn');
        const cancelBtn = document.getElementById('groupFormCancelBtn');
        if (closeBtn) { closeBtn.addEventListener('click', closeGroupForm); }
        if (cancelBtn) { cancelBtn.addEventListener('click', closeGroupForm); }
        if (overlay) {
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) { closeGroupForm(); }
            });
        }

        // Form submission
        const groupForm = document.getElementById('groupForm');
        if (groupForm) {
            groupForm.addEventListener('submit', function (e) {
                e.preventDefault();
                submitGroupForm();
            });
        }

        // Handle messages from the extension host
        window.addEventListener('message', function (event) {
            const message = event.data;
            switch (message.type) {
                case 'clearLoading':
                    if (message.deviceId) {
                        setCardLoading(message.deviceId, false);
                    } else if (message.groupId) {
                        setGroupLoading(message.groupId, false);
                    } else {
                        setRefreshAllLoading(false);
                    }
                    break;
            }
        });
    });

    // ── Group form ──────────────────────────────────────────────

    function openGroupForm(groupId) {
        const overlay    = document.getElementById('groupFormOverlay');
        const title      = document.getElementById('groupFormTitle');
        const idInput    = document.getElementById('groupFormId');
        const nameInput  = document.getElementById('groupFormName');
        const descInput  = document.getElementById('groupFormDesc');
        const reqPkgs    = document.getElementById('groupFormRequiredPkgs');
        const pinnedPkgs = document.getElementById('groupFormPinnedPkgs');
        const customPb   = document.getElementById('groupFormCustomPlaybook');
        const submitBtn  = document.getElementById('groupFormSubmitBtn');
        if (!overlay || !idInput || !nameInput || !descInput) { return; }

        // Reset form
        idInput.value = '';
        nameInput.value = '';
        descInput.value = '';
        if (reqPkgs)    { reqPkgs.value = ''; }
        if (pinnedPkgs) { pinnedPkgs.value = ''; }
        if (customPb)   { customPb.value = ''; }
        document.querySelectorAll('.device-checkbox').forEach(function (cb) {
            cb.checked = false;
        });

        if (groupId) {
            // Edit mode: pre-populate from the group card's data attributes
            const groupCard = document.querySelector('[data-group-id="' + groupId + '"]');
            const groupName = groupCard ? groupCard.querySelector('.group-card-name') : null;
            const groupDesc = groupCard ? groupCard.querySelector('.group-card-description') : null;
            idInput.value = groupId;
            if (groupName) { nameInput.value = groupName.textContent.trim(); }
            if (groupDesc) { descInput.value = groupDesc.textContent.trim(); }
            // Policy fields stored as data attributes on the card
            if (reqPkgs    && groupCard) { reqPkgs.value    = groupCard.getAttribute('data-policy-required')  || ''; }
            if (pinnedPkgs && groupCard) { pinnedPkgs.value = groupCard.getAttribute('data-policy-pinned')    || ''; }
            if (customPb   && groupCard) { customPb.value   = groupCard.getAttribute('data-policy-playbook')  || ''; }
            if (title) { title.textContent = 'Edit Group'; }
            if (submitBtn) { submitBtn.textContent = 'Save Changes'; }

            // Pre-check devices that belong to this group
            document.querySelectorAll('.device-checkbox').forEach(function (cb) {
                const groupIds = (cb.getAttribute('data-group-ids') || '').split(',');
                if (groupIds.includes(groupId)) { cb.checked = true; }
            });
        } else {
            if (title) { title.textContent = 'Create Group'; }
            if (submitBtn) { submitBtn.textContent = 'Create Group'; }
        }

        overlay.classList.add('is-open');
        nameInput.focus();
    }

    function closeGroupForm() {
        const overlay = document.getElementById('groupFormOverlay');
        if (overlay) { overlay.classList.remove('is-open'); }
    }

    function submitGroupForm() {
        const idInput    = document.getElementById('groupFormId');
        const nameInput  = document.getElementById('groupFormName');
        const descInput  = document.getElementById('groupFormDesc');
        const reqPkgs    = document.getElementById('groupFormRequiredPkgs');
        const pinnedPkgs = document.getElementById('groupFormPinnedPkgs');
        const customPb   = document.getElementById('groupFormCustomPlaybook');
        if (!idInput || !nameInput) { return; }

        const name = nameInput.value.trim();
        if (!name) {
            nameInput.focus();
            return;
        }

        const deviceIds = [];
        document.querySelectorAll('.device-checkbox:checked').forEach(function (cb) {
            deviceIds.push(cb.value);
        });

        // Parse policy fields
        function splitCsv(val) {
            return (val || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        }
        const policy = {
            requiredPackages: splitCsv(reqPkgs && reqPkgs.value),
            pinnedPackages:   splitCsv(pinnedPkgs && pinnedPkgs.value),
            customPlaybookPath: (customPb && customPb.value.trim()) || '',
        };

        const groupId = idInput.value;
        if (groupId) {
            vscode.postMessage({ type: 'updateGroup', groupId, name, description: descInput.value.trim(), deviceIds, policy });
        } else {
            vscode.postMessage({ type: 'createGroup', name, description: descInput.value.trim(), deviceIds, policy });
        }
        closeGroupForm();
    }

    // ── Group card loading ──────────────────────────────────────

    function setGroupLoading(groupId, loading) {
        const card = document.querySelector('.group-card[data-group-id="' + groupId + '"]');
        if (!card) { return; }
        if (loading) {
            card.classList.add('loading');
            card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        } else {
            card.classList.remove('loading');
            card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        }
    }

    // ── Device card loading ─────────────────────────────────────

    function setCardLoading(deviceId, loading) {
        const card = document.querySelector('[data-device-id="' + deviceId + '"].device-card');
        if (!card) { return; }
        if (loading) {
            card.classList.add('loading');
            card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        } else {
            card.classList.remove('loading');
            card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        }
    }

    function setRefreshAllLoading(loading) {
        const btn = document.getElementById('refreshAllBtn');
        if (btn) { btn.disabled = loading; }
    }
}());
