/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for string utilities, including the F-2 sudo-output redactor.
 */

import { getLastChars, redactSudoOutput } from '../../utils/string';

describe('getLastChars', () => {
    it('returns the whole string when shorter than n', () => {
        expect(getLastChars('hello', 10)).toBe('hello');
    });

    it('truncates to the last n characters', () => {
        expect(getLastChars('abcdefghij', 4)).toBe('ghij');
    });
});

describe('redactSudoOutput', () => {
    it('strips a [sudo] password prompt line', () => {
        const output = 'line one\n[sudo] password for nvidia: \nline two';
        const result = redactSudoOutput(output);
        expect(result).not.toContain('[sudo] password');
        expect(result).toContain('line one');
        expect(result).toContain('line two');
    });

    it('strips a "Sorry, try again" PAM retry line', () => {
        const output = 'Sorry, try again.\napt-get output here';
        const result = redactSudoOutput(output);
        expect(result).not.toContain('Sorry, try again');
        expect(result).toContain('apt-get output here');
    });

    it('strips a sudo: denial line', () => {
        const output = 'sudo: a password is required\nfallback output';
        const result = redactSudoOutput(output);
        expect(result).not.toContain('sudo:');
        expect(result).toContain('fallback output');
    });

    it('scrubs a literal password appearing outside a recognized prompt line', () => {
        const output = 'debug: sent hunter2 to stdin\nnormal output';
        const result = redactSudoOutput(output, 'hunter2');
        expect(result).not.toContain('hunter2');
        expect(result).toContain('[REDACTED]');
        expect(result).toContain('normal output');
    });

    it('leaves ordinary output untouched when no password is supplied and no prompt lines match', () => {
        const output = '0 upgraded, 1 newly installed, 0 to remove';
        expect(redactSudoOutput(output)).toBe(output);
    });
});
