/**
 * Client for the studio API. Types come from the real packages (type-only, so
 * nothing server-side lands in the bundle) — the UI renders the same
 * `BuildEvent` union the terminal does (§5.2: the union is the boundary).
 */
import type { BuildEvent, PlanAssumption } from '@substrat-run/builder-generator';
import type { GateRun } from '@substrat-run/builder-workspace';

export type { BuildEvent, GateRun, PlanAssumption };

/** Derived from the event union so the UI cannot drift from the server's ladder. */
export type BuildPhase = Extract<BuildEvent, { type: 'phase' }>['phase'];

export interface ProjectInfo {
	id: string;
	name: string;
	nameSource: 'auto' | 'ai' | 'user';
	dir: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionInfo {
	root: string;
	vertical: string;
	project: Pick<ProjectInfo, 'id' | 'name' | 'nameSource'>;
	/** 'project' = the vertical is its own git repo (§4.6); 'scoped' = legacy demos/*. */
	repoMode: 'project' | 'scoped';
	/** The build-phase ladder position — a workspace fact, computed server-side
	 * (interview: no spec/concept.md; scaffold: no src/module.ts yet; iterate).
	 * Null from the hosted host before the project's first turn. */
	phase: BuildPhase | null;
	modelSpec: string;
	endpoint?: string;
	endpointSource?: string;
	modelError: string | null;
	envFiles: string[];
	busy: boolean;
	turns: number;
	foreign: string[];
	mode: string;
}

export interface ProviderEntry {
	name: string;
	kind: 'direct' | 'compatible';
	hosting: { vendor: string; location: string; host: string; dataNote: string };
	credential: { envVar: string | null; set: boolean };
	listable: boolean;
	suggested: string[];
}

async function j<T>(res: Response): Promise<T> {
	const body = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body;
}

export interface UsageDay {
	date: string;
	input: number;
	output: number;
}

export interface UsageByProject {
	projectId: string;
	input: number;
	output: number;
	turns: number;
}

export interface UsageReport {
	totals: { input: number; output: number };
	daily: UsageDay[];
	byProject: UsageByProject[];
	windowDays: number;
	generatedAt: string;
}

export const api = {
	session: () => fetch('/api/session').then((r) => j<SessionInfo>(r)),
	usage: () => fetch('/api/usage').then((r) => j<UsageReport>(r)),
	providers: () => fetch('/api/providers').then((r) => j<ProviderEntry[]>(r)),
	models: (provider: string) =>
		fetch(`/api/models?provider=${encodeURIComponent(provider)}`).then((r) =>
			j<{ models: string[] }>(r),
		),
	setModel: (spec: string) =>
		fetch('/api/model', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ spec }),
		}).then((r) => j<{ spec: string; endpoint?: string }>(r)),
	history: () =>
		fetch('/api/history').then((r) => j<Array<{ role: 'user' | 'assistant'; text: string }>>(r)),
	projects: () =>
		fetch('/api/projects').then((r) => j<{ current: string; projects: ProjectInfo[] }>(r)),
	createProject: (name?: string) =>
		fetch('/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name }),
		}).then((r) => j<ProjectInfo>(r)),
	selectProject: (id: string) =>
		fetch('/api/projects/select', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id }),
		}).then((r) => j<ProjectInfo>(r)),
	renameProject: (name: string) =>
		fetch('/api/project', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name }),
		}).then((r) => j<ProjectInfo>(r)),
	files: (path: string) =>
		fetch(`/api/files?path=${encodeURIComponent(path)}`).then((r) => j<{ entries: string[] }>(r)),
	file: (path: string) =>
		fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => j<{ content: string }>(r)),
	saveFile: (path: string, content: string) =>
		fetch('/api/file', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path, content }),
		}).then((r) => j<{ ok: boolean }>(r)),
	gates: () => fetch('/api/gates', { method: 'POST' }).then((r) => j<GateRun>(r)),
	abort: () => fetch('/api/abort', { method: 'POST' }),
	devStatus: () =>
		fetch('/api/dev').then((r) =>
			j<{
				state: 'stopped' | 'starting' | 'running' | 'error';
				url: string | null;
				apiPort: number | null;
				webPort: number | null;
				log: string[];
			}>(r),
		),
	dev: (action: 'start' | 'stop') =>
		fetch('/api/dev', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action }),
		}).then((r) => j<{ state: string }>(r)),
	metric: (data: Record<string, unknown>) =>
		fetch('/api/metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(data),
		}).catch(() => undefined),
};

/**
 * Run a turn, invoking `onEvent` for each NDJSON line as it arrives.
 * The stream is the DO-WebSocket analog (§7.1); on Cloudflare this function is
 * the only thing that changes shape.
 */
export async function streamTurn(
	message: string,
	onEvent: (e: BuildEvent) => void,
	/** Called on EVERY received chunk, heartbeats included — the liveness signal.
	 * Events prove progress; activity only proves the request is still alive. */
	onActivity?: () => void,
): Promise<void> {
	const res = await fetch('/api/turn', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	if (!res.ok || !res.body) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		onActivity?.();
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim()) onEvent(JSON.parse(line) as BuildEvent);
		}
	}
	if (buffer.trim()) onEvent(JSON.parse(buffer) as BuildEvent);
}
