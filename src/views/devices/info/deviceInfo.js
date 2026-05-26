/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

(function () {
    const vscode = acquireVsCodeApi();

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
            vscode.postMessage({ type: 'runInventory' });
        });
    }

    // Empty-state "Run Inventory" button
    const runInventoryBtn = document.getElementById('runInventoryBtn');
    if (runInventoryBtn) {
        runInventoryBtn.addEventListener('click', () => {
            runInventoryBtn.disabled = true;
            runInventoryBtn.textContent = 'Running…';
            vscode.postMessage({ type: 'runInventory' });
        });
    }
}());
