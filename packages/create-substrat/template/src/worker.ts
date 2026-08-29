/**
 * This vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less: the shape `substrat push` deploys into the platform's
 * dispatch namespace. Its only durable stores are its OWN DO classes — `SCOPE`
 * (kernel + engines + this vertical, bundled), `SWEEPER` (the deployment's own
 * timer, #461) and `CONFIG` (per-instance settings delivered by the platform);
 * no CONTROL_PLANE binding, no service bindings, no ASSETS binding — the
 * platform refuses those.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json (entry = this file, stores = the DO classes exported here) —
 * you never author wrangler config.
 *
 * ── THE AUTH SEAM ────────────────────────────────────────────────────────────
 * This starter ships NO auth in the worker: every /api/* call is 401 until you
 * wire `authenticatedPrincipal` below. That is deliberate and it is honest —
 * there is nothing here that resolves a caller, in any environment, so there is
 * nothing to accidentally deploy.
 *
 * It used to resolve a caller through an `x-principal` header gated on
 * ALLOW_DEV_HEADER. That is an impersonation bypass — a cross-tenant hole with a
 * UI, one environment variable from being live — and it is gone. `src/server.ts`
 * shows the shape you want instead: @substrat-run/vertical-auth's
 * `oidcRpAuthProvider` verifies the request against your issuer and hands you a
 * subject; an identity directory maps that subject to a PrincipalId. The dev
 * server can use `host.admin` as that directory. A hosted worker needs a durable
 * one — @substrat-run/vertical-auth's per-tenant `IdentityDO` is the platform's,
 * and it also gives you the owner-claim and invite flows a new install needs.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  resolveScopedEnvSpec,
  scopeId,
  tenantId,
  z,
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
import { SHOP_ENV } from './manifest.js';
import { mountApi } from './routes.js';
import { AUTH_CONFIG_KEY, ConfigDO, type ConfigDo } from './config-do.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});

/**
 * The per-instance config store (`config-do.ts`) — one per tenant, rows keyed by scope.
 * Declared as a store in package.json `substrat.runtimeNeeds.stores`, like `ScopeDO`
 * above and `SweeperDO` below. Re-exported because workerd resolves a DO class from the
 * ENTRY module's exports; defining it in another file is fine, hiding it here is not.
 */
export { ConfigDO };

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
// where there is no router to assert one; gated on ALLOW_DEV_NODE (never set in
// prod).
//
// This is an ADDRESS, not an identity: it says which instance an un-routed local
// request belongs to, and grants nobody anything. Keeping the two separate is why
// it survived the removal of the dev header, which named the CALLER.
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

interface Env {
  /** One DO per scope — the vertical's only durable store (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** The roster-keeping sweep singleton — the deployment's own timer (#461). */
  SWEEPER: DurableObjectNamespace;
  /** Per-instance config delivered by the platform (`/internal/configure`). */
  CONFIG: DurableObjectNamespace;
  /** Local `wrangler dev` only: when 'true', fall back to DEV_NODE if no router
   *  asserted a node. Addresses an instance; authenticates nobody. */
  ALLOW_DEV_NODE?: string;
  /** Shared secret the router presents (how this worker knows the asserted node is real). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents on /internal/* calls. */
  PLATFORM_SECRET?: string;
}

/** The routed (tenant, scope) — from the router assertion, or the dev node. */
function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, {
      expectedSecret: env.ROUTER_SECRET,
      // #966: an unsigned assertion is refused unless this is an un-routed dev instance.
      allowUnsigned: env.ALLOW_DEV_NODE === 'true',
    });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_NODE === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** This tenant's config DO — one per tenant, holding a row set per scope. */
function configDo(env: Env, node: Node): DurableObjectStub & ConfigDo {
  return env.CONFIG.get(env.CONFIG.idFromName(node.tenantId)) as DurableObjectStub & ConfigDo;
}

/**
 * The scope's delivered auth choice. Parsed LENIENTLY on purpose: an absent or
 * malformed entry means "nothing delivered", never a throw, so a bad delivery can
 * never lock an instance out of its own login.
 */
