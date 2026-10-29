/**
 * BuilderAgent — the studio's durable home, now with EXECUTION (#625 shell,
 * #626 workspace; builder-studio.md §7.1).
 *
 * State (registry, per-project history, model choice) lives in DO storage under
 * keys mirroring the local `.builder/` files. Execution runs in the Sandbox
 * container (builder.Dockerfile — the monorepo, warm): the DO builds a
 * `ContainerWorkspace` over the sandbox stub and reuses the SAME turn loop the
 * local server runs — generator over a project-rooted
 * workspace, runTurn with standalone gates, commit-per-turn. The skills arrive
 * from the image (the container has `.claude/skills/`), read once and cached.
 *
 * Source lives in tenant-owned GitHub or Cloudflare Artifacts repositories (D-66).
 * The container is disposable; source is pushed after commits. Project and session
 * metadata, plus disposable editor snapshots, live in this tenant's agent DO.
 *
 * Honest limit: /api/dev (preview) stays 503 — background processes want the
 * SDK's process API + exposePort wiring, a named follow-up of #626.
 */
import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import {
	AiSdkGenerator,
	historyMarker,
	type BuildEvent,
	type GeneratorTurn,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import {
	ContainerWorkspace,
	modelEmitWarning,
	runGates,
	runTurn,
	runTurnLoop,
	snapshotWorkspace,
	standaloneGates,
	workspaceBrief,
	type SandboxLike,
	type TurnResult,
	type Workspace,
} from '@substrat-run/builder-workspace/edge';
import { editToolFor, resolveAutoSpec, samplingFor } from './model-pairs.js';
import {
	orUnhandled,
	problemResponse,
	providerMessage,
	providerRefusal,
	refuse,
	turnFailure,
	sourceBuildFailure,
	SourceBuildError,
} from './problem.js';
import type { BuildPhase } from './phase.js';
import {
	buildWriteGuard,
	buildContext,
	detectPhase,
	interviewWriteGuard,
	isSpecPhase,
	modelWriteGuard,
	scenarioWriteGuard,
	skillsForPhase,
	SKILL_MANIFEST,
} from './phase.js';
import { explainProviderFailure } from '@substrat-run/model-providers';
import {
	hostedProviderCatalog,
	listModelsHosted,
	resolveModelHosted,
	type ProviderSecrets,
} from './providers-worker.js';
import { reportTurnUsage } from './metering.js';
import { underProject, withinProject } from './project-path.js';
import { sourceBuildRequest, projectRepository, type SourceBuildRequest, type ProjectRepository } from '@substrat-run/contracts';
import { checkedExec, checkoutRepository, repositoryAccess, saveRepository, shellQuote } from './repositories.js';

const REPO = '/workspace';
const TOOLCHAIN = '/workspace/substrat';
const PROJECTS = 'projects';

interface Env extends ProviderSecrets {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ARTIFACTS: Artifacts;
	CONTROL_PLANE_SVC: Fetcher;
	CP_SERVICE_TOKEN?: string;
	/** The studio's own kernel scope (#646) — usage metering lives here. */
	SCOPE: DurableObjectNamespace;
}

interface ProjectEntry {
	id: string;
	name: string;
	nameSource: 'auto' | 'ai' | 'user';
	slug: string;
	repository: ProjectRepository;
	directory: string;
	revision?: string;
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
	/** Red-gate report carried into the next turn's context (H5) — unset while green. */
	lastGateReport?: string;
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
function sandboxLike(sb: Sandbox, timeout?: number): SandboxLike {
	return {
		exec: async (cmd, opts) => {
			const r = await sb.exec(cmd, { ...(opts?.cwd ? { cwd: opts.cwd } : {}), ...(timeout ? { timeout } : {}) });
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
	/** The running turn's kill switch (POST /api/abort) — null while idle. */
	#abort: AbortController | null = null;
	#skills: Map<string, string> | null = null;

	// ── storage (keys mirror the local .builder/ files) ───────────────────────

	async #registry(): Promise<Registry> {
		return (
			((await this.ctx.storage.get('source-registry')) as Registry | undefined) ?? {
				currentId: null,
				projects: [],
			}
		);
	}

	async #save(reg: Registry): Promise<void> {
		await this.ctx.storage.put('source-registry', reg);
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
			entry = await this.#createProject('Untitled', `${this.#tenantSlug || this.#tenant}/draft-${ulid().toLowerCase()}`);
			return { reg: await this.#registry(), entry };
		}
		return { reg, entry };
	}

	// ── execution plumbing ────────────────────────────────────────────────────

	/** One sandbox per project — its DO id is the project ULID (§7.1). The raw
	 * stub is kept alongside the bridged slice for file transfer and container lifecycle. */
	#sandboxPair(projectId: string): { sb: SandboxLike; raw: Sandbox } {
		const raw = getSandbox(this.env.Sandbox, `source-project:${projectId}`);
		return { sb: sandboxLike(raw), raw };
	}

	#sandbox(projectId: string): SandboxLike {
		return this.#sandboxPair(projectId).sb;
	}

	// ── D-66: one source repository per project ────────────────────────────

	async #createProject(name: string, slug: string, repository?: ProjectRepository, select = true): Promise<ProjectEntry> {
		let reg = await this.#registry();
		if (reg.projects.some((p) => p.slug === slug)) throw new SourceBuildError('project already exists for this vertical');
		const id = ulid();
		if (!repository) {
			const created = await this.env.ARTIFACTS.create(`project-${id.toLowerCase()}`, { setDefaultBranch: 'main' });
			repository = { kind: 'artifacts', name: created.name, remote: created.remote, branch: 'main' };
		}
		const directory = repository.kind === 'github' ? repository.directory : '.';
		const now = new Date().toISOString();
		const entry: ProjectEntry = {
			id, name, slug, nameSource: name === 'Untitled' ? 'auto' : 'user', repository, directory,
			dir: `${PROJECTS}/${id}${directory === '.' ? '' : `/${directory}`}`,
			createdAt: now, updatedAt: now,
		};
		reg = await this.#registry();
		if (reg.projects.some((p) => p.slug === slug)) throw new SourceBuildError('project already exists for this vertical');
		reg.projects.push(entry);
		if (select) reg.currentId = id;
		await this.#save(reg);
		return entry;
	}

	async #access(entry: ProjectEntry, scope: 'read' | 'write', tenant: string) {
		return repositoryAccess(this.env.ARTIFACTS, entry.repository, scope, async (owner, repo, permission) => {
			const response = await this.env.CONTROL_PLANE_SVC.fetch('https://control-plane/api/source/github-access', {
				method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': this.env.CP_SERVICE_TOKEN ?? '' },
				body: JSON.stringify({ tenantId: tenant, owner, repo, scope: permission }),
			});
			if (!response.ok) throw new SourceBuildError(`GitHub repository access refused (${response.status}); check the team connection and repository permissions`);
			return response.json() as Promise<{ remote: string; token: string }>;
		});
	}

	#tenant = '';
	#tenantSlug = '';
	#repoRoot(entry: ProjectEntry): string { return `${REPO}/${PROJECTS}/${entry.id}`; }

	async #restoreProject(pair: { sb: SandboxLike; raw: Sandbox }, entry: ProjectEntry): Promise<void> {
		await checkoutRepository(pair.sb, await this.#access(entry, 'read', this.#tenant), this.#repoRoot(entry), entry.repository.branch);
		const head = await pair.sb.exec('git rev-parse --verify HEAD', { cwd: this.#repoRoot(entry) });
		if (head.exitCode === 0 && entry.revision !== head.stdout.trim()) {
			entry.revision = head.stdout.trim();
			const reg = await this.#registry();
			reg.projects = reg.projects.map((p) => p.id === entry.id ? entry : p);
			await this.#save(reg);
		}
	}

	async #saveSource(pair: { sb: SandboxLike; raw: Sandbox }, entry: ProjectEntry): Promise<void> {
		entry.revision = await saveRepository(pair.sb, await this.#access(entry, 'write', this.#tenant), this.#repoRoot(entry), entry.repository.branch);
		entry.updatedAt = new Date().toISOString();
		const reg = await this.#registry();
		reg.projects = reg.projects.map((p) => p.id === entry.id ? entry : p);
		await this.#save(reg);
	}

	#snapshotKey(entry: ProjectEntry): string { return `snapshot:${entry.id}`; }

	async #saveSnapshot(sb: SandboxLike, entry: ProjectEntry): Promise<void> {
		try {
			const snap = await snapshotWorkspace(this.#sourceWs(sb, entry), entry.directory);
			// A disposable editor cache. Source durability comes from the Git push above.
			await this.ctx.storage.put(this.#snapshotKey(entry), JSON.stringify({ dir: entry.dir, generatedAt: new Date().toISOString(), ...snap }));
		} catch { /* file endpoints remain available */ }
	}

	async #build(slug: string, request: SourceBuildRequest): Promise<Response> {
		if (this.#busy) return refuse(409, 'project operation already in progress');
		this.#busy = true;
		const buildId = ulid();
		const raw = getSandbox(this.env.Sandbox, `build:${buildId}`);
		const sb = sandboxLike(raw, 600_000);
		let entry: ProjectEntry | undefined;
		let revision: string | undefined;
		try {
			entry = (await this.#registry()).projects.find((p) => p.slug === slug);
			if (!entry && !request.snapshot) return refuse(404, 'this vertical has no source repository; submit source or connect GitHub first');
			entry ??= await this.#createProject(request.name ?? slug, slug, undefined, false);
			const root = '/build/source';
			await checkedExec(sb, 'mkdir -p /build');
			await checkoutRepository(sb, await this.#access(entry, 'read', this.#tenant), root, entry.repository.branch);
			if (request.snapshot) {
				await raw.writeFile('/build/snapshot.json', JSON.stringify(request.snapshot));
				await checkedExec(sb, 'node --import tsx /workspace/substrat/apps/builder/src/stage-source.ts /build/source /build/snapshot.json', TOOLCHAIN);
				await checkedExec(sb, "git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null -c user.name=Substrat -c user.email=build@substrat.invalid commit --allow-empty -m 'Source snapshot'", root);
				if (entry.repository.kind === 'artifacts') {
					entry.directory = request.snapshot.directory;
					revision = await saveRepository(sb, await this.#access(entry, 'write', this.#tenant), root, entry.repository.branch);
					entry.revision = revision;
				} else {
					// Local work on a GitHub project is durable in a separate snapshot repo.
					const snapshot = await this.env.ARTIFACTS.create(`snapshot-${buildId.toLowerCase()}`, { setDefaultBranch: 'main' });
					const repo: ProjectEntry = { ...entry, repository: { kind: 'artifacts', name: snapshot.name, remote: snapshot.remote, branch: 'main' } };
					revision = await saveRepository(sb, await this.#access(repo, 'write', this.#tenant), root, 'main');
					await this.ctx.storage.put(`build-source:${buildId}`, repo.repository);
				}
			} else {
				// The request pins a commit, not a moving branch. Fetch that commit explicitly.
				const access = await this.#access(entry, 'read', this.#tenant);
				const { repositoryGit } = await import('./repositories.js');
				await repositoryGit(sb, access, ['fetch', access.remote, request.revision!], root);
				await checkedExec(sb, `git -c core.hooksPath=/dev/null checkout --detach ${shellQuote(request.revision!)}`, root);
				revision = await checkedExec(sb, 'git rev-parse HEAD', root);
				entry.revision = revision;
			}
			const directory = request.snapshot?.directory ?? entry.directory;
			entry.dir = `${PROJECTS}/${entry.id}${entry.directory === '.' ? '' : `/${entry.directory}`}`;
			const reg = await this.#registry();
			reg.projects = reg.projects.map((p) => p.id === entry!.id ? entry! : p);
			await this.#save(reg);
			await this.ctx.storage.delete(this.#snapshotKey(entry));
			await this.ctx.storage.put(`build:${buildId}`, { projectId: entry.id, revision, state: 'building', startedAt: new Date().toISOString() });
			const toolchain = await checkedExec(sb, 'cat /workspace/substrat/.toolchain-id');
			const input = { root: directory === '.' ? root : `${root}/${directory}`, slug, request: { ...request, snapshot: undefined, revision } };
			await raw.writeFile('/build/request.json', JSON.stringify(input));
			// Source code and dependency hooks run without repository or control-plane credentials.
			await checkedExec(sb, 'chown -R substrat-build:substrat-build /build');
			const install = "cd /build/source && pnpm install --frozen-lockfile";
			const run = 'cd /workspace/substrat && node --import tsx apps/builder/src/build-runner.ts /build/request.json /build/result.json';
			await checkedExec(sb, `su -s /bin/sh substrat-build -c ${shellQuote(`${install} && ${run}`)}`);
			const outputBytes = Number(await checkedExec(sb, 'wc -c < /build/result.json'));
			if (!Number.isFinite(outputBytes) || outputBytes > 24 * 1024 * 1024) throw new SourceBuildError('release output exceeds the build transfer limit');
			const resultFile = await raw.readFile('/build/result.json');
			const result = JSON.parse(typeof resultFile === 'string' ? resultFile : resultFile.content) as { parts: Array<{ name: string; text?: string; base64?: string; type?: string }>; dataLoss: unknown };
			const form = new FormData();
			for (const part of result.parts) {
				if (part.text !== undefined) form.set(part.name, part.text);
				else form.set(part.name, new Blob([Uint8Array.from(atob(part.base64!), (c) => c.charCodeAt(0))], { type: part.type }), part.name);
			}
			const gate = JSON.parse(form.get('origin') as string)?.gate;
			const origin = entry.repository.kind === 'github' && !request.snapshot
				? { source: 'git', gitRepo: `${entry.repository.owner}/${entry.repository.repo}`, gitCommit: revision, gitRef: entry.repository.branch }
				: request.origin ?? { source: 'cli' };
			form.set('origin', JSON.stringify({ ...origin, gate }));
			const manifest = JSON.parse(form.get('manifest') as string);
			manifest.build = { id: buildId, projectId: entry.id, revision, toolchain };
			form.set('manifest', JSON.stringify(manifest));
			form.set('buildResult', JSON.stringify({ projectId: entry.id, revision, dataLoss: result.dataLoss }));
			await this.ctx.storage.put(`build:${buildId}`, { projectId: entry.id, revision, state: 'built', completedAt: new Date().toISOString() });
			return new Response(form);
		} catch (error) {
			const detail = sourceBuildFailure(error);
			console.error('source.build.failed', { buildId, error });
			await this.ctx.storage.put(`build:${buildId}`, { projectId: entry?.id, state: 'failed', detail, completedAt: new Date().toISOString() });
			return refuse(error instanceof SourceBuildError ? 422 : 500, `platform build failed: ${detail}`);
		} finally {
			this.#busy = false;
			await raw.destroy().catch(() => undefined);
		}
	}

	async #cachedSnapshot(entry: ProjectEntry): Promise<Response | null> {
		const value = await this.ctx.storage.get<string>(this.#snapshotKey(entry));
		return value ? new Response(value, { headers: { 'content-type': 'application/json' } }) : null;
	}

	#sourceWs(sb: SandboxLike, entry: ProjectEntry): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: this.#repoRoot(entry), id: `source:${entry.id}`, toolchainRoot: TOOLCHAIN });
	}

	#projectWs(sb: SandboxLike, dir: string): Workspace {
		return new ContainerWorkspace({ sandbox: sb, root: `${REPO}/${dir}`, id: `container:${dir}`, toolchainRoot: TOOLCHAIN });
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

	async #generator(spec: string, skills: string[], phase: BuildPhase): Promise<VerticalGenerator> {
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
			// Sampling defaults per provider (H4): qwen wants 0.55, not SDK default.
			...samplingFor(spec),
			// The ladder is mechanical, not a prompt hope (phase.ts explains the
			// dead-end this prevents). Spec phases write only spec/**; build phases
			// may write anything EXCEPT the model — that mirror is the direction
			// rule, and it is what stops a failing build redrawing the contract.
			denyWrite:
				phase === 'interview'
					? interviewWriteGuard
					: phase === 'model'
						? modelWriteGuard
						: phase === 'scenario'
							? scenarioWriteGuard
							: buildWriteGuard,
		});
	}

	// ── the turn (the local server's handleTurn, ported) ──────────────────────

	async #turn(req: Request): Promise<Response> {
		if (this.#busy) return refuse(409, 'a turn is already running');
		const { message } = (await req.json().catch(() => ({}))) as { message?: string };
		if (!message?.trim()) return refuse(400, 'message required');

		const { reg, entry } = await this.#current();
		const state = await this.#state(entry.id);
		const modelSpec =
			((await this.ctx.storage.get('modelSpec')) as string | undefined) ?? 'anthropic:claude-opus-5';

		const pair = this.#sandboxPair(entry.id);
		const sb = pair.sb;
		// Validate the provider config EARLY so a missing secret is a 422, not a
		// mid-stream error. The generator itself is built inside run(), AFTER the
		// Repository checkout — phase detection reads the workspace, and a slept
		// container's disk is empty until restore (detecting before it loaded
		// interview skills for mature projects).
		try {
			// Auto specs validate via their strong member (same provider/credential).
			resolveModelHosted(this.env, resolveAutoSpec(modelSpec, 'iterate'));
		} catch (err) {
			return problemResponse(providerRefusal(err));
		}

		this.#busy = true;
		this.#abort = new AbortController();
		const signal = this.#abort.signal;
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
			try {
				// A slept container reopens the authoritative Git branch.
				await this.#restoreProject(pair, entry);
				if (entry.directory === '.') {
					const head = await sb.exec('git rev-parse HEAD', { cwd: this.#repoRoot(entry) });
					if (head.exitCode !== 0) await checkedExec(sb, "git -c core.hooksPath=/dev/null -c user.name=Substrat -c user.email=builder@substrat.invalid commit --allow-empty -m 'Project created'", this.#repoRoot(entry));
				}
				const projectWs = this.#projectWs(sb, entry.dir);
				// Post-restore on purpose — the phase is a workspace fact, and the
				// workspace only exists now. Emitted so the UI stepper shows real state.
				const phase = await detectPhase(projectWs);
				emit({ type: 'phase', phase });
				const allSkills = await this.#loadSkills(new ContainerWorkspace({ sandbox: sb, root: TOOLCHAIN, id: 'toolchain' }));
				// `<provider>:auto` becomes concrete per phase (model-pairs.ts) —
				// fast for interview, strong for build turns.
				const generator = await this.#generator(
					resolveAutoSpec(modelSpec, phase),
					skillsForPhase(allSkills, phase),
					phase,
				);
				const concept = `${await buildContext(projectWs, phase)}\n\nHosted project identity: ${entry.slug}. Keep package.json substrat.slug pinned to ${entry.slug.split('/').pop()} and substrat.tenant pinned to ${this.#tenantSlug || this.#tenant}; these identify the same project when exported and pushed with the CLI. A display-name change does not change this identity.`;

				// Same shape as the local server's handleTurn: pass → checks → capped
				// repair loop (H5; the policy constants live in gates.ts so the hosts
				// cannot drift). Repair prompts are recorded verbatim as user turns.
				const transcript: GeneratorTurn[] = [];

				const runPass = async (text: string, carriedReport?: string): Promise<boolean> => {
					let assistant = '';
					let truncated = false;
					for await (const event of generator.run({
						workspace: projectWs,
						verticalDir: '.',
						concept,
						message: text,
						workspaceBrief: await workspaceBrief(this.#sourceWs(sb, entry), entry.directory).catch(() => undefined),
						...(carriedReport ? { gateReport: carriedReport } : {}),
						// Text-only history is lean by design; cap it so decade-long
						// sessions do not grow the per-step bill without bound.
						history: [...state.history.slice(-24), ...transcript],
						signal,
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
						if (event.type === 'truncated') truncated = true;
						if (event.type === 'assistant-text') assistant += event.text;
						// Questions asked and step-ceiling cuts survive into durable
						// history — the model's next turn must know both.
						const marker = historyMarker(event);
						if (marker) assistant += `${assistant ? '\n\n' : ''}${marker}`;
					}
					transcript.push({ role: 'user', text });
					if (assistant) transcript.push({ role: 'assistant', text: assistant });
					return truncated;
				};

				const runChecks = async (label: string): Promise<TurnResult> => {
					const turn = await runTurn(this.#sourceWs(sb, entry), {
						verticalDir: entry.directory,
						message: label,
						gates: standaloneGates(entry.directory),
						onGateResult: (result) => emit({ type: 'check', result }),
					});
					// A failed model emit leaves the PREVIOUS model.json in the tree, so the
					// Model tab would go on showing it as current with nothing saying so.
					const stale = modelEmitWarning(turn.model);
					if (stale) emit({ type: 'error', message: stale, fatal: false });
					emit({ type: 'gates', run: turn.gates });
					if (turn.commit) {
						emit({ type: 'commit', sha: turn.commit, summary: `${turn.changedFiles.length} files` });
						// The commit is durable once pushed to the authoritative repository.
						await this.#saveSource(pair, entry);
						// The SPA's container-free read path — refresh it while the
						// container is provably awake and at the commit it just made.
						await this.#saveSnapshot(pair.sb, entry);
					}
					return turn;
				};

				// pass → continuations → checks → capped repair, abort-guarded between
				// passes — the one shared loop (builder-workspace turn-loop.ts, #974).
				// A stopped turn used to keep burning continuations here (#676 guarded
				// only the local server's copy).
				const loop = await runTurnLoop(
					{ message, turnNo: state.turnNo, lastGateReport: state.lastGateReport },
					{ runPass, runChecks, signal },
				);

				// Whatever survived the loop is the report the NEXT turn opens with —
				// deleted the moment the tree goes green.
				if (loop.lastGateReport) state.lastGateReport = loop.lastGateReport;
				else delete state.lastGateReport;

				const after = await detectPhase(projectWs);
				if (after !== phase) emit({ type: 'phase', phase: after });
				await this.ctx.storage.put(`phase:${entry.id}`, after);

				state.history.push(...transcript);
			} catch (err) {
				emit({ type: 'error', message: turnFailure(err), fatal: true });
			} finally {
				clearInterval(heartbeat);
				await this.ctx.storage.put(`state:${entry.id}`, state);
				entry.updatedAt = new Date().toISOString();
				await this.#save(reg);
				this.#busy = false;
				this.#abort = null;
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
		return orUnhandled(() => this.#route(req));
	}

	async #route(req: Request): Promise<Response> {
		this.#tenant = req.headers.get('x-substrat-tenant') ?? '';
		this.#tenantSlug = req.headers.get('x-substrat-tenant-slug') ?? '';
		if (!this.#tenant) return refuse(400, 'tenant context is required');
		const url = new URL(req.url);
		if (url.pathname === '/internal/build' && req.method === 'POST') {
			const { slug, request } = await req.json() as { slug: string; request: unknown };
			return this.#build(slug, sourceBuildRequest.parse(request));
		}
		const route = `${req.method} ${url.pathname}`;

		switch (route) {
			case 'GET /api/project-source': {
				return json(200, (await this.#current()).entry);
			}
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
					modelError = providerMessage(err);
				}
				return json(200, {
					root: REPO,
					vertical: entry.dir,
					project: { id: entry.id, name: entry.name, nameSource: entry.nameSource },
					repoMode: entry.directory === '.' ? 'project' : 'scoped',
					sourceProjects: true,
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
					mode: 'hosted — execution in the sandbox container; source in GitHub or Artifacts (D-66)',
				});
			}
			case 'POST /api/turn':
				return this.#turn(req);
			case 'POST /api/abort':
				// Stops the MODEL, not the turn: the running pass ends, the repair
				// loop stops, but gates + commit still run so the work done so far
				// lands in its source repository (same contract as the local server).
				this.#abort?.abort();
				return json(200, { ok: true });
			case 'POST /api/gates': {
				const { entry } = await this.#current();
				const pair = this.#sandboxPair(entry.id);
				await this.#restoreProject(pair, entry);
				// Source checkout already established the repository boundary.
				return json(200, await runGates(this.#sourceWs(pair.sb, entry), entry.directory, standaloneGates(entry.directory)));
			}
			case 'GET /api/snapshot': {
				// The whole working tree in ONE response, served from the editor cache — the sandbox
				// container stays asleep. Miss (legacy project, or none committed since
				// this landed) → build once from the container and cache it; a project
				// with no repo at all is an honest 404 and the SPA falls back to the
				// per-directory endpoints below.
				const { entry } = await this.#current();
				const cached = await this.#cachedSnapshot(entry);
				if (cached) {
					return new Response(cached.body, {
						headers: { 'content-type': 'application/json' },
					});
				}
				const pair = this.#sandboxPair(entry.id);
				await this.#restoreProject(pair, entry);
				const probe = await pair.sb.exec(`test -d ${JSON.stringify(`${this.#repoRoot(entry)}/.git`)}`);
				if (probe.exitCode !== 0) return refuse(404, 'no snapshot yet');
				await this.#saveSnapshot(pair.sb, entry);
				const built = await this.#cachedSnapshot(entry);
				if (!built) return refuse(404, 'no snapshot yet');
				return new Response(built.body, { headers: { 'content-type': 'application/json' } });
			}
			case 'GET /api/files': {
				const { entry } = await this.#current();
				const path = url.searchParams.get('path') ?? entry.dir;
				// The same containment the write route applies, and this is the half that
				// is deployed: a read was jailed only to the REPO, so the file pane served
				// any file in the checkout — the sandbox's own secrets included (#1225).
				const rel = underProject(path, entry.dir);
				if (rel === null) return refuse(403, `reads are limited to ${entry.dir}/`);
				const pair = this.#sandboxPair(entry.id);
				await this.#restoreProject(pair, entry);
				// Through the PROJECT-rooted workspace, so the read is confined twice. NOTE
				// the asymmetry with the local server: `ContainerWorkspace.resolveWithin` is
				// purely lexical — the files live in the container, so it cannot realpath the
				// way `LocalWorkspace` does. A symlink the turn created inside the project is
				// therefore followed here, and the normalised check above is the load-bearing
				// half. Closing that needs a resolve hop through `sb.exec`.
				const projectWs = this.#projectWs(pair.sb, entry.dir);
				try {
					return json(200, { path, entries: await projectWs.listFiles(rel) });
				} catch {
					return refuse(404, `no such directory: ${path}`);
				}
			}
			case 'GET /api/file': {
				const { entry } = await this.#current();
				const path = url.searchParams.get('path');
				if (!path) return refuse(400, 'path required');
				const rel = underProject(path, entry.dir);
				if (rel === null) return refuse(403, `reads are limited to ${entry.dir}/`);
				try {
					return json(200, {
						path,
						content: await this.#projectWs(this.#sandbox(entry.id), entry.dir).readFile(rel),
					});
				} catch {
					return refuse(404, `no such file: ${path}`);
				}
			}
			case 'PUT /api/file': {
				const { entry } = await this.#current();
				const { path, content } = (await req.json().catch(() => ({}))) as {
					path?: string;
					content?: string;
				};
				if (!path || content === undefined)
					return refuse(400, 'path and content required');
				// The same containment the local server applies, and this is the half that
				// is deployed: judged on the NORMALISED path, never the text. A `..` segment
				// after the project prefix passes a `startsWith` test and still names a file
				// anywhere in the repo — which the repo-rooted workspace writes happily,
				// because its own jail only refuses paths that leave the REPO (#1225).
				const rel = withinProject(path, entry.dir);
				if (rel === null) return refuse(403, `writes are limited to ${entry.dir}/`);
				// Through the PROJECT-rooted workspace, so the write is confined twice: once
				// by the check above, and again by that workspace's own jail, which is also
				// what judges a symlink pointing out of the project.
				if (this.#busy) return refuse(409, 'project operation already in progress');
				this.#busy = true;
				try {
					const pair = this.#sandboxPair(entry.id);
					await this.#restoreProject(pair, entry);
					await this.#projectWs(pair.sb, entry.dir).writeFile(rel, content);
					const sourcePath = entry.directory === '.' ? rel : `${entry.directory}/${rel}`;
					await checkedExec(pair.sb, `git -c core.hooksPath=/dev/null add -- ${shellQuote(sourcePath)} && git -c core.hooksPath=/dev/null -c user.name=Substrat -c user.email=builder@substrat.invalid commit --allow-empty -m 'Save source'`, this.#repoRoot(entry));
					await this.#saveSource(pair, entry);
				} finally { this.#busy = false; }
				// Patch the stored snapshot so a reload before the next commit still
				// shows this save. Best-effort: absent snapshot → next commit builds it.
				try {
					const key = this.#snapshotKey(entry);
					const obj = await this.#cachedSnapshot(entry);
					if (obj) {
						const snap = (await obj.json()) as { files: Record<string, string> };
						// `rel`, not a slice of the raw path: the slice of a traversal path
						// keyed the snapshot under `../../…`, so the entry a reload read back
						// was not the file that had been written.
						snap.files[rel] = content;
						await this.ctx.storage.put(key, JSON.stringify(snap));
					}
				} catch {
					/* read path falls back to per-file endpoints */
				}
				return json(200, { ok: true });
			}
			case 'GET /api/providers':
				return json(200, hostedProviderCatalog(this.env));
			case 'GET /api/models': {
				const provider = url.searchParams.get('provider');
				if (!provider) return refuse(400, 'provider required');
				try {
					return json(200, { models: await listModelsHosted(this.env, provider) });
				} catch (err) {
					return problemResponse(providerRefusal(err));
				}
			}
			case 'POST /api/model': {
				if (this.#busy) return refuse(409, 'cannot switch model mid-turn');
				const { spec } = (await req.json().catch(() => ({}))) as { spec?: string };
				if (!spec) return refuse(400, 'spec required (provider:model)');
				try {
					const r = resolveModelHosted(this.env, spec);
					await this.ctx.storage.put('modelSpec', spec);
					return json(200, { spec, endpoint: r.endpoint, endpointSource: 'worker secret' });
				} catch (err) {
					return problemResponse(providerRefusal(err));
				}
			}
			case 'GET /api/history': {
				const { entry } = await this.#current();
				return json(200, (await this.#state(entry.id)).history);
			}
			case 'GET /api/projects': {
				const reg = await this.#registry();
				const sorted = [...reg.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
				return json(200, { current: reg.currentId, projects: sorted });
			}
			case 'POST /api/projects': {
				if (this.#busy) return refuse(409, 'project operation already in progress');
				this.#busy = true;
				try {
					const body = await req.json() as { name?: string; slug?: string; repository?: unknown };
					const name = body.name?.trim() || 'Untitled';
					const repository = body.repository === undefined ? undefined : projectRepository.parse(body.repository);
					if (repository && repository.kind !== 'github') return refuse(400, 'hosted repositories are created by the platform');
					if (repository) await this.#access({ repository } as ProjectEntry, 'read', this.#tenant);
					const slug = body.slug ?? `${this.#tenantSlug || this.#tenant}/draft-${ulid().toLowerCase()}`;
					return json(200, await this.#createProject(name, slug, repository));
				} finally { this.#busy = false; }
			}
			case 'POST /api/projects/select': {
				if (this.#busy) return refuse(409, 'project operation already in progress');
				const { id } = (await req.json().catch(() => ({}))) as { id?: string };
				const reg = await this.#registry();
				const entry = reg.projects.find((p) => p.id === id);
				if (!entry) return refuse(404, `no project ${id}`);
				reg.currentId = entry.id;
				await this.#save(reg);
				return json(200, entry);
			}
			case 'PUT /api/project': {
				if (this.#busy) return refuse(409, 'project operation already in progress');
				const { name } = (await req.json().catch(() => ({}))) as { name?: string };
				if (!name?.trim()) return refuse(400, 'name required');
				const { reg, entry } = await this.#current();
				entry.name = name.trim();
				entry.nameSource = 'user';
				entry.updatedAt = new Date().toISOString();
				await this.#save(reg);
				return json(200, entry);
			}
			default:
				return refuse(503, 'not hosted yet: /api/dev (preview processes) lands with the #626 follow-ups');
		}
	}
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
