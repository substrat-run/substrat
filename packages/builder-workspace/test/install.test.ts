/**
 * Host-owned dependency install (turn.ts → gates.ts runInstall): a fresh
 * project's `workspace:*` deps resolve only after `pnpm install`, and leaving
 * that to the model by prompt lost to the step ceiling in practice (observed:
 * two 40-step scaffold turns, both red on module-not-found with node_modules
 * missing). These tests pin the DECISION — when the host installs — with the
 * command intercepted at the Workspace seam, so they stay offline and fast.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '../src/local.js';
import { ensureVerticalRepo, runTurn } from '../src/turn.js';
import type { ExecOptions, ExecResult } from '../src/workspace.js';

const NO_GATES: [] = [];
const PROJECT = '.builder/projects/x';

/** LocalWorkspace with `pnpm install` intercepted: counted, never executed. */
class InstallSpyWorkspace extends LocalWorkspace {
	installs = 0;
	installExit = 0;
	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd === 'pnpm install') {
			this.installs += 1;
			return { stdout: 'stub install', stderr: '', exitCode: this.installExit };
		}
		return super.exec(cmd, opts);
	}
}

async function repo(): Promise<InstallSpyWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-install-'));
	const ws = new InstallSpyWorkspace({ root });
	await ws.exec('git init -q');
	await ws.writeFile('README.md', 'seed\n');
	await ws.exec('git add -A');
	await ws.exec('git -c user.name=t -c user.email=t@t commit -q -m seed');
	await ensureVerticalRepo(ws, PROJECT);
	return ws;
}

describe('host-owned pnpm install (runTurn)', () => {
	it('installs when the turn touched a package.json, and reports it first', async () => {
		const ws = await repo();
		await ws.writeFile(`${PROJECT}/package.json`, '{"name":"x","private":true}\n');

		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 't', gates: NO_GATES });

		expect(ws.installs).toBe(1);
		expect(turn.gates.results[0]).toMatchObject({ name: 'install', status: 'passed' });
		expect(turn.gates.ok).toBe(true);
		await ws.dispose();
	});

	it('installs when a package.json exists but node_modules is missing', async () => {
		const ws = await repo();
		await ws.writeFile(`${PROJECT}/package.json`, '{"name":"x","private":true}\n');
		await runTurn(ws, { verticalDir: PROJECT, message: 't1', gates: NO_GATES });
		expect(ws.installs).toBe(1);

		// package.json is now committed (unchanged this turn) — but deps never
		// materialised, so the next turn must install again.
		await ws.writeFile(`${PROJECT}/src/module.ts`, 'export const M = 1;\n');
		await runTurn(ws, { verticalDir: PROJECT, message: 't2', gates: NO_GATES });
		expect(ws.installs).toBe(2);
		await ws.dispose();
	});

	it('skips install when deps are present and no manifest changed', async () => {
		const ws = await repo();
		await ws.writeFile(`${PROJECT}/package.json`, '{"name":"x","private":true}\n');
		await runTurn(ws, { verticalDir: PROJECT, message: 't1', gates: NO_GATES });
		await ws.mkdir(`${PROJECT}/node_modules`, { recursive: true });

		await ws.writeFile(`${PROJECT}/src/module.ts`, 'export const M = 1;\n');
		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 't2', gates: NO_GATES });

		expect(ws.installs).toBe(1); // only the first turn's
		expect(turn.gates.results.find((r) => r.name === 'install')).toBeUndefined();
		await ws.dispose();
	});

	it('never installs for a project without a package.json (interview turns)', async () => {
		const ws = await repo();
		await ws.writeFile(`${PROJECT}/spec/concept.md`, '# concept\n');
		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 't', gates: NO_GATES });

		expect(ws.installs).toBe(0);
		expect(turn.gates.results).toHaveLength(0);
		await ws.dispose();
	});

	it('a failed install turns the run red, with pnpm output attached', async () => {
		const ws = await repo();
		ws.installExit = 1;
		await ws.writeFile(`${PROJECT}/package.json`, '{"name":"x","private":true}\n');

		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 't', gates: NO_GATES });

		expect(turn.gates.ok).toBe(false);
		expect(turn.gates.results[0]).toMatchObject({
			name: 'install',
			status: 'failed',
			output: 'stub install',
		});
		// Red or not, the turn still commits — recoverability first (§4.2).
		expect(turn.commit).not.toBeNull();
		await ws.dispose();
	});
});
