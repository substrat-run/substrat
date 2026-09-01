/**
 * ticket0 as a deployable Cloudflare Worker — SANDBOX-CLEAN and control-plane-less,
 * the shape `substrat push` deploys into the platform's dispatch namespace.
 *
 * Its only durable stores are its OWN DO classes: `SCOPE` (kernel + metering + the
 * ticket0 module, bundled — one per desk) and `AUTH` (the shared per-tenant identity
 * DO from @substrat-run/vertical-auth, which also holds the per-instance config the
 * dashboard's Env tab delivers). No CONTROL_PLANE binding, no service binding, no
 * ASSETS binding — `assertSandboxContract` refuses all three.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json (entry = this file, stores = the DO classes exported here); there is
 * no wrangler.jsonc to author.
 *
 * ── What is here that `server.ts` also has, and why it is not a copy ──────────
 * The node dev server and this worker mount the SAME two surfaces from the same
 * files: the declared `/api` table (`routes.ts`) and the public widget surface
 * (`harness/widget-surface.ts`). What differs is genuinely host-specific and is all
 * in this file: which desk a request belongs to (there, the embedding origin across
 * one node holding two seeded desks; here, the hostname the router resolved), where
 * the login lives (there, `packages/dev-issuer`; here, whatever issuer the tenant
 * bound), and how a background job is kept alive (there, node keeps the process up;
 * here, `executionCtx.waitUntil`).
 *
 * ── The three service principals ─────────────────────────────────────────────
 * The seed hands each desk a `widget`, an `assistant` and a `relay` account. A hosted
 * desk has no seed, so `/internal/provision` mints them (once, idempotently) and
 * records them in the tenant's identity DO. Everything unauthenticated this worker
 * does runs as one of them, holding the keys that role holds and no others.
 *
 * Deploy:     substrat push
 *
 * There is no `cf:dev` script, and that is a consequence of `runtimeNeeds` rather than
 * an omission: `wrangler dev` wants a wrangler config, and the only one this vertical
 * has is the one the CLI derives inside a push. Authoring a second by hand is what the
 * declaration exists to avoid — the CLI would ignore it on the way out, and it would
 * drift. `pnpm dev` (the node host) is the local loop; the worker is exercised by the
 * push's own bundle step.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
  z,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { CloudflareScopeHost, cloudflareClientContext, defineScopeDO } from '@substrat-run/adapter-cloudflare';
import { readRoutedNode, RouterAssertionError, ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { createModelHost, type ModelAttribution } from '@substrat-run/vertical-host/model';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  sha256Hex,
  type AuthProvider,
} from '@substrat-run/vertical-auth';
import { API_DOCUMENT } from './api.js';
import { T0_PERM, TICKET0_ENV, ticket0Manifest } from './manifest.js';
import {
  CONTACT_BOUND_ROLE,
  HUMAN_ROLES,
  MODULES,
  OWNER_ROLE_KEY,
  ROLES,
  SERVICE_ROLES,
  STAFF_ROLES,
  type ServiceRole,
} from './provision.js';
import { mountApi } from './routes.js';
import {
  answerConversation,
  errorText,
  describeModel,
  modelFor,
  recordAssistantFailure,
} from '../harness/assistant.js';
import { mountAssistantStatus } from '../harness/assistant-status.js';
import { mountKbRefresh } from '../harness/kb-refresh.js';
import { mountInvites, recordStaffProfile } from '../harness/invites.js';
import { mountWidgetSurface } from '../harness/widget-surface.js';

/** The scope-DO class = the app binary: kernel + metering + ticket0, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH. */
export { IdentityDO };

/** The (tenant, scope) a request is addressed to — one desk. */
interface DeskNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname; this is ONLY the fallback for an un-routed local `wrangler dev`, where there
// is no router to assert one, and is gated on ALLOW_DEV_NODE (never set in prod).
//
// This is an ADDRESS, not an identity: it says which instance an un-routed local request
// belongs to, and grants nobody anything. The principal still comes from a verified login.
const DEV_NODE: DeskNode = {
  tenantId: tenantId.parse('01JZ0000000000000000TKT001'),
  scopeId: scopeId.parse('01JZ0000000000000000TKT002'),
};

