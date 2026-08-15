/**
 * The oracle-feedback policy (builder-harness.md H5): what the model is told
 * about a red gate run, and when a repair attempt is warranted at all. These
 * are pure functions, but their edges are load-bearing — a `blocked` gate
 * must never read as "fix me" (gates.ts's exit-code convention), and the
 * drift gates must steer toward regeneration, not hand-editing.
 */
import { describe, expect, it } from 'vitest';
import {
	gateRepairPrompt,
	gateReport,
	repairNeeded,
	type GateResult,
	type GateRun,
} from '../src/gates.js';

function result(partial: Partial<GateResult> & Pick<GateResult, 'name' | 'status'>): GateResult {
	return { exitCode: partial.status === 'passed' ? 0 : 1, durationMs: 10, output: '', ...partial };
}

function run(results: GateResult[]): GateRun {
	return {
		results,
		ok: results.every((r) => r.status === 'passed' || r.status === 'skipped'),
		durationMs: 100,
	};
}

describe('repairNeeded', () => {
	it('is false on a green run', () => {
		expect(repairNeeded(run([result({ name: 'typecheck', status: 'passed' })]))).toBe(false);
	});

	it('is true when any gate failed', () => {
		expect(
			repairNeeded(
				run([
					result({ name: 'typecheck', status: 'passed' }),
					result({ name: 'scenario', status: 'failed' }),
				]),
			),
		).toBe(true);
	});

	it('is false when gates are only blocked — the checker crashed, not the code', () => {
		expect(
			repairNeeded(run([result({ name: 'boundary-lint', status: 'blocked', exitCode: 2 })])),
		).toBe(false);
	});
});

describe('gateReport', () => {
	it('is null when nothing failed (green, skipped, or blocked-only)', () => {
		expect(gateReport(run([result({ name: 'typecheck', status: 'passed' })]))).toBeNull();
		expect(gateReport(run([result({ name: 'api', status: 'skipped' })]))).toBeNull();
		expect(
			gateReport(run([result({ name: 'boundary-lint', status: 'blocked', exitCode: 2 })])),
		).toBeNull();
	});

	it('carries the failure name, exit code, and output', () => {
		const report = gateReport(
			run([result({ name: 'typecheck', status: 'failed', output: "src/module.ts(3): TS2304" })]),
		);
		expect(report).toContain('typecheck FAILED (exit 1)');
		expect(report).toContain('TS2304');
	});

	it('keeps the TAIL of over-cap output — compilers put the useful part last', () => {
		const output = `${'x'.repeat(10_000)}THE-ACTUAL-ERROR`;
		const report = gateReport(run([result({ name: 'scenario', status: 'failed', output })]));
		expect(report).toContain('THE-ACTUAL-ERROR');
		expect(report).toContain('chars trimmed');
		expect(report?.length ?? 0).toBeLessThan(5_000);
	});

	it('lists blocked gates as facts with an explicit do-not-fix note', () => {
		const report = gateReport(
			run([
				result({ name: 'typecheck', status: 'failed', output: 'boom' }),
				result({ name: 'boundary-lint', status: 'blocked', exitCode: 2 }),
			]),
		);
		expect(report).toContain('do not try to fix');
		expect(report).toContain('boundary-lint');
	});

	it('steers golden-file drift toward regeneration, never hand-editing', () => {
		const report = gateReport(
			run([result({ name: 'permissions', status: 'failed', output: 'PERMISSIONS.md drift' })]),
		);
		expect(report).toContain('regenerate');
		expect(report).toContain('human review');
	});
});

describe('gateRepairPrompt', () => {
	it('carries the attempt counter and the no-arguing instruction', () => {
		const prompt = gateRepairPrompt(
			run([result({ name: 'typecheck', status: 'failed', output: 'boom' })]),
			1,
			2,
		);
		expect(prompt).toContain('repair attempt 1/2');
		expect(prompt).toContain('gates are the oracle');
		expect(prompt).toContain('typecheck FAILED');
	});
});
