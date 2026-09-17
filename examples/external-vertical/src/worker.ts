/**
 * A Substrat vertical built OUTSIDE the monorepo, as a deployable Cloudflare
 * Worker. Everything below the API is a published package — `npm install` and go:
 *
 *   - kernel + contracts        the vocabulary and the operation runtime
 *   - adapter-cloudflare        the Durable-Object scope host (one ScopeDO per
 *                               scope, a durable ControlPlaneDO directory)
 *   - vertical-auth             the OIDC relying party: login, callback, session
 *   - engine-workorder          a composed engine, proving engines resolve and
 *                               bundle from npm alongside your own module
 *   - ./notes                   your own module
 *
 * This vertical is SELF-CONTAINED: it embeds its own control plane and seeds its
 * own tenant/scope, exactly like the Callout demo. Registering into a
 * separately-deployed shared control plane is what `substrat push` does, and this
 * example deliberately does not.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * An ordinary OpenID Connect round-trip against whatever `OIDC_ISSUER` names, then
 * `sub` → principal through the identity directory the embedded control plane
 * keeps. `npm run dev` starts `@substrat-run/dev-issuer` on :8879 — a real provider
 * whose only shortcut is that you pick a name instead of typing a password — so the
 * login you exercise locally is the one a deployment runs, and pointing it at
 * another issuer is configuration, not code.
 *
 * There is deliberately NO dev header. A header naming the caller is an
 * impersonation bypass; impersonation for scripts lives at the issuer instead:
 *   curl -XPOST localhost:8879/dev/token -d '{"sub":"dev|ada"}'
 *
 * Local run:  npm run dev         (dev issuer + wrangler dev, no account)
 * Deploy:     npm run cf:deploy   (needs a Workers Paid plan — DO SQLite)
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  listPageQuery,
  nextPageLink,
  PAGE_LINK_HEADER,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import { oidcRpAuthProvider } from '@substrat-run/vertical-auth/oidc-rp-provider';
import type { AuthProvider } from '@substrat-run/vertical-auth/provider';
import { PERM as WO, workorderModule } from '@substrat-run/engine-workorder';
import { NOTES_PERM, notesModule } from './notes.js';
import { DEV_PROVIDER, PERSONAS } from './personas.js';
import { PAGE } from './ui.js';

// The scope-DO class = the app binary: kernel + the engine + your module, bundled.
// A Durable Object cannot receive handler closures over RPC, so the module set is
// code-time, closed over here.
const MODULES = [workorderModule, notesModule];
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

// One fixed tenant, scope, two principals and a staff actor (valid ULIDs) so the
// demo has a world.
const T = tenantId.parse('01JZ0000000000000000000001');
const S = scopeId.parse('01JZ0000000000000000000002');
const MEMBER = principalId.parse('01JZ0000000000000000000003');
const STAFF = platformActorId.parse('01JZ0000000000000000000004');
const NO_ROLE = principalId.parse('01JZ0000000000000000000005');

/** Which principal each dev persona signs in as. Bo holds no role, so Bo is denied. */
const PERSONA_PRINCIPALS: Record<string, PrincipalId> = {
  'dev|ada': MEMBER,
  'dev|bo': NO_ROLE,
};

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** The OIDC issuer origin. `npm run dev` points it at the local dev issuer. */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  /** Signs the session cookie. A deploy sets it with `wrangler secret put`. */
  SESSION_SECRET?: string;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * The relying party, or null when this worker was given no issuer. Null is the
 * fail-closed answer: a deploy that forgot its OIDC settings authenticates nobody,
 * rather than falling back to some second path that does.
 */
function authFor(env: Env): AuthProvider | null {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET } = env;
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !SESSION_SECRET) return null;
  return oidcRpAuthProvider({
    issuer: OIDC_ISSUER,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    sessionSecret: SESSION_SECRET,
  });
}

const NO_ISSUER =
  'no OIDC issuer is configured — set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and SESSION_SECRET';

/**
 * The two steps every OIDC-only vertical takes: verify the request against the
 * issuer (session cookie, or a bearer token for a script) to get a `sub`, then ask
 * the identity directory which principal that subject is. The kernel only ever
 * receives the resolved PrincipalId.
 */
async function callerOf(env: Env, req: Request) {
  const auth = authFor(env);
  if (!auth) throw new HTTPException(401, { message: `unauthorized — ${NO_ISSUER}` });
  const subject = await auth.resolve(req.headers);
  if (!subject) throw new HTTPException(401, { message: 'unauthorized' });
  const identity = await hostFor(env).admin.resolveIdentity(T, DEV_PROVIDER, subject.sub);
  if (!identity) {
    throw new HTTPException(403, {
      message: `signed in as ${subject.sub}, but that login is linked to no principal here — seed the world first`,
    });
  }
  return {
    principal: identity.principal,
    sub: subject.sub,
    display: subject.name ?? subject.email ?? subject.sub,
  };
}

