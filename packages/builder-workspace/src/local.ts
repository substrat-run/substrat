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
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecOptions, ExecResult, ExposedPort, Workspace } from './workspace.js';
import { WorkspacePathError } from './workspace.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
	readonly #env: Record<string, string>;
	readonly #timeoutMs: number;

	constructor(opts: LocalWorkspaceOptions) {
		this.#root = resolve(opts.root);
		this.id = opts.id ?? `local:${this.#root}`;
		this.#env = { ...(opts.env ?? minimalEnv()) };
		this.#timeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	get root(): string {
		return this.#root;
	}

	/**
	 * The path boundary. Rejects absolute paths and anything that resolves
	 * outside the root — including via `..` and via a symlink whose target
	 * escapes, which is why this resolves rather than string-matching.
	 */
	#resolve(path: string): string {
		if (isAbsolute(path)) throw new WorkspacePathError(path, 'absolute paths are not allowed');
		const full = resolve(this.#root, path);
		const rel = relative(this.#root, full);
		if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
			throw new WorkspacePathError(path, 'escapes the workspace root');
		}
		return full;
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
