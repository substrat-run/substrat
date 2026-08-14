/**
 * BuilderAgent — the studio's durable home (#625; builder-studio.md §7.1).
 *
 * This DO carries exactly what `src/server.ts` kept in `.builder/` locally:
 * the project registry, per-project chat history, model choice. The local
 * server was written as this class's 1:1 analog, and the storage keys mirror
 * the local files:
 *
 *   .builder/projects.json   →  storage 'registry'
 *   .builder/state/<id>.json →  storage 'state:<id>'
 *
 * Deliberately a plain DurableObject rather than the Agents SDK's AIChatAgent
 * for the shell: the SDK earns its place when the chat loop moves in
 * (WebSocket resume, AIChatAgent persistence) — which is #626's turn, because
 * a turn needs a workspace. Until then every execution endpoint 503s naming
 * #626 instead of pretending.
 */
import { DurableObject } from 'cloudflare:workers';
import type { GeneratorTurn } from '@substrat-run/builder-generator';

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

/** ULID, Web-Crypto only — same wire shape as kernel `ulid()` (which is not
 * imported to keep the DO's dependency set worker-lean). */
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

const NOT_YET = {
	error: 'hosted execution lands with #626 (ContainerWorkspace) — the shell holds sessions only',
};

export class BuilderAgent extends DurableObject {
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
				dir: `projects/untitled`,
				createdAt: now,
				updatedAt: now,
			};
			reg.projects.push(entry);
			reg.currentId = entry.id;
			await this.#save(reg);
		}
		return { reg, entry };
	}

	override async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const route = `${req.method} ${url.pathname}`;
		const json = (status: number, body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			});

		switch (route) {
			case 'GET /api/session': {
				const { entry } = await this.#current();
				const state = await this.#state(entry.id);
				return json(200, {
					root: '(hosted)',
					vertical: entry.dir,
					project: { id: entry.id, name: entry.name, nameSource: entry.nameSource },
					repoMode: 'project',
					conceptApproved: false, // workspace-derived; real answer arrives with #626
					modelSpec: (await this.ctx.storage.get('modelSpec')) ?? 'anthropic:claude-opus-5',
					modelError: NOT_YET.error,
					envFiles: [],
					busy: false,
					turns: state.turnNo,
					foreign: [],
					mode: 'hosted shell — execution pending #626',
				});
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
					dir: `projects/${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'}`,
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
				// Turns, gates, files, dev, providers, models — all need a workspace.
				return json(503, NOT_YET);
		}
	}
}
