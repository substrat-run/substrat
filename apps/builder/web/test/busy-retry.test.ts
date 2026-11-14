/**
 * The preview's Run rides out a busy project (another operation holds it) instead of failing,
 * for a bounded time, and retries nothing else. Driven with an injected clock: no real waits.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { BUSY_RETRY_BOUND_MS, retryWhileBusy } from '../src/busy-retry.js';

const busy = () =>
	new ApiError('project operation already in progress: an agent turn in project "CRM", started 3 s ago', 409, {
		occupant: { what: 'an agent turn in project "CRM"' },
	});

function clock() {
	let t = 0;
	const slept: number[] = [];
	return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

describe('retryWhileBusy', () => {
	it('waits out a busy refusal, naming the occupant, and returns the call that gets through', async () => {
		const c = clock();
		const waited: string[] = [];
		let calls = 0;
		const result = await retryWhileBusy(async () => {
			if (++calls < 3) throw busy();
			return 'ready';
		}, { ...c, onWait: (o) => waited.push(o) });
		expect(result).toBe('ready');
		expect(waited).toEqual(['an agent turn in project "CRM"', 'an agent turn in project "CRM"']);
		expect(c.slept).toEqual([5_000, 10_000]);
	});

	it('stops at its bound and fails with the sentence', async () => {
		expect(BUSY_RETRY_BOUND_MS).toBe(10 * 60_000);
		const c = clock();
		let calls = 0;
		await expect(retryWhileBusy(async () => { calls++; throw busy(); }, c)).rejects.toThrow(/^project operation already in progress: an agent turn/);
		expect(c.now()).toBeLessThanOrEqual(BUSY_RETRY_BOUND_MS);
		expect(c.now() + 30_000).toBeGreaterThan(BUSY_RETRY_BOUND_MS);
		expect(calls).toBe(c.slept.length + 1);
	});

	it('does not retry any other error, a different 409 included', async () => {
		for (const e of [new ApiError('save source before running a preview', 409, {}), new ApiError('platform build failed', 500, {}), new Error('network')]) {
			const c = clock();
			let calls = 0;
			await expect(retryWhileBusy(async () => { calls++; throw e; }, c)).rejects.toBe(e);
			expect(calls).toBe(1);
			expect(c.slept).toEqual([]);
		}
	});
});
