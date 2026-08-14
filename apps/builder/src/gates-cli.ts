/**
 * `pnpm builder gates <vertical-dir>` — the tier-1 gates alone (§9.1), no model.
 * The cheapest way to check that a vertical still holds, and what phase 1 of the
 * spike proved before any generator existed.
 */
import { formatGateRun, LocalWorkspace, runGates } from '@substrat-run/builder-workspace';

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const rootIdx = argv.indexOf('--root');
	// pnpm runs a filtered script with cwd set to the PACKAGE directory, so
	// process.cwd() here is apps/builder. INIT_CWD is where the user actually ran
	// `pnpm builder …` from, which is what they mean by "here".
	const root = rootIdx === -1 ? (process.env.INIT_CWD ?? process.cwd()) : argv[rootIdx + 1];
	const verticalDir = argv.find(
		(a, i) => !a.startsWith('--') && !(rootIdx !== -1 && i === rootIdx + 1),
	);

	if (!verticalDir || !root) {
		process.stderr.write('usage: pnpm builder gates <vertical-dir> [--root <path>]\n');
		return 2;
	}

	const ws = new LocalWorkspace({ root });
	if (!(await ws.exists(verticalDir))) {
		process.stderr.write(`no such vertical directory: ${verticalDir} (root ${root})\n`);
		return 2;
	}

	process.stdout.write(`gates · ${verticalDir} · ${ws.root}\n`);
	const run = await runGates(ws, verticalDir);
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
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(2);
	},
);
