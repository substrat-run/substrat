/**
 * The studio's membership read (builder-plane.md §4) — the control plane's
 * directory answer, PARSED rather than asserted (part of #971).
 *
 * This is the "parse, don't trust" rule applied to a service-binding read. The
 * cast it replaces (`(await res.json()) as { tenants: Team[] }`) made every
 * field optimistic: a control plane that renamed `entitled`, or answered a
 * `{ error }` body with a 200, handed the gate `entitled: undefined` — falsy,
 * so the studio locked the tenant out with the ordinary "not enabled for your
 * team yet" page and nothing anywhere said the directory had changed shape.
 * A refused parse throws instead, where a 500 and a log line are visible.
 *
 * The request, the problem-document read of a refusal and the parse itself are
 * `ControlPlaneClient.identityTenants` (control-plane-api). What stays here is the
 * per-isolate cache around it.
 *
 * It lives beside the worker rather than inside it because the worker's own
 * module graph reaches `cloudflare:workers` (agent.ts) and so cannot be
 * imported by a node test — and the cache is exactly the part worth a test.
 */
import { ControlPlaneClient, type IdentityTenant } from '@substrat-run/control-plane-api';

/** A tenant this login builds for, as the control plane states it — the schema is
 * the control-plane client's, which is what parses the directory answer. */
export type Team = IdentityTenant;

/** The bindings this read needs — the subset of the worker's `Env`. */
export interface TeamsEnv {
	/** The shared control plane — membership lookups over the service binding. */
	CONTROL_PLANE_SVC: Fetcher;
	/** The control plane's SERVICE_TOKEN, under the studio's name for it. */
	CP_SERVICE_TOKEN?: string;
}

/** Per-isolate membership cache — the trade the worker's gate comment names:
 * every file-tree click was paying a CP subrequest, so memberships are held
 * for TEAMS_TTL_MS and revocation lags by at most that. Isolate-local by
 * design: no cross-user leakage beyond what teamsFor itself returns per sub. */
export const TEAMS_TTL_MS = 60_000;
const teamsCache = new Map<string, { teams: Team[]; until: number }>();

/**
 * The teams (= tenants, dashboard-teams.md) this login builds for, from the
 * shared directory — each flagged with the `builder` entitlement (the studio's
 * gate). One subrequest per request that needs it; the CP answers from its own
 * DO, so this is a directory read, not a fan-out.
 */
export async function teamsFor(env: TeamsEnv, sub: string): Promise<Team[]> {
	const hit = teamsCache.get(sub);
	if (hit && hit.until > Date.now()) return hit.teams;
	const teams = await teamsForUncached(env, sub);
	teamsCache.set(sub, { teams, until: Date.now() + TEAMS_TTL_MS });
	return teams;
}

async function teamsForUncached(env: TeamsEnv, sub: string): Promise<Team[]> {
	// The client reads a refusal's problem document into a `ControlPlaneError` and
	// parses the answer's shape; what this file adds is the cache around it. The
	// binding's `fetch` is BOUND: a service binding checks its receiver, as workerd
	// does the global's (lint:bound-fetch).
	const cp = new ControlPlaneClient({
		baseUrl: 'https://control-plane',
		// Never sent: with a service token the plane resolves the subject from the
		// token, and without one it refuses this route whatever the header says.
		actor: 'builder-studio',
		serviceToken: env.CP_SERVICE_TOKEN,
		fetch: env.CONTROL_PLANE_SVC.fetch.bind(env.CONTROL_PLANE_SVC),
	});
	return await cp.identityTenants(sub);
}

/** Test seam: drop the isolate's cache. Never called by the worker. */
export function resetTeamsCache(): void {
	teamsCache.clear();
}
