/**
 * The studio's local API server — the browser UI's backend in mode A.
 *
 * THIS PROCESS IS THE `BuilderAgent` DO OF §7.1, run locally. The mapping is
 * deliberate and 1:1 so the Cloudflare move is a re-host, not a rewrite:
 *
 *   this Node process        →  BuilderAgent Durable Object (Agents SDK)
 *   the project registry     →  DO state (projects, current, chat history)
 *   LocalWorkspace           →  ContainerWorkspace over the Sandbox DO
 *   NDJSON streaming         →  the DO's WebSocket
 *
 * It holds the provider credential and the turn loop; the workspace only ever
 * sees tool calls (§5.3). Binds to 127.0.0.1 — mode A has no isolation (§3.1)
 * and this must never listen on a routable interface.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
	AiSdkGenerator,
	historyMarker,
	type BuildEvent,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import {
	continuationPrompt,
	defaultGates,
	ensureVerticalRepo,
	foreignChanges,
	gateRepairPrompt,
	gateReport,
	LocalWorkspace,
	MAX_CONTINUATIONS,
	MAX_GATE_REPAIRS,
	repairNeeded,
	runGates,
	runTurn,
	snapshotWorkspace,
	standaloneGates,
	workspaceBrief,
	type GateSpec,
} from '@substrat-run/builder-workspace';
import { devStatus, startDev, stopDev } from './devserver.js';
import { loadEnvFiles } from './env.js';
import { providerCatalog } from './hosting.js';
import {
	loadRegistry,
	loadState,
	newEntry,
	rename,
	saveRegistry,
	saveState,
	slugify,
	touch,
	type ProjectEntry,
	type ProjectState,
} from './projects.js';
import {
	DEFAULT_MODEL,
	explainProviderError,
	listModels,
	ProviderError,
	resolveModel,
} from './providers.js';
import { editToolFor, resolveAutoSpec, samplingFor } from './model-pairs.js';
import { detectPhase, interviewWriteGuard, skillsForPhase, type BuildPhase } from './phase.js';
import { loadSkills, type LoadedSkills } from './skills.js';

// ── config ───────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}

const ROOT = flag('--root') ?? process.env.INIT_CWD ?? process.cwd();
const PORT = Number(process.env.PORT ?? 8879);
const MAX_STEPS = Number(flag('--max-steps') ?? 40);
const PROJECTS_DIR = '.builder/projects';

const env = loadEnvFiles(ROOT);
/** Root workspace: registry, gates, commits. NEVER handed to the generator. */
const ws = new LocalWorkspace({ root: ROOT });
let skills: LoadedSkills = { byFile: new Map(), loaded: [], missing: [] };

// ── the current project (the DO-state analog, resumable and switchable) ──────

interface Current {
	readonly entry: ProjectEntry;
	/** The generator's workspace — rooted at THIS project (§5.3 confinement). */
	readonly projectWs: LocalWorkspace;
	readonly gateSet: readonly GateSpec[];
	readonly repoMode: 'project' | 'scoped';
	readonly state: ProjectState;
}

let cur: Current;
let modelSpec = process.env.SUBSTRAT_BUILDER_MODEL ?? DEFAULT_MODEL;
let busy = false;
let abort: AbortController | null = null;

/** Activate a project: ensure its repo, pick its gate set, load its history. */
async function activate(entry: ProjectEntry): Promise<Current> {
	const ensured = await ensureVerticalRepo(ws, entry.dir);
	cur = {
		entry,
		projectWs: new LocalWorkspace({ root: join(ROOT, entry.dir), id: `project:${entry.id}` }),
		gateSet: ensured.mode === 'project' ? standaloneGates(entry.dir) : defaultGates(entry.dir),
		repoMode: ensured.mode,
		state: await loadState(ws, entry.id),
	};
	return cur;
}

async function uniqueDir(base: string): Promise<string> {
	let dir = `${PROJECTS_DIR}/${base}`;
	for (let n = 2; await ws.exists(dir); n++) dir = `${PROJECTS_DIR}/${base}-${n}`;
	return dir;
}

// ── http plumbing ────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
	let data = '';
	for await (const chunk of req) data += chunk;
	return data;
}

/** Writes one BuildEvent per line — the DO-WebSocket analog. */
function ndjson(res: ServerResponse): (e: BuildEvent) => void {
	res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
	return (e) => res.write(`${JSON.stringify(e)}\n`);
}

