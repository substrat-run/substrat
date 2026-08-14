/**
 * The workspace seam — builder-studio.md §3.
 *
 * One interface, deliberately shaped to the Cloudflare Sandbox SDK's surface so
 * that the container implementation is a thin pass-through and the local one is
 * `child_process` + `node:fs`. Everything above this line (the generator, the
 * gates, the turn loop, the chat UI) is identical across run modes; everything
 * that differs lives below it.
 *
 * The rule that keeps the two honest (§3): anything that must hold in BOTH modes
 * belongs in the turn loop, above this seam — never in an implementation.
 * Commit-per-turn is the load-bearing example: §4.2's ephemeral disk forces it in
 * the hosted mode but not locally, so if it lived in `ContainerWorkspace` the
 * local mode would drift into long uncommitted sessions and the hosted path would
 * be the only one that ever broke.
 */

/** Result of a command. `exitCode` is the oracle — see gates.ts. */
export interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface ExecOptions {
	/** Relative to the workspace root. Defaults to the root. */
	readonly cwd?: string;
	/** Hard ceiling in ms; the implementation kills the process and returns a non-zero code. */
	readonly timeoutMs?: number;
	/** Extra environment. Implementations MUST NOT forward provider credentials (§5.3). */
	readonly env?: Readonly<Record<string, string>>;
}

/** A running service the workspace has made reachable. */
export interface ExposedPort {
	readonly port: number;
	/** Mode A: `http://127.0.0.1:<port>`. Mode C: the sandbox preview URL (§4.3). */
	readonly url: string;
}

/**
 * The seam. Paths are always POSIX-style and relative to the workspace root;
 * implementations reject absolute paths and any path escaping the root.
 */
export interface Workspace {
	/** Stable id for this workspace — the session id in hosted mode. */
	readonly id: string;

	exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
	listFiles(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	exposePort(port: number): Promise<ExposedPort>;
	dispose(): Promise<void>;
}

/** Thrown when a path escapes the workspace root, or is absolute. */
export class WorkspacePathError extends Error {
	constructor(path: string, reason: string) {
		super(`workspace path ${JSON.stringify(path)} rejected: ${reason}`);
		this.name = 'WorkspacePathError';
	}
}
