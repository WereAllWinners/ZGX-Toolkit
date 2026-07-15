/*
 * Copyright ©2025 HP Development Company, L.P.
 * Licensed under the X11 License. See LICENSE file in the project root for details.
 */

/**
 * Unit tests for the F-6 bounded-concurrency pool helper.
 */

import { runWithConcurrencyLimit } from '../../utils/concurrency';

describe('runWithConcurrencyLimit', () => {
    it('never exceeds the configured concurrency limit', async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        let inFlight = 0;
        let maxInFlight = 0;

        await runWithConcurrencyLimit(items, 3, async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
        });

        expect(maxInFlight).toBeLessThanOrEqual(3);
        expect(maxInFlight).toBeGreaterThan(1); // actually ran concurrently, not serially
    });

    it('processes every item exactly once', async () => {
        const items = Array.from({ length: 9 }, (_, i) => i);
        const processed: number[] = [];

        await runWithConcurrencyLimit(items, 4, async item => {
            processed.push(item);
        });

        expect(processed.slice().sort((a, b) => a - b)).toEqual(items);
    });

    it('one item rejecting does not stop the others from running', async () => {
        const items = [1, 2, 3, 4, 5];
        const processed: number[] = [];

        await runWithConcurrencyLimit(items, 2, async item => {
            if (item === 3) {
                throw new Error('boom');
            }
            processed.push(item);
        });

        expect(processed.slice().sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    });

    it('resolves immediately for an empty item list', async () => {
        await expect(runWithConcurrencyLimit([], 5, async () => {
            throw new Error('should never be called');
        })).resolves.toBeUndefined();
    });

    it('clamps an oversized limit to the number of items (no extra workers)', async () => {
        const items = [1, 2];
        let callCount = 0;

        await runWithConcurrencyLimit(items, 50, async () => {
            callCount++;
        });

        expect(callCount).toBe(2);
    });

    it('behaves correctly with limit of 1 (fully serial)', async () => {
        const items = [1, 2, 3];
        const order: number[] = [];

        await runWithConcurrencyLimit(items, 1, async item => {
            order.push(item);
            await new Promise(resolve => setTimeout(resolve, 1));
        });

        expect(order).toEqual([1, 2, 3]);
    });
});