async function makeGenerator(spec: string, phase: BuildPhase = 'iterate'): Promise<VerticalGenerator> {
	// `<provider>:auto` becomes concrete here — fast for interview, strong for
	// build (model-pairs.ts). The generator label carries what actually ran.
	const resolved = await resolveModel(resolveAutoSpec(spec, phase));
	// The phase ladder (phase.ts): prefix content changes only at phase
	// boundaries, so each phase's prefix is byte-stable and caches independently.
	const phaseSkills = skillsForPhase(skills.byFile, phase);
	return new AiSdkGenerator({
		model: resolved.model,
		label: resolved.label,
		maxSteps: MAX_STEPS,
		skills: phaseSkills,
		explainError: explainProviderError(spec.split(':')[0] ?? 'anthropic'),
		// Format-per-model (H1): frontier providers get search/replace edits,
		// weak/unknown models keep whole-file writes (model-pairs.ts).
		editTool: editToolFor(spec),
		// Sampling defaults per provider (H4): qwen wants 0.55, not SDK default.
		...samplingFor(spec),
		// Interview turns may write only spec/** — the ladder is mechanical, not
		// a prompt hope (phase.ts explains the dead-end this prevents).
		...(phase === 'interview' ? { denyWrite: interviewWriteGuard } : {}),
	});
}

// ── routes ───────────────────────────────────────────────────────────────────

async function handleSession(res: ServerResponse): Promise<void> {
	let endpoint: string | undefined;
	let endpointSource: string | undefined;
	let modelError: string | null = null;
	try {
		// Auto specs validate/display via their strong member (the build tier).
		const resolved = await resolveModel(resolveAutoSpec(modelSpec, 'iterate'));
		endpoint = resolved.endpoint;
		endpointSource = resolved.endpointSource;
	} catch (err) {
		modelError = err instanceof ProviderError ? err.message : String(err);
	}
	json(res, 200, {
		root: ws.root,
		vertical: cur.entry.dir,
		project: { id: cur.entry.id, name: cur.entry.name, nameSource: cur.entry.nameSource },
		repoMode: cur.repoMode,
		phase: await detectPhase(cur.projectWs),
		modelSpec,
		endpoint,
		endpointSource,
		modelError,
		envFiles: env.loaded,
		busy,
		turns: cur.state.turnNo,
		foreign: await foreignChanges(ws, cur.entry.dir),
		mode: 'A — local, no isolation; the model has shell access to this machine',
	});
}

async function handleProjects(res: ServerResponse): Promise<void> {
	const reg = await loadRegistry(ws);
	// ULIDs sort by creation; updatedAt sorts by recency — recency wins for a picker.
	reg.projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	json(res, 200, { current: cur.entry.id, projects: reg.projects });
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (busy) return json(res, 409, { error: 'a turn is running' });
	const { name } = JSON.parse(await readBody(req)) as { name?: string };
	const projectName = name?.trim() || 'Untitled';
	const reg = await loadRegistry(ws);
	const entry = newEntry(projectName, await uniqueDir(slugify(projectName)), name ? 'user' : 'auto');
	reg.projects.push(entry);
	reg.currentId = entry.id;
	await saveRegistry(ws, reg);
	await activate(entry);
	json(res, 200, entry);
}

async function handleSelectProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (busy) return json(res, 409, { error: 'a turn is running' });
	const { id } = JSON.parse(await readBody(req)) as { id?: string };
	const reg = await loadRegistry(ws);
	const entry = reg.projects.find((p) => p.id === id);
	if (!entry) return json(res, 404, { error: `no project ${id}` });
	reg.currentId = entry.id;
	await saveRegistry(ws, reg);
	await activate(entry);
	json(res, 200, entry);
}

async function handleRenameProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const { name } = JSON.parse(await readBody(req)) as { name?: string };
	if (!name?.trim()) return json(res, 400, { error: 'name required' });
	const reg = await loadRegistry(ws);
	const entry = reg.projects.find((p) => p.id === cur.entry.id);
	if (!entry) return json(res, 500, { error: 'current project missing from registry' });
	rename(entry, name.trim(), 'user');
	await saveRegistry(ws, reg);
	rename(cur.entry, name.trim(), 'user');
	json(res, 200, entry);
}

