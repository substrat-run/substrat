/**
 * A Substrat vertical built OUTSIDE the monorepo, as a deployable Cloudflare
 * Worker. Everything below the API is a published package — `pnpm add` and go:
 *
 *   - kernel + contracts        the vocabulary and the operation runtime
 *   - adapter-cloudflare        the Durable-Object scope host (one ScopeDO per
 *                               scope, a durable ControlPlaneDO directory)
 *   - engine-workorder          a composed engine, proving engines resolve and
 *                               bundle from npm alongside your own module
 *   - ./notes                   your own module
 *
 * This vertical is SELF-CONTAINED: it embeds its own control plane and seeds its
 * own tenant/scope, exactly like the Callout demo. Registering into a
 * separately-deployed shared control plane is what `substrat push` does, and this
 * example deliberately does not.
 *
 * Local run:  npm run dev         (wrangler dev, no account; dev-header auth on)
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
} from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import { PERM as WO, workorderModule } from '@substrat-run/engine-workorder';
import { NOTES_PERM, notesModule } from './notes.js';
import { PAGE } from './ui.js';

// The scope-DO class = the app binary: kernel + the engine + your module, bundled.
// A Durable Object cannot receive handler closures over RPC, so the module set is
// code-time, closed over here.
const MODULES = [workorderModule, notesModule];
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

// One fixed tenant, scope, and user (valid ULIDs) so the demo has a world.
const T = tenantId.parse('01JZ0000000000000000000001');
const S = scopeId.parse('01JZ0000000000000000000002');
const USER = principalId.parse('01JZ0000000000000000000003');
const STAFF = platformActorId.parse('01JZ0000000000000000000004');

interface Env {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER in prod. */
  ALLOW_DEV_HEADER?: string;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Dev-header auth: the `x-principal` header names the caller directly, no
 * credentials. Gated on ALLOW_DEV_HEADER so it is off unless explicitly opted in
 * — secure by default.
 *
 * This is a PLACEHOLDER, not a shape to copy: no vertical in the monorepo carries
 * an `x-principal` seam any more. They are OIDC-only (docs/architecture/
 * oidc-only-demos.md) — a real issuer even in dev, and the vertical only maps the
 * authenticated `sub` onto a scope principal. `packages/vertical-auth` is that
 * composition; the kernel only ever receives the resolved PrincipalId either way.
 */
function resolvePrincipal(env: Env, req: Request) {
  if (env.ALLOW_DEV_HEADER !== 'true') return null;
  const raw = req.headers.get('x-principal');
  if (!raw) return null;
  const parsed = principalId.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function scopeFor(c: Context<{ Bindings: Env }>) {
  const principal = resolvePrincipal(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // getScope validates the (tenant, scope) pair against the directory and fails
  // closed on a suspended scope or tenant — the same gate the console drives.
  return hostFor(c.env).getScope(principal, T, S);
}

const app = new Hono<{ Bindings: Env }>();

// A tiny built-in web page so the vertical is clickable in a browser (no separate
// frontend build). It drives the same routes below.
app.get('/', (c) => c.html(PAGE));

// Idempotent world provisioning: tenant → entitlements → scope → activate → a
// role the user holds. Safe to re-run (createTenant/provisionScope are idempotent).
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
    principalId: USER,
    roleKey: 'member',
    node: { tenantId: T, scopeId: S },
  });
  return c.json({ ok: true, tenant: T, scope: S, user: USER });
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

// The data API — each route is a thin wrapper over an operation. Send the seeded
// user with `x-principal: 01JZ0000000000000000000003`. The handler does NOT parse
// the body: the module declares `operationInputs`, and the host parses before the
// operation runs, on every path in.
app.post('/api/notes', async (c) =>
  c.json(await (await scopeFor(c)).invoke('notes/create', await c.req.json())),
);
app.get('/api/notes', async (c) => page(c, 'notes/list'));
app.get('/api/workorders', async (c) => page(c, 'workorder/list'));

// One fail-closed error boundary: refusals reach the caller as a status, not a
// stack trace.
app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  return c.json({ error: (err as Error).message }, status);
});

export default app;
