/**
 * The Run manager — starts/stops the generated app's dev processes (mode A).
 *
 * THE CONTAINER MAPPING, stated so the Cloudflare move stays a re-host:
 *   spawn(pnpm dev/web)   →  sandbox.exec() of the same scripts (§4.1)
 *   freePort() + localhost →  sandbox.exposePort() preview URL (§4.3)
 *   this in-memory state   →  BuilderAgent DO state; "Run" wakes the container
 *
 * Mode A honesty: these are plain child processes of the studio — no isolation
 * beyond what the app itself does (§3.1). Ports are allocated fresh per start so
 * a user's own terminal run of the same app never collides.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface DevStatus {
	readonly state: 'stopped' | 'starting' | 'running' | 'error';
	readonly url: string | null;
	readonly apiPort: number | null;
	readonly webPort: number | null;
	readonly startedAt: string | null;
	/** Tail of combined process output — the debugging surface when it breaks. */
	readonly log: readonly string[];
}

const MAX_LOG = 60;

interface Managed {
	projectDir: string;
	api: ChildProcess;
	web: ChildProcess;
	apiPort: number;
	webPort: number;
	startedAt: string;
	state: DevStatus['state'];
	log: string[];
}

let current: Managed | null = null;

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error('no port')));
			}
		});
	});
}

function pushLog(m: Managed, source: string, chunk: Buffer): void {
	for (const line of chunk.toString().split('\n')) {
		if (!line.trim()) continue;
		m.log.push(`[${source}] ${line}`);
	}
	if (m.log.length > MAX_LOG) m.log.splice(0, m.log.length - MAX_LOG);
}

function child(m: Managed, root: string, script: string, env: Record<string, string>): ChildProcess {
	const c = spawn('pnpm', ['--filter', `./${m.projectDir}`, script], {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	c.stdout?.on('data', (b: Buffer) => pushLog(m, script, b));
	c.stderr?.on('data', (b: Buffer) => pushLog(m, script, b));
	c.on('exit', (code) => {
		pushLog(m, script, Buffer.from(`exited with code ${code}`));
		// Either process dying while we thought we were up is an error state —
		// the liveness rule again: never report running without evidence.
		if (current === m && m.state !== 'stopped') m.state = 'error';
	});
	return c;
}

/** Poll the web port until Vite answers — "running" means proven reachable. */
async function waitReady(m: Managed, timeoutMs = 30_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (m.state === 'error') return;
		try {
			await fetch(`http://localhost:${m.webPort}/`, { signal: AbortSignal.timeout(1500) });
			m.state = 'running';
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 700));
		}
	}
	m.state = 'error';
	pushLog(m, 'studio', Buffer.from(`web port ${m.webPort} not reachable after ${timeoutMs}ms`));
}

export async function startDev(root: string, projectDir: string): Promise<DevStatus> {
	if (current && current.state !== 'stopped') await stopDev();

	const apiPort = await freePort();
	const webPort = await freePort();
	const m: Managed = {
		projectDir,
		apiPort,
		webPort,
		startedAt: new Date().toISOString(),
		state: 'starting',
		log: [],
		// Both ends read the same env pair — the generated apps follow the demo
		// convention (PORT moves the API, WEB_PORT the web, proxy bridges them).
		api: undefined as unknown as ChildProcess,
		web: undefined as unknown as ChildProcess,
	};
	const env = { PORT: String(apiPort), WEB_PORT: String(webPort) };
	m.api = child(m, root, 'dev', env);
	m.web = child(m, root, 'web', env);
	current = m;
	void waitReady(m);
	return devStatus();
}

export async function stopDev(): Promise<DevStatus> {
	const m = current;
	if (!m) return devStatus();
	m.state = 'stopped';
	for (const c of [m.api, m.web]) {
		try {
			c.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	}
	// tsx watch / vite exit fast on SIGTERM; escalate if they linger.
	setTimeout(() => {
		for (const c of [m.api, m.web]) {
			try {
				if (c.exitCode === null) c.kill('SIGKILL');
			} catch {
				/* already gone */
			}
		}
	}, 2_000).unref();
	return devStatus();
}

export function devStatus(): DevStatus {
	if (!current) {
		return { state: 'stopped', url: null, apiPort: null, webPort: null, startedAt: null, log: [] };
	}
	return {
		state: current.state,
		url: current.state === 'running' ? `http://localhost:${current.webPort}` : null,
		apiPort: current.apiPort,
		webPort: current.webPort,
		startedAt: current.startedAt,
		log: [...current.log],
	};
}

/** The studio exiting must not orphan the app's processes. */
process.on('exit', () => {
	if (current) {
		try {
			current.api.kill('SIGKILL');
			current.web.kill('SIGKILL');
		} catch {
			/* best effort */
		}
	}
});
