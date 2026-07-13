/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Allowlist validation for package and firmware tokens before they are
 * interpolated into a shell command run over SSH. This is a second,
 * independent gate on top of the existing device-reported candidate-set
 * intersection in updateReconciliationService.buildApplyPlan() — that check
 * only guarantees a name matches something the device itself reported, which
 * is a weak guarantee for a fleet tool. This gate rejects shell metacharacters
 * outright regardless of where the name came from.
 *
 * Covers apt/dnf/zypper package names (letters, digits, '.', '+', '_', '-')
 * and fwupd DeviceId values (hex GUIDs, which fit the same character class).
 */
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 256;

export function isValidPackageName(name: string): boolean {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= MAX_PACKAGE_NAME_LENGTH
        && PACKAGE_NAME_RE.test(name);
}

/**
 * Throws if any name fails isValidPackageName(). The apply is aborted
 * entirely rather than silently dropping the bad token(s) — a silent drop
 * could mask an attack or a corrupted candidate list.
 */
export function assertValidPackageNames(names: string[]): void {
    const bad = names.filter(n => !isValidPackageName(n));
    if (bad.length > 0) {
        throw new Error(`Refusing to apply: invalid package/firmware name(s): ${bad.join(', ')}`);
    }
}
