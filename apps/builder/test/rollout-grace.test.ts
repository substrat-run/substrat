import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { BUILD_COMMAND_TIMEOUT_MS, BUILD_WAIT_MS } from '../src/build-queue.js';

/**
 * A release's container rollout must not stop a source build in flight (#3259). Every build
 * starts a sandbox of its own, and the rollout leaves a sandbox alone only while it is younger
 * than `rollout_active_grace_period`, so the grace period has to outlast a build.
 *
 * A build holds its sandbox through the queue wait and then its commands. Four of them do real
 * work — clone, stage the submitted source, save it, install and build — and each is capped at
 * `BUILD_COMMAND_TIMEOUT_MS`; the rest take seconds.
 */
const LONG_COMMANDS = 4;
const BUILD_HOLD_MAX_S = (BUILD_WAIT_MS + LONG_COMMANDS * BUILD_COMMAND_TIMEOUT_MS) / 1000;

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);
type Container = { class_name: string; rollout_active_grace_period?: number };

describe('the sandbox container rollout (#3259)', () => {
	it.each([undefined, 'test'])('spares a sandbox for longer than a build holds it (env %s)', (env) => {
		const { containers } = unstable_readConfig({ config, env }) as unknown as { containers: Container[] };
		const sandbox = containers.find((c) => c.class_name === 'Sandbox');
		expect(sandbox?.rollout_active_grace_period).toBeGreaterThan(BUILD_HOLD_MAX_S);
	});
});