/** The model proposed a name mid-turn: apply unless the user already named it. */
async function applyAiName(name: string): Promise<void> {
	const reg = await loadRegistry(ws);
	const entry = reg.projects.find((p) => p.id === cur.entry.id);
	if (!entry) return;
	if (rename(entry, name, 'ai')) {
		await saveRegistry(ws, reg);
		rename(cur.entry, name, 'ai');
	}
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (busy) return json(res, 409, { error: 'a turn is already running' });

	const { message } = JSON.parse(await readBody(req)) as { message?: string };
	if (!message?.trim()) return json(res, 400, { error: 'message required' });

	let generator: VerticalGenerator;
	const phase = await detectPhase(cur.projectWs);
	try {
		generator = await makeGenerator(modelSpec, phase);
	} catch (err) {
		return json(res, 422, { error: err instanceof ProviderError ? err.message : String(err) });
	}

	busy = true;
	abort = new AbortController();
	const signal = abort.signal;
	cur.state.turnNo += 1;
	const emit = ndjson(res);

	// Transport heartbeat: a bare newline every 10s. NOT a BuildEvent — it
	// carries no claim about progress, only "this request is still alive" (the
	// one thing the client cannot know during a long tool execution).
	const heartbeat = setInterval(() => {
		try {
			res.write('\n');
		} catch {
			/* client gone — the turn still runs to completion and commits */
		}
	}, 10_000);

	const concept =
		phase === 'interview'
			? '(no concept document yet — interview the builder before writing code)'
			: await cur.projectWs.readFile('spec/concept.md');

	try {
		// The phase is a workspace fact (phase.ts), so the UI's stepper renders
		// real state — emitted at turn start, and again at the end if the turn's
		// work moved the ladder (concept landed, module landed).
		emit({ type: 'phase', phase });

		// This turn's exchanges, appended to durable history at the end. Repair
		// prompts are recorded verbatim as user turns — the transcript stays
		// truthful about who said what, and alternation survives for providers
		// that require it.
		const transcript: { role: 'user' | 'assistant'; text: string }[] = [];

		/**
		 * One generator pass; returns whether the step ceiling cut it mid-work.
		 * `carriedReport` is the previous TURN's red-gate state — first pass only;
		 * repair prompts already embed the fresh report.
		 */
		const runPass = async (text: string, carriedReport?: string): Promise<boolean> => {
			let prose = '';
			let truncated = false;
			for await (const event of generator.run({
				workspace: cur.projectWs,
				verticalDir: '.',
				concept,
				message: text,
				workspaceBrief: await workspaceBrief(ws, cur.entry.dir).catch(() => undefined),
				...(carriedReport ? { gateReport: carriedReport } : {}),
				history: [...cur.state.history.slice(-24), ...transcript],
				signal,
			})) {
				if (event.type === 'project-named') await applyAiName(event.name);
				if (event.type === 'truncated') truncated = true;
				emit(event);
				if (event.type === 'assistant-text') prose += event.text;
				// Questions asked and step-ceiling cuts survive into durable history —
				// the model's next turn must know both (events.ts historyMarker).
				const marker = historyMarker(event);
				if (marker) prose += `${prose ? '\n\n' : ''}${marker}`;
			}
			transcript.push({ role: 'user', text });
			if (prose) transcript.push({ role: 'assistant', text: prose });
			return truncated;
		};

		// A truncated pass is "not done yet", not "done but broken" — continue it
		// before the gates run, so the repair budget stays reserved for genuine
		// breakage (gates.ts MAX_CONTINUATIONS). The cap is per turn: repair
		// passes draw from the same continuation budget as the first pass.
		let continuations = 0;
		const runToCompletion = async (text: string, carriedReport?: string): Promise<void> => {
			let truncated = await runPass(text, carriedReport);
			while (truncated && continuations < MAX_CONTINUATIONS && !signal.aborted) {
				continuations += 1;
				truncated = await runPass(continuationPrompt(continuations, MAX_CONTINUATIONS));
			}
		};

		/** Gates + commit for one pass (commit-per-turn lives above the seam, §3). */
		const runChecks = async (label: string): ReturnType<typeof runTurn> => {
			const turn = await runTurn(ws, {
				verticalDir: cur.entry.dir,
				message: label,
				gates: cur.gateSet,
				onGateResult: (result) => emit({ type: 'check', result }),
			});
			emit({ type: 'gates', run: turn.gates });
			if (turn.commit) {
				emit({ type: 'commit', sha: turn.commit, summary: `${turn.changedFiles.length} files` });
			}
			return turn;
		};

		await runToCompletion(message, cur.state.lastGateReport);
		let turn = await runChecks(`studio turn ${cur.state.turnNo}: ${message.slice(0, 60)}`);

		// Red gates are the model's problem, not the builder's (H5): drive capped
		// repair attempts, but only while attempts make progress (changed files) —
		// a chat-only turn over a pre-existing red tree must not burn budget, and
		// `blocked` gates never trigger repair (the checker crashed, not the code).
		for (
			let attempt = 1;
			attempt <= MAX_GATE_REPAIRS &&
			repairNeeded(turn.gates) &&
			turn.changedFiles.length > 0 &&
			!signal.aborted;
			attempt++
		) {
			await runToCompletion(gateRepairPrompt(turn.gates, attempt, MAX_GATE_REPAIRS));
			turn = await runChecks(`studio turn ${cur.state.turnNo} · gate repair ${attempt}/${MAX_GATE_REPAIRS}`);
		}

		// Whatever survived the loop is the report the NEXT turn opens with —
		// deleted the moment the tree goes green.
		const report = gateReport(turn.gates);
		if (report) cur.state.lastGateReport = report;
		else delete cur.state.lastGateReport;

		const after = await detectPhase(cur.projectWs);
		if (after !== phase) emit({ type: 'phase', phase: after });

		cur.state.history.push(...transcript);
	} catch (err) {
		emit({
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
			fatal: true,
		});
	} finally {
		clearInterval(heartbeat);
		// Persist the session — this is what "pick up where we were" is.
		await saveState(ws, cur.entry.id, cur.state).catch(() => undefined);
		const reg = await loadRegistry(ws);
		const entry = reg.projects.find((p) => p.id === cur.entry.id);
		if (entry) {
			touch(entry);
			await saveRegistry(ws, reg).catch(() => undefined);
		}
		busy = false;
		abort = null;
		res.end();
	}
}

