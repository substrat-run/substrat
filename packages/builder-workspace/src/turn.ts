/**
 * The turn loop — builder-studio.md §3, §4.2, §4.6.
 *
 * This is where behaviour that must hold in BOTH run modes lives: above the
 * `Workspace` seam, so neither implementation can drift. Commit-per-turn is the
 * load-bearing example (§4.2).
 *
 * Two git modes, decided by where the vertical's repo boundary sits:
 *
 * - **Project mode** (the default, §4.6): the vertical directory contains its
 *   OWN `.git` — a separate repository, gitignored by any surrounding checkout.
 *   This is the local materialization of D-52's repo-per-vertical: the studio's
 *   commits can never touch anyone else's history because the repo boundary IS
 *   the project. `git add -A` inside it is safe by construction.
 *
 * - **Legacy scoped mode**: the vertical lives inside a larger repo (demos/*).
 *   Commits are then path-scoped, because the tree may hold unrelated work.
 *   Kept for running the gates over monorepo demos; new projects never use it.
 */
import { runGates, type GateRun, type GateSpec } from './gates.js';
import type { Workspace } from './workspace.js';

const BOT_NAME = 'Substrat Builder Studio';
const BOT_EMAIL = 'builder@substrat.run';

/** Where git commands run and what they may stage. */
interface GitCtx {
	/** cwd for git, relative to the workspace root. */
	readonly cwd: string;
	/** pathspec for staging/status: '.' in project mode, the dir in scoped mode. */
	readonly scope: string;
	readonly mode: 'project' | 'scoped';
}

async function gitCtx(ws: Workspace, verticalDir: string): Promise<GitCtx> {
	if (await ws.exists(`${verticalDir}/.git`)) {
		return { cwd: verticalDir, scope: '.', mode: 'project' };
	}
	return { cwd: '.', scope: verticalDir, mode: 'scoped' };
}

export interface EnsureRepoResult {
	readonly mode: 'project' | 'scoped';
	/** Set when a fresh repo was initialised this call. */
	readonly initialized: boolean;
}

/**
 * Makes the vertical directory a self-contained git repository, initialising one
 * on first use. Refuses to nest a repo inside files the PARENT repo tracks —
 * a tracked directory (demos/callout) is monorepo territory and gets scoped
 * mode, never a nested repo that would shadow tracked files.
 */
export async function ensureVerticalRepo(
	ws: Workspace,
	verticalDir: string,
): Promise<EnsureRepoResult> {
	if (await ws.exists(`${verticalDir}/.git`)) return { mode: 'project', initialized: false };

	// Tracked by a surrounding repo? Then it is not ours to convert.
	const tracked = await ws.exec(`git ls-files -- ${JSON.stringify(verticalDir)}`);
	if (tracked.exitCode === 0 && tracked.stdout.trim() !== '') {
		return { mode: 'scoped', initialized: false };
	}

	await ws.mkdir(verticalDir, { recursive: true });
	const init = await ws.exec('git init -q', { cwd: verticalDir });
	if (init.exitCode !== 0) {
		throw new Error(`git init failed in ${verticalDir}: ${init.stderr || init.stdout}`);
	}
	// The project's own ignores — build noise, never source.
	await ws.writeFile(
		`${verticalDir}/.gitignore`,
		['node_modules/', 'dist/', '.data/', '*.log', ''].join('\n'),
	);
	await ws.exec(
		`git -c user.name='${BOT_NAME}' -c user.email='${BOT_EMAIL}' add -A && ` +
			`git -c user.name='${BOT_NAME}' -c user.email='${BOT_EMAIL}' commit -q -m 'studio: project created'`,
		{ cwd: verticalDir },
	);
	return { mode: 'project', initialized: true };
}

/** Working-tree changes for the vertical, whichever mode its repo is in. */
export async function changedFiles(ws: Workspace, verticalDir?: string): Promise<string[]> {
	const ctx = verticalDir ? await gitCtx(ws, verticalDir) : { cwd: '.', scope: '.', mode: 'scoped' as const };
	const { stdout, exitCode } = await ws.exec(
		`git status --porcelain -- ${JSON.stringify(ctx.scope)}`,
		{ cwd: ctx.cwd },
	);
	if (exitCode !== 0) return [];
	return stdout
		.split('\n')
		.map((l) => l.slice(3).trim())
		.filter(Boolean);
}

/**
 * Changes outside the vertical that the studio must leave alone. Only meaningful
 * in scoped mode — a project repo cannot contain foreign work by construction,
 * which is the whole point of §4.6's separate-repo model.
 */
