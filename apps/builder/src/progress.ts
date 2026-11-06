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

/** The least time between two snapshots inside a pass; each reads the whole tree. */
export const SNAPSHOT_EVERY_MS = 30_000;

/** Whether enough time has passed to take another snapshot. */
export function snapshotDue(lastAt: number, now: number): boolean {
	return now - lastAt >= SNAPSHOT_EVERY_MS;
}

/**
 * Write back what a lost container took: each snapshot file the tree no longer has. A file
 * still there is left alone, since the tree is newer than any snapshot of it. Returns how
 * many came back.
 */
export async function restoreMissing(
	ws: Workspace,
	verticalDir: string,
	files: Readonly<Record<string, string>>,
): Promise<number> {
	let restored = 0;
	for (const [rel, content] of Object.entries(files)) {
		const path = verticalDir === '.' ? rel : `${verticalDir}/${rel}`;
		if (await ws.exists(path)) continue;
		await ws.writeFile(path, content);
		restored += 1;
	}
	return restored;
}