async function handleSnapshot(res: ServerResponse): Promise<void> {
	// Same shape the hosted agent serves from R2; local disk is cheap enough to
	// build it live per request, so it can never go stale.
	try {
		const snap = await snapshotWorkspace(ws, cur.entry.dir);
		json(res, 200, {
			dir: cur.entry.dir,
			generatedAt: new Date().toISOString(),
			files: snap.files,
			skipped: snap.skipped,
		});
	} catch {
		json(res, 404, { error: 'no snapshot yet' });
	}
}

async function handleFiles(url: URL, res: ServerResponse): Promise<void> {
	const path = url.searchParams.get('path') ?? cur.entry.dir;
	try {
		json(res, 200, { path, entries: await ws.listFiles(path) });
	} catch {
		json(res, 404, { error: `no such directory: ${path}` });
	}
}

async function handleFileRead(url: URL, res: ServerResponse): Promise<void> {
	const path = url.searchParams.get('path');
	if (!path) return json(res, 400, { error: 'path required' });
	try {
		json(res, 200, { path, content: await ws.readFile(path) });
	} catch {
		json(res, 404, { error: `no such file: ${path}` });
	}
}

async function handleFileWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const { path, content } = JSON.parse(await readBody(req)) as { path?: string; content?: string };
	if (!path || content === undefined) return json(res, 400, { error: 'path and content required' });
	// Writes are confined to the current project — everything else is foreign
	// work the studio must not touch (same rule the commit scope enforces).
	if (!path.startsWith(`${cur.entry.dir}/`)) {
		return json(res, 403, { error: `writes are limited to ${cur.entry.dir}/` });
	}
	await ws.writeFile(path, content);
	json(res, 200, { ok: true });
}

async function handleModels(url: URL, res: ServerResponse): Promise<void> {
	const provider = url.searchParams.get('provider');
	if (!provider) return json(res, 400, { error: 'provider required' });
	try {
		json(res, 200, { provider, models: await listModels(provider) });
	} catch (err) {
		json(res, 422, { error: err instanceof ProviderError ? err.message : String(err) });
	}
}

async function handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (busy) return json(res, 409, { error: 'cannot switch model mid-turn' });
	const { spec } = JSON.parse(await readBody(req)) as { spec?: string };
	if (!spec) return json(res, 400, { error: 'spec required (provider:model)' });
	try {
		// Validates provider, credential, endpoint; an auto spec validates via its
		// strong member (both members share provider + credential by construction).
		const resolved = await resolveModel(resolveAutoSpec(spec, 'iterate'));
		modelSpec = spec;
		// History survives a model switch by design: GeneratorTurn is provider-
		// neutral (§5.2), so a session can continue on another model.
		json(res, 200, { spec, endpoint: resolved.endpoint, endpointSource: resolved.endpointSource });
	} catch (err) {
		json(res, 422, { error: err instanceof ProviderError ? err.message : String(err) });
	}
}

