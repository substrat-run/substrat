/**
 * The studio's staff check (src/staff.ts, #1359). Staff bypass the builder entitlement,
 * and the roster keys on the address — so an address the issuer did not verify must never
 * be looked up, by default, with nothing configured. The roster here is a stub that
 * lists one address and records whether it was asked at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionUser } from '@substrat-run/oidc-rp';
import { deniedDetail, staffAccessOf, type StaffEnv } from '../src/staff.js';

const ROSTERED = 'staff@substrat.run';

function rosterOf(...emails: string[]): StaffEnv & { asked: string[] } {
	const asked: string[] = [];
	const db = {
		prepare: () => ({
			bind: (email: string) => ({
				first: async () => {
					asked.push(email);
					return emails.includes(email) ? { actor: '01JZ0000000000000000000AAA' } : null;
				},
			}),
		}),
	};
	return { AUTH_DB: db as unknown as D1Database, asked };
}

const session = (emailVerified: boolean | undefined): SessionUser => ({ id: 'sub-1', email: ROSTERED, emailVerified });

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('staffAccessOf', () => {
	it('a verified, rostered address is staff', async () => {
		expect(await staffAccessOf(rosterOf(ROSTERED), session(true))).toEqual({ staff: true });
	});

	it.each([
		['false', false, 'unverified'],
		['absent', undefined, 'unasserted'],
	] as const)('a rostered address whose claim is %s is not staff, and the roster is never asked', async (_l, verified, why) => {
		const env = rosterOf(ROSTERED);
		expect(await staffAccessOf(env, session(verified))).toEqual({ staff: false, refused: why });
		expect(env.asked).toEqual([]);
	});

	it('the break-glass looks an unverified address up, and logs that it did', async () => {
		const env = { ...rosterOf(ROSTERED), OIDC_ALLOW_UNVERIFIED_EMAIL: 'true' };
		expect(await staffAccessOf(env, session(false))).toEqual({ staff: true });
		expect(warn.mock.calls.some((c) => String(c[0]).includes('admitted'))).toBe(true);
	});

	it('a verified address that is not rostered is not staff', async () => {
		expect(await staffAccessOf(rosterOf('someone-else@substrat.run'), session(true))).toEqual({ staff: false });
	});
});

describe('deniedDetail', () => {
	it('tells a session that predates the claim to sign in again', () => {
		expect(deniedDetail(session(undefined), 'unasserted')).toMatch(/sign in again/);
	});

	it('keeps the entitlement sentence for an address that was looked up', () => {
		expect(deniedDetail(session(true), undefined)).toMatch(/not enabled for/);
	});
});
