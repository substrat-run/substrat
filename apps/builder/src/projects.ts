/**
 * The project registry — mode A's materialization of what the BuilderAgent DO
 * owns in hosted mode (§7.1): which projects exist, which is current, and each
 * one's chat history.
 *
 * Placement is deliberate: all of it lives under `.builder/` in the STUDIO's
 * root, never inside a project repo. The project repo is the customer's code
 * (§2.1, §4.6) — exporting it must not drag our session transcripts along, and
 * §7.1 already draws the line: conversation is DO state, the workspace is
 * disposable.
 *
 *   .builder/projects.json     — the registry (id → name, dir, timestamps)
 *   .builder/projects/<dir>/   — the project repos (own git each, §4.6)
 *   .builder/state/<id>.json   — per-project chat history + turn counter
 *
 * Ids are ULIDs (the platform convention — kernel `ulid()`), so sorting by id
 * is sorting by creation time. The directory name is derived from the first
 * name but NEVER renamed afterwards: a rename is a registry edit, not a
 * filesystem move of a live git repo.
 */
import { ulid } from '@substrat-run/kernel';
import type { GeneratorTurn } from '@substrat-run/builder-generator';
import type { Workspace } from '@substrat-run/builder-workspace';

export type NameSource = 'auto' | 'ai' | 'user';

export interface ProjectEntry {
	readonly id: string;
	name: string;
	/** Who last named it — an AI suggestion never overwrites a user's choice. */
	nameSource: NameSource;
	/** Repo-root-relative project dir. Stable for the project's lifetime. */
	readonly dir: string;
	readonly createdAt: string;
	updatedAt: string;
}

interface Registry {
	currentId: string | null;
	projects: ProjectEntry[];
}

const REGISTRY = '.builder/projects.json';

export async function loadRegistry(ws: Workspace): Promise<Registry> {
	if (!(await ws.exists(REGISTRY))) return { currentId: null, projects: [] };
	try {
		return JSON.parse(await ws.readFile(REGISTRY)) as Registry;
	} catch {
		return { currentId: null, projects: [] };
	}
}

export async function saveRegistry(ws: Workspace, reg: Registry): Promise<void> {
	await ws.mkdir('.builder', { recursive: true });
	await ws.writeFile(REGISTRY, `${JSON.stringify(reg, null, '\t')}\n`);
}

export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'project';
}

/** Creates a registry entry; the caller decides the dir (usually from the name). */
export function newEntry(name: string, dir: string, nameSource: NameSource): ProjectEntry {
	const now = new Date().toISOString();
	return { id: ulid(), name, nameSource, dir, createdAt: now, updatedAt: now };
}

export function touch(entry: ProjectEntry): void {
	entry.updatedAt = new Date().toISOString();
}

/**
 * Renames respecting provenance: 'ai' applies only while the name is still
 * automatic — the model proposing a name must never clobber one the builder
 * typed. 'user' always wins and locks.
 */
export function rename(entry: ProjectEntry, name: string, source: NameSource): boolean {
	if (source === 'ai' && entry.nameSource === 'user') return false;
	entry.name = name;
	entry.nameSource = source;
	touch(entry);
	return true;
}

// ── per-project session state (chat history) ─────────────────────────────────

export interface ProjectState {
	history: GeneratorTurn[];
	turnNo: number;
	/**
	 * Red-gate report from the last completed turn (gates.ts `gateReport`).
	 * Present only while the tree is red; fed into the next turn's context so
	 * the model never opens a turn blind to its own oracle.
	 */
	lastGateReport?: string;
}

function stateFile(id: string): string {
	return `.builder/state/${id}.json`;
}

export async function loadState(ws: Workspace, id: string): Promise<ProjectState> {
	if (!(await ws.exists(stateFile(id)))) return { history: [], turnNo: 0 };
	try {
		return JSON.parse(await ws.readFile(stateFile(id))) as ProjectState;
	} catch {
		return { history: [], turnNo: 0 };
	}
}

export async function saveState(ws: Workspace, id: string, state: ProjectState): Promise<void> {
	await ws.mkdir('.builder/state', { recursive: true });
	await ws.writeFile(stateFile(id), `${JSON.stringify(state, null, '\t')}\n`);
}
