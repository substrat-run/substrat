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
	/** The `<provider>:auto` pair — fast (interview) + strong (build) — when declared. */
	pair?: { fast: string; strong: string };
}

/** A team (= tenant, dashboard-teams.md) the signed-in user builds for. */
export interface TeamInfo {
	id: string;
	slug: string;
	name: string;
}

export interface MeInfo {
	email: string | null;
	teams: TeamInfo[];
}

/**
 * The team every API call acts in — hosted mode only. `App` pins it after
 * `/api/me` resolves (from the URL's team slug); the local server (mode A) has
 * no teams, so it stays null there and requests carry no header.
 */
let teamId: string | null = null;
export function setApiTeam(id: string | null): void {
	teamId = id;
}

/** All studio calls go through here: `fetch` + the team-selection header. */
function f(input: string, init?: RequestInit): Promise<Response> {
	if (!teamId) return window.fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set('x-substrat-tenant', teamId);
	return window.fetch(input, { ...init, headers });
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

export interface UsageByModel {
	/** Normalized `provider:modelId`; null for entries recorded before the model dimension existed. */
	model: string | null;
	input: number;
	output: number;
	/** Cache slices of `input`, when the provider reported them (0 otherwise). Optional: older API responses predate them. */
	cacheRead?: number;
	cacheWrite?: number;
	/** USD decimal strings; null when the model has no rate card entry. */
	listUsd: string | null;
	billedUsd: string | null;
}

export interface UsageReport {
	totals: { input: number; output: number };
	daily: UsageDay[];
	byProject: UsageByProject[];
	byModel: UsageByModel[];
	cost: { listUsd: string; billedUsd: string; unpricedTokens: number };
	markupPercent: number;
	windowDays: number;
	generatedAt: string;
}

export const api = {
	/**
	 * Who am I + which teams. Null means "no team scoping here": the local
	 * server (mode A) has no such route and 404s. Anything else non-OK is a
	 * real error (a hosted studio that cannot resolve memberships must say so,
	 * not quietly behave like local mode and then 400 on every call).
	 */
	me: async (): Promise<MeInfo | null> => {
		const r = await f('/api/me');
		if (r.status === 404) return null;
		return j<MeInfo>(r);
	},
	session: () => f('/api/session').then((r) => j<SessionInfo>(r)),
	usage: () => f('/api/usage').then((r) => j<UsageReport>(r)),
	providers: () => f('/api/providers').then((r) => j<ProviderEntry[]>(r)),
	models: (provider: string) =>
		f(`/api/models?provider=${encodeURIComponent(provider)}`).then((r) =>
			j<{ models: string[] }>(r),
		),
	setModel: (spec: string) =>
		f('/api/model', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ spec }),
		}).then((r) => j<{ spec: string; endpoint?: string }>(r)),
	history: () =>
		f('/api/history').then((r) => j<Array<{ role: 'user' | 'assistant'; text: string }>>(r)),
	projects: () =>
		f('/api/projects').then((r) => j<{ current: string; projects: ProjectInfo[] }>(r)),
	createProject: (name?: string) =>
		f('/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name }),
		}).then((r) => j<ProjectInfo>(r)),
	selectProject: (id: string) =>
		f('/api/projects/select', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id }),
		}).then((r) => j<ProjectInfo>(r)),
	renameProject: (name: string) =>
		f('/api/project', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name }),
		}).then((r) => j<ProjectInfo>(r)),
	files: (path: string) =>
		f(`/api/files?path=${encodeURIComponent(path)}`).then((r) => j<{ entries: string[] }>(r)),
	file: (path: string) =>
		f(`/api/file?path=${encodeURIComponent(path)}`).then((r) => j<{ content: string }>(r)),
	saveFile: (path: string, content: string) =>
		f('/api/file', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path, content }),
		}).then((r) => j<{ ok: boolean }>(r)),
	gates: () => f('/api/gates', { method: 'POST' }).then((r) => j<GateRun>(r)),
	abort: () => f('/api/abort', { method: 'POST' }),
	devStatus: () =>
		f('/api/dev').then((r) =>
			j<{
				state: 'stopped' | 'starting' | 'running' | 'error';
				url: string | null;
				apiPort: number | null;
				webPort: number | null;
				log: string[];
			}>(r),
		),
	dev: (action: 'start' | 'stop') =>
		f('/api/dev', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action }),
		}).then((r) => j<{ state: string }>(r)),
	metric: (data: Record<string, unknown>) =>
		f('/api/metrics', {
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
	const res = await f('/api/turn', {
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