// ── server ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
	const route = `${req.method} ${url.pathname}`;

	const handler = async (): Promise<void> => {
		switch (route) {
			case 'GET /api/session':
				return handleSession(res);
			case 'GET /api/usage':
				// Local mode runs no metering scope (#646 — hosted-only); an honest
				// empty report renders the pane's empty state, never a fake number.
				return json(res, 200, {
					totals: { input: 0, output: 0 },
					daily: [],
					byProject: [],
					byModel: [],
					cost: { listUsd: '0', billedUsd: '0', unpricedTokens: 0 },
					markupPercent: 20,
					windowDays: 30,
					generatedAt: new Date().toISOString(),
				});
			case 'GET /api/projects':
				return handleProjects(res);
			case 'POST /api/projects':
				return handleCreateProject(req, res);
			case 'POST /api/projects/select':
				return handleSelectProject(req, res);
			case 'PUT /api/project':
				return handleRenameProject(req, res);
			case 'GET /api/providers':
				return json(res, 200, providerCatalog());
			case 'GET /api/models':
				return handleModels(url, res);
			case 'POST /api/model':
				return handleSetModel(req, res);
			case 'POST /api/turn':
				return handleTurn(req, res);
			case 'POST /api/abort':
				abort?.abort();
				return json(res, 200, { ok: true });
			case 'GET /api/snapshot':
				return handleSnapshot(res);
			case 'GET /api/files':
				return handleFiles(url, res);
			case 'GET /api/file':
				return handleFileRead(url, res);
			case 'PUT /api/file':
				return handleFileWrite(req, res);
			case 'GET /api/dev':
				return json(res, 200, devStatus());
			case 'POST /api/dev': {
				const { action } = JSON.parse(await readBody(req)) as { action?: string };
				if (action === 'start') return json(res, 200, await startDev(ROOT, cur.entry.dir));
				if (action === 'stop') return json(res, 200, await stopDev());
				return json(res, 400, { error: 'action must be start or stop' });
			}
			case 'POST /api/gates':
				return json(res, 200, await runGates(ws, cur.entry.dir, cur.gateSet));
			case 'GET /api/history':
				return json(res, 200, cur.state.history);
			case 'POST /api/metrics': {
				// Assumption-chip tap rates (append-only JSONL) — per-category tap
				// rate is the where-are-our-defaults-wrong signal.
				const body = await readBody(req);
				await ws.mkdir('.builder', { recursive: true });
				const line = JSON.stringify({
					at: new Date().toISOString(),
					project: cur.entry.id,
					...JSON.parse(body),
				});
				const existing = (await ws.exists('.builder/metrics.jsonl'))
					? await ws.readFile('.builder/metrics.jsonl')
					: '';
				await ws.writeFile('.builder/metrics.jsonl', `${existing}${line}\n`);
				return json(res, 200, { ok: true });
			}
			default:
				return json(res, 404, { error: `no route: ${route}` });
		}
	};

	handler().catch((err: unknown) => {
		if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
		else res.end();
	});
});

async function main(): Promise<void> {
	skills = await loadSkills(ROOT);
	if (skills.missing.length) {
		process.stderr.write(`  warn: skill(s) not found: ${skills.missing.join(', ')}\n`);
	}

	// Resume: last current project wins; --vertical adopts/uses a specific dir
	// (a monorepo demo lands in scoped mode via ensureVerticalRepo's guard);
	// first boot adopts a pre-registry spike dir or starts Untitled.
	const reg = await loadRegistry(ws);
	const flagDir = flag('--vertical');
	let entry: ProjectEntry | undefined;
	if (flagDir) {
		entry = reg.projects.find((p) => p.dir === flagDir);
		if (!entry) {
			entry = newEntry(flagDir.split('/').pop() ?? flagDir, flagDir, 'auto');
			reg.projects.push(entry);
		}
	} else {
		entry = reg.projects.find((p) => p.id === reg.currentId) ?? reg.projects[0];
		if (!entry) {
			const legacySpike = `${PROJECTS_DIR}/spike`;
			entry = (await ws.exists(legacySpike))
				? newEntry('Spike', legacySpike, 'auto')
				: newEntry('Untitled', await uniqueDir('untitled'), 'auto');
			reg.projects.push(entry);
		}
	}
	reg.currentId = entry.id;
	await saveRegistry(ws, reg);
	await activate(entry);

	server.listen(PORT, '127.0.0.1', () => {
		process.stdout.write(
			`builder api · http://127.0.0.1:${PORT}\n` +
				`  project  ${cur.entry.name} (${cur.entry.id})\n` +
				`  dir      ${cur.entry.dir}  (${cur.repoMode} repo)\n` +
				`  history  ${cur.state.history.length} turns restored\n` +
				`  model    ${modelSpec}\n` +
				`  skills   ${skills.loaded.length}/${skills.loaded.length + skills.missing.length} loaded into the prompt prefix\n` +
				`  env      ${env.loaded.join(', ') || '(shell only)'}\n`,
		);
	});
}

void main();