export async function foreignChanges(ws: Workspace, verticalDir: string): Promise<string[]> {
	const ctx = await gitCtx(ws, verticalDir);
	if (ctx.mode === 'project') return [];
	const all = await changedFiles(ws);
	const mine = new Set(await changedFiles(ws, verticalDir));
	return all.filter((f) => !mine.has(f));
}

export interface CommitOptions {
	readonly message: string;
	readonly verticalDir: string;
	readonly authorName?: string;
	readonly authorEmail?: string;
}

/**
 * Commits the turn. In project mode this commits everything in the project repo;
 * in scoped mode only the vertical's path. Never amends, never force-pushes:
 * the repo is the durable tier (§2) and history is append-only.
 */
export async function commitTurn(ws: Workspace, opts: CommitOptions): Promise<string | null> {
	const ctx = await gitCtx(ws, opts.verticalDir);
	const files = await changedFiles(ws, opts.verticalDir);
	if (files.length === 0) return null;

	const name = opts.authorName ?? BOT_NAME;
	const email = opts.authorEmail ?? BOT_EMAIL;

	await ws.exec(`git add -- ${JSON.stringify(ctx.scope)}`, { cwd: ctx.cwd });
	const message = opts.message.replace(/'/g, "'\\''");
	const commit = await ws.exec(
		`git -c user.name='${name}' -c user.email='${email}' commit -q -m '${message}'`,
		{ cwd: ctx.cwd },
	);
	if (commit.exitCode !== 0) {
		throw new Error(`commit failed (${commit.exitCode}): ${commit.stderr || commit.stdout}`);
	}

	const rev = await ws.exec('git rev-parse HEAD', { cwd: ctx.cwd });
	return rev.exitCode === 0 ? rev.stdout.trim() : null;
}

export interface TurnResult {
	readonly gates: GateRun;
	readonly commit: string | null;
	readonly changedFiles: readonly string[];
}

export interface RunTurnOptions {
	readonly verticalDir: string;
	readonly message: string;
	readonly gates?: readonly GateSpec[];
	/**
	 * Commit even when gates are red. Defaults to true: a red turn is exactly the
	 * state you most want recoverable (§4.2 — an uncommitted red tree is lost on
	 * container sleep). The verdict goes in the commit trailer instead.
	 */
	readonly commitOnRed?: boolean;
	readonly onGateResult?: Parameters<typeof runGates>[3];
}

/** Run the gates, then commit. Call after every generator turn. */
export async function runTurn(ws: Workspace, opts: RunTurnOptions): Promise<TurnResult> {
	const gates = await runGates(ws, opts.verticalDir, opts.gates, opts.onGateResult);
	const files = await changedFiles(ws, opts.verticalDir);

	const shouldCommit = files.length > 0 && (gates.ok || (opts.commitOnRed ?? true));
	const trailer = gates.ok ? 'gates: green' : 'gates: red';
	const commit = shouldCommit
		? await commitTurn(ws, {
				message: `${opts.message}\n\n${trailer}`,
				verticalDir: opts.verticalDir,
			})
		: null;

	return { gates, commit, changedFiles: files };
}

/** True when the workspace root itself is a git repo (scoped-mode precondition). */
export async function isGitRepo(ws: Workspace): Promise<boolean> {
	const { exitCode } = await ws.exec('git rev-parse --is-inside-work-tree');
	return exitCode === 0;
}

/**
 * A cheap project map for the generator's per-turn context: file list, recent
 * commits, last diffstat. Costs three git commands; saves the model from
 * re-discovering the project with list_files/read_file every turn (the
 * "it starts by indexing everything" cost). Volatile by nature — hosts place it
 * after the prompt-cache breakpoints, never inside the stable prefix.
 */
export async function workspaceBrief(ws: Workspace, verticalDir: string): Promise<string> {
	const ctx = (await ws.exists(`${verticalDir}/.git`))
		? { cwd: verticalDir, scope: '.' }
		: { cwd: '.', scope: verticalDir };
	const run = async (cmd: string): Promise<string> =>
		(await ws.exec(cmd, { cwd: ctx.cwd })).stdout.trim();
	const files = await run(`git ls-files -- ${JSON.stringify(ctx.scope)}`);
	const log = await run('git log --oneline -3');
	const diff = await run('git diff --stat HEAD~1..HEAD 2>/dev/null || true');
	return [
		`Files:\n${files || '(none yet — fresh project)'}`,
		`Recent commits:\n${log || '(none)'}`,
		...(diff ? [`Changed last turn:\n${diff}`] : []),
	].join('\n\n');
}
