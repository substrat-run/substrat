import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { beforeDeadline, BUILD_COMMAND_TIMEOUT_MS, BUILD_LIFETIME_MS, BuildLifetimeExpired, commandBudget } from '../src/build-queue.js';

/**
 * A release's container rollout must not stop a source build in flight (#3259). Every build
 * starts a sandbox of its own and destroys it when it ends, and the rollout leaves a sandbox
 * alone only while it is younger than `rollout_active_grace_period`. So the build's lifetime,
 * which every command and file operation is held to, must fit inside the grace period.
 */
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);
type Container = { class_name: string; rollout_active_grace_period?: number };

describe('the sandbox container rollout (#3259)', () => {
	it.each([undefined, 'test'])('spares a sandbox for longer than a build may live (env %s)', (env) => {
		const { containers } = unstable_readConfig({ config, env }) as unknown as { containers: Container[] };
		const sandbox = containers.find((c) => c.class_name === 'Sandbox');
		expect(sandbox?.rollout_active_grace_period).toBeGreaterThan(BUILD_LIFETIME_MS / 1000);
	});

	it('gives a command the per-command cap, then only what is left of the build, then nothing', () => {
		const deadline = 1_000_000_000;
		expect(commandBudget(deadline, deadline - BUILD_LIFETIME_MS)).toBe(BUILD_COMMAND_TIMEOUT_MS);
		expect(commandBudget(deadline, deadline - 5_000)).toBe(5_000);
		expect(() => commandBudget(deadline, deadline)).toThrow(BuildLifetimeExpired);
	});

	it('refuses a file operation still running when the build runs out of time', async () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			const hung = beforeDeadline(now + 1_000, () => new Promise<never>(() => undefined), now);
			const refused = expect(hung).rejects.toThrow(BuildLifetimeExpired);
			await vi.advanceTimersByTimeAsync(1_000);
			await refused;
		} finally {
			vi.useRealTimers();
		}
	});
});
