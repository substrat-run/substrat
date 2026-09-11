/**
 * The studio's membership read (src/teams.ts, part of #971): the control
 * plane's directory answer is parsed, not asserted.
 *
 * The cast this replaced accepted anything a 200 carried, so the interesting
 * cases are the WRONG shapes — a renamed field, a missing flag, an `{ error }`
 * body answered with a 200. Each of those used to produce `entitled: undefined`
 * or `tenants: undefined` and lock a tenant out of the studio silently; here
 * each one throws.
 *
 * The cache is asserted too, because the parse sits inside it: a hit must not
 * re-fetch, and a refusal must leave nothing cached for the next request to
 * inherit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityTenantsResponse, resetTeamsCache, teamsFor, type TeamsEnv } from '../src/teams.js';

/** A stub service binding: answers a scripted body, counts the calls. */
function cpStub(answer: () => { status?: number; body: unknown }): TeamsEnv & { calls: number } {
	const env = {
		calls: 0,
		CP_SERVICE_TOKEN: 'tok',
		CONTROL_PLANE_SVC: {
			fetch: async (_input: unknown, _init?: unknown) => {
				env.calls += 1;
				const { status = 200, body } = answer();
				return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			},
		},
	} as unknown as TeamsEnv & { calls: number };
	return env;
}

// Real ULIDs: the schema parses the id with the same `tenantId` the `tenant`
// record publishes, so a placeholder that merely looks id-shaped is refused.
const TEN1 = '01J8ZQ4T9XK2V7NH3M5PBRWY6C';
const TEN2 = '01J8ZQ4T9XK2V7NH3M5PBRWY7D';

const GOOD = {
	tenants: [
		{ id: TEN1, slug: 'acme', name: 'Acme', entitled: true },
		{ id: TEN2, slug: 'tenant-a', name: 'Tenant A', entitled: false },
	],
};

beforeEach(() => resetTeamsCache());
afterEach(() => resetTeamsCache());

describe('teamsFor', () => {
	it('parses a well-formed directory answer and caches it', async () => {
		const env = cpStub(() => ({ body: GOOD }));

		const teams = await teamsFor(env, 'sub-1');
		expect(teams).toEqual(GOOD.tenants);
		expect(env.calls).toBe(1);

		// A second read inside the TTL is served from the isolate cache.
		expect(await teamsFor(env, 'sub-1')).toEqual(GOOD.tenants);
		expect(env.calls).toBe(1);

		// A different subject is a different membership: its own subrequest.
		await teamsFor(env, 'sub-2');
		expect(env.calls).toBe(2);
	});

	it('refuses a body whose entitlement flag is missing', async () => {
		// The failure this file exists for: `entitled: undefined` is falsy, so the
		// gate used to deny an entitled tenant and say nothing about the shape.
		const env = cpStub(() => ({
			body: { tenants: [{ id: TEN1, slug: 'acme', name: 'Acme' }] },
		}));
		await expect(teamsFor(env, 'sub-1')).rejects.toThrow(/unexpected shape/);
	});

	it.each([
		['a renamed collection', { teams: GOOD.tenants }],
		['an error document answered 200', { error: 'service token required' }],
		['a retyped flag', { tenants: [{ ...GOOD.tenants[0], entitled: 'yes' }] }],
		['a tenant with no id', { tenants: [{ ...GOOD.tenants[0], id: '' }] }],
		['a bare array', GOOD.tenants],
		['a non-JSON body', 'not json at all'],
		// The three the `tenant` record's own schemas catch and a generic
		// `z.string().min(1)` would not — each is non-empty and still wrong.
		['an id that is not a ULID', { tenants: [{ ...GOOD.tenants[0], id: 'tenant-acme' }] }],
		['a slug with a capital and a space', { tenants: [{ ...GOOD.tenants[0], slug: 'Acme Inc' }] }],
		['an empty name', { tenants: [{ ...GOOD.tenants[0], name: '' }] }],
	])('refuses %s', async (_label, body) => {
		const env = cpStub(() => ({ body }));
		await expect(teamsFor(env, 'sub-1')).rejects.toThrow(/unexpected shape/);
	});

	it('caches nothing when the parse refused', async () => {
		let good = false;
		const env = cpStub(() => ({ body: good ? GOOD : { tenants: null } }));

		await expect(teamsFor(env, 'sub-1')).rejects.toThrow(/unexpected shape/);
		good = true;
		expect(await teamsFor(env, 'sub-1')).toEqual(GOOD.tenants);
		expect(env.calls).toBe(2);
	});

	it('keeps the non-2xx message it always threw', async () => {
		const env = cpStub(() => ({ status: 403, body: { error: 'service token required' } }));
		await expect(teamsFor(env, 'sub-1')).rejects.toThrow(/membership lookup failed: 403/);
	});
});

describe('identityTenantsResponse', () => {
	it('accepts an empty membership — a login that has not signed up yet', () => {
		expect(identityTenantsResponse.parse({ tenants: [] }).tenants).toEqual([]);
	});

	it('drops fields the studio does not declare', () => {
		const parsed = identityTenantsResponse.parse({
			tenants: [{ ...GOOD.tenants[0], plan: 'enterprise' }],
		});
		expect(parsed.tenants[0]).toEqual(GOOD.tenants[0]);
	});
});