interface Env {
  /** One DO per desk — business data. The vertical's own class (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** One DO per tenant — the sub→principal directory, invites, and per-scope config. */
  AUTH: DurableObjectNamespace<IdentityDO>;
  /** Declared in TICKET0_ENV (src/manifest.ts). Read ONLY through `instanceConfig` —
   *  a bare `env.X` read sees the deployment-wide default every install shares (#374).
   *  Typed here so a binding or a `--var` override is a compile-checked name. */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  TICKET0_MODEL?: string;
  /**
   * PLATFORM-held model credentials (#1054) — deployment-wide on purpose, the one
   * place a bare binding read is the design rather than the bug (#374): the platform
   * pays the provider and meters the desk. A desk never holds one of these. Read only by
   * the model host, which reads each row's own variables and nothing else.
   */
  CLOUDFLARE_AI_BASE_URL?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  SCALEWAY_API_KEY?: string;
  /**
   * Workers AI, bound by the platform on every pushed vertical (#1054). A capability the
   * runtime grants — there is no credential here to read. Absent locally.
   */
  AI?: unknown;
  /** Local dev only: when 'true', fall back to DEV_NODE. Addresses an instance; authenticates nobody. */
  ALLOW_DEV_NODE?: string;
  /** Shared secret the router presents (K-26): how the desk knows the asserted node came from the router. */
  ROUTER_SECRET?: string;
  /** Shared secret the CONTROL PLANE presents to provision/configure here (K-31). Unset ⇒ refused. */
  PLATFORM_SECRET?: string;
}

/**
 * Which desk this request is for. Behind the router: whatever the hostname resolved to
 * (signed headers). An un-routed local run (ALLOW_DEV_NODE): the fixed dev node. Neither:
 * refuse — an unrouted request in a multi-tenant deployment has no defensible default,
 * and picking one would mean serving somebody else's inbox.
 */
function nodeFor(req: Request, env: Env): DeskNode {
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
  throw new HTTPException(503, {
    message: 'no scope was asserted for this request (missing router assertion)',
  });
}

/**
 * The coordinator is stateless — rebuilt per request; durable state is in the DOs.
 * CP-less: permissions evaluate from each desk's own storage, and the router asserts
 * the node, so this worker trusts it rather than reading a directory it has no
 * binding to.
 */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** The tenant's identity DO stub — the sub→principal directory and the config store. */
function identityDo(env: Env, node: DeskNode) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

// ── Per-instance config ──────────────────────────────────────────────────────


/** Where the desk's three service principals are recorded, once, at provision. */
const SERVICES_CONFIG_KEY = 'ticket0:services';
const servicePrincipals = z.object({
  widget: principalId,
  assistant: principalId,
  /**
   * OPTIONAL, and it has to stay that way.
   *
   * `servicesOf` parses this record with `safeParse` and reads a failure as "this desk
   * is not provisioned" — which `resolveDesk` turns into a dead widget. Every desk
   * provisioned before the autonomous assistant existed has three keys, so requiring a
   * fourth would take down every live widget the moment this shipped, until each was
   * reconciled. Absent means the same thing here as a null column: not decided, so
   * supervised.
   */
  'assistant-autonomous': principalId.optional(),
  relay: principalId,
});
type ServicePrincipals = z.infer<typeof servicePrincipals>;

/**
 * Everything this desk was configured with, in ONE DO hop: the declared settings
 * (`TICKET0_ENV`) resolved delivered > binding > manifest default, the structured
 * `substrat:auth` choice, and the tenant's session-signing secret. The composition is
 * `@substrat-run/vertical-auth`'s (#972); this only names the desk's env spec.
 */
async function instanceConfig(env: Env, node: DeskNode) {
  return instanceAuthFor({
    directory: identityDo(env, node),
    scopeId: node.scopeId,
    envSpec: TICKET0_ENV,
    env: env as unknown as Record<string, unknown>,
  });
}

