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
 * Sign-in is `workerDoor`'s, from @substrat-run/vertical-host: the issuer the dashboard delivers
 * for this instance, the tenant's identity directory (the `AUTH` store), and the owner seat the
 * first person takes. There is no credential store here and no dev header: a request names no
 * caller, the session does. Member invites go through the door too: name your invite operations
 * in `workerDoor({ invites })` (below).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  defineScopeDO,
  defineScopeSweeperDO,
  SCOPE_SWEEPER_NAME,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import type { ScopeStub } from '@substrat-run/kernel';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import {
  kickFlags,
  mountPlatformSurface,
  readRoutedNode,
  RouterAssertionError,
  invocationLog,
} from '@substrat-run/vertical-host';
import { IdentityDO, workerDoor } from '@substrat-run/vertical-host/worker-door';
// Only from provision.ts, the file `substrat push` reads: so this worker fits any vertical whose
// provision.ts exports these five, and needs no edit beyond a `join`.
import { MODULES, OWNER_ROLE_KEY, ROLES, envSpec, permissions } from './provision.js';
import { mountApi } from './routes.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {}, { permissions });

/**
 * The tenant's identity directory: who is bound to what, the owner seat, and the settings the
 * platform delivers. Declared as a store in package.json `substrat.runtimeNeeds.stores`, like
 * `ScopeDO` above and `SweeperDO` below. Re-exported because workerd resolves a DO class from the
 * ENTRY module's exports.
 */
export { IdentityDO };

/**
 * The deployment's own timer (#461): a roster-keeping singleton whose alarm runs
 * each provisioned scope's due recurring work — executor retries and any
 * `manifest.schedules` your modules declare — with no control plane anywhere.
 * `/internal/provision` and `/internal/reconcile` add scopes to the roster;
 * `/internal/delete-scope` removes them. Costs nothing while the roster is empty.
 */
export const SweeperDO = defineScopeSweeperDO<Env>({
  // #1232: the pass reports the version whose code actually ran (the deploy-injected binding).
  versionId: (env) => env.SUBSTRAT_VERSION_ID ?? null,
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
  /** Injected at deploy (#1242); absent locally — the sweep record then reads NULL. */
  SUBSTRAT_VERSION_ID?: string;
  /** One DO per scope — the vertical's only durable store (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** The roster-keeping sweep singleton — the deployment's own timer (#461). */
  SWEEPER: DurableObjectNamespace;
  /** The tenant's identity directory, and what the platform delivers to this instance. */
  AUTH: DurableObjectNamespace<IdentityDO>;
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
  const host = new CloudflareScopeHost({ scope: env.SCOPE, attachmentExtractors: defaultAttachmentExtractors(), permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Who is calling, for every route below. It hands an operation the caller's verified address, and
 * the first time a person reaches a scope it gives them every shape `permissions` declares
 * `bootstrap` with `holder: 'self'`, on their own record. A vertical with a join operation names it
 * here, so a person is joined when they first sign in, before that grant:
 *
 *   join: (scope, who) => scope.invoke('shop/join', { displayName: who.display }),
 *
 * A person a member invite names is let in by the address their issuer verified, with no link: the
 * first time they sign in they are bound to the invited account, with its role, and then joined. A
 * vertical whose people invite each other names its invite operations here, and the door mounts
 * `POST /api/member-invites` and `POST /api/member-invites/:principal/withdraw` for its screens:
 *
 *   invites: {
 *     roles: ['mechanic', 'front-desk'],
 *     send: (scope, i) => scope.invoke('shop/invite-member', { principal: i.principal, email: i.email, roleKey: i.roleKey }),
 *     cancel: (scope, i) => scope.invoke('shop/cancel-invite', { principal: i.principal }),
 *   },
 *
 * `send` checks who may invite, records the invite for the screens and queues the mail ("sign in
 * with this address"); it must not grant anything to `i.principal`. server.ts names the same three.
 *
 * This shop has none of these: its people are added by staff, and its portal shape is a customer's.
 */
const door = workerDoor<Env>({
  directory: (env, node) => env.AUTH.get(env.AUTH.idFromName(node.tenantId)),
  nodeFor,
  hostFor,
  envSpec,
});

/** The caller's scope stub. 401 if nobody. */
function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  return door.scope(c, {
    // An operation that called `ctx.requestPlatform`, or committed an event of a type this
    // vertical EXPORTS (whether or not another app imports it yet), flags its response. The
    // router then has the platform act on this scope within seconds instead of at the next
    // sweep. Leave it wired even if nothing uses either yet: the host raises a flag only when a
    // committed invoke did one of the two, so it costs nothing until then, and without it each
    // waits up to a quarter of an hour.
    ...kickFlags((name, value) => c.header(name, value)),
  });
}

const app = new Hono<{ Bindings: Env }>();

// FIRST, before any route: Hono composes handlers in registration order and stops at the
// one that answers, so a route registered above this line would never be logged. The line
// it writes is what attributes this vertical's invocations to the tenant they served —
// see `invocationLog`'s header for why the router cannot supply that from its side.
app.use(
  '*',
  invocationLog<Env>({
    // The same two answers this worker gives `readRoutedNode` in `nodeFor`: the line is
    // written from a VERIFIED assertion, never from the header, or anyone who could reach
    // this script directly could file their request under a tenant of their choosing.
    routerSecret: (env) => env.ROUTER_SECRET,
    allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',
  }),
);

// Sign-in: the login round-trip at `/api/auth/*`, who is signed in at `/api/me`, and the owner
// seat at `/api/claim-owner`. Accounts and passwords live at the issuer, not here.
door.mount(app);

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
// The hooks keep the deployment's sweep roster (#461) in step: a newly provisioned scope joins it
// (so its schedules run), and a deleted one leaves it. The door's hooks do the rest: the owner seat
// at provision, and the settings the dashboard's Env and Identity tabs deliver.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  ...door.platform,
  onProvision: async (env, b) => {
    await door.platform.onProvision(env, b);
    await sweeper(env).noteScope(b.tenantId, b.scopeId);
  },
  onDeleteScope: async (env, s, tenantId) => {
    await door.platform.onDeleteScope(env, s, tenantId);
    await sweeper(env).forgetScope(s);
  },
});

// Unmatched /api/* fails as JSON; everything else gets a pointer, not a UI —
// this starter ships no SPA (add one and inline it at build time when you do).
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));
app.all('*', (c) =>
  c.json({
    service: 'substrat vertical',
    api: 'POST /api/invoke { op, input } — plus the routes declared on the operations in src/operations.ts',
    docs: 'https://substrat.net',
  }),
);

export default app;
