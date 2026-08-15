/**
 * The hosted builder studio worker — builder.substrat.net (#625).
 *
 * AUTH IS THE POINT OF THIS FILE. Two gates, both fail closed:
 *
 * 1. OIDC (AuthHero, via @substrat-run/oidc-rp) + the control plane's staff
 *    roster (D1 `staff_actor`, read-only) — builder-studio.md §1.1. The roster
 *    stays as an AND-gate until the builder entitlement flag exists on plans
 *    (builder-plane.md §7 open question); dropping it is then a one-line,
 *    deliberate act, not a side effect of the teams work.
 * 2. Team membership (builder-studio.md §14): every studio URL and API call is
 *    scoped to a TEAM (= tenant, dashboard-teams.md), and each team gets its
 *    own BuilderAgent DO — `idFromName(tenantId)`, mirroring the per-tenant
 *    IdentityDO pattern. Membership is resolved from the shared control-plane
 *    directory (the identity links the dashboard mirrors in) via the
 *    service-binding call below; the `x-substrat-tenant` header names which
 *    membership a request acts in. The pre-teams shared instance
 *    (`idFromName('studio')`) is deliberately abandoned, not migrated —
 *    nothing in it was worth saving (2026-08-15).
 *
 * EVERYTHING routes through the worker (`run_worker_first: true`): the SPA
 * shell itself is gated, so even assets are behind auth. The only anonymous
 * surface is the OIDC login flow.
 *
 * Scope of the shell (#625): auth + SPA + the BuilderAgent DO carrying the
 * durable session state (projects, history, names). Endpoints that need a
 * workspace — turns, gates, files, run, provider resolution — return 503
 * naming #626 (ContainerWorkspace): the hosted studio is honest about not
 * being able to execute yet, rather than pretending with a broken loop.
 */
import { Hono } from 'hono';
import { defineScopeDO } from '@substrat-run/adapter-cloudflare';
import { meteringModule } from '@substrat-run/engine-metering';
import { studioUsage } from './metering.js';
import {
	mountOidcRoutes,
	SESSION_COOKIE,
	verifySession,
	type OidcEnv,
	type SessionUser,
} from '@substrat-run/oidc-rp';

export { BuilderAgent } from './agent.js';
// The execution container's DO class (#626) — wrangler requires the export here.
export { Sandbox } from '@cloudflare/sandbox';
// The studio's kernel scope (#646): one CP-less ScopeDO bundling only the
// metering engine — the builder's first kernel-backed table (src/metering.ts).
export const ScopeDO = defineScopeDO([meteringModule], {});

export interface Env extends OidcEnv {
	/** The control plane's auth DB — read-only roster lookups, never writes. */
	AUTH_DB: D1Database;
	BUILDER_AGENT: DurableObjectNamespace;
	/** The studio's own kernel scope (#646) — usage metering lives here. */
	SCOPE: DurableObjectNamespace;
	ASSETS: Fetcher;
	/** The shared control plane — membership lookups over the service binding. */
	CONTROL_PLANE_SVC: Fetcher;
	/** The control plane's SERVICE_TOKEN, under the studio's name for it (the
	 * dashboard precedent: CP_SERVICE_TOKEN in secrets.mjs). */
	CP_SERVICE_TOKEN?: string;
}

/** The tenant-selection header — same name, same meaning as the CP API's. */
const TENANT_HEADER = 'x-substrat-tenant';

export interface Team {
	id: string;
	slug: string;
	name: string;
}

/**
 * The teams (= tenants, dashboard-teams.md) this login builds for, from the
 * shared directory. One subrequest per API call that needs it (assets don't);
 * the CP answers from its own DO, so this is a directory read, not a fan-out.
 */
async function teamsFor(env: Env, sub: string): Promise<Team[]> {
	const res = await env.CONTROL_PLANE_SVC.fetch(
		'https://control-plane/internal/builder/identity-tenants',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-service-token': env.CP_SERVICE_TOKEN ?? '',
			},
			body: JSON.stringify({ externalId: sub }),
		},
	);
	if (!res.ok) {
		throw new Error(`membership lookup failed: ${res.status} ${await res.text().catch(() => '')}`);
	}
	const body = (await res.json()) as { tenants: Team[] };
	return body.tenants;
}

function readCookie(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return v.join('=');
	}
	return undefined;
}

/** Roster check — same table, same fail-closed semantics as the control plane. */
async function isStaff(env: Env, email: string | undefined): Promise<boolean> {
	if (!email) return false;
	const row = await env.AUTH_DB.prepare(
		'SELECT actor FROM staff_actor WHERE email = ? AND revoked_at IS NULL',
	)
		.bind(email.toLowerCase())
		.first<{ actor: string }>();
	return row !== null;
}

const app = new Hono<{ Bindings: Env }>();

// Login/callback/logout — the one anonymous surface.
mountOidcRoutes(app, { onSuccess: '/', onError: '/api/auth/denied' });

app.get('/api/auth/denied', (c) =>
	c.text('Login failed. The builder studio is staff-only.', 403),
);

/** The gate. Order matters: OIDC session first, then roster. */
app.use('*', async (c, next) => {
	const token = readCookie(c.req.header('cookie') ?? null, SESSION_COOKIE);
	const user: SessionUser | null = await verifySession(c.env, token);
	if (!user) {
		// Browsers get sent to login; API callers get the 401 they can parse.
		if (c.req.header('accept')?.includes('text/html')) {
			return c.redirect(`/api/auth/login?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
		}
		return c.json({ error: 'not signed in' }, 401);
	}
	if (!(await isStaff(c.env, user.email))) {
		return c.text(
			`The builder studio is staff-only. ${user.email ?? 'This account'} is not on the roster.`,
			403,
		);
	}
	c.set('user' as never, user as never);
	await next();
});

/** The studio's usage rollup (#646) — served by the worker, not the agent DO:
 * the ledger lives in the SCOPE DO and the worker holds that binding. Still
 * STUDIO-WIDE (the fixed metering node, src/metering.ts): per-team ledgers are
 * the follow-up that retires that node — acceptable meanwhile only because the
 * staff AND-gate above keeps every viewer on the roster. */
app.get('/api/usage', async (c) => c.json(await studioUsage(c.env)));

/** Who am I, and which teams can I build for. The SPA calls this first; a 404
 * from the local server (mode A) is its cue that there are no teams to pick. */
app.get('/api/me', async (c) => {
	const user = c.get('user' as never) as SessionUser;
	return c.json({ email: user.email ?? null, teams: await teamsFor(c.env, user.id) });
});

/**
 * Session/state endpoints live on the DO — ONE PER TEAM (`idFromName(tenantId)`),
 * so projects, history, and names partition by tenant. The header names which
 * membership the call acts in; anything not in the caller's own list is refused
 * before the DO is ever addressed. Fail closed: no header, no dispatch.
 */
app.all('/api/*', async (c) => {
	const user = c.get('user' as never) as SessionUser;
	const selected = c.req.header(TENANT_HEADER)?.trim();
	if (!selected) return c.json({ error: `${TENANT_HEADER} header (a team id) is required` }, 400);
	const teams = await teamsFor(c.env, user.id);
	const team = teams.find((t) => t.id === selected);
	if (!team) return c.json({ error: `not a member of team '${selected}'` }, 403);
	const id = c.env.BUILDER_AGENT.idFromName(team.id);
	return await c.env.BUILDER_AGENT.get(id).fetch(c.req.raw);
});

/** Everything else is the SPA — already behind the gate above. */
app.all('*', async (c) => await c.env.ASSETS.fetch(c.req.raw));

export default app;