/**
 * The desk's service principals, or null before it has been provisioned.
 *
 * Read rather than derived: a principal derived from the scope id would be one string
 * manipulation away from colliding with a real one, and there would be no record of
 * what was granted to whom. These are ordinary ULIDs, minted once and written down.
 */
async function servicesOf(env: Env, node: DeskNode): Promise<ServicePrincipals | null> {
  const config = await identityDo(env, node).getScopeConfig(node.scopeId);
  const raw = config[SERVICES_CONFIG_KEY];
  if (!raw) return null;
  try {
    const parsed = servicePrincipals.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Mint the desk's service accounts, once. Idempotent — the platform re-delivers a
 * provision on reconcile, and minting a second `widget` principal would leave the
 * first one holding a live key nothing reads any more.
 *
 * The assistant is given the SUPERVISED role (`assistant`: drafts, never sends). That
 * is the one policy this vertical will not decide for a desk: an assistant that
 * answers customers unattended from the moment of install is a decision somebody
 * should make on purpose, in Settings, having read what it says.
 */
async function mintServices(env: Env, node: DeskNode): Promise<ServicePrincipals> {
  const existing = await servicesOf(env, node);
  /**
   * Mint what is MISSING, rather than the whole set or nothing.
   *
   * The original read "reuse all three, or mint all three", which is correct exactly
   * until a service role is added: every desk already provisioned then has an
   * `existing` record, takes the reuse path forever, and never receives the new
   * principal — the feature ships and reaches no desk that predates it.
   *
   * Filling gaps is only half of it: the platform's reconcile has to REACH this hook,
   * and until `@substrat-run/vertical-host` ran `onProvision` on that route it did not.
   * A repair that re-projects roles and stops leaves a desk missing whatever the
   * vertical mints for itself, with no other way to get it — `/internal/provision` is
   * called at install and never again.
   */
  const minted = SERVICE_ROLES.filter((role) => !existing?.[role]);
  const services = servicePrincipals.parse({
    ...(existing ?? {}),
    ...Object.fromEntries(minted.map((role) => [role, principalId.parse(ulid())])),
  });

  /**
   * WRITE THE IDS DOWN FIRST, then grant the roles — and note that this is the opposite
   * of the intuitive order.
   *
   * These are two stores: the identity DO holds the ids, the scope DO holds the role
   * tuples, and nothing spans them. Granting first means a failure in between leaves
   * three principals holding `widget` / `assistant` / `relay` in a scope with no record
   * of who they are — and the platform's retry, finding nothing recorded, mints three
   * MORE. The orphans keep their keys forever, because the only thing that could revoke
   * them is a record that was never written.
   *
   * Recording first inverts the failure into a harmless one: ids with some roles not yet
   * granted, which the retry below repairs. `assignScopeRole` is `INSERT OR REPLACE` on
   * one tuple, so re-granting an existing role is a no-op — which is what lets the
   * reuse path re-run unconditionally rather than trusting that a previous call got
   * past this loop.
   */
  if (minted.length > 0) {
    await identityDo(env, node).setScopeConfig(node.scopeId, [
      { key: SERVICES_CONFIG_KEY, value: JSON.stringify(services) },
    ]);
  }
  const host = hostFor(env);
  for (const role of SERVICE_ROLES) {
    // Present for every role by construction — the fill above minted whatever the
    // record was missing — but the schema cannot say so, since the key is optional
    // for the desks that predate it.
    const principal = services[role];
    if (principal) await host.assignScopeRole(node.scopeId, principal, role);
  }
  return services;
}

/** A scope stub acting as one of the desk's service accounts. Null before provision. */
async function serviceStub(
  env: Env,
  node: DeskNode,
  role: ServiceRole,
): Promise<ScopeStub | null> {
  const services = await servicesOf(env, node);
  const principal = services?.[role];
  if (!principal) return null;
  return hostFor(env).getScope(principal, node.tenantId, node.scopeId);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the
 * contract. Per-SCOPE first (hosted): a delivered `substrat:auth` builds the full
 * relying-party provider (browser login at the issuer, cookie sessions signed with the
 * tenant's DO-minted secret, bearer fallback for API clients). Otherwise the DEPLOYMENT
 * default: `AUTH_PROVIDER=oidc` verifies bearer tokens against a fixed issuer. Neither
 * ⇒ fail closed. The app never learns which; it only ever holds an `AuthProvider`.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  const instance = await instanceConfig(env, nodeFor(req, env));
  try {
    return instance.provider();
  } catch (err) {
    if (err instanceof AuthConfigError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  }
}

/**
 * Resolve the caller to a PrincipalId, PROVIDER-AGNOSTICALLY: the configured provider
 * verifies the request → a subject, and the tenant's identity DO maps that subject → a
 * principal in this desk (claiming the owner seat on first login). Null ⇒ nobody.
 *
 * ONE path, in every environment. There is no header branch: a dev-only `x-principal`
 * would mean the login exercised locally is not the login a customer runs, and would
 * ship an impersonation bypass one environment variable from being live.
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const app = new Hono<{ Bindings: Env }>();

/** Resolve caller + routed node → a scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less: lifecycle is the router's gate — it forwards only an active scope and
  // asserts the node. Permissions evaluate locally, from this desk's own storage.
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

// ── Identity: the login round-trip and who I am ──────────────────────────────

// Credentials and sessions live entirely at the issuer: the desk runs no credential
// store and hosts no sign-up. `/api/auth/*` is the relying-party flow only — `/login`
// → issuer → `/callback` → session cookie → `/logout`.
app.on(['GET', 'POST'], '/api/auth/*', async (c) =>
  (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw),
);

/**
 * Who am I — `{ principal, display }`, the shape `app/src/api.ts` centres on, plus the
 * first-run signal. A desk whose owner seat is unclaimed answers `needs-setup` rather
 * than a bare 401, so the SPA can say "sign in to claim this desk" instead of showing
 * a login that looks like it failed.
 */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  // One provider, resolved once. Going through `principalFor` here would build a second
  // one for the display name — and building a provider reads the delivered config, so
  // the cost of the convenience is a whole extra identity-DO round trip on the request
  // every screen makes first.
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  const principal = subject
    ? await identityDo(c.env, node).resolvePrincipal(node.scopeId, subject.sub)
    : null;
  if (!principal) {
    // An unclaimed seat says HOW it can be claimed (#925): by signing in, while the
    // first-sign-in window is open; by a claim link from the dashboard once it has closed.
    // The SPA's copy depends on which, and it must not offer a sign-in that binds nobody.
    const seat = await identityDo(c.env, node).ownerSeat(node.scopeId);
    return seat.state === 'unclaimed'
      ? c.json({ status: 'needs-setup', firstSignInOpen: seat.firstSignIn?.open ?? false })
      : c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({
    principal: principalId.parse(principal),
    display: subject?.name ?? subject?.email ?? 'You',
  });
});

/**
 * Claim the owner seat by link (#925): the installer signed in at the issuer and now
 * presents the token the dashboard minted for this desk. Binds their subject → the owner
 * principal, which already holds `desk-admin` from provision. One answer for every way it
 * can fail, so a probe learns nothing about which.
 */
app.post('/api/claim-owner', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before claiming this desk' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimOwner(
    node.scopeId,
    subject.sub,
    await sha256Hex(token),
  );
  if (!principal) throw new HTTPException(400, { message: 'this claim link is invalid, expired, or already used' });
  /**
   * The owner is the desk's first colleague, so they go in its directory (#1149).
   * Without this the one human on a fresh hosted desk was missing from `list-agents`,
   * which made the assignee picker they were shown empty and their own name a ULID.
   */
  await recordStaffProfile(
    async (p, operation, input) =>
      (await hostFor(c.env).getScope(principalId.parse(p), node.tenantId, node.scopeId)).invoke(
        operation,
        input,
      ),
    principal,
    subject,
  );
  return c.json({ ok: true, principal });
});

// ── Invites — the only way a second person reaches a hosted desk ─────────────

/**
 * The flow itself is `harness/invites.ts`, mounted by the dev server too. What is
 * host-specific and stays here is all of what this passes it: which desk the routed
 * hostname means, where its pending invites live (the tenant's identity DO), how a
 * caller is authenticated, and what "may manage people" means on this vertical.
 */
mountInvites(app, {
  humanRoles: HUMAN_ROLES,
  staffRoles: STAFF_ROLES,
  contactBoundRole: CONTACT_BOUND_ROLE,
  /** The worker serves the SPA as well as the API, so an invite link points at itself. */
  appOrigin: (c) => new URL(c.req.raw.url).origin,
  subjectOf: async (c) => (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers),
  /**
   * Gate an admin-only action. `get-desk` IS the check — it asserts `desk:configure`
   * inside the operation, which only `desk-admin` holds — so the authority comes from
   * this desk's own grants rather than from a second role table out here.
   */
  requireAdmin: async (c) => {
    await (await stub(c)).invoke('ticket0/get-desk', {});
  },
  deskOf: async (c) => {
    const node = nodeFor(c.req.raw, c.env);
    const directory = identityDo(c.env, node);
    const host = hostFor(c.env);
    return {
      store: {
        /**
         * The DO stamps `created_at` as epoch millis; every other timestamp this
         * vertical shows is ISO text, and the screen rendering these calls the same
         * `ago()` it calls on rows out of a scope. Normalising here keeps the surface
         * one shape rather than making the app ask which store answered.
         */
        list: async () =>
          (await directory.listInvites(node.scopeId)).map((i) => ({
            principal: i.principal,
            roleKey: i.roleKey,
            email: i.email,
            created_at: new Date(i.createdAt).toISOString(),
          })),
        create: ({ principal, roleKey, email, tokenHash }) =>
          directory.createInvite(node.scopeId, principal, roleKey, email, tokenHash),
        revoke: (principal) => directory.revokeInvite(node.scopeId, principal),
        /**
         * The role is read BEFORE the claim consumes the invite — afterwards the row
         * is gone and nothing can still say whether this person works the desk. The
         * worker always knows its scope (the router asserted it), so listing is free
         * here in a way it is not on a node holding two desks.
         */
        claim: async (sub, tokenHash) => {
          const pending = await directory.listInvites(node.scopeId);
          const principal = await directory.claimInvite(node.scopeId, sub, tokenHash);
          if (!principal) return null;
          return {
            principal,
            roleKey: pending.find((i) => i.principal === principal)?.roleKey ?? '',
          };
        },
      },
      assignRole: (principal, roleKey) =>
        host.assignScopeRole(node.scopeId, principalId.parse(principal), roleKey),
      grantContactPortal: (principal, contactId) =>
        host.grantEntityLocal(node.scopeId, principalId.parse(principal), T0_PERM.conversationReadOwn, {
          entityType: 'contact',
          entityId: contactId,
        }),
      invokeAs: async (principal, operation, input) =>
        (await host.getScope(principalId.parse(principal), node.tenantId, node.scopeId)).invoke(
          operation,
          input,
        ),
    };
  },
});
// ── The knowledge base: the fetching half ────────────────────────────────────

/**
 * Re-read one documentation source — the connector-shaped job, run as the CALLER.
 *
 * The dev server runs the same read on every boot. A worker has no boot, and a
 * dispatch user-worker has no cron, so here it is only ever a button:
 * `POST /api/kb/sources/:id/refresh`, shared with the dev server in
 * `harness/kb-refresh.ts` so the two cannot drift.
 */
mountKbRefresh(app, stub);

/**
 * The platform's model host (#1054), over this worker's own bindings. One per request
 * is fine: it holds no state beyond the credential map and the wired factories.
 */
const modelHostFor = (env: Env) =>
  createModelHost({
    env: env as unknown as Record<string, string | undefined>,
    factories: { anthropic: createAnthropic },
    // The platform binds `env.AI` on every pushed vertical (#1054), so the default
    // Cloudflare row runs with no credential on this script at all. Absent locally and
    // in a test, where the row falls back to its HTTP transport or to extractive.
    ...(env.AI ? { aiBinding: env.AI } : {}),
    sent: 'Customer messages and the knowledge-base excerpts they match',
  });

/** The five keys every model call this desk makes is attributed with. */
const attributionFor = (node: DeskNode): ModelAttribution => ({
  tenant: node.tenantId,
  scope: node.scopeId,
  vertical: ticket0Manifest.id,
  version: ticket0Manifest.version,
  operation: 'ticket0/answer',
});

// Which model THIS install would answer with, beside its failed turns — the read
// behind Settings → Assistant. Per install through `instanceConfig`, like the job.
mountAssistantStatus(app, stub, async (c) => {
  const env = c.env as Env;
  const { settings } = await instanceConfig(env, nodeFor(c.req.raw, env));
  return describeModel(modelHostFor(env), settings.TICKET0_MODEL as string | undefined);
});

// ── The public widget surface ────────────────────────────────────────────────

mountWidgetSurface(app, {
  /**
   * One desk per hostname, and the ROUTER decides which — so unlike the dev server,
   * the embedding origin does not pick the desk here, it is only checked against the
   * desk the hostname already resolved to.
   */
  resolveDesk: async (c) => {
    const env = c.env as Env;
    const node = nodeFor(c.req.raw, env);
    const widget = await serviceStub(env, node, 'widget');
    if (!widget) return null; // not provisioned yet — no desk to embed
    const invoke = <T,>(op: string, input: unknown) => widget.invoke(op, input) as Promise<T>;
    const declared = await invoke<{ origins: string[] }>('ticket0/widget-origins', {});
    return { invoke, allowedOrigins: declared.origins };
  },
  // The edge knows where the request came from; the adapter is the one place that
  // reads `request.cf`, and the operation sees only the normalised shape.
  clientOf: (c) => cloudflareClientContext(c.req.raw),
  onCustomerMessage: (c, m) => {
    // `waitUntil`, not a floating promise: a Workers isolate stops executing the moment
    // the response is returned, so an un-tracked model call would be cancelled mid-flight
    // and the visitor would watch the dots spin until the widget's own ceiling gave up.
    c.executionCtx.waitUntil(answerFor(c.env as Env, c.req.raw, m));
  },
});

/**
 * Answer one customer message as this desk's assistant, out of band.
 *
 * Nothing that goes wrong in here is allowed to be silent. This used to `return` when
 * the assistant principal was missing and swallow everything else in a bare `catch`,
 * on the reasoning that an unanswered message leaves the conversation for a human
 * anyway — which is true of the conversation and false of the desk: a customer
 * message with no turn against it is indistinguishable from an assistant that is
 * merely slow, and the reason lived nowhere. Now the reason is (1) logged, where the
 * platform's observability tail can read it, and (2) recorded on the conversation as
 * a failed turn, where the desk draws it — by the assistant when the assistant can
 * still write, and by the widget when the assistant is what broke.
 */
async function answerFor(
  env: Env,
  req: Request,
  m: { conversationId: string; messageId: string; body: string },
): Promise<void> {
  const node = nodeFor(req, env);
  const where = { scope: node.scopeId, conversation: m.conversationId, message: m.messageId };
  let model = 'unknown';
  try {
    const { settings } = await instanceConfig(env, node);
    // A provider the platform holds nothing for ⇒ the extractive model, which quotes the
    // best-matching section and labels itself `offline/extractive`. A desk still answers.
    const chosen = modelFor({
      spec: settings.TICKET0_MODEL as string | undefined,
      host: modelHostFor(env),
      attribution: attributionFor(node),
    });
    model = chosen.label;
    /**
     * WHICH assistant answers — the desk's own policy, read as the widget service.
     *
     * A supervised desk answers as `assistant`, which holds no `conversation:reply-public`:
     * `answerConversation` writes the answer, is refused the send, and records the turn
     * as `drafted` for a person to send. An autonomous desk answers as the principal
     * that holds the key. Nothing here decides whether the answer may go out — the
     * kernel does, on the principal's keys — and that is the point: this only picks who
     * asks.
     *
     * Read through the widget principal because that is the one this path is already
     * holding when a stranger has just said something and nobody is signed in.
     */
    const widget = await serviceStub(env, node, 'widget');
    if (!widget) {
      throw new Error(
        'this desk has no widget service principal — provision never minted one, so nothing can answer',
      );
    }
    const { autonomous } = await (widget.invoke('ticket0/assistant-mode', {}) as Promise<{
      autonomous: boolean;
    }>);
    const role: ServiceRole = autonomous ? 'assistant-autonomous' : 'assistant';
    const assistant = await serviceStub(env, node, role);
    if (!assistant) {
      // A desk that turned autonomy on before its reconcile minted the principal lands
      // here. Recorded as a failure rather than quietly answered by the supervised one:
      // the desk asked for an answer to reach the customer, and it will not.
      throw new Error(
        `this desk has no '${role}' service principal — provision never minted one, so nothing can answer` +
          (autonomous ? ' (autonomy is on; a reconcile mints it)' : ''),
      );
    }
    const outcome = await answerConversation(
      { invoke: (op, input, options) => assistant.invoke(op, input, options) as Promise<never> },
      { conversationId: m.conversationId, messageId: m.messageId, question: m.body },
      chosen,
    );
    // The turn already carries this; the log line is for whoever is tailing the
    // worker rather than reading the desk.
    if (outcome.outcome === 'failed') {
      console.error('ticket0 assistant: turn failed', { ...where, model, error: outcome.detail });
    }
  } catch (err) {
    const error = errorText(err);
    console.error('ticket0 assistant: could not run', { ...where, model, error });
    // The last resort: the assistant could not write its own failure, so the widget —
    // the principal that just accepted the message — writes it. Best effort; if this
    // refuses too, the desk's own storage is what is broken, and the log has both.
    try {
      const widget = await serviceStub(env, node, 'widget');
      if (!widget) throw new Error('no widget service principal either');
      await recordAssistantFailure(
        { invoke: (op, input) => widget.invoke(op, input) as Promise<never> },
        { conversationId: m.conversationId, messageId: m.messageId, model, error: err },
      );
    } catch (recordErr) {
      console.error('ticket0 assistant: could not record the failure either', {
        ...where,
        model,
        error: errorText(recordErr),
      });
    }
  }
}

// ── The declared API, the spec, and the platform contract ────────────────────

// The same table `server.ts` mounts (src/routes.ts), derived from spec/model.ts.
mountApi(app, stub);

// The OpenAPI 3.1 document, built from the operation catalog. Session-gated like the
// rest of /api/*: the spec enumerates the surface, so it is for signed-in callers.
app.get('/openapi.json', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return c.json(API_DOCUMENT);
});

