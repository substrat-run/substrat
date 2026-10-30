/**
 * `ContainerWorkspace` — mode C (builder-studio.md §3.1, #626): the same
 * `Workspace` seam over a Cloudflare Sandbox container.
 *
 * Deliberately typed against a STRUCTURAL `SandboxLike`, not `@cloudflare/sandbox`:
 * this package is consumed by node processes (the local server, evals) that must
 * never pull worker-only dependencies, and the seam's whole point is that the
 * interface is ours. The worker constructs the real sandbox stub and hands it in;
 * this class contributes what the stub does not have — the PROJECT ROOT and the
 * path guard, so the generator's confinement (§5.3) holds identically in both
 * modes: paths are relative, escapes throw, and nothing above the project is
 * reachable through the tool surface.
 *
 * Mapping (documented since the first spike, now real):
 *   LocalWorkspace child_process  →  sandbox.exec
 *   node:fs                       →  sandbox file API
 *   localhost ports               →  sandbox.exposePort preview URLs (§4.3)
 */
import type { ExecOptions, ExecResult, ExposedPort, Workspace } from './workspace.js';
import { WorkspacePathError } from './workspace.js';

/** The slice of @cloudflare/sandbox this class needs — structural, versionless. */
export interface SandboxLike {
	exec(cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	readFile(path: string): Promise<{ content: string } | string>;
	writeFile(path: string, content: string): Promise<unknown>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
	listFiles(path: string): Promise<{ files: Array<{ name: string; type?: string }> } | string[]>;
	exposePort(port: number, opts?: { hostname?: string }): Promise<{ url: string }>;
}

export interface ContainerWorkspaceOptions {
	readonly sandbox: SandboxLike;
	/** Absolute project root inside the container, e.g. /workspace/substrat/.builder/projects/x */
	readonly root: string;
	readonly id?: string;
	/** Host-owned checker binaries, outside the disposable source repository. */
	readonly toolchainRoot?: string;
	readonly defaultTimeoutMs?: number;
}

/** POSIX-only path guard — same rules as LocalWorkspace, no node:path needed. */
function resolveWithin(root: string, path: string): string {
	if (path.startsWith('/')) throw new WorkspacePathError(path, 'absolute paths are not allowed');
	const parts: string[] = [];
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (parts.length === 0) throw new WorkspacePathError(path, 'escapes the workspace root');
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.length ? `${root}/${parts.join('/')}` : root;
}

export class ContainerWorkspace implements Workspace {
	readonly id: string;
	readonly #sb: SandboxLike;
	readonly #root: string;
	readonly #toolchainRoot?: string;

	constructor(opts: ContainerWorkspaceOptions) {
		this.#sb = opts.sandbox;
		this.#root = opts.root.replace(/\/+$/, '');
		this.#toolchainRoot = opts.toolchainRoot?.replace(/\/+$/, '');
		this.id = opts.id ?? `container:${this.#root}`;
	}

	get root(): string {
		return this.#root;
	}

	async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const cwd = opts.cwd ? resolveWithin(this.#root, opts.cwd) : this.#root;
		if (this.#toolchainRoot) {
			const quote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
			const tool = /^pnpm exec tsx tools\/(model-diff|permission-diff|api-diff)\.mts(?=\s|$)/.exec(cmd);
			if (tool) {
				cmd = `${quote(`${this.#toolchainRoot}/node_modules/.bin/tsx`)} ${quote(`${this.#toolchainRoot}/tools/${tool[1]}.mts`)}${cmd.slice(tool[0].length)}`;
			} else if (cmd.startsWith('node packages/boundary-lint/dist/cli.js ')) {
				cmd = `node ${quote(`${this.#toolchainRoot}/packages/boundary-lint/dist/cli.js`)}${cmd.slice('node packages/boundary-lint/dist/cli.js'.length)}`;
			} else if (cmd.startsWith('pnpm exec tsc ')) {
				cmd = `${quote(`${this.#toolchainRoot}/node_modules/.bin/tsc`)}${cmd.slice('pnpm exec tsc'.length)}`;
			}
		}
		// env vars ride the command line: the sandbox exec has no env option in
		// our structural slice, and the generator never passes secrets (§5.3).
		const envPrefix = Object.entries(opts.env ?? {})
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(' ');
		const full = envPrefix ? `${envPrefix} ${cmd}` : cmd;
		try {
			const r = await this.#sb.exec(full, { cwd });
			return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		} catch (err) {
			return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 127 };
		}
	}

	async readFile(path: string): Promise<string> {
		const r = await this.#sb.readFile(resolveWithin(this.#root, path));
		return typeof r === 'string' ? r : r.content;
	}

	async writeFile(path: string, content: string): Promise<void> {
		const full = resolveWithin(this.#root, path);
		const dir = full.slice(0, full.lastIndexOf('/'));
		if (dir && dir !== this.#root) await this.#sb.mkdir(dir, { recursive: true });
		await this.#sb.writeFile(full, content);
	}

	async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
		await this.#sb.mkdir(resolveWithin(this.#root, path), { recursive: opts.recursive ?? true });
	}

	async listFiles(path: string): Promise<string[]> {
		const r = await this.#sb.listFiles(resolveWithin(this.#root, path));
		if (Array.isArray(r)) return [...r].sort();
		return r.files
			.map((f) => (f.type === 'directory' ? `${f.name}/` : f.name))
			.sort();
	}

	async exists(path: string): Promise<boolean> {
		// The structural slice has no stat; a shell test is the portable answer.
		const r = await this.exec(`test -e ${JSON.stringify(resolveWithin(this.#root, path))}`, {
			cwd: '.',
		});
		return r.exitCode === 0;
	}

	/** `exec` runs the repo tools from the toolchain root when there is one, so look there. */
	async hasTool(path: string): Promise<boolean> {
		if (!this.#toolchainRoot) return await this.exists(path);
		const r = await this.exec(`test -e ${JSON.stringify(resolveWithin(this.#toolchainRoot, path))}`, { cwd: '.' });
		return r.exitCode === 0;
	}

	async exposePort(port: number): Promise<ExposedPort> {
		const { url } = await this.#sb.exposePort(port);
		return { port, url };
	}

	/** The sandbox outlives the workspace object (it is a DO); nothing to do. */
	async dispose(): Promise<void> {}
}
