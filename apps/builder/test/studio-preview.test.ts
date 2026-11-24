/**
 * Hosted Run (src/studio-preview.ts, #2895): release the saved revision, bind it to the
 * studio's one preview tag, and relay any refusal in the plane's own words.
 */
import { describe, expect, it } from 'vitest';
import {
	FramedSignInCache,
	STALE_AUTH_NOTE,
	STUDIO_DATA_PREVIEW_TAG,
	STUDIO_PREVIEW_TAG,
	personPlane,
	readStudioDataPreview,
	readStudioPersonas,
	readStudioPreview,
	runStudioDataPreview,
	runStudioPreview,
	studioSignIn,
	type ControlPlaneCall,
	type PreviewFetch,
} from '../src/studio-preview.js';

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
/** The plane's answer to "what is already built from this revision", pinned to the team. */
const built = `/verticals/acme%2Ftodo/builds/${'a'.repeat(40)}?tenant=ten_a`;
const lookup = { path: built, method: 'GET', body: undefined };
const ready = { url: 'https://todo--studio.acme.substrat.run', scopeId: 'scp_1', versionId: 'ver_1', reused: false, auth: { status: 'unregistered', note: 'no login yet' } };

describe('runStudioPreview', () => {
	it('releases a revision nothing was built from, pinned to the team, then binds it to the studio tag as a seeded clean-room slot', async () => {
		// The lookup is unanswered (599): any answer but a version builds, as Run always did.
		const { cp, calls } = plane({ [deploy]: { status: 201, body: { id: 'ver_1' } }, [previews]: { status: 201, body: ready } });
		const res = await runStudioPreview(cp, project, 'ten_a', '0.0.0-studio.x');
		expect(calls).toEqual([
			lookup,
			{ path: deploy, method: 'POST', body: { version: '0.0.0-studio.x', revision: project.revision, tenant: 'ten_a' } },
			{ path: previews, method: 'POST', body: { tag: STUDIO_PREVIEW_TAG, versionId: 'ver_1', empty: true, seed: true } },
		]);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ state: 'ready', url: ready.url, versionId: 'ver_1', reused: false, built: true, authNote: 'no login yet' });
	});

	it('binds the version already built from the revision, and builds nothing', async () => {
		const { cp, calls } = plane({ [built]: { body: { id: 'ver_0' } }, [previews]: { status: 200, body: { ...ready, versionId: 'ver_0', reused: true } } });
		const res = await runStudioPreview(cp, project, 'ten_a', '0.0.0-studio.x');
		expect(calls).toEqual([
			lookup,
			{ path: previews, method: 'POST', body: { tag: STUDIO_PREVIEW_TAG, versionId: 'ver_0', empty: true, seed: true } },
		]);
		expect(await res.json()).toMatchObject({ state: 'ready', versionId: 'ver_0', built: false });
	});

	it('relays a refused release as it came and never asks for a slot', async () => {
		const refusal = { error: 'a build of this vertical is already running', detail: 'a build of this vertical is already running' };
		const { cp, calls } = plane({ [deploy]: { status: 409, body: refusal } });
		const res = await runStudioPreview(cp, project, 'ten_a', 'v');
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual(refusal);
		expect(calls.map((c) => c.path)).toEqual([built, deploy]);
	});

	it('refuses a project with no saved revision before calling the plane', async () => {
		const { cp, calls } = plane({});
		const res = await runStudioPreview(cp, { slug: 'acme/todo' }, 'ten_a', 'v');
		expect(res.status).toBe(409);
		expect(calls).toEqual([]);
	});
});

describe('readStudioPreview', () => {
	const now = new Date('2026-11-05T12:00:00Z');
	const ci = { scopeId: 'scp_0', tag: 'pr-7', versionId: 'ver_0', url: 'https://x', expiresAt: null };
	it.each([
		['the studio slot', { status: 200, body: [ci, { scopeId: 'scp_1', tag: 'studio', versionId: 'ver_1', url: ready.url, expiresAt: '2026-11-06T00:00:00Z' }] }, { state: 'ready', url: ready.url, versionId: 'ver_1', reused: true }],
		['none when only CI slots exist', { status: 200, body: [ci] }, { state: 'none' }],
		['none for a slot past its TTL', { status: 200, body: [{ scopeId: 'scp_1', tag: 'studio', versionId: 'ver_1', url: ready.url, expiresAt: '2026-11-05T11:59:59Z' }] }, { state: 'none' }],
		['none for a project never released', { status: 404, body: { error: "unknown vertical 'acme/todo'" } }, { state: 'none' }],
	])('reads %s', async (_name, answer, expected) => {
		const { cp } = plane({ [previews]: answer });
		const res = await readStudioPreview(cp, project, now);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(expected);
	});
});

