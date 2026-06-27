/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

(function () {
    const vscode = window.vscodeApi || acquireVsCodeApi();
    window.vscodeApi = vscode;

    const deviceId = document.querySelector('.container[data-device-id]')
        ? document.querySelector('.container').getAttribute('data-device-id')
        : undefined;

    // Back button — return to Admin Dashboard
    const backBtn = document.getElementById('backBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => vscode.postMessage({ type: 'goBack' }));
    }

    // Refresh button — re-runs collectInventory via the view controller
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i> Refreshing…';
            vscode.postMessage({ type: 'runInventory', deviceId });
        });
    }

    // Empty-state "Run Inventory" button
    const runInventoryBtn = document.getElementById('runInventoryBtn');
    if (runInventoryBtn) {
        runInventoryBtn.addEventListener('click', () => {
            runInventoryBtn.disabled = true;
            runInventoryBtn.textContent = 'Running…';
            vscode.postMessage({ type: 'runInventory', deviceId });
        });
    }

    // Re-enable refresh button after inventory completes
    window.addEventListener('message', function (event) {
        if (event.data && event.data.type === 'inventoryComplete') {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.innerHTML = '<i class="codicon codicon-refresh"></i> Refresh';
            }
            if (runInventoryBtn) {
                runInventoryBtn.disabled = false;
                runInventoryBtn.textContent = 'Run Inventory';
            }
        }
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var target = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-btn').forEach(function (b) {
                b.classList.remove('tab-active');
            });
            document.querySelectorAll('.tab-panel').forEach(function (p) {
                p.classList.add('tab-hidden');
            });
            btn.classList.add('tab-active');
            var panel = document.getElementById('tab-' + target);
            if (panel) { panel.classList.remove('tab-hidden'); }
        });
    });

    // Policy action buttons (capture-baseline, check-drift, export-remediation)
    document.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var action = btn.getAttribute('data-action');
            btn.disabled = true;
            vscode.postMessage({ type: action, deviceId: deviceId });
            setTimeout(function () { btn.disabled = false; }, 5000);
        });
    });
}());
