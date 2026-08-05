/**
 * This vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less: the shape `substrat push` deploys into the platform's
 * dispatch namespace. Its only durable stores are its OWN DO classes — `SCOPE`
 * (kernel + engines + this vertical, bundled) and `SWEEPER` (the deployment's
 * own timer, #461); no CONTROL_PLANE binding, no service bindings, no ASSETS
 * binding — the platform refuses those.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json (entry = this file, stores = the DO classes exported here) —
 * you never author wrangler config.
 *
 * ── THE AUTH SEAM ────────────────────────────────────────────────────────────
 * This starter resolves a caller ONLY through the `x-principal` dev header,
 * gated on ALLOW_DEV_HEADER — an impersonation bypass by design, for local
 * `wrangler dev` and smoke tests. In production the gate is off and every
 * /api/* call is 401 until you wire real auth into `authenticatedPrincipal`
 * below (a session/bearer verifier that maps a login → PrincipalId — see
 * @substrat-run/vertical-auth, the platform's pluggable AuthProvider +
 * per-tenant identity DO, for the intended shape). Deploying with the dev
 * header enabled is a cross-tenant hole with a UI. ──────────────────────────
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  defineScopeDO,
  defineScopeSweeperDO,
  SCOPE_SWEEPER_NAME,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { readRoutedNode, RouterAssertionError, type ScopeStub } from '@substrat-run/kernel';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});

/**
 * The deployment's own timer (#461): a roster-keeping singleton whose alarm runs
 * each provisioned scope's due recurring work — executor retries and any
 * `manifest.schedules` your modules declare — with no control plane anywhere.
 * `/internal/provision` and `/internal/reconcile` add scopes to the roster;
 * `/internal/delete-scope` removes them. Costs nothing while the roster is empty.
 */
export const SweeperDO = defineScopeSweeperDO<Env>({
  intervalMs: 120_000,
  host: hostFor,
});

/** The sweeper singleton's stub — one roster and one alarm per deployment. */
function sweeper(env: Env): DurableObjectStub & ScopeSweeperDo {
  return env.SWEEPER.get(
    env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME),
  ) as DurableObjectStub & ScopeSweeperDo;
}

interface Node {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs) — ONLY the fallback for local `wrangler dev`,
// where there is no router to assert one; gated on ALLOW_DEV_HEADER (never set
// in prod).
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

interface Env {
  /** One DO per scope — the vertical's only durable store (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** The roster-keeping sweep singleton — the deployment's own timer (#461). */
  SWEEPER: DurableObjectNamespace;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (how this worker knows the asserted node is real). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents on /internal/* calls. */
  PLATFORM_SECRET?: string;
}

/** The routed (tenant, scope) — from the router assertion, or the dev node. */
function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_HEADER === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * THE AUTH SEAM (see the header comment): resolve the caller to a PrincipalId,
 * or null for nobody. Replace the body with a real session/bearer verifier
 * before exposing this worker to users — the dev header is dev-only.
 */
async function authenticatedPrincipal(req: Request, env: Env): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const parsed = principalId.safeParse(req.headers.get('x-principal') ?? '');
    if (parsed.success) return parsed.data;
  }
  return null; // ← wire real auth here
}

/** Resolve caller + routed node → a scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

const app = new Hono<{ Bindings: Env }>();

// Who am I — resolves the caller without invoking anything.
app.get('/api/me', async (c) => {
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal });
});

// Generic invoke: the kernel checks a permission inside EVERY operation, so a
// generic route is exactly as safe as one route per operation.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// ── /internal/* — the platform-gated management contract ────────────────────
// The control plane provisions, heals, inspects and restores installs through
// these routes. The whole contract — provision, reconcile, introspection, the
// read-only SQL console, platform-request drain, snapshot/delete/export/restore,
// and bookmarks/rewind — plus the guaranteed { error } envelope is authored ONCE
// in @substrat-run/vertical-host (issue #510); mount it and it cannot drift.
//
// This starter's hooks keep the deployment's sweep roster (#461) in step: a newly
// provisioned scope joins it (so its schedules run), and a deleted one leaves it.
// Reconcile needs a durable owner-of-record to heal from — this starter keeps none
// (that lives with real auth, the auth seam), so `resolveOwner` is omitted and
// /internal/reconcile answers 501 until you wire auth and supply one.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision: (env, b) => sweeper(env).noteScope(b.tenantId, b.scopeId),
  onDeleteScope: (env, s) => sweeper(env).forgetScope(s),
});

// Unmatched /api/* fails as JSON; everything else gets a pointer, not a UI —
// this starter ships no SPA (add one and inline it at build time when you do).
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));
app.all('*', (c) =>
  c.json({
    service: 'substrat vertical',
    api: 'POST /api/invoke { op, input }',
    docs: 'https://substrat.net',
  }),
);

export default app;
