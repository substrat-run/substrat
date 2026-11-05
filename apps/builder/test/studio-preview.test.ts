/**
 * Hosted Run (src/studio-preview.ts, #2895): release the saved revision, bind it to the
 * studio's one preview tag, and relay any refusal in the plane's own words.
 */
import { describe, expect, it } from 'vitest';
import { STUDIO_PREVIEW_TAG, readStudioPreview, runStudioPreview, type ControlPlaneCall } from '../src/studio-preview.js';

interface Call { path: string; method: string; body: unknown }

/** A scripted control plane: one answer per path, every call recorded. */
function plane(answers: Record<string, { status?: number; body: unknown }>): { cp: ControlPlaneCall; calls: Call[] } {
	const calls: Call[] = [];
	const cp: ControlPlaneCall = async (path, init) => {
		calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const answer = answers[path];
		if (!answer) return new Response('{}', { status: 599 });
		return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
	};
	return { cp, calls };
}

const project = { slug: 'acme/todo', revision: 'a'.repeat(40) };
const deploy = '/verticals/acme%2Ftodo/deploy';
const previews = '/verticals/acme%2Ftodo/previews';
const ready = { url: 'https://todo--studio.acme.substrat.run', scopeId: 'scp_1', versionId: 'ver_1', reused: false, auth: { status: 'unregistered', note: 'no login yet' } };

describe('runStudioPreview', () => {
	it('releases the revision pinned to the team, then binds it to the studio tag as a clean-room slot', async () => {
		const { cp, calls } = plane({ [deploy]: { status: 201, body: { id: 'ver_1' } }, [previews]: { status: 201, body: ready } });
		const res = await runStudioPreview(cp, project, 'ten_a', { versionLabel: '0.0.0-studio.x' });
		expect(calls).toEqual([
			{ path: deploy, method: 'POST', body: { version: '0.0.0-studio.x', revision: project.revision, tenant: 'ten_a' } },
			{ path: previews, method: 'POST', body: { tag: STUDIO_PREVIEW_TAG, versionId: 'ver_1', empty: true } },
		]);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ state: 'ready', url: ready.url, versionId: 'ver_1', reused: false, authNote: 'no login yet' });
	});

	it('relays a refused release as it came and never asks for a slot', async () => {
		const refusal = { error: 'a build of this vertical is already running', detail: 'a build of this vertical is already running' };
		const { cp, calls } = plane({ [deploy]: { status: 409, body: refusal } });
		const res = await runStudioPreview(cp, project, 'ten_a', { versionLabel: 'v' });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual(refusal);
		expect(calls.map((c) => c.path)).toEqual([deploy]);
	});

	it('answers copying while the plane copies, and resumes with the built version without releasing again', async () => {
		const copying = { copying: true, scopeId: 'scp_1', versionId: 'ver_1', progress: { pages: 1, rows: 9, attempt: 1 }, retryAfter: 5 };
		const { cp, calls } = plane({ [previews]: { status: 202, body: copying } });
		const res = await runStudioPreview(cp, project, 'ten_a', { versionLabel: 'v', versionId: 'ver_1' });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ state: 'copying', versionId: 'ver_1', retryAfter: 5 });
		expect(calls.map((c) => c.path)).toEqual([previews]);
	});

	it('refuses a project with no saved revision before calling the plane', async () => {
		const { cp, calls } = plane({});
		const res = await runStudioPreview(cp, { slug: 'acme/todo' }, 'ten_a', { versionLabel: 'v' });
		expect(res.status).toBe(409);
		expect(calls).toEqual([]);
	});
});

describe('readStudioPreview', () => {
	it.each([
		['the studio slot', { status: 200, body: [{ tag: 'pr-7', versionId: 'ver_0', url: 'https://x' }, { tag: 'studio', versionId: 'ver_1', url: ready.url }] }, { state: 'ready', url: ready.url, versionId: 'ver_1', reused: true }],
		['none when only CI slots exist', { status: 200, body: [{ tag: 'pr-7', versionId: 'ver_0', url: 'https://x' }] }, { state: 'none' }],
		['none for a project never released', { status: 404, body: { error: "unknown vertical 'acme/todo'" } }, { state: 'none' }],
	])('reads %s', async (_name, answer, expected) => {
		const { cp } = plane({ [previews]: answer });
		const res = await readStudioPreview(cp, project);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(expected);
	});
});
