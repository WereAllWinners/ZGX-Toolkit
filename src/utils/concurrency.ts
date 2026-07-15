/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Run `fn` over each item in `items`, allowing at most `limit` concurrent
 * invocations in flight at once. Resolves once every item has settled —
 * a single item's rejection does not stop the pool from processing the
 * rest of the queue (mirrors Promise.allSettled's "one failure doesn't
 * abort the others" contract, just with bounded concurrency).
 *
 * Callers that need to know about individual failures should catch and
 * record them inside `fn` itself.
 */
export async function runWithConcurrencyLimit<T>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    const boundedLimit = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            try {
                await fn(items[index], index);
            } catch {
                // Swallowed: one item's failure must not stop this worker
                // from continuing to pull the rest of the queue.
            }
        }
    }

    await Promise.all(Array.from({ length: boundedLimit }, () => worker()));
}
