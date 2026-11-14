/**
 * A turn's work between commits. A turn commits once, after all its passes, so until then
 * its files exist only on the sandbox's disk: a container that goes away mid-turn takes a
 * whole 40-step pass with it, and the browser, which reads the snapshot, sees nothing.
 *
 * So the host snapshots the working tree as the turn runs. A snapshot lists files without
 * touching git, which matters: the repair loop reads what is uncommitted, so a mid-turn
 * commit would tell it nothing had changed.
 */
import type { Workspace } from '@substrat-run/builder-workspace';
import { gitPaths, isDependencyPath } from '@substrat-run/builder-workspace/edge';
import { shellQuote } from './repositories.js';

/** The least time between two snapshots inside a pass; each reads the whole tree. */
export const SNAPSHOT_EVERY_MS = 30_000;

/** Whether enough time has passed to take another snapshot. */
export function snapshotDue(lastAt: number, now: number): boolean {
	return now - lastAt >= SNAPSHOT_EVERY_MS;
}

/** The uncommitted tree a stored snapshot holds. */
export interface WorkSnapshot {
	readonly files: Readonly<Record<string, string>>;
	/** Listed in the tree but too large or binary to hold, so present, not deleted. */
	readonly skipped: readonly string[];
}

/** The work in a stored snapshot, or null when it holds none or cannot be read. */
export function workIn(stored: string | undefined): WorkSnapshot | null {
	if (!stored) return null;
	try {
		const snap = JSON.parse(stored) as { work?: boolean; files?: Record<string, string>; skipped?: string[] };
		return snap.work && snap.files ? { files: snap.files, skipped: snap.skipped ?? [] } : null;
	} catch {
		return null;
	}
}

/**
 * Put a turn's work back on a fresh checkout. Only for one: the tree is then the last commit,
 * so the snapshot is newer than every file in it. That covers the edits to committed files as
 * well as the new ones, and a tracked file the snapshot does not list is one the turn deleted.
 * Returns how many files changed.
 */
export async function restoreWork(ws: Workspace, verticalDir: string, work: WorkSnapshot): Promise<number> {
	// A snapshot with no files cannot be a project's tree: the empty listing saved while the hosted
	// exec dropped NULs (see gitPaths). Read as one, every tracked file would be a deletion.
	if (Object.keys(work.files).length === 0) return 0;
	const prefix = verticalDir === '.' ? '' : `${verticalDir}/`;
	let restored = 0;
	for (const [rel, content] of Object.entries(work.files)) {
		const current = await ws.readFile(`${prefix}${rel}`).catch(() => null);
		if (current === content) continue;
		await ws.writeFile(`${prefix}${rel}`, content);
		restored += 1;
	}
	const listed = new Set([...Object.keys(work.files), ...work.skipped]);
	const deleted = (await gitPaths(ws, `-- ${shellQuote(verticalDir)}`, '.'))
		.filter((p) => p && !isDependencyPath(p) && !listed.has(p.slice(prefix.length)));
	if (deleted.length) {
		const rm = await ws.exec(`rm -f -- ${deleted.map(shellQuote).join(' ')}`, { cwd: '.' });
		if (rm.exitCode !== 0) throw new Error(`rm failed in ${verticalDir}: ${rm.stderr || rm.stdout}`);
	}
	return restored + deleted.length;
}
