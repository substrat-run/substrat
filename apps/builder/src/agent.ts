/**
 * BuilderAgent — the studio's durable home, now with EXECUTION (#625 shell,
 * #626 workspace; builder-studio.md §7.1).
 *
 * State (registry, per-project history, model choice) lives in DO storage under
 * keys mirroring the local `.builder/` files. Execution runs in the Sandbox
 * container (builder.Dockerfile — the monorepo, warm): the DO builds a
 * `ContainerWorkspace` over the sandbox stub and reuses the SAME turn loop the
 * local server runs — ensureVerticalRepo, generator over a project-rooted
 * workspace, runTurn with standalone gates, commit-per-turn. The skills arrive
 * from the image (the container has `.claude/skills/`), read once and cached.
 *
 * Durability (D-52, #627): the container's disk is a CACHE — it resets on
 * sleep (§4.2). The durable tier is one git bundle per project in R2:
 * restored on wake (clone at HEAD, §4.5), re-bundled after every commit,
 * rollback via R2 object versioning. History and names live in DO storage.
 *
 * Honest limit: /api/dev (preview) stays 503 — background processes want the
 * SDK's process API + exposePort wiring, a named follow-up of #626.
 */
import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import {
	AiSdkGenerator,
	type BuildEvent,
	type GeneratorTurn,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import {
	ContainerWorkspace,
	ensureVerticalRepo,
	runGates,
	runTurn,
	standaloneGates,
	workspaceBrief,
	type SandboxLike,
	type Workspace,
} from '@substrat-run/builder-workspace/edge';
import { editToolFor, resolveAutoSpec } from './model-pairs.js';
import { detectPhase, interviewWriteGuard, skillsForPhase, SKILL_MANIFEST } from './phase.js';
import { explainProviderFailure } from './provider-errors.js';
import {
	HostedProviderError,
	hostedProviderCatalog,
	listModelsHosted,
	resolveModelHosted,
	type ProviderSecrets,
} from './providers-worker.js';
import { reportTurnUsage } from './metering.js';

const REPO = '/workspace/substrat';
const PROJECTS = '.builder/projects';

interface Env extends ProviderSecrets {
	Sandbox: DurableObjectNamespace<Sandbox>;
	/** D-52 (#627): one git bundle per project — the durable tier. */
	PROJECT_REPOS: R2Bucket;
	/** The studio's own kernel scope (#646) — usage metering lives here. */
	SCOPE: DurableObjectNamespace;
}

interface ProjectEntry {
	id: string;
	name: string;
	nameSource: 'auto' | 'ai' | 'user';
	dir: string;
	createdAt: string;
	updatedAt: string;
}

interface Registry {
	currentId: string | null;
	projects: ProjectEntry[];
}

interface ProjectState {
	history: GeneratorTurn[];
	turnNo: number;
}

/** ULID, Web-Crypto only — same wire shape as kernel `ulid()`. */
function ulid(now = Date.now()): string {
	const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
	let t = now;
	let time = '';
	for (let i = 0; i < 10; i++) {
		time = A[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const rand = crypto.getRandomValues(new Uint8Array(16));
	let out = time;
	for (const b of rand) out += A[b % 32];
	return out;
}

/** Bridge the real sandbox stub to the structural slice ContainerWorkspace takes. */
function sandboxLike(sb: Sandbox): SandboxLike {
	return {
		exec: async (cmd, opts) => {
			const r = await sb.exec(cmd, opts?.cwd ? { cwd: opts.cwd } : undefined);
			return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		},
		readFile: async (path) => {
			const r = await sb.readFile(path);
			return typeof r === 'string' ? r : { content: (r as { content: string }).content };
		},
		writeFile: async (path, content) => await sb.writeFile(path, content),
		mkdir: async (path, opts) => await sb.mkdir(path, opts),
		listFiles: async (path) => {
			const r = (await sb.listFiles(path)) as unknown;
			if (Array.isArray(r)) return r as string[];
			const files = (r as { files?: Array<{ name: string; type?: string }> }).files ?? [];
			return { files };
		},
		// hostname is REQUIRED by the SDK (preview URLs hang off it). Until the
		// hosted dev/preview endpoint lands this is only exercised by future code,
		// but the bridge must be honest about the contract now.
		exposePort: async (port, opts) =>
			(await sb.exposePort(port, { hostname: opts?.hostname ?? 'builder.substrat.net' })) as {
				url: string;
			},
	};
}

export class BuilderAgent extends DurableObject<Env> {
	#busy = false;
	#skills: Map<string, string> | null = null;

	// ── storage (keys mirror the local .builder/ files) ───────────────────────

	async #registry(): Promise<Registry> {
		return (
			((await this.ctx.storage.get('registry')) as Registry | undefined) ?? {
				currentId: null,
				projects: [],
			}
		);
	}

	async #save(reg: Registry): Promise<void> {
		await this.ctx.storage.put('registry', reg);
	}

	async #state(id: string): Promise<ProjectState> {
		return (
			((await this.ctx.storage.get(`state:${id}`)) as ProjectState | undefined) ?? {
				history: [],
				turnNo: 0,
			}
		);
	}

	async #current(): Promise<{ reg: Registry; entry: ProjectEntry }> {
		const reg = await this.#registry();
		let entry = reg.projects.find((p) => p.id === reg.currentId) ?? reg.projects[0];
		if (!entry) {
			const now = new Date().toISOString();
			entry = {
				id: ulid(),
				name: 'Untitled',
				nameSource: 'auto',
				dir: `${PROJECTS}/untitled`,
				createdAt: now,
				updatedAt: now,
			};
			reg.projects.push(entry);
			reg.currentId = entry.id;
			await this.#save(reg);
		}
		return { reg, entry };
	}

	// ── execution plumbing ────────────────────────────────────────────────────

	/** One sandbox per project — its DO id is the project ULID (§7.1). The raw
	 * stub is kept alongside the bridged slice: bundle transfer needs the SDK's
	 * base64 file encoding, which is DO plumbing, not generator surface. */
	#sandboxPair(projectId: string): { sb: SandboxLike; raw: Sandbox } {
		const raw = getSandbox(this.env.Sandbox, `project:${projectId}`);
		return { sb: sandboxLike(raw), raw };
	}

	#sandbox(projectId: string): SandboxLike {
		return this.#sandboxPair(projectId).sb;
	}

	// ── D-52: git bundles in R2 — restore on wake, save after every commit ────

	/** Bundle HISTORY, not a single overwritten object: R2 has no object
	 * versioning (verified against docs + API — bucket locks and lifecycles,
	 * yes; versioning, no), so the rollback trail is ours: one ULID-keyed
	 * bundle per save (lexicographic = chronological), pruned to the last N.
	 * A corrupted newest bundle leaves every prior one intact. */
	#bundlePrefix(entry: ProjectEntry): string {
		return `projects/${entry.id}/`;
	}

	async #newestBundle(entry: ProjectEntry): Promise<string | null> {
		const listed = await this.env.PROJECT_REPOS.list({ prefix: this.#bundlePrefix(entry) });
		const keys = listed.objects.map((o) => o.key).sort();
		if (keys.length > 0) return keys[keys.length - 1] as string;
		// Legacy single-key layout from the pre-history deployments.
		const legacy = `projects/${entry.id}.bundle`;
		return (await this.env.PROJECT_REPOS.head(legacy)) ? legacy : null;
	}

	/**
	 * The wake path (§4.5): clone at HEAD, not restore a disk. If the container's
	 * disk lost the project (sleep) and a bundle exists, clone it back — full
	 * history, exactly what the last completed turn committed. No bundle + no
	 * dir = genuinely new project; ensureVerticalRepo inits it.
	 */
	async #restoreProject(pair: { sb: SandboxLike; raw: Sandbox }, entry: ProjectEntry): Promise<void> {
		const probe = await pair.sb.exec(`test -d ${JSON.stringify(`${REPO}/${entry.dir}/.git`)}`);
		if (probe.exitCode === 0) return; // container still has it

		const key = await this.#newestBundle(entry);
		const obj = key ? await this.env.PROJECT_REPOS.get(key) : null;
		if (!obj) return; // nothing durable yet — first turn will init

		// Chunked: spreading a multi-MB bundle into fromCharCode blows the arg limit.
		const bytes = new Uint8Array(await obj.arrayBuffer());
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		const b64 = btoa(bin);
		const tmp = `/tmp/${entry.id}.bundle`;
		await pair.raw.writeFile(tmp, b64, { encoding: 'base64' });
		const clone = await pair.sb.exec(
			`mkdir -p ${JSON.stringify(`${REPO}/${PROJECTS}`)} && git clone -q ${JSON.stringify(tmp)} ${JSON.stringify(`${REPO}/${entry.dir}`)} && rm -f ${JSON.stringify(tmp)}`,
		);
		if (clone.exitCode !== 0) {
			throw new Error(`bundle restore failed for ${entry.id}: ${clone.stderr || clone.stdout}`);
		}
	}

	/** The save path: after a commit, the repo IS the durable state — bundle it
	 * whole (few MB) and let R2 versioning keep the rollback trail. */
	async #saveBundle(pair: { sb: SandboxLike; raw: Sandbox }, entry: ProjectEntry): Promise<void> {
		const tmp = `/tmp/${entry.id}.bundle`;
		const made = await pair.sb.exec(`git bundle create ${JSON.stringify(tmp)} --all`, {
			cwd: `${REPO}/${entry.dir}`,
		});
		if (made.exitCode !== 0) {
			throw new Error(`git bundle failed for ${entry.id}: ${made.stderr || made.stdout}`);
		}
		const r = await pair.raw.readFile(tmp, { encoding: 'base64' });
		const b64 = typeof r === 'string' ? r : (r as { content: string }).content;
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		await this.env.PROJECT_REPOS.put(`${this.#bundlePrefix(entry)}${ulid()}.bundle`, bytes);
		await pair.sb.exec(`rm -f ${JSON.stringify(tmp)}`);
		// Prune to the last N — each bundle is complete (git bundle --all), so
		// history depth is a rollback budget, not a chain.
		const KEEP = 10;
		const listed = await this.env.PROJECT_REPOS.list({ prefix: this.#bundlePrefix(entry) });
		const keys = listed.objects.map((o) => o.key).sort();
		for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) {
			await this.env.PROJECT_REPOS.delete(k);
		}
	}

	#rootWs(sb: SandboxLike): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: REPO, id: 'container:repo' });
	}

	#projectWs(sb: SandboxLike, dir: string): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: `${REPO}/${dir}`, id: `container:${dir}` });
	}

	/** Skills come from the image — the builder-distilled set that phase.ts's
	 * SKILL_MANIFEST names (see skills.ts for why not the repo's SKILL.md files). */
	async #loadSkills(root: Workspace): Promise<Map<string, string>> {
		if (this.#skills) return this.#skills;
		const skills = new Map<string, string>();
		for (const { file } of SKILL_MANIFEST) {
			try {
				skills.set(file, await root.readFile(file));
			} catch {
				/* image without skills: the generator runs dumber, never blind */
			}
		}
		this.#skills = skills;
		return skills;
	}

	async #generator(spec: string, skills: string[], interview: boolean): Promise<VerticalGenerator> {
		const resolved = resolveModelHosted(this.env, spec);
		const provider = spec.includes(':') ? (spec.split(':')[0] as string) : 'anthropic';
		return new AiSdkGenerator({
			model: resolved.model,
			label: resolved.label,
			maxSteps: 40,
			skills,
			// The incident behind this: an exhausted qwen weekly quota rendered as
			// "API key is invalid" in the chat pane. Name the real class, keep the
			// provider's message (it carries the reset time), say what to do next.
			explainError: (err) => explainProviderFailure(provider, err, 'hosted'),
			// Format-per-model (H1): frontier providers get search/replace edits,
			// weak/unknown models keep whole-file writes (model-pairs.ts).
			editTool: editToolFor(spec),
			// Interview turns may write only spec/** — the ladder is mechanical,
			// not a prompt hope (phase.ts explains the dead-end this prevents).
			...(interview ? { denyWrite: interviewWriteGuard } : {}),
		});
	}

	// ── the turn (the local server's handleTurn, ported) ──────────────────────

	async #turn(req: Request): Promise<Response> {
		if (this.#busy) return json(409, { error: 'a turn is already running' });
		const { message } = (await req.json().catch(() => ({}))) as { message?: string };
		if (!message?.trim()) return json(400, { error: 'message required' });

		const { reg, entry } = await this.#current();
		const state = await this.#state(entry.id);
		const modelSpec =
			((await this.ctx.storage.get('modelSpec')) as string | undefined) ?? 'anthropic:claude-opus-5';

		const pair = this.#sandboxPair(entry.id);
		const sb = pair.sb;
		const rootWs = this.#rootWs(sb);
		// Validate the provider config EARLY so a missing secret is a 422, not a
		// mid-stream error. The generator itself is built inside run(), AFTER the
		// R2 restore — phase detection reads the workspace, and a slept
		// container's disk is empty until restore (detecting before it loaded
		// interview skills for mature projects).
		try {
			// Auto specs validate via their strong member (same provider/credential).
			resolveModelHosted(this.env, resolveAutoSpec(modelSpec, 'iterate'));
		} catch (err) {
			return json(422, { error: err instanceof HostedProviderError ? err.message : String(err) });
		}

		this.#busy = true;
		state.turnNo += 1;
		// The turn's identity for metering: the dedupe key that makes a replayed
		// usage report record nothing (#646).
		const turnId = ulid();

		const { readable, writable } = new TransformStream<Uint8Array>();
		const writer = writable.getWriter();
		const enc = new TextEncoder();
		const emit = (e: BuildEvent): void => {
			void writer.write(enc.encode(`${JSON.stringify(e)}\n`)).catch(() => undefined);
		};
		// Same transport heartbeat as the local server: bytes prove liveness.
		const heartbeat = setInterval(() => {
			void writer.write(enc.encode('\n')).catch(() => undefined);
		}, 10_000);

		const run = async (): Promise<void> => {
			let assistant = '';
			try {
				// The container's disk may be fresh (slept): restore from the R2
				// bundle first (clone at HEAD, §4.5), then ensure — both idempotent.
				await this.#restoreProject(pair, entry);
				await ensureVerticalRepo(rootWs, entry.dir);
				const projectWs = this.#projectWs(sb, entry.dir);
				// Post-restore on purpose — the phase is a workspace fact, and the
				// workspace only exists now. Emitted so the UI stepper shows real state.
				const phase = await detectPhase(projectWs);
				emit({ type: 'phase', phase });
				const allSkills = await this.#loadSkills(rootWs);
				// `<provider>:auto` becomes concrete per phase (model-pairs.ts) —
				// fast for interview, strong for build turns.
				const generator = await this.#generator(
					resolveAutoSpec(modelSpec, phase),
					skillsForPhase(allSkills, phase),
					phase === 'interview',
				);
				const concept =
					phase === 'interview'
						? '(no concept document yet — interview the builder before writing code)'
						: await projectWs.readFile('spec/concept.md');

				for await (const event of generator.run({
					workspace: projectWs,
					verticalDir: '.',
					concept,
					message,
					workspaceBrief: await workspaceBrief(rootWs, entry.dir).catch(() => undefined),
					// Text-only history is lean by design; cap it so decade-long
					// sessions do not grow the per-step bill without bound.
					history: state.history.slice(-24),
				})) {
					if (event.type === 'project-named' && entry.nameSource !== 'user') {
						entry.name = event.name;
						entry.nameSource = 'ai';
						entry.updatedAt = new Date().toISOString();
						await this.#save(reg);
					}
					if (event.type === 'usage') {
						// Best-effort by design: the turn's product is the commit, and
						// the meter must never take it down. waitUntil, not await — the
						// record rides out past the stream close if it must.
						this.ctx.waitUntil(
							reportTurnUsage(this.env, {
								projectId: entry.id,
								turnId,
								model: modelSpec,
								inputTokens: event.inputTokens,
								outputTokens: event.outputTokens,
								...(event.cachedInputTokens != null
									? { cachedInputTokens: event.cachedInputTokens }
									: {}),
								...(event.cacheWriteTokens != null
									? { cacheWriteTokens: event.cacheWriteTokens }
									: {}),
								// The per-step split — required for tier-correct pricing
								// (pricing.ts: tier selection is per request, not per turn).
								...(event.stepUsage ? { stepUsage: event.stepUsage } : {}),
							}),
						);
					}
					emit(event);
					if (event.type === 'assistant-text') assistant += event.text;
				}

				const turn = await runTurn(rootWs, {
					verticalDir: entry.dir,
					message: `studio turn ${state.turnNo}: ${message.slice(0, 60)}`,
					gates: standaloneGates(entry.dir),
					onGateResult: (result) => emit({ type: 'check', result }),
				});
				emit({ type: 'gates', run: turn.gates });
				if (turn.commit) {
					emit({ type: 'commit', sha: turn.commit, summary: `${turn.changedFiles.length} files` });
					// The commit is only durable once bundled (§4.5): container disk
					// is the cache, R2 is where the repo rests.
					await this.#saveBundle(pair, entry);
				}
				const after = await detectPhase(projectWs);
				if (after !== phase) emit({ type: 'phase', phase: after });
				await this.ctx.storage.put(`phase:${entry.id}`, after);

				state.history.push({ role: 'user', text: message });
				if (assistant) state.history.push({ role: 'assistant', text: assistant });
			} catch (err) {
				emit({
					type: 'error',
					message: err instanceof Error ? err.message : String(err),
					fatal: true,
				});
			} finally {
				clearInterval(heartbeat);
				await this.ctx.storage.put(`state:${entry.id}`, state);
				entry.updatedAt = new Date().toISOString();
				await this.#save(reg);
				this.#busy = false;
				await writer.close().catch(() => undefined);
			}
		};
		// waitUntil: the turn must survive the client dropping the stream —
		// the same "server keeps running and commits" promise the local server makes.
		this.ctx.waitUntil(run());

		return new Response(readable, {
			headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' },
		});
	}

	// ── routes ────────────────────────────────────────────────────────────────

	override async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const route = `${req.method} ${url.pathname}`;

		switch (route) {
			case 'GET /api/session': {
				const { entry } = await this.#current();
				const state = await this.#state(entry.id);
				const modelSpec =
					((await this.ctx.storage.get('modelSpec')) as string | undefined) ??
					'anthropic:claude-opus-5';
				let modelError: string | null = null;
				let endpoint: string | undefined;
				try {
					endpoint = resolveModelHosted(this.env, modelSpec).endpoint;
				} catch (err) {
					modelError = err instanceof Error ? err.message : String(err);
				}
				return json(200, {
					root: REPO,
					vertical: entry.dir,
					project: { id: entry.id, name: entry.name, nameSource: entry.nameSource },
					repoMode: 'project',
					// Last phase persisted by a turn. Truthful without booting the
					// container: only turns mutate the workspace, so the value can't
					// be stale — null just means "no turn yet" (UI hides the stepper).
					phase: ((await this.ctx.storage.get(`phase:${entry.id}`)) as string | undefined) ?? null,
					modelSpec,
					endpoint,
					endpointSource: endpoint ? 'worker secret' : undefined,
					modelError,
					envFiles: [],
					busy: this.#busy,
					turns: state.turnNo,
					foreign: [],
					mode: 'hosted — execution in the sandbox container; repos durable as R2 bundles (D-52)',
				});
			}
			case 'POST /api/turn':
				return this.#turn(req);
			case 'POST /api/gates': {
				const { entry } = await this.#current();
				const pair = this.#sandboxPair(entry.id);
				const rootWs = this.#rootWs(pair.sb);
				await this.#restoreProject(pair, entry);
				await ensureVerticalRepo(rootWs, entry.dir);
				return json(200, await runGates(rootWs, entry.dir, standaloneGates(entry.dir)));
			}
			case 'GET /api/files': {
				const { entry } = await this.#current();
				const path = url.searchParams.get('path') ?? entry.dir;
				const pair = this.#sandboxPair(entry.id);
				await this.#restoreProject(pair, entry).catch(() => undefined);
				const rootWs = this.#rootWs(pair.sb);
				try {
					return json(200, { path, entries: await rootWs.listFiles(path) });
				} catch {
					return json(404, { error: `no such directory: ${path}` });
				}
			}
			case 'GET /api/file': {
				const { entry } = await this.#current();
				const path = url.searchParams.get('path');
				if (!path) return json(400, { error: 'path required' });
				const rootWs = this.#rootWs(this.#sandbox(entry.id));
				try {
					return json(200, { path, content: await rootWs.readFile(path) });
				} catch {
					return json(404, { error: `no such file: ${path}` });
				}
			}
			case 'PUT /api/file': {
				const { entry } = await this.#current();
				const { path, content } = (await req.json().catch(() => ({}))) as {
					path?: string;
					content?: string;
				};
				if (!path || content === undefined)
					return json(400, { error: 'path and content required' });
				if (!path.startsWith(`${entry.dir}/`))
					return json(403, { error: `writes are limited to ${entry.dir}/` });
				await this.#rootWs(this.#sandbox(entry.id)).writeFile(path, content);
				return json(200, { ok: true });
			}
			case 'GET /api/providers':
				return json(200, hostedProviderCatalog(this.env));
			case 'GET /api/models': {
				const provider = url.searchParams.get('provider');
				if (!provider) return json(400, { error: 'provider required' });
				try {
					return json(200, { models: await listModelsHosted(this.env, provider) });
				} catch (err) {
					return json(422, {
						error: err instanceof HostedProviderError ? err.message : String(err),
					});
				}
			}
			case 'POST /api/model': {
				if (this.#busy) return json(409, { error: 'cannot switch model mid-turn' });
				const { spec } = (await req.json().catch(() => ({}))) as { spec?: string };
				if (!spec) return json(400, { error: 'spec required (provider:model)' });
				try {
					const r = resolveModelHosted(this.env, spec);
					await this.ctx.storage.put('modelSpec', spec);
					return json(200, { spec, endpoint: r.endpoint, endpointSource: 'worker secret' });
				} catch (err) {
					return json(422, {
						error: err instanceof HostedProviderError ? err.message : String(err),
					});
				}
			}
			case 'GET /api/history': {
				const { entry } = await this.#current();
				return json(200, (await this.#state(entry.id)).history);
			}
			case 'GET /api/projects': {
				const { reg, entry } = await this.#current();
				const sorted = [...reg.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
				return json(200, { current: entry.id, projects: sorted });
			}
			case 'POST /api/projects': {
				const { name } = (await req.json().catch(() => ({}))) as { name?: string };
				const reg = await this.#registry();
				const now = new Date().toISOString();
				const projectName = name?.trim() || 'Untitled';
				const entry: ProjectEntry = {
					id: ulid(),
					name: projectName,
					nameSource: name ? 'user' : 'auto',
					dir: `${PROJECTS}/${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'}`,
					createdAt: now,
					updatedAt: now,
				};
				reg.projects.push(entry);
				reg.currentId = entry.id;
				await this.#save(reg);
				return json(200, entry);
			}
			case 'POST /api/projects/select': {
				const { id } = (await req.json().catch(() => ({}))) as { id?: string };
				const reg = await this.#registry();
				const entry = reg.projects.find((p) => p.id === id);
				if (!entry) return json(404, { error: `no project ${id}` });
				reg.currentId = entry.id;
				await this.#save(reg);
				return json(200, entry);
			}
			case 'PUT /api/project': {
				const { name } = (await req.json().catch(() => ({}))) as { name?: string };
				if (!name?.trim()) return json(400, { error: 'name required' });
				const { reg, entry } = await this.#current();
				entry.name = name.trim();
				entry.nameSource = 'user';
				entry.updatedAt = new Date().toISOString();
				await this.#save(reg);
				return json(200, entry);
			}
			default:
				return json(503, {
					error:
						'not hosted yet: /api/dev (preview processes) lands with the #626 follow-ups',
				});
		}
	}
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
