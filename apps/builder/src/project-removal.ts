/**
 * Removing a project — the half both hosts share.
 *
 * A removal is a hard delete: the registry entry, the chat history and the
 * per-project caches go, and so does the source the studio created for it (a
 * hosted project's Artifacts repository, a local project's directory under
 * `.builder/projects/`). Two things are never the studio's to delete and stay:
 * a GitHub repository the team connected, and a directory the local server was
 * pointed at with `--vertical`. A vertical already deployed from the project is
 * the dashboard's, not the studio's, and keeps running.
 */

interface Listed {
	readonly id: string;
	readonly updatedAt: string;
}

interface Registry<T extends Listed> {
	currentId: string | null;
	projects: T[];
}

/**
 * The registry without project `id`, or null when it lists no such project.
 * Removing the current project makes the most recently touched one current;
 * removing the last leaves none, for the host to start a fresh one as it does
 * on first boot.
 */
export function withoutProject<T extends Listed>(
	reg: Registry<T>,
	id: string,
): { registry: Registry<T>; removed: T } | null {
	const removed = reg.projects.find((p) => p.id === id);
	if (!removed) return null;
	const projects = reg.projects.filter((p) => p.id !== id);
	let currentId = reg.currentId;
	if (currentId === id || !projects.some((p) => p.id === currentId)) {
		currentId = projects.reduce<T | null>((a, p) => (!a || p.updatedAt > a.updatedAt ? p : a), null)?.id ?? null;
	}
	return { registry: { currentId, projects }, removed };
}

/** Every key the hosted agent (agent.ts) stores under one project's id. */
export function projectStorageKeys(id: string): string[] {
	return [`state:${id}`, `phase:${id}`, `snapshot:${id}`, `record:${id}`, `record-turn:${id}`, `record-turn-seq:${id}`];
}

/**
 * Whether the local server created `dir` and may delete it: one directory
 * directly under `.builder/projects/`. An adopted `--vertical` directory (a
 * demo, the builder's own checkout) is only unregistered.
 */
export function ownedProjectDir(dir: string): boolean {
	const m = /^\.builder\/projects\/([^/]+)$/.exec(dir);
	return m !== null && m[1] !== '.' && m[1] !== '..';
}
