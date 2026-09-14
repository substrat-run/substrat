/**
 * `LocalWorkspace` — mode A (builder-studio.md §3.1). No container runtime of any
 * kind: `exec` is `child_process`, file ops are `node:fs`, ports are localhost.
 *
 * This is the reference implementation, not a fallback: §1 establishes that the
 * local loop came first and the hosted one is the port. It is also how `evals/`
 * runs (§9.6) — an eval suite that needs a container runtime is one that gets run
 * once a quarter.
 *
 * SECURITY (§10, honest limits): mode A has NO isolation. This class holds the
 * agent's shell access to the machine, so the root is a hard boundary enforced on
 * every path, and callers are expected to point it at a scratch clone rather than
 * a working checkout. That is a mitigation, not a sandbox.
 *
 * Harness code — `node:*` imports are expected here and this file is never
 * reachable from a ModuleRegistration.
 */
import { spawn } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecOptions, ExecResult, ExposedPort, Workspace } from './workspace.js';
import { WorkspacePathError } from './workspace.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** How many links a path may pass through before it is a loop rather than a path. */
const MAX_LINK_HOPS = 32;

/**
 * Where a path really points, resolving as much of it as exists.
 *
 * `realpathSync` throws on a path that is not there yet, which every write to a new
 * file is. So it walks up to the nearest existing ancestor and resolves that: the
 * segments below cannot be symlinks, because they do not exist.
 *
 * Except when one of them is a link to NOWHERE. `realpath` reports a dangling symlink
 * as `ENOENT` too, and a walk that read every failure as "not there" then treated the
 * link as an absent segment and returned its lexical, in-root path — while `writeFile`
 * followed the link and created its target outside the root. So a failed segment is
 * asked, with `lstat`, whether it is there after all: a link is followed by hand,
 * relative to its own directory, and the walk continues from where it points. A
 * segment that exists, is not a link, and still will not resolve is not ours to
 * guess at — that error propagates, because a jail that guesses is not one.
 */
function realpathOfNearest(full: string, hops = 0): string {
	let cur = full;
	for (;;) {
		try {
			const real = realpathSync(cur);
			return cur === full ? real : join(real, relative(cur, full));
		} catch (err) {
			const link = danglingLinkTarget(cur, err);
			if (link !== null) {
				if (hops >= MAX_LINK_HOPS) throw new Error(`too many levels of symbolic links: ${full}`);
				const rest = relative(cur, full);
				return realpathOfNearest(rest ? join(link, rest) : link, hops + 1);
			}
			const parent = dirname(cur);
			// The filesystem root has no parent; nothing above it to ask about.
			if (parent === cur) return full;
			cur = parent;
		}
	}
}

/**
 * Where a symlink that `realpath` could not resolve points — an absolute path, or
 * `null` when the segment genuinely does not exist. Any other state rethrows the
 * original `realpath` error.
 */
