#!/usr/bin/env node
/**
 * `substrat-builder-gates <vertical-dir> [--root <path>]`
 *
 * Drives the tier-1 gates (§9.1) over a `LocalWorkspace`. This is phase 1 of the
 * spike: no model, no container, no UI — the proof that the seam can carry the
 * existing Callout build before anything is generated into it.
 */
import { formatGateRun, runGates } from './gates.js';
import { LocalWorkspace } from './local.js';

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const rootFlag = argv.indexOf('--root');
	const root = rootFlag === -1 ? (process.env.INIT_CWD ?? process.cwd()) : argv[rootFlag + 1];
	const positional = argv.filter(
		(a, i) => !a.startsWith('--') && !(rootFlag !== -1 && i === rootFlag + 1),
	);
	const verticalDir = positional[0];

	if (!verticalDir || !root) {
		process.stderr.write('usage: substrat-builder-gates <vertical-dir> [--root <path>]\n');
		return 2;
	}

	const ws = new LocalWorkspace({ root });
	if (!(await ws.exists(verticalDir))) {
		process.stderr.write(`no such vertical directory: ${verticalDir} (root ${root})\n`);
		return 2;
	}

	process.stdout.write(`gates · ${verticalDir} · ${ws.root}\n`);
	const run = await runGates(ws, verticalDir, undefined, (r) => {
		const glyph = { passed: '✓', failed: '✗', blocked: '!', skipped: '–' }[r.status];
		process.stdout.write(`  ${glyph} ${r.name}\n`);
	});
	process.stdout.write(`\n${formatGateRun(run)}\n`);

	if (!run.ok) {
		for (const r of run.results) {
			if (r.status === 'failed' || r.status === 'blocked') {
				process.stdout.write(`\n--- ${r.name} (exit ${r.exitCode}) ---\n${r.output}\n`);
			}
		}
	}
	await ws.dispose();
	return run.ok ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(2);
	},
);