describe('production data (#3108): the fork is made as the signed-in person', () => {
	// The token cache lives as long as the isolate, so each case names its own person.
	it('mints one tenant token naming the person, makes every call with it, and mints again on a 401', async () => {
		const { cp, calls } = plane({ '/tenant-tokens': { status: 201, body: { token: 'stt1.x' } } });
		const used: string[] = [];
		const statuses = [200, 200, 401, 200];
		const asPerson = personPlane(cp, (token) => async () => {
			used.push(token);
			return new Response('{}', { status: statuses.shift() });
		}, 'ten_a', 'prn_ann');
		await asPerson('/anything');
		await asPerson('/anything');
		expect((await asPerson('/anything')).status).toBe(200);
		const mint = { path: '/tenant-tokens', method: 'POST', body: { tenantId: 'ten_a', principal: 'prn_ann' } };
		expect(calls).toEqual([mint, mint]);
		expect(used).toHaveLength(4);
	});

	it('answers a call with the refused mint, and asks again next time', async () => {
		const { cp, calls } = plane({ '/tenant-tokens': { status: 501, body: { detail: 'tenant tokens are not configured on this control plane' } } });
		const asPerson = personPlane(cp, () => async () => new Response('{}'), 'ten_a', 'prn_bo');
		const res = await asPerson('/anything');
		expect(res.status).toBe(501);
		expect(await res.json()).toMatchObject({ detail: expect.stringMatching(/not configured on this control plane$/) });
		await asPerson('/anything');
		expect(calls).toHaveLength(2);
	});

	const check = `${previews}/fork-check`;
	const admitted = { body: { ok: true, sourceScopeId: 'scp_1' } };

	it('asks first, releases with the builder credential, then forks into the data slot as the person', async () => {
		const builder = plane({ [deploy]: { status: 201, body: { id: 'ver_1' } } });
		const person = plane({ [check]: admitted, [previews]: { status: 201, body: ready } });
		const res = await runStudioDataPreview(builder.cp, person.cp, project, 'ten_a', 'v');
		expect(builder.calls.map((c) => c.path)).toEqual([built, deploy]);
		expect(person.calls).toEqual([
			{ path: check, method: 'GET', body: undefined },
			{ path: previews, method: 'POST', body: { tag: STUDIO_DATA_PREVIEW_TAG, versionId: 'ver_1' } },
		]);
		expect(res.status).toBe(200);
	});

	it('refuses a person the plane would refuse before building anything', async () => {
		const builder = plane({ [deploy]: { status: 201, body: { id: 'ver_1' } } });
		const person = plane({ [check]: { body: { ok: false, code: 'not-owner', reason: 'plane words' } } });
		const res = await runStudioDataPreview(builder.cp, person.cp, project, 'ten_a', 'v');
		expect(res.status).toBe(403);
		expect(builder.calls).toEqual([]);
	});

	it("relays the plane's refusal of the person as it came", async () => {
		const builder = plane({ [deploy]: { status: 201, body: { id: 'ver_1' } } });
		const refusal = { detail: "copying scp_1's data takes its owner, or every role its owner holds there" };
		const person = plane({ [check]: admitted, [previews]: { status: 403, body: refusal } });
		const res = await runStudioDataPreview(builder.cp, person.cp, project, 'ten_a', 'v');
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual(refusal);
	});

	it.each([
		['admitted', admitted, { ok: true }],
		['a project never released', { status: 404, body: {} }, { ok: false, reason: expect.stringMatching(/^not installed yet/) }],
		["a refusal it words itself", { body: { ok: false, code: 'not-owner', reason: 'plane words' } }, { ok: false, reason: "only the app's owner can copy its production data" }],
		["a refusal it has no words for", { body: { ok: false, code: 'new-code', reason: 'plane words' } }, { ok: false, reason: 'plane words' }],
	])('reads whether Run may fork: %s', async (_name, answer, fork) => {
		const { cp } = plane({ [previews]: { body: [] }, [check]: answer });
		const res = await readStudioDataPreview(cp, project, new Date('2026-11-05T12:00:00Z'));
		expect(await res.json()).toEqual({ state: 'none', fork });
	});
});