// The platform's entire /internal/* contract — provision, reconcile, introspection, the
// read-only SQL console, platform-request drain, snapshot/delete/export/restore,
// bookmarks/rewind, and per-instance configure — plus the guaranteed { error } envelope,
// authored once in @substrat-run/vertical-host and mounted here.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision: async (env, b) => {
    const node = { tenantId: b.tenantId, scopeId: b.scopeId };
    await identityDo(env, node).setPendingOwner(b.scopeId, b.owner);
    // The desk's widget, assistant and relay accounts. Idempotent, and done here rather
    // than lazily on first use: a principal minted on a request path is a principal
    // minted by whoever got there first.
    await mintServices(env, node);
  },
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  // The owner seat as the platform may see it, and the claim link it may mint for one that
  // sits empty after the first-sign-in window (#925). Both read the same directory the
  // provision hook above writes.
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
  mintOwnerClaim: (env, ref, input) => mintOwnerClaimLink(identityDo(env, ref), ref.scopeId, input.origin),
});

// Any OTHER platform verb is honestly unimplemented: JSON 501, never the SPA fallback —
// an /internal/* request that reaches a SPA returns 200 text/html, which the platform's
// JSON parse turns into an opaque "internal error".
app.all('/internal/*', (c) =>
  c.json({ error: `ticket0 does not implement ${c.req.method} ${new URL(c.req.url).pathname}` }, 501),
);

// No SPA catch-all: the built app and `widget.js` are served by the runtime's own asset
// layer, from the edge, without invoking this worker. It sees only what
// `runtimeNeeds.assets.runWorkerFirst` routes here; anything reaching this line is a
// worker-first prefix with no matching route.
app.all('*', (c) => c.json({ error: 'not found' }, 404));

export default app;