function danglingLinkTarget(path: string, realpathError: unknown): string | null {
	let isLink: boolean;
	try {
		isLink = lstatSync(path).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	if (!isLink) throw realpathError;
	return resolve(dirname(path), readlinkSync(path));
}

export interface LocalWorkspaceOptions {
	/** Absolute path to the workspace root. Every path is resolved inside it. */
	readonly root: string;
	readonly id?: string;
	/**
	 * Environment for `exec`. Deliberately NOT `process.env` by default: the
	 * studio process holds provider credentials and the agent's shell must not
	 * inherit them (§5.3 — no credential reaches the tool surface).
	 */
	readonly env?: Readonly<Record<string, string>>;
	readonly defaultTimeoutMs?: number;
}

/** The env an agent command gets when the caller supplies none. */
function minimalEnv(): Record<string, string> {
	const { PATH, HOME, SHELL, LANG, TMPDIR } = process.env;
	return {
		PATH: PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: HOME ?? '',
		SHELL: SHELL ?? '/bin/sh',
		LANG: LANG ?? 'en_US.UTF-8',
		...(TMPDIR ? { TMPDIR } : {}),
		CI: '1',
	};
}

export class LocalWorkspace implements Workspace {
	readonly id: string;
	readonly #root: string;
	readonly #rootReal: string;
	readonly #env: Record<string, string>;
	readonly #timeoutMs: number;

	constructor(opts: LocalWorkspaceOptions) {
		this.#root = resolve(opts.root);
		// The ROOT's own real path: a scratch root is routinely reached through a link
		// (`/var/folders/...` is `/private/var/folders/...` on macOS), and comparing a
		// realpath against a lexical root would then reject every path in the workspace.
		this.#rootReal = realpathOfNearest(this.#root);
		this.id = opts.id ?? `local:${this.#root}`;
		this.#env = { ...(opts.env ?? minimalEnv()) };
		this.#timeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	get root(): string {
		return this.#root;
	}

	/**
	 * The path boundary. Rejects absolute paths, anything that climbs out with
	 * `..`, and anything that leaves the root through a SYMLINK.
	 *
	 * The symlink half needs `realpath` and used to say it did not. `resolve()` is
	 * purely lexical — it normalises `..` and never looks at the filesystem — so a
	 * link inside the root pointing anywhere on the machine resolved to a path
	 * inside the root and was allowed through, while the comment here claimed the
	 * opposite. Verified rather than reasoned about: a link at `<root>/escape.txt`
	 * → `../outside.txt` read the outside file.
	 *
	 * For mode A that was defence in depth rather than a breach — `exec` runs
	 * `shell: true` on the host, so an agent that can run a command can already
	 * read anything this would have stopped. It still mattered, because a guard
	 * that ADVERTISES a protection invites a caller to lean on it: the next
	 * surface to hand this a path from somewhere less trusted would have been
	 * relying on a check that was not happening.
	 *
	 * A path that does not exist yet — every `writeFile` to a new file — has no
	 * realpath, so the nearest existing ancestor is resolved instead. That is the
	 * component a symlink could have redirected; the segments below it cannot be
	 * links, because they do not exist.
	 */
	#resolve(path: string): string {
		if (isAbsolute(path)) throw new WorkspacePathError(path, 'absolute paths are not allowed');
		const full = resolve(this.#root, path);
		// Each check against its OWN base. The lexical path is compared with the
		// lexical root and the real path with the real one: a scratch root is routinely
		// reached through a link (`/var/folders/…` is `/private/var/folders/…` on
		// macOS), so crossing them rejects every path in the workspace — which is what
		// the first version of this did, and what the first test below catches.
		this.#assertWithin(path, full, this.#root);
		// Then the same question of where it REALLY points.
		this.#assertWithin(path, realpathOfNearest(full), this.#rootReal);
		return full;
	}

	/** Containment: `full` is `base` or below it. */
	#assertWithin(path: string, full: string, base: string): void {
		const rel = relative(base, full);
		if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
			throw new WorkspacePathError(path, 'escapes the workspace root');
		}
	}

	async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const cwd = opts.cwd ? this.#resolve(opts.cwd) : this.#root;
		const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
		const env = { ...this.#env, ...(opts.env ?? {}) };

		return await new Promise<ExecResult>((res) => {
			const child = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			let timedOut = false;

			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, timeoutMs);

			child.stdout.on('data', (c: Buffer) => {
				stdout += c.toString();
			});
			child.stderr.on('data', (c: Buffer) => {
				stderr += c.toString();
			});
			child.on('error', (err) => {
				clearTimeout(timer);
				res({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127 });
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				res({
					stdout,
					stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]` : stderr,
					exitCode: timedOut ? 124 : (code ?? 0),
				});
			});
		});
	}

	async readFile(path: string): Promise<string> {
		return await readFile(this.#resolve(path), 'utf8');
	}

	async writeFile(path: string, content: string): Promise<void> {
		const full = this.#resolve(path);
		await mkdir(full.slice(0, full.lastIndexOf(sep)), { recursive: true });
		await writeFile(full, content, 'utf8');
	}

	async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
		await mkdir(this.#resolve(path), { recursive: opts.recursive ?? true });
	}

	async listFiles(path: string): Promise<string[]> {
		const entries = await readdir(this.#resolve(path), { withFileTypes: true });
		return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
	}

	async exists(path: string): Promise<boolean> {
		try {
			await stat(this.#resolve(path));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Mode A has nothing to expose — the dev server is already listening on the
	 * host. Port ALLOCATION (so concurrent sessions do not collide) is the turn
	 * loop's job via `PORT`/`WEB_PORT`, not the workspace's.
	 */
	async exposePort(port: number): Promise<ExposedPort> {
		return { port, url: `http://127.0.0.1:${port}` };
	}

	/** Nothing to tear down: the checkout outlives the session by design (§2). */
	async dispose(): Promise<void> {}
}

/** Convenience for evals and tests: a workspace over an existing checkout. */
export function localWorkspace(root: string, opts: Omit<LocalWorkspaceOptions, 'root'> = {}): LocalWorkspace {
	return new LocalWorkspace({ ...opts, root: join(root) });
}