async function scopeFor(c: Context<{ Bindings: Env }>) {
  const { principal } = await callerOf(c.env, c.req.raw);
  // getScope validates the (tenant, scope) pair against the directory and fails
  // closed on a suspended scope or tenant — the same gate the console drives.
  return hostFor(c.env).getScope(principal, T, S);
}

/**
 * Only a LOCAL issuer gets the dev cast linked. The personas are names anyone can
 * pick at the dev issuer, so linking them against a real one would hand out
 * principals to whoever that issuer happens to call `dev|ada`.
 */
function isLocalIssuer(issuer: string | undefined): boolean {
  if (!issuer) return false;
  try {
    const { hostname } = new URL(issuer);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const app = new Hono<{ Bindings: Env }>();

// A tiny built-in web page so the vertical is clickable in a browser (no separate
// frontend build). It drives the same routes below.
app.get('/', (c) => c.html(PAGE));

// Login, callback, logout. Accounts live at the issuer; this vertical runs no
// credential store of its own.
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const auth = authFor(c.env);
  if (!auth) return Response.json({ error: NO_ISSUER }, { status: 503 });
  return auth.handle(c.req.raw);
});

/** Who is signed in, or 401 — the question the page asks before anything else. */
app.get('/api/me', async (c) => {
  const { principal, sub, display } = await callerOf(c.env, c.req.raw);
  return c.json({ principal, sub, display });
});

// Idempotent world provisioning: tenant → entitlements → scope → activate → a
// role → the dev cast's identity links. Safe to re-run (every call is idempotent).
app.post('/seed', async (c) => {
  const host = hostFor(c.env);
  await host.admin.createTenant(STAFF, { id: T, slug: 'acme', name: 'Acme Inc' });
  for (const key of ['notes', 'workorder']) await host.admin.grantEntitlement(STAFF, T, key);
  await host.provisionScope(STAFF, { tenantId: T, scopeId: S, jurisdiction: 'eu' });
  // provisioning → active (K-31). `provisionScope` writes the directory row and
  // stops; `getScope` fails closed on any non-active scope, so this second call
  // is the vertical's confirmation that the scope really exists. Skipping it is
  // why every route answers "scope not active (status: provisioning)".
  await host.admin.activateScope(STAFF, T, S);
  await host.admin.defineRole(STAFF, T, {
    key: 'member',
    permissions: [NOTES_PERM.write, NOTES_PERM.read, WO.read],
    source: 'vertical',
  });
  await host.admin.assignRole(STAFF, {
    principalId: MEMBER,
    roleKey: 'member',
    node: { tenantId: T, scopeId: S },
  });

  // Bind each persona's `sub` to a principal (K-23). Tenant-bound: this pool's
  // subjects mean something in this one tenant only.
  const local = isLocalIssuer(c.env.OIDC_ISSUER);
  if (local) {
    await host.admin.registerIdentityPool(STAFF, { provider: DEV_PROVIDER, topology: 'tenant-bound', tenantId: T });
    for (const persona of PERSONAS) {
      const principal = PERSONA_PRINCIPALS[persona.sub];
      if (!principal) continue;
      await host.admin.linkIdentity(STAFF, {
        provider: DEV_PROVIDER,
        externalId: persona.sub,
        principal,
        tenantId: T,
        scopeId: S,
      });
    }
  }
  return c.json({ ok: true, tenant: T, scope: S, personas: local ? 'linked' : 'skipped (issuer is not local)' });
});

/**
 * Serve a paged operation the way the platform does on the wire (#829): the BODY
 * is the entries, and the walk rides in a `Link: <…>; rel="next"` header. A
 * client follows that URL — it never assembles a cursor — so the page size and
 * every filter travel with it. No `rel="next"` means the walk is over.
 */
async function page<T>(c: Context<{ Bindings: Env }>, operation: string): Promise<Response> {
  const params = listPageQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const result = await (await scopeFor(c)).invoke<Page<T>>(operation, params);
  const link = nextPageLink(c.req.url, result.nextCursor);
  if (link) c.header(PAGE_LINK_HEADER, link);
  return c.json(result.entries);
}

// The data API — each route is a thin wrapper over an operation, called as whoever
// signed in. The handler does NOT parse the body: the module declares
// `operationInputs`, and the host parses before the operation runs, on every path in.
app.post('/api/notes', async (c) =>
  c.json(await (await scopeFor(c)).invoke('notes/create', await c.req.json())),
);
app.get('/api/notes', async (c) => page(c, 'notes/list'));
app.get('/api/workorders', async (c) => page(c, 'workorder/list'));

// One fail-closed error boundary: refusals reach the caller as a status, not a
// stack trace. A permission denial is matched by NAME, not `instanceof`: it has
// crossed the ScopeDO hop, which keeps the name and loses the class.
app.onError((err, c) => {
  const denied = err.name === 'PermissionDenied' || /permission denied/i.test(err.message);
  const status = err instanceof HTTPException ? err.status : denied ? 403 : 400;
  return c.json({ error: (err as Error).message }, status);
});

export default app;
