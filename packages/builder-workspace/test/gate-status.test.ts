/**
 * runGate exit-code classification. The 0/1/2 "2 = blocked" convention belongs
 * to Substrat's own checkers ONLY (`exitConvention: 'substrat'`): tsc exits 2
 * on ordinary type errors, and classifying that as `blocked` muted the entire
 * repair loop — repairNeeded() saw nothing `failed`, gateReport() returned
 * null, and the model was told its own type errors were "NOT a code problem"
 * (observed: the todo-app run, `TS2345 … PrincipalId` reported as blocked).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGate, standaloneGates, type GateSpec } from '../src/gates.js';
import { LocalWorkspace } from '../src/local.js';
import type { ExecOptions, ExecResult } from '../src/workspace.js';

/** LocalWorkspace whose exec returns a scripted exit code for the gate cmd. */
class ExitCodeWorkspace extends LocalWorkspace {
	exit = 0;
	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd.startsWith('git ')) return super.exec(cmd, opts);
		return { stdout: 'gate output', stderr: '', exitCode: this.exit };
	}
}

async function ws(exit: number): Promise<ExitCodeWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-gate-status-'));
	const w = new ExitCodeWorkspace({ root });
	w.exit = exit;
	return w;
}

const binary: GateSpec = { name: 'typecheck', cmd: 'pnpm typecheck' };
const substrat: GateSpec = { name: 'boundary-lint', cmd: 'lint', exitConvention: 'substrat' };

describe('runGate exit-code classification', () => {
	it('exit 2 from an external tool is a FAILURE — tsc exits 2 on type errors', async () => {
		const w = await ws(2);
		const r = await runGate(w, binary, '.');
		expect(r).toMatchObject({ status: 'failed', exitCode: 2, output: 'gate output' });
		await w.dispose();
	});

	it('exit 2 from a substrat-convention checker is blocked, not failed', async () => {
		const w = await ws(2);
		expect((await runGate(w, substrat, '.')).status).toBe('blocked');
		await w.dispose();
	});

	it('exit 1 fails and exit 0 passes under both conventions', async () => {
		const red = await ws(1);
		expect((await runGate(red, binary, '.')).status).toBe('failed');
		expect((await runGate(red, substrat, '.')).status).toBe('failed');
		await red.dispose();

		const green = await ws(0);
		expect((await runGate(green, binary, '.')).status).toBe('passed');
		expect((await runGate(green, substrat, '.')).status).toBe('passed');
		await green.dispose();
	});

	it('standalone gates opt only our own checkers into the substrat convention', () => {
		const byName = new Map(standaloneGates('p').map((g) => [g.name, g.exitConvention]));
		expect(byName.get('boundary-lint')).toBe('substrat');
		expect(byName.get('typecheck')).toBeUndefined();
		expect(byName.get('scenario')).toBeUndefined();
	});
});
