/**
 * The shared host turn loop (#974): one copy of continuation + repair, and the
 * abort guard from #676 holds in it — so no host can lose it again.
 */
import { describe, expect, it } from 'vitest';
import {
	MAX_CONTINUATIONS,
	MAX_GATE_REPAIRS,
	runTurnLoop,
	type GateRun,
	type TurnResult,
} from '../src/index.js';

const green: GateRun = { results: [], ok: true, durationMs: 0 };
const red: GateRun = {
	results: [{ name: 'typecheck', status: 'failed', exitCode: 1, durationMs: 0, output: 'TS2322' }],
	ok: false,
	durationMs: 0,
};
const checked = (gates: GateRun, changed = 1): TurnResult => ({
	gates,
	commit: changed ? 'abc123' : null,
	changedFiles: Array.from({ length: changed }, (_, i) => `src/f${i}.ts`),
});

describe('runTurnLoop', () => {
	it('continues a truncated pass up to the cap, then checks once', async () => {
		const passes: string[] = [];
		const result = await runTurnLoop(
			{ message: 'build it', turnNo: 3 },
			{
				runPass: async (text) => {
					passes.push(text);
					return true; // always cut by the step ceiling
				},
				runChecks: async () => checked(green),
			},
		);
		expect(passes).toHaveLength(1 + MAX_CONTINUATIONS);
		expect(passes[0]).toBe('build it');
		expect(result.continuations).toBe(MAX_CONTINUATIONS);
		expect(result.repairs).toBe(0);
		expect(result.lastGateReport).toBeUndefined();
	});

	it('stops continuing the moment the signal aborts — a stopped turn burns nothing more', async () => {
		const controller = new AbortController();
		const passes: string[] = [];
		const result = await runTurnLoop(
			{ message: 'build it', turnNo: 1 },
			{
				signal: controller.signal,
				runPass: async (text) => {
					passes.push(text);
					controller.abort(); // the user hit stop during the first pass
					return true;
				},
				runChecks: async () => checked(red),
			},
		);
		expect(passes).toHaveLength(1);
		expect(result.continuations).toBe(0);
		// Red gates with changed files would normally repair; not after an abort.
		expect(result.repairs).toBe(0);
		expect(result.lastGateReport).toContain('typecheck FAILED');
	});

	it('repairs red gates while attempts change files, and carries the report forward', async () => {
		const labels: string[] = [];
		const prompts: string[] = [];
		let checks = 0;
		const result = await runTurnLoop(
			{ message: 'add invoices', turnNo: 7, lastGateReport: 'carried' },
			{
				runPass: async (text, carried) => {
					prompts.push(text);
					if (prompts.length === 1) expect(carried).toBe('carried');
					else expect(carried).toBeUndefined();
					return false;
				},
				runChecks: async (label) => {
					labels.push(label);
					checks += 1;
					return checked(red);
				},
			},
		);
		expect(checks).toBe(1 + MAX_GATE_REPAIRS);
		expect(result.repairs).toBe(MAX_GATE_REPAIRS);
		expect(labels[0]).toBe('studio turn 7: add invoices');
		expect(labels[1]).toBe(`studio turn 7 · gate repair 1/${MAX_GATE_REPAIRS}`);
		expect(prompts[1]).toContain('repair attempt 1/');
		expect(result.lastGateReport).toContain('typecheck FAILED');
	});

	it('does not repair a red tree the turn did not touch', async () => {
		let checks = 0;
		const result = await runTurnLoop(
			{ message: 'just chatting', turnNo: 2 },
			{
				runPass: async () => false,
				runChecks: async () => {
					checks += 1;
					return checked(red, 0);
				},
			},
		);
		expect(checks).toBe(1);
		expect(result.repairs).toBe(0);
	});
});
