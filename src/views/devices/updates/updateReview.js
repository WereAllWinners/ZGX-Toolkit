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

    // Package select-all checkbox
    var selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', function () {
            document.querySelectorAll('.candidate-cb').forEach(function (cb) {
                cb.checked = selectAll.checked;
            });
        });

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

    // Firmware select-all checkbox
    var fwSelectAll = document.getElementById('fwSelectAll');
    if (fwSelectAll) {
        fwSelectAll.addEventListener('change', function () {
            document.querySelectorAll('.fw-candidate-cb').forEach(function (cb) {
                cb.checked = fwSelectAll.checked;
            });
        });

        document.addEventListener('change', function (e) {
            if (e.target && e.target.classList.contains('fw-candidate-cb')) {
                var cbs = document.querySelectorAll('.fw-candidate-cb');
                var allChecked = Array.prototype.every.call(cbs, function (cb) { return cb.checked; });
                var anyChecked = Array.prototype.some.call(cbs, function (cb) { return cb.checked; });
                fwSelectAll.checked = allChecked;
                fwSelectAll.indeterminate = anyChecked && !allChecked;
            }
        });
    }

    // Re-check button
    var recheckBtn = document.getElementById('recheckBtn');
    if (recheckBtn) {
        recheckBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'runCheckupNow' });
        });
    }

    // Apply package updates button
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

    // Apply firmware updates button
    var applyFirmwareBtn = document.getElementById('applyFirmwareBtn');
    if (applyFirmwareBtn) {
        applyFirmwareBtn.addEventListener('click', function () {
            var checked = document.querySelectorAll('.fw-candidate-cb:checked');
            var packages = Array.prototype.map.call(checked, function (cb) {
                return cb.getAttribute('data-package');
            });
            vscode.postMessage({ type: 'apply-firmware-selected', packages: packages });
        });
    }

    // Apply all button (packages + firmware)
    var applyAllBtn = document.getElementById('applyAllBtn');
    if (applyAllBtn) {
        applyAllBtn.addEventListener('click', function () {
            var pkgChecked = document.querySelectorAll('.candidate-cb:checked');
            var fwChecked = document.querySelectorAll('.fw-candidate-cb:checked');
            var pkgPackages = Array.prototype.map.call(pkgChecked, function (cb) {
                return cb.getAttribute('data-package');
            });
            var fwPackages = Array.prototype.map.call(fwChecked, function (cb) {
                return cb.getAttribute('data-package');
            });
            vscode.postMessage({ type: 'apply-all-selected', packages: pkgPackages, firmwarePackages: fwPackages });
        });
    }
}());