const authChoice = z.object({
  mode: z.literal('oidc'),
  issuer: z.string().min(1),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

/**
 * Everything this instance was configured with, in ONE DO hop: the ordinary declared
 * settings (`SHOP_ENV`) resolved delivered > env > default, and the structured
 * `substrat:auth` choice the dashboard's Identity tab sends.
 *
 * Reading settings THROUGH this — rather than off `env` — is the whole reason the
 * `/internal/configure` hook exists: a spec `default` rides as a worker binding shared
 * by every install of one serving script, so `env.SHOP_NAME` is the same string for
 * every tenant no matter what any of them saved.
 */
async function instanceConfig(env: Env, node: Node) {
  const delivered = await configDo(env, node).getScopeConfig(node.scopeId);
  const settings = resolveScopedEnvSpec(SHOP_ENV, env as unknown as Record<string, unknown>, delivered).values;
  let identity: z.infer<typeof authChoice> | null = null;
  const raw = delivered[AUTH_CONFIG_KEY];
  if (raw) {
    try {
      const parsed = authChoice.safeParse(JSON.parse(raw));
      identity = parsed.success ? parsed.data : null;
    } catch {
      identity = null;
    }
  }
  return { settings, identity };
}

/**
 * THE AUTH SEAM (see the header comment): resolve the caller to a PrincipalId, or
 * null for nobody. Two steps, and this starter ships neither:
 *
 *   1. Verify the request → a subject. `instanceConfig` already reads the issuer
 *      the dashboard delivered as `substrat:auth`, so this is
 *      `oidcRpAuthProvider({ issuer, clientId, clientSecret, sessionSecret }).resolve(...)`
 *      — and you mount the same provider's `handle` on `/api/auth/*` for the login
 *      round-trip. `src/server.ts` does exactly this against the local dev issuer.
 *   2. Map that subject → a PrincipalId, per scope. This needs a durable store the
 *      worker owns; @substrat-run/vertical-auth's `IdentityDO` is one, and carries
 *      the owner-claim (first sign-in takes the seat) and invite flows with it.
 *
 * Returning null unconditionally is the safe default, not an oversight: a starter
 * that guessed here would be a starter that let the wrong person in.
 */
async function authenticatedPrincipal(_req: Request, _env: Env): Promise<PrincipalId | null> {
  return null; // ← wire real auth here (see the two steps above)
}

/** Resolve caller + routed node → a scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) throw new HTTPException(401, { message: await unauthorizedReason(c.env, node) });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

/**
 * Why the caller is nobody — a DIAGNOSIS, not a bare "unauthorized".
 *
 * The expensive case to debug is the one that looks like a platform bug and is not:
 * a tenant picks an identity provider in the dashboard, the platform delivers it here
 * successfully, and every request is still 401 — because this starter ships no auth.
 * Saying so, and naming the seam, is the difference between a five-minute fix and a
 * support thread. Only runs on the failure path, so it costs a DO hop on 401s alone.
 */
async function unauthorizedReason(env: Env, node: Node): Promise<string> {
  try {
    const { identity } = await instanceConfig(env, node);
    if (identity) {
      return `unauthorized — this instance has an identity provider configured (${identity.issuer}), but this vertical has not wired it up yet: implement \`authenticatedPrincipal\` in src/worker.ts (the auth seam)`;
    }
  } catch {
    // The config store is unreachable — that is not the caller's problem to hear about.
  }
  return 'unauthorized';
}

const app = new Hono<{ Bindings: Env }>();

// Who am I, and what instance am I on — resolves the caller without invoking
// anything. Auth-shaped and host-specific, so it stays OUT of the shared table;
// `server.ts` answers the same question from its own login.
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) return c.json({ error: await unauthorizedReason(c.env, node) }, 401);
  const { settings, identity } = await instanceConfig(c.env, node);
  return c.json({ principal, settings, identity: identity ? { issuer: identity.issuer } : null });
});

// ── The vertical's API — the SAME table `server.ts` mounts (src/routes.ts) ───
// Including `/api/invoke`. Mounted BEFORE the platform surface: Hono keeps only the
// last-registered `onError`, so the platform's envelope wins for the whole app — which
// is harmless because both handlers classify through the same `classifyError`.
mountApi(app, stub);

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
  // Both hooks are `Promise<void>`: the roster's own count is its business, and
  // returning it here would make the platform's response shape depend on what a
  // vertical happens to hand back. Await, discard.
  onProvision: async (env, b) => {
    await sweeper(env).noteScope(b.tenantId, b.scopeId);
  },
  onDeleteScope: async (env, s) => {
    await sweeper(env).forgetScope(s);
  },
  // Per-instance config delivery (the dashboard's Settings → Env and Identity tabs).
  // WITHOUT this hook `/internal/configure` answers 501 for the life of the app: the
  // dashboard saves the setting, reports `delivered: false`, and the running worker
  // never sees it — including the `substrat:auth` issuer choice that is the difference
  // between a working login and 401-on-everything. Store it; `instanceConfig` reads it
  // back. Idempotent, so the platform's reconciliation sweep can re-deliver safely.
  onConfigure: async (env, b) => {
    await configDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries);
  },
});

// Unmatched /api/* fails as JSON; everything else gets a pointer, not a UI —
// this starter ships no SPA (add one and inline it at build time when you do).
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));
app.all('*', (c) =>
  c.json({
    service: 'substrat vertical',
    api: 'POST /api/invoke { op, input } — plus the named routes in src/routes.ts',
    docs: 'https://substrat.net',
  }),
);

export default app;
