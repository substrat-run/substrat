/**
 * The hosted builder studio worker — builder.substrat.net (#625).
 *
 * AUTH IS THE POINT OF THIS FILE (builder-studio.md §1.1: staff-only, unlisted).
 * In mode A the loopback binding was the auth; on a public hostname the gate is
 * OIDC (AuthHero, via @substrat-run/oidc-rp — the platform-apps pattern) plus
 * the SAME staff roster the control plane consults (D1 `staff_actor`, bound
 * read-only here). Fail closed: authenticated is not authorized — an
 * un-rostered login gets a 403 naming the email, never the app.
 *
 * EVERYTHING routes through the worker (`run_worker_first: true`): the SPA
 * shell itself is staff-only, so even assets are behind the gate. The only
 * anonymous surface is the OIDC login flow.
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

/** Session/state endpoints live on the DO — one named instance, the studio's
 * single home, mirroring the one-process local server it replaces. */
app.all('/api/*', async (c) => {
	const id = c.env.BUILDER_AGENT.idFromName('studio');
	return await c.env.BUILDER_AGENT.get(id).fetch(c.req.raw);
});

/** Everything else is the SPA — already behind the gate above. */
app.all('*', async (c) => await c.env.ASSETS.fetch(c.req.raw));

export default app;
