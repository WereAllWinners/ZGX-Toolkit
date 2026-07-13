/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Returns the last 500 characters of a string.
 * If the string is shorter than 500 characters, returns the entire string.
 * @param str - The input string
 * @returns The last 500 characters (or the entire string if shorter)
 */
export function getLastChars(str: string, n: number = 500): string {
    return str.length <= n ? str : str.slice(-n);
}

/**
 * Sudo/PAM prompt line patterns to strip from command output before it's
 * logged or shown to the user. A chatty PAM stack can echo prompt text
 * (and, in edge cases, password fragments) into stdout/stderr.
 */
const SUDO_PROMPT_LINE_PATTERNS = [
    /^\[sudo\] password/i,
    /^sorry, try again/i,
    /^sudo:/i,
];

/**
 * Redact sudo-password material from SSH command output before it is logged
 * or surfaced in a notification. Strips any line matching a known sudo/PAM
 * prompt pattern, and additionally scrubs any literal occurrence of the
 * supplied password (defense in depth, in case it appears outside a
 * recognized prompt line — e.g. echoed back mid-line by a shell wrapper).
 *
 * @param output raw combined stdout/stderr from an SSH command
 * @param sudoPassword the password that was sent, if any
 * @returns output with sudo/PAM prompt lines and the literal password removed
 */
export function redactSudoOutput(output: string, sudoPassword?: string): string {
    const lines = output.split('\n').filter(
        line => !SUDO_PROMPT_LINE_PATTERNS.some(pattern => pattern.test(line.trim()))
    );
    let result = lines.join('\n');
    if (sudoPassword) {
        result = result.split(sudoPassword).join('[REDACTED]');
    }
    return result;
}