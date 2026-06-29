/*
 * Copyright © 2026 Jerome Gabryszewski
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

(function () {
    const vscode = window.vscodeApi || acquireVsCodeApi();
    window.vscodeApi = vscode;

    document.addEventListener('DOMContentLoaded', function () {
        var backBtn    = document.getElementById('backBtn');
        var refreshBtn = document.getElementById('refreshBtn');

        if (backBtn) {
            backBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'goBack' });
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                refreshBtn.disabled = true;
                vscode.postMessage({ type: 'refresh' });
            });
        }

        document.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-action]');
            if (!btn) { return; }
            var action   = btn.getAttribute('data-action');
            var deviceId = btn.getAttribute('data-device-id');

            if (action === 'open-update-review' && deviceId) {
                vscode.postMessage({ type: 'openUpdateReview', deviceId: deviceId });
            }
        });
    });
}());
