/**
 * The hosted builder studio worker — builder.substrat.net (#625).
 *
 * AUTH IS THE POINT OF THIS FILE. Two gates, both fail closed:
 *
 * 1. OIDC (AuthHero, via @substrat-run/oidc-rp) + an access list in the control
 *    plane's auth D1 (read-only here): platform staff (`staff_actor`,
 *    builder-studio.md §1.1) or a console-granted studio invite
 *    (`builder_access`, CP migration 0003 — the console's Members view manages
 *    it). The invite decouples "may use the studio" from "may act on the
 *    control plane"; both lists stay an AND-gate with team membership until the
 *    builder entitlement flag exists on plans (builder-plane.md §7 open
 *    question) — dropping them is then a deliberate act, not a side effect.
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

/**
 * The access check, fail closed: platform staff (same `staff_actor` table, same
 * semantics as the control plane) OR a console-granted studio invite
 * (`builder_access`, CP migration 0003 — managed from the console's Members
 * view). The invite grants THIS surface and nothing else; staff keep implicit
 * access. Both are AND-ed with team membership below, and both are the interim
 * until the plan-entitlement flag exists (builder-plane.md §7).
 */
async function studioAccessFor(
	env: Env,
	email: string | undefined,
): Promise<'staff' | 'invited' | null> {
	if (!email) return null;
	const e = email.toLowerCase();
	const staff = await env.AUTH_DB.prepare(
		'SELECT actor FROM staff_actor WHERE email = ? AND revoked_at IS NULL',
	)
		.bind(e)
		.first<{ actor: string }>();
	if (staff !== null) return 'staff';
	const invited = await env.AUTH_DB.prepare(
		'SELECT email FROM builder_access WHERE email = ? AND revoked_at IS NULL',
	)
		.bind(e)
		.first<{ email: string }>();
	return invited !== null ? 'invited' : null;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The denied page — what a browser sees on a roster 403 (or a failed login).
 * Self-contained (the SPA and its assets sit BEHIND the gate, so nothing from
 * it can be referenced here). The switch-account link is federated: a plain
 * logout leaves the IdP's SSO cookie alive and the same account signs straight
 * back in, so "use a different account" would never work without it.
 */
function deniedPage(detail: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Builder Studio — access</title>
<style>
	body { margin: 0; display: grid; place-items: center; min-height: 100dvh;
		font-family: ui-sans-serif, system-ui, sans-serif;
		background: #fafafa; color: #18181b; }
	main { max-width: 26rem; padding: 2rem; text-align: center; }
	h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.75rem; }
	p { margin: 0 0 1.5rem; font-size: 0.9rem; line-height: 1.5; color: #52525b; }
	a { display: inline-block; padding: 0.5rem 1rem; border: 1px solid #d4d4d8;
		border-radius: 0.5rem; font-size: 0.85rem; color: inherit; text-decoration: none; }
	a:hover { background: #f4f4f5; }
	@media (prefers-color-scheme: dark) {
		body { background: #111113; color: #e4e4e7; }
		p { color: #a1a1aa; }
		a { border-color: #3f3f46; }
		a:hover { background: #1c1c1f; }
	}
</style>
</head>
<body>
<main>
<h1>Builder Studio</h1>
<p>${escapeHtml(detail)}</p>
<a href="/api/auth/logout?federated&amp;returnTo=/">Sign in with a different account</a>
</main>
</body>
</html>`;
}

const app = new Hono<{ Bindings: Env }>();

// Login/callback/logout — the one anonymous surface.
mountOidcRoutes(app, { onSuccess: '/', onError: '/api/auth/denied' });

app.get('/api/auth/denied', (c) =>
	c.html(deniedPage('Login failed. The builder studio needs a Substrat account with access.'), 403),
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
	const access = await studioAccessFor(c.env, user.email);
	if (!access) {
		// Same split as the 401 above: a page for browsers, JSON for API callers.
		// Still names the email, never the app (header comment: fail closed).
		const detail = `The builder studio is invite-only. ${user.email ?? 'This account'} does not have access yet.`;
		if (c.req.header('accept')?.includes('text/html')) {
			return c.html(deniedPage(detail), 403);
		}
		return c.json({ error: detail }, 403);
	}
	c.set('user' as never, user as never);
	c.set('access' as never, access as never);
	await next();
});

/** The studio's usage rollup (#646) — served by the worker, not the agent DO:
 * the ledger lives in the SCOPE DO and the worker holds that binding. Still
 * STUDIO-WIDE (the fixed metering node, src/metering.ts): per-team ledgers are
 * the follow-up that retires that node — until then the reading is cross-team,
 * so it is STAFF-ONLY: an invited builder must not see other teams' spend. */
app.get('/api/usage', async (c) => {
	if ((c.get('access' as never) as string) !== 'staff') {
		return c.json({ error: 'usage is staff-only until it is per-team' }, 403);
	}
	return c.json(await studioUsage(c.env));
});

/** Who am I, and which teams can I build for. The SPA calls this first; a 404
 * from the local server (mode A) is its cue that there are no teams to pick.
 * `staff` drives what the SPA offers (the studio-wide usage tab), never what
 * the worker enforces — the /api/usage gate above is the enforcement. */
app.get('/api/me', async (c) => {
	const user = c.get('user' as never) as SessionUser;
	return c.json({
		email: user.email ?? null,
		staff: (c.get('access' as never) as string) === 'staff',
		teams: await teamsFor(c.env, user.id),
	});
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