describe("sign in as… (#3145): the seeded slot's personas, and a ticket for one", () => {
	const now = new Date('2026-11-05T12:00:00Z');
	const slot = { body: [{ scopeId: 'scp_1', tag: 'studio', versionId: 'ver_1', url: ready.url, expiresAt: null }] };
	const ada = { sub: 'dev|ada', name: 'Ada', email: 'ada@example.test' };
	const offering = { '/internal/builder/persona/scp_1/personas': { body: { personas: [ada] } } };
	/** The preview's login answering with this flow cookie, every probe recorded. */
	const login = (flowCookie: string): { fetchPreview: PreviewFetch; probed: Array<{ url: string; redirect?: string }> } => {
		const probed: Array<{ url: string; redirect?: string }> = [];
		const fetchPreview: PreviewFetch = async (url, init) => {
			probed.push({ url, redirect: init.redirect });
			const headers = new Headers({ location: 'https://issuer.test/authorize' });
			headers.append('set-cookie', flowCookie);
			return new Response(null, { status: 302, headers });
		};
		return { fetchPreview, probed };
	};
	const partitioned = 'sb_oidc_flow=f; Path=/; Max-Age=600; HttpOnly; SameSite=None; Secure; Partitioned';

	it("asks the slot's own issuer, for the person the studio vouches for, and relays its answer", async () => {
		const builder = plane({ [previews]: slot });
		const internal = plane({
			...offering,
			'/internal/builder/persona/scp_1/ticket': { status: 403, body: { detail: "only a member of the preview's team can sign in to it" } },
		});
		const { fetchPreview, probed } = login(partitioned);
		const personas = await readStudioPersonas(builder.cp, internal.cp, fetchPreview, project, 'user-1', now);
		expect(((await personas.json()) as { personas: unknown[] }).personas).toHaveLength(1);
		const ticket = await studioSignIn(builder.cp, internal.cp, project, 'user-1', 'dev|ada', now);
		expect(ticket.status).toBe(403);
		expect(internal.calls).toEqual([
			{ path: '/internal/builder/persona/scp_1/personas', method: 'POST', body: { externalId: 'user-1' } },
			{ path: '/internal/builder/persona/scp_1/ticket', method: 'POST', body: { externalId: 'user-1', sub: 'dev|ada' } },
		]);
		expect(probed).toEqual([{ url: `${ready.url}/api/auth/login`, redirect: 'manual' }]);
	});

	it.each<[string, PreviewFetch, unknown]>([
		[
			'offers nobody, and says why, when the login sets its cookies unpartitioned',
			login('sb_oidc_flow=f; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure').fetchPreview,
			{ personas: [], note: STALE_AUTH_NOTE },
		],
		[
			'still offers its people when the probe cannot reach the preview',
			async () => { throw new TypeError('network connection lost'); },
			{ personas: [ada] },
		],
		[
			'still offers its people when the preview answers with no flow cookie to judge',
			async () => new Response('upstream unavailable', { status: 503 }),
			{ personas: [ada] },
		],
	])('%s', async (_name, fetchPreview, expected) => {
		const builder = plane({ [previews]: slot });
		const internal = plane(offering);
		const res = await readStudioPersonas(builder.cp, internal.cp, fetchPreview, project, 'user-1', now);
		expect(await res.json()).toEqual(expected);
	});

	it('probes a version once, and asks again only while the answer is undecided', async () => {
		const builder = plane({ [previews]: slot });
		const internal = plane(offering);
		const framed = new FramedSignInCache();
		const unreachable: PreviewFetch = async () => { throw new TypeError('network connection lost'); };
		await readStudioPersonas(builder.cp, internal.cp, unreachable, project, 'user-1', now, framed);
		const { fetchPreview, probed } = login(partitioned);
		for (let i = 0; i < 2; i++) await readStudioPersonas(builder.cp, internal.cp, fetchPreview, project, 'user-1', now, framed);
		expect(probed).toHaveLength(1);
	});

	it('offers nobody, and mints nothing, with no slot running', async () => {
		const builder = plane({ [previews]: { body: [] } });
		const internal = plane({});
		expect(await (await readStudioPersonas(builder.cp, internal.cp, login(partitioned).fetchPreview, project, 'user-1', now)).json()).toEqual({ personas: [] });
		expect((await studioSignIn(builder.cp, internal.cp, project, 'user-1', 'dev|ada', now)).status).toBe(409);
		expect(internal.calls).toEqual([]);
	});
});
