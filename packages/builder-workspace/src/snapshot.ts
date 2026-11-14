/**
 * Workspace snapshots — the browser-readable form of a project's working tree.
 *
 * The hosted studio's read path (file tree, opens) must not depend on the
 * sandbox container being awake: reads were paying worker → agent DO → sandbox
 * DO → container bridge per click, plus a full container cold start after
 * `sleepAfter`. The durable git bundle (D-52) already exists but is not
 * browser-consumable, so hosts persist THIS alongside it: one JSON object of
 * the whole tree, rebuilt at commit time, served to the SPA in a single
 * request. Runs above the `Workspace` seam so both modes produce identical
 * snapshots (the local server builds one live per request — disk is cheap
 * there).
 *
 * Coverage is `git ls-files -c -o --exclude-standard`: tracked plus untracked
 * non-ignored, i.e. exactly what the editor should show — build noise stays
 * out via the project's own .gitignore. Binary/oversize files are listed in
 * `skipped`, never silently dropped.
 */
import type { Workspace } from './workspace.js';

/** Per-file ceiling — generated verticals are source text; anything bigger is
 * a lockfile-sized artifact the editor can live without. */
export const SNAPSHOT_MAX_FILE_BYTES = 1_000_000;

export interface WorkspaceSnapshot {
	/** Path → content, keyed RELATIVE to the vertical dir (POSIX). */
	readonly files: Record<string, string>;
	/** Paths present in the tree but not in `files` (binary or oversize). */
	readonly skipped: string[];
}

/**
 * The paths `git ls-files <args>` prints, run in `cwd`. Git separates them with NUL (`-z`, so no
 * path comes back C-quoted), but the hosted container's exec drops NUL bytes from what it relays:
 * every path arrived as one string that named no file, and the studio's Code and Model tabs were
 * empty. `tr` turns the separators into newlines inside the container, before the relay sees them.
 * A path holding a newline is split in two and then reads as missing, which is where it belongs.
 */
export async function gitPaths(ws: Workspace, args: string, cwd: string): Promise<string[]> {
	// Through a file rather than a pipe, so git's own exit status is the one returned; in a
	// subshell, so the `exit` cannot end a shell session the exec may reuse.
	const ls = await ws.exec(
		`(f=$(mktemp) && git ls-files -z ${args} > "$f" && tr '\\0' '\\n' < "$f"; s=$?; rm -f "$f"; exit $s)`,
		{ cwd },
	);
	if (ls.exitCode !== 0) throw new Error(`git ls-files failed in ${cwd}: ${ls.stderr || ls.stdout}`);
	return ls.stdout.split('\n').filter(Boolean);
}

/** A path under node_modules, which a snapshot never lists, ignored or not. */
export function isDependencyPath(path: string): boolean {
	return /(^|\/)node_modules\//.test(path);
}

/**
 * Snapshot the vertical's working tree. `ws` is the ROOT workspace (repo root),
 * mirroring the turn loop's calling convention; paths in the result are
 * relative to `verticalDir` in both git modes.
 */
export async function snapshotWorkspace(
	ws: Workspace,
	verticalDir: string,
): Promise<WorkspaceSnapshot> {
	// Same mode split as the turn loop (turn.ts gitCtx): a project repo lists
	// from its own root; a legacy scoped dir lists path-scoped from the parent.
	const project = await ws.exists(`${verticalDir}/.git`);
	const cwd = project ? verticalDir : '.';
	const scope = project ? '.' : verticalDir;
	const prefix = `${verticalDir}/`;
	const rels = (await gitPaths(ws, `-c -o --exclude-standard -- ${JSON.stringify(scope)}`, cwd))
		.map((p) => (project ? p : p.startsWith(prefix) ? p.slice(prefix.length) : p))
		// A project may not have its .gitignore yet, and a snapshot runs mid-turn, one read per file.
		.filter((p) => !isDependencyPath(p))
		.sort();

	const files: Record<string, string> = {};
	const skipped: string[] = [];
	for (const rel of rels) {
		let content: string;
		try {
			content = await ws.readFile(`${verticalDir}/${rel}`);
		} catch {
			skipped.push(rel); // deleted between ls and read, or unreadable
			continue;
		}
		// NUL = binary (readFile already mangled it); oversize = not editor fare.
		if (content.includes('\u0000') || content.length > SNAPSHOT_MAX_FILE_BYTES) {
			skipped.push(rel);
			continue;
		}
		files[rel] = content;
	}
	return { files, skipped };
}
