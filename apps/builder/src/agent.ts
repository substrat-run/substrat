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
 * Honest limits, stated where they bite:
 * - Project repos live on the container's disk, which RESETS on sleep (§4.2).
 *   Until #627 (R2 git bundles) a hosted project's code survives only as long
 *   as its container — the UI must treat hosted projects as scratch. History
 *   and names survive (DO storage); the working tree does not.
 * - /api/dev (preview) stays 503: background processes want the SDK's process
 *   API + exposePort wiring, scoped to the follow-up in #626's checklist.
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
	type SandboxLike,
	type Workspace,
} from '@substrat-run/builder-workspace';
import { HostedProviderError, resolveModelHosted, type ProviderSecrets } from './providers-worker.js';

const REPO = '/workspace/substrat';
const PROJECTS = '.builder/projects';

interface Env extends ProviderSecrets {
	Sandbox: DurableObjectNamespace<Sandbox>;
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
	#skills: string[] | null = null;

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

	/** One sandbox per project — its DO id is the project ULID (§7.1). */
	#sandbox(projectId: string): SandboxLike {
		return sandboxLike(getSandbox(this.env.Sandbox, `project:${projectId}`));
	}

	#rootWs(sb: SandboxLike): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: REPO, id: 'container:repo' });
	}

	#projectWs(sb: SandboxLike, dir: string): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: `${REPO}/${dir}`, id: `container:${dir}` });
	}

	/** Skills come from the image — the container carries .claude/skills/. */
	async #loadSkills(root: Workspace): Promise<string[]> {
		if (this.#skills) return this.#skills;
		const skills: string[] = [];
		for (const rel of ['.claude/skills/substrat/SKILL.md', '.claude/skills/new-vertical/SKILL.md']) {
			try {
				skills.push(await root.readFile(rel));
			} catch {
				/* image without skills: the generator runs dumber, never blind */
			}
		}
		this.#skills = skills;
		return skills;
	}

	async #generator(spec: string, skills: string[]): Promise<VerticalGenerator> {
		const resolved = resolveModelHosted(this.env, spec);
		return new AiSdkGenerator({
			model: resolved.model,
			label: resolved.label,
			maxSteps: 40,
			skills,
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

		const sb = this.#sandbox(entry.id);
		const rootWs = this.#rootWs(sb);
		let generator: VerticalGenerator;
		try {
			generator = await this.#generator(modelSpec, await this.#loadSkills(rootWs));
		} catch (err) {
			return json(422, { error: err instanceof HostedProviderError ? err.message : String(err) });
		}

		this.#busy = true;
		state.turnNo += 1;

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
				// The container's disk may be fresh (slept) — ensure the project repo
				// exists every turn, not just on create. Idempotent by design.
				await ensureVerticalRepo(rootWs, entry.dir);
				const projectWs = this.#projectWs(sb, entry.dir);
				const concept = (await projectWs.exists('spec/concept.md'))
					? await projectWs.readFile('spec/concept.md')
					: '(no concept document yet — interview the builder before writing code)';

				for await (const event of generator.run({
					workspace: projectWs,
					verticalDir: '.',
					concept,
					message,
					history: state.history,
				})) {
					if (event.type === 'project-named' && entry.nameSource !== 'user') {
						entry.name = event.name;
						entry.nameSource = 'ai';
						entry.updatedAt = new Date().toISOString();
						await this.#save(reg);
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
				if (turn.commit)
					emit({ type: 'commit', sha: turn.commit, summary: `${turn.changedFiles.length} files` });

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
					conceptApproved: false, // cheap answer; the turn reads the real file
					modelSpec,
					endpoint,
					endpointSource: endpoint ? 'worker secret' : undefined,
					modelError,
					envFiles: [],
					busy: this.#busy,
					turns: state.turnNo,
					foreign: [],
					mode: 'hosted — execution in the sandbox container; project code is scratch until #627',
				});
			}
			case 'POST /api/turn':
				return this.#turn(req);
			case 'POST /api/gates': {
				const { entry } = await this.#current();
				const sb = this.#sandbox(entry.id);
				const rootWs = this.#rootWs(sb);
				await ensureVerticalRepo(rootWs, entry.dir);
				return json(200, await runGates(rootWs, entry.dir, standaloneGates(entry.dir)));
			}
			case 'GET /api/files': {
				const { entry } = await this.#current();
				const path = url.searchParams.get('path') ?? entry.dir;
				const rootWs = this.#rootWs(this.#sandbox(entry.id));
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
						'not hosted yet: /api/dev (preview processes) and /api/providers|models (picker catalog) land with the #626 follow-ups',
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
