// Copyright © 2026 Jerome Gabryszewski
// Licensed under the X11 License. See LICENSE file in the project root for details.

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // Back button
    var backBtn = document.getElementById('backBtn');
    if (backBtn) {
        backBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'goBack' });
        });
    }

    // Select-all checkbox
    var selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', function () {
            var cbs = document.querySelectorAll('.candidate-cb');
            cbs.forEach(function (cb) {
                cb.checked = selectAll.checked;
            });
        });

        // Keep select-all in sync when individual checkboxes change
        document.addEventListener('change', function (e) {
            if (e.target && e.target.classList.contains('candidate-cb')) {
                var cbs = document.querySelectorAll('.candidate-cb');
                var allChecked = Array.prototype.every.call(cbs, function (cb) { return cb.checked; });
                var anyChecked = Array.prototype.some.call(cbs, function (cb) { return cb.checked; });
                selectAll.checked = allChecked;
                selectAll.indeterminate = anyChecked && !allChecked;
            }
        });
    }

    // Apply button
    var applyBtn = document.getElementById('applyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', function () {
            var checked = document.querySelectorAll('.candidate-cb:checked');
            var packages = Array.prototype.map.call(checked, function (cb) {
                return cb.getAttribute('data-package');
            });
            vscode.postMessage({ type: 'apply-selected', packages: packages });
        });
    }
}());
