import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { SqlExec } from './introspect.js';
import type { SessionSubject } from './do-contract.js';
import { ACCOUNT_LINKING, ALLOW_SIGNUP, accountLinkingMode, boolValue, isTruthy, putDeliveredConfig } from './settings.js';
import { assertSignInPolicy, isReservedMethodId, sanitizeSignInPolicy } from './sign-in-policy.js';
import {
  CONSOLE_CLIENT_ID,
  CONSOLE_CLIENT_NAME,
  assertConsoleClientPatch,
  assertConsolePolicy,
  isConsoleClient,
} from './console-client.js';
import {
  GENERIC_ID_PATTERN,
  LOOPBACK_HOSTS,
  PROVIDER_CATALOGUE,
  deleteProvider,
  descriptorOf,
  isReservedProviderId,
  readProvider,
  isHttpsOrLoopback,
  readProviders,
  toWireProvider,
  upsertProvider,
  type ProviderEndpoints,
} from './providers.js';
import { resolveIssuerEndpoints } from './provider-discovery.js';
import { deleteBankIdConfig, putBankIdConfig, readBankIdConfig, toWireBankId } from './bankid.js';

/**
 * The issuer's own admin surface — what neither Better Auth nor `oauthProvider` has an
 * endpoint for. Two things:
 *
 *  1. **Whether people may create their own account** (`ALLOW_SIGNUP`), and what a federated
 *     sign-in does when its address is already taken (`ACCOUNT_LINKING`).
 *  2. **The UPSTREAM identity providers** an operator has enabled (`src/providers.ts`) —
 *     "sign in with Microsoft". Better Auth takes those as CONFIG, so an issuer that is
 *     configured at runtime has to hold them itself; there is no library endpoint to proxy.
 *  3. **Every registered client, for an administrator.** The plugin's `/oauth2/get-clients`
 *     is a "my applications" read — it filters by the CALLER's `userId` (or organization
 *     reference). An issuer's registry is not per-owner: it holds clients another admin
 *     registered and clients that registered THEMSELVES with no user at all, and an operator
 *     who cannot see those cannot review or withdraw them. So the list is ours; a read, and
 *     only a read.
 *
 * Where the split falls, and why:
 *
 *  - **Creating** a client is the library's (`adminCreateOAuthClient`, proxied here because
 *    the plugin marks it `SERVER_ONLY`). It mints the id, mints and HASHES the secret, and
 *    validates the redirect URIs. None of that should be reimplemented, and the deleted 1.6
 *    registry reimplemented all three.
 *  - **Rotating** a secret is the library's too, for the same reason — it is the only verb
 *    left that touches secret material, and the plugin hashes with whatever
 *    `storeClientSecret` says.
 *  - **Editing, disabling and removing** are OURS, and that is a deliberate disagreement with
 *    the library rather than an oversight. Every client-mutating endpoint it exposes requires
 *    `client.userId === session.user.id`: a client belongs to whoever registered it, and a
 *    self-registered one (no user at all) can never be changed by anybody. That is the right
 *    model for "users manage their own OAuth apps" and the wrong one for an ISSUER's
 *    operator, whose whole job includes withdrawing an application they did not register. The
 *    `disabled` column is not in the plugin's update body at all, which points the same way.
 *    These verbs touch plain columns — no ids, no secrets, no hashing — and re-validate the
 *    redirect URIs the plugin would have.
 *
 * Rows are read and returned in the SAME wire shape the plugin emits (RFC 7591 field names),
 * so the dashboard sees one shape whichever side answered.
 *
 * Built as a factory over `{ sql, session, effectiveCfg }` so ONE implementation answers in
 * both runtimes: the Durable Object over `ctx.storage.sql`, the node dev server over
 * better-sqlite3.
 */

/**
 * The two client verbs the plugin marks `SERVER_ONLY` — reachable through `auth.api`, never
 * over HTTP. That is deliberate on the library's part: they are the ones that can set
 * `skip_consent` and `disabled`, so registering a consent-skipping client has to pass through
 * a server that decides who may. This is that server. Narrow on purpose, so the Durable
 * Object and the dev server can each hand over their own Better Auth instance.
 */
export interface OAuthClientAdminApi {
  adminCreateOAuthClient(input: { headers: Headers; body: Record<string, unknown> }): Promise<unknown>;
  adminUpdateOAuthClient(input: { headers: Headers; body: Record<string, unknown> }): Promise<unknown>;
}

export interface AdminApiDeps {
  /** This issuer's SQLite. */
  sql: SqlExec;
  /** Resolve the session behind a request's cookies, or null. */
  session(headers: Headers): Promise<SessionSubject | null>;
  /** The live merge of worker env + delivered per-instance config. */
  effectiveCfg(): Record<string, string | undefined>;
  /** Better Auth for THIS request — used only for the server-only client verbs. */
  auth(): OAuthClientAdminApi;
  /**
   * Every sign-in button this issuer could draw right now — the enabled upstream rows plus
   * BankID when this runtime can actually present its certificate.
   *
   * A dep rather than a read off `sql`, because the second half of that sentence is not in
   * the database: BankID is offered only where an mTLS binding exists, which the Durable
   * Object knows and the dev server knows differently. It is used for ONE thing — the
   * console's lock-out guard (`console-client.ts`) — and guessing there would either block a
   * legitimate policy or wave through the one that strands its author.
   */
  offeredProviders(): { id: string; label: string }[];
}

const CLIENT_COLUMNS = `client_id, name, icon, metadata, redirect_uris, disabled, skip_consent,
  token_endpoint_auth_method, application_type, user_id, client_secret, created_at, scopes,
  enable_end_session, post_logout_redirect_uris`;

interface ClientRow {
  client_id: string;
  name: string | null;
  icon: string | null;
  metadata: string | null;
  redirect_uris: string | null;
  disabled: number | null;
  skip_consent: number | null;
  token_endpoint_auth_method: string | null;
  application_type: string | null;
  user_id: string | null;
  client_secret: string | null;
  created_at: number | null;
  scopes: string | null;
  enable_end_session: number | null;
  post_logout_redirect_uris: string | null;
}

/** `string[]`/`json` columns are TEXT here — SQLite is not a JSON provider for the adapter. */
function jsonColumn<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readClientRow(sql: SqlExec, clientId: string): ClientRow | undefined {
  return sql
    .exec(`SELECT ${CLIENT_COLUMNS} FROM oauth_client WHERE client_id = ?`, clientId)
    .toArray()[0] as unknown as ClientRow | undefined;
}

function readClient(sql: SqlExec, clientId: string): WireClient {
  const row = readClientRow(sql, clientId);
  if (!row) throw new HTTPException(404, { message: `unknown client '${clientId}'` });
  return toWireClient(row);
}

/** One row, in the RFC 7591-shaped object `schemaToOAuth` emits, minus anything secret. */
function toWireClient(row: ClientRow) {
  return {
    client_id: row.client_id,
    client_name: row.name ?? undefined,
    logo_uri: row.icon ?? undefined,
    redirect_uris: jsonColumn<string[]>(row.redirect_uris, []),
    scope: jsonColumn<string[]>(row.scopes, []).join(' ') || undefined,
    token_endpoint_auth_method: row.token_endpoint_auth_method ?? undefined,
    application_type: row.application_type ?? undefined,
    disabled: Boolean(row.disabled),
    skip_consent: Boolean(row.skip_consent),
    user_id: row.user_id ?? undefined,
    client_id_issued_at: row.created_at ? Math.round(Number(row.created_at) / 1000) : undefined,
    metadata: jsonColumn<Record<string, unknown>>(row.metadata, {}),
    /**
     * RP-initiated logout, which the plugin refuses unless the client row says yes: the
     * column has no default, so a client registered without it can never sign anyone out.
     * `post_logout_redirect_uris` is its own list — the plugin matches the requested
     * `post_logout_redirect_uri` against THIS one, never against `redirect_uris`.
     */
    enable_end_session: Boolean(row.enable_end_session),
    post_logout_redirect_uris: jsonColumn<string[]>(row.post_logout_redirect_uris, []),
    /** Whether a secret exists — never the secret, which is stored hashed. */
    client_secret_set: Boolean(row.client_secret),
    /**
     * The issuer's OWN console (`console-client.ts`), rather than an application somebody
     * registered. On the wire because the dashboard has to draw it differently — it has no
     * redirect URIs, no secret to rotate and no Remove button — and deriving that from a
     * hardcoded id in the browser would put the same fact in two places.
     */
    builtin: isConsoleClient(row.client_id),
  };
}

export type WireClient = ReturnType<typeof toWireClient>;

/**
 * Call a plugin endpoint and translate its `APIError` into an HTTP answer the dashboard can
 * display. Better Auth throws a structured error with the OAuth `error_description` inside;
 * losing it would turn "web clients require https redirect URIs" into a bare 400.
 */
async function pluginCall(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { statusCode?: number; body?: { error_description?: string; error?: string }; message?: string };
    if (err.statusCode) {
      throw new HTTPException(err.statusCode as 400, {
        message: err.body?.error_description ?? err.body?.error ?? err.message ?? 'the issuer refused the request',
      });
    }
    throw e;
  }
}

/** SQLite's own clock, in the epoch-ms Better Auth stores dates as. */
const NOW_MS = "cast(unixepoch('subsecond') * 1000 as integer)";

/**
 * Whether an `account` row is actually a way in — as a PREDICATE over the hash, never the hash.
 * The answer the screen and the unlink guard both need is "is there a password", and selecting
 * the column to work it out would put a bcrypt hash in a variable one careless `c.json(row)`
 * away from the wire.
 *
 * Only a `credential` row can be false today: an upstream row exists because somebody completed
 * a round trip with that provider. Deliberately NOT narrowed further to the providers this
 * issuer currently offers — disabling a provider leaves its `account` rows alone on purpose
 * (see the provider delete above), and re-enabling it restores those sign-ins, so treating a
 * disabled provider's row as "not a way in" would turn a reversible state into a permitted,
 * irreversible unlink.
 */
const METHOD_IS_USABLE = "(provider_id <> 'credential' OR (password IS NOT NULL AND password <> ''))";

interface SignInMethodRow {
  id: string;
  provider_id: string;
  account_id: string;
  issuer: string | null;
  created_at: number | null;
  usable: number;
}

/**
 * One person's `account` rows, in the shape both the read and the unlink need. One reader, so
 * the screen's idea of "this cannot be removed" and the server's refusal cannot drift apart.
 */
function readSignInMethods(sql: SqlExec, userId: string): SignInMethodRow[] {
  return sql
    .exec(
      `SELECT id, provider_id, account_id, issuer, created_at, ${METHOD_IS_USABLE} AS usable
         FROM account WHERE user_id = ? ORDER BY created_at ASC`,
      userId,
    )
    .toArray() as unknown as SignInMethodRow[];
}

/**
 * Refuse a client write whose `signIn` policy is not one (`src/sign-in-policy.ts`).
 *
 * The runtime read is deliberately permissive — a policy it cannot understand is no policy,
 * because a half-applied restriction is worse than none. That is the right answer for a row
 * already in the database and the wrong one HERE, where an operator is holding the form: a
 * misspelt key would be accepted, stored, and quietly not restrict anything. So this is the
 * strict end, and it is also where a policy allowing nothing at all is caught, while the
 * person who wrote it can still see why.
 *
 * Both write paths go through it — the plugin-backed create and the plain-column patch —
 * because `metadata` is one column with two doors.
 */
function assertClientMetadata(metadata: unknown): void {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const signIn = (metadata as Record<string, unknown>).signIn;
  if (signIn === undefined) return;
  try {
    assertSignInPolicy(signIn);
  } catch (e) {
    throw new HTTPException(400, { message: e instanceof Error ? e.message : 'invalid signIn policy' });
  }
}

const clientPatch = z
  .object({
    client_name: z.string().min(1),
    logo_uri: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    skip_consent: z.boolean(),
    disabled: z.boolean(),
    application_type: z.enum(['web', 'native']),
    redirect_uris: z.array(z.string().min(1)).min(1),
    enable_end_session: z.boolean(),
    /**
     * Unlike `redirect_uris`, an EMPTY list is meaningful and allowed: a client may end a
     * session without being sent anywhere afterwards, and clearing the list is how an
     * operator withdraws a target that has moved.
     */
    post_logout_redirect_uris: z.array(z.string().min(1)),
  })
  .partial();

/**
 * One upstream provider, as the dashboard sends it.
 *
 * `clientSecret` is optional and, when present, must be non-empty: an empty string arriving
 * from an untouched form field would otherwise overwrite a working credential with nothing.
 * Absent means keep; the route refuses absence on a first save.
 */
const providerPut = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tenantId: z.string().nullable().optional(),
  /** Generic rows only: the upstream's issuer URL. Required there, refused on a catalogue id. */
  issuer: z.string().min(1).nullable().optional(),
  /** Generic rows only: what the login button says. */
  label: z.string().min(1).max(60).nullable().optional(),
  allowSignup: z.boolean(),
  trustEmail: z.boolean(),
  disabled: z.boolean(),
});

/**
 * BankID's configuration, as the panel sends it. Same convention as the OAuth providers for
 * credential fields: absent means "keep the stored one", and empty strings are refused rather
 * than read as an instruction to clear a working credential. `caCert: null` is the one
 * explicit clear — it removes a trust-anchor override, falling back to the embedded root.
 */
const bankidPut = z.object({
  environment: z.enum(['test', 'production']),
  clientCert: z.string().min(1).optional(),
  clientKey: z.string().min(1).optional(),
  caCert: z.string().min(1).nullable().optional(),
  allowSignup: z.boolean(),
  disabled: z.boolean(),
});

/**
 * The redirect-URI rule the plugin applies at registration, applied again here because an
 * edit does not pass through the plugin. A `web` client must use HTTPS off loopback; a
 * `native` one may use HTTP loopback or a private-use scheme. Getting this wrong does not
 * fail loudly — it registers fine and the authorize request is refused later, at the point
 * where a person is trying to sign in.
 */
function assertRedirectUri(value: string, applicationType: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: `'${value}' is not an absolute URI` });
  }
  if (url.hash) throw new HTTPException(400, { message: `'${value}' must not carry a fragment` });
  if (applicationType === 'web' && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new HTTPException(400, {
      message: `web clients require https redirect URIs on non-loopback hosts: ${value}`,
    });
  }
}

/**
 * The rule for a GENERIC provider's issuer URL. HTTPS, because the discovery document fetched
 * from it decides where this issuer sends people and their authorization codes — with the
 * loopback exception every other rule here grants, so a local Keycloak works in dev. No
 * query or fragment: an issuer is an origin plus an optional path (RFC 8414), and anything
 * after that is a pasted authorize URL, not an issuer.
 */
function assertIssuerUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: `'${value}' is not an absolute URL` });
  }
  if (url.hash || url.search) {
    throw new HTTPException(400, { message: 'an issuer URL carries no query or fragment' });
  }
  if (!isHttpsOrLoopback(url)) {
    throw new HTTPException(400, { message: `an issuer URL must be https (or http on loopback): ${value}` });
  }
}

function parsedBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HTTPException(400, {
      message: result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
    });
  }
  return result.data;
}

export function createAdminApi(deps: AdminApiDeps): Hono {
  const app = new Hono();

  /** The gate. Identical to the dashboard's own: a Better Auth session holding `admin`. */
  app.use('*', async (c, next) => {
    const session = await deps.session(c.req.raw.headers);
    if (!session) throw new HTTPException(401, { message: 'sign in first' });
    if (session.role !== 'admin') throw new HTTPException(403, { message: 'administrator role required' });
    await next();
  });

  const settingsView = () => {
    const cfg = deps.effectiveCfg();
    return {
      allowSignup: isTruthy(cfg[ALLOW_SIGNUP]),
      accountLinking: accountLinkingMode(cfg[ACCOUNT_LINKING]),
    };
  };

  app.get('/settings', (c) => c.json(settingsView()));

  /**
   * A real PATCH: every field is optional and only what arrives is written, so a panel that
   * changes the linking mode does not have to restate the sign-up decision it did not touch —
   * and cannot revert it by echoing a stale copy. An empty body is refused rather than
   * answered 200, which would report success for a request that set nothing.
   */
  app.patch('/settings', async (c) => {
    const parsed = z
      .object({ allowSignup: z.boolean().optional(), accountLinking: z.enum(['link', 'block']).optional() })
      .refine((v) => v.allowSignup !== undefined || v.accountLinking !== undefined, {
        message: 'name at least one setting to change',
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
      });
    }
    putDeliveredConfig(deps.sql, [
      ...(parsed.data.allowSignup !== undefined
        ? [{ key: ALLOW_SIGNUP, value: boolValue(parsed.data.allowSignup) }]
        : []),
      ...(parsed.data.accountLinking !== undefined
        ? [{ key: ACCOUNT_LINKING, value: parsed.data.accountLinking }]
        : []),
    ]);
    return c.json(settingsView());
  });

  /* ---- the upstream identity providers ---- */

  /**
   * The catalogue and what is configured against it, in one read — the panel needs both to
   * draw itself, and they are meaningless apart. The client secret is not here and cannot be
   * asked for: it is a live credential this issuer presents to the upstream, so `clientSecretSet`
   * is the only thing said about it, exactly as `client_secret_set` is for a relying party.
   */
  app.get('/providers', (c) =>
    c.json({
      catalogue: PROVIDER_CATALOGUE,
      providers: readProviders(deps.sql).map(toWireProvider),
    }),
  );

  /**
   * Add or edit one upstream. A PUT because the id is the operator's choice — from the closed
   * catalogue, or a slug they named a GENERIC OIDC provider themselves — rather than something
   * minted here: enabling Microsoft twice is enabling it once.
   *
   * The id decides which kind of row this is, and there are three. A BUILT-IN catalogue id
   * takes no issuer — the library owns those endpoints. A NAMED generic catalogue id
   * (`issuerField`, i.e. Supabase) requires one and gets its label from the catalogue. Any
   * other id is an UNNAMED generic provider and must bring both. The id is refused where it
   * would collide with a provider Better Auth ships built-in — a generic row named `gitlab`
   * would silently shadow the real GitLab.
   *
   * `clientSecret` is optional on an edit and absent means "keep the stored one", so changing a
   * tenant id or a toggle does not require re-pasting a credential the operator may not have
   * kept. It is required the first time, which is where `upsertProvider` refuses.
   */
  app.put('/providers/:providerId', async (c) => {
    const providerId = c.req.param('providerId');
    const input = parsedBody(providerPut, await c.req.json().catch(() => null));
    const descriptor = descriptorOf(providerId);
    if (descriptor?.issuerField) {
      // A NAMED generic entry (Supabase): the catalogue owns the id, the button label and the
      // console string, and the operator owns the one thing this file cannot know — which
      // project. So it is a generic row in every other respect, and takes the same issuer
      // rule, the same save-time discovery and the same `genericOAuth` mounting.
      if (!input.issuer) {
        throw new HTTPException(400, { message: `'${providerId}' needs an issuer URL — ${descriptor.issuerField.label}` });
      }
      assertIssuerUrl(input.issuer);
      // Neither is the operator's to give: the label is the catalogue's, and the directory
      // field is Entra's — an issuer URL already names one directory.
      input.label = descriptor.label;
      input.tenantId = null;
    } else if (descriptor) {
      // Loudly, not silently dropped: an issuer arriving with a built-in catalogue id means
      // the caller thinks it is configuring endpoints that the library will never read.
      if (input.issuer) {
        throw new HTTPException(400, { message: `'${providerId}' is a built-in provider and does not take an issuer URL` });
      }
    } else {
      if (isReservedProviderId(providerId)) {
        throw new HTTPException(400, {
          message: `'${providerId}' is a provider Better Auth ships built-in — a custom provider cannot take its name`,
        });
      }
      // The other namespace an id can collide with: the sign-in-method stamp a session
      // carries (`src/sign-in-policy.ts`). `password` is not a built-in provider, so nothing
      // above stops it — and an upstream registered under that id would land on
      // `/callback/password` and stamp its sessions the way a password sign-in is stamped,
      // which a password-only client policy would then admit wholesale.
      if (isReservedMethodId(providerId)) {
        throw new HTTPException(400, {
          message: `'${providerId}' is how this issuer names a sign-in that is not an upstream provider — a custom provider cannot take its name`,
        });
      }
      if (!GENERIC_ID_PATTERN.test(providerId)) {
        throw new HTTPException(400, {
          message: `'${providerId}' is not a usable provider id — lowercase letters, digits and hyphens, up to 40 characters (it becomes the callback path segment)`,
        });
      }
      if (!input.issuer) {
        throw new HTTPException(400, { message: `'${providerId}' is not in the catalogue — a custom provider needs an issuer URL` });
      }
      if (!input.label?.trim()) {
        throw new HTTPException(400, { message: 'a custom provider needs a label for its sign-in button' });
      }
      assertIssuerUrl(input.issuer);
      // The directory field is Entra's; a generic provider's issuer already names one.
      input.tenantId = null;
    }
    const existing = readProvider(deps.sql, providerId);
    if (!input.clientSecret && !existing) {
      throw new HTTPException(400, { message: 'a client secret is required to enable a provider' });
    }
    let endpoints: ProviderEndpoints | null = null;
    if (input.issuer) {
      // Discovery, resolved HERE and stored on the row — never at runtime (see
      // `resolveIssuerEndpoints` for why that is load-bearing). Re-resolved when the issuer
      // changes and kept otherwise, so flipping a toggle does not depend on the upstream
      // being reachable at that moment.
      const issuerChanged = input.issuer.trim() !== existing?.issuer;
      if (issuerChanged || !existing?.endpoints) {
        try {
          endpoints = await resolveIssuerEndpoints(input.issuer.trim());
        } catch (e) {
          throw new HTTPException(400, {
            message: `the issuer's discovery document could not be used: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      } else {
        endpoints = JSON.parse(existing.endpoints) as ProviderEndpoints;
      }
    }
    upsertProvider(deps.sql, providerId, { ...input, endpoints }, existing);
    return c.json(toWireProvider(readProvider(deps.sql, providerId)!), existing ? 200 : 201);
  });

  /**
   * Remove an upstream — the credential goes with the row, and this issuer stops offering the
   * button. Accounts already linked to it are NOT touched: a `user`/`account` pair is the
   * person's identity here, not the provider's, and deleting people is the admin API's verb.
   * Re-adding the provider later re-links them by `(issuer, account_id)`.
   */
  app.delete('/providers/:providerId', (c) => {
    const providerId = c.req.param('providerId');
    if (!readProvider(deps.sql, providerId)) {
      throw new HTTPException(404, { message: `provider '${providerId}' is not configured` });
    }
    deleteProvider(deps.sql, providerId);
    return c.json({ deleted: providerId });
  });

  /* ---- BankID ---- */

  /**
   * BankID is configured beside the OAuth upstreams but not among them (`src/bankid.ts` for
   * why: no client id, no redirect — a certificate and two decisions). One read, one PUT, one
   * DELETE, singleton by nature. The key material goes in and never comes back out.
   */
  app.get('/bankid', (c) => {
    const cfg = readBankIdConfig(deps.sql);
    return c.json({ bankid: cfg ? toWireBankId(cfg) : null });
  });

  app.put('/bankid', async (c) => {
    const input = parsedBody(bankidPut, await c.req.json().catch(() => null));
    const existing = readBankIdConfig(deps.sql);
    // The certificate and its key replace each other only AS A PAIR: accepting one half
    // would merge it with the stored other half, and a mismatched pair does not fail here —
    // it fails as a refused TLS handshake the next time someone tries to sign in.
    if ((input.clientCert === undefined) !== (input.clientKey === undefined)) {
      throw new HTTPException(400, {
        message: 'the client certificate and key replace each other as a pair — paste both, or neither',
      });
    }
    if (!input.clientCert && !existing) {
      throw new HTTPException(400, { message: 'a client certificate and key are required to enable BankID' });
    }
    const saved = putBankIdConfig(deps.sql, input, existing);
    return c.json(toWireBankId(saved), existing ? 200 : 201);
  });

  app.delete('/bankid', (c) => {
    if (!readBankIdConfig(deps.sql)) throw new HTTPException(404, { message: 'BankID is not configured' });
    deleteBankIdConfig(deps.sql);
    return c.json({ deleted: 'bankid' });
  });

  /**
   * Every registered client, newest first, in the plugin's own wire shape. The secret is
   * never here: `storeClientSecret` defaults to `hashed`, so the stored value is not the
   * credential and could not be returned even deliberately — `client_secret_set` is the only
   * honest thing to say about it.
   */
  app.get('/clients', (c) => {
    const rows = deps.sql
      .exec(`SELECT ${CLIENT_COLUMNS} FROM oauth_client ORDER BY created_at DESC`)
      .toArray() as unknown as ClientRow[];
    return c.json({ clients: rows.map(toWireClient) });
  });

  /**
   * Register a client, and hand back the secret the plugin minted. This proxies
   * `auth.api.adminCreateOAuthClient` rather than letting the browser call it, because the
   * plugin marks that endpoint `SERVER_ONLY`: it is the variant that can set `skip_consent`,
   * and a consent-skipping client is not something a browser gets to create directly. The
   * request's own headers go through, so the plugin re-checks the session and
   * `clientPrivileges` itself — this middleware is a gate in front of a gate, not instead of
   * one.
   */
  app.post('/clients', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HTTPException(400, { message: 'a JSON body is required' });
    assertClientMetadata(body.metadata);
    return c.json((await pluginCall(() => deps.auth().adminCreateOAuthClient({ headers: c.req.raw.headers, body }))) as object, 201);
  });

  /**
   * Edit a client — including `disabled`, which the plugin's update body does not carry, and
   * including clients this administrator did not register, which every plugin endpoint
   * refuses (see the header). Plain columns only.
   */
  app.patch('/clients/:clientId', async (c) => {
    const clientId = c.req.param('clientId');
    const patch = parsedBody(clientPatch, await c.req.json().catch(() => null));
    // Before anything is read or written: the console's row has no OAuth surface, and
    // this is the one route that could give it one (`CONSOLE_LOCKED_FIELDS`).
    if (isConsoleClient(clientId)) assertConsoleClientPatch(patch);
    const exists = deps.sql
      .exec(
        `SELECT client_id, application_type, redirect_uris, post_logout_redirect_uris
           FROM oauth_client WHERE client_id = ?`,
        clientId,
      )
      .toArray()[0] as
      | { application_type: string | null; redirect_uris: string | null; post_logout_redirect_uris: string | null }
      | undefined;
    if (!exists) throw new HTTPException(404, { message: `unknown client '${clientId}'` });

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.client_name !== undefined) set('name', patch.client_name);
    if (patch.logo_uri !== undefined) set('icon', patch.logo_uri || null);
    if (patch.metadata !== undefined) {
      assertClientMetadata(patch.metadata);
      /**
       * The console gets a second, stricter reading of the same policy: not "is this a
       * policy" but "does it leave a way in HERE". `assertClientMetadata` above passes
       * `{ password: false, providers: ['microsoft'] }` for every client and should — the
       * screen says so when the provider is missing. On this row saying so is not good
       * enough, because the person who would read it is the one who can no longer sign in.
       */
      if (isConsoleClient(clientId)) {
        assertConsolePolicy(
          sanitizeSignInPolicy((patch.metadata as Record<string, unknown>).signIn),
          deps.offeredProviders(),
        );
      }
      set('metadata', JSON.stringify(patch.metadata));
    }
    if (patch.skip_consent !== undefined) set('skip_consent', patch.skip_consent ? 1 : 0);
    if (patch.disabled !== undefined) set('disabled', patch.disabled ? 1 : 0);
    if (patch.application_type !== undefined) set('application_type', patch.application_type);
    if (patch.enable_end_session !== undefined) set('enable_end_session', patch.enable_end_session ? 1 : 0);
    /**
     * The URI rule is a fact about the PAIR — a list, and the application type that judges it
     * — so a patch naming the type re-judges whichever list it did not replace. Checking only
     * what the request carried would let `application_type: 'web'` on its own move a native
     * client's `http:` callbacks under a rule they fail: a row no registration would have
     * accepted, that nothing afterwards is asked to look at again.
     */
    const type = patch.application_type ?? exists.application_type ?? 'web';
    const assertList = (uris: string[]) => {
      for (const uri of uris) assertRedirectUri(uri, type);
    };
    if (patch.redirect_uris !== undefined) {
      assertList(patch.redirect_uris);
      set('redirect_uris', JSON.stringify(patch.redirect_uris));
    } else if (patch.application_type !== undefined) {
      assertList(jsonColumn<string[]>(exists.redirect_uris, []));
    }
    if (patch.post_logout_redirect_uris !== undefined) {
      // Same rule, and for the same reason: this is a URI the issuer hands to a browser.
      assertList(patch.post_logout_redirect_uris);
      set('post_logout_redirect_uris', JSON.stringify(patch.post_logout_redirect_uris));
    } else if (patch.application_type !== undefined) {
      assertList(jsonColumn<string[]>(exists.post_logout_redirect_uris, []));
    }
    if (!sets.length) throw new HTTPException(400, { message: 'nothing to change' });
    deps.sql.exec(
      `UPDATE oauth_client SET ${sets.join(', ')}, updated_at = ${NOW_MS} WHERE client_id = ?`,
      ...values,
      clientId,
    );
    return c.json(readClient(deps.sql, clientId));
  });

  /**
   * Un-register a client, and take what it holds with it.
   *
   * Only ONE of the four tables referencing `oauth_client` declares `ON DELETE CASCADE`
   * (`oauth_client_resource`); the plugin leaves the others plain, so a client with a live
   * token or a standing consent cannot be deleted at all — the foreign key refuses, and the
   * operator sees "FOREIGN KEY constraint failed" instead of a removed application. Deleting
   * the dependents first is therefore not tidying: it is what makes the verb work. It is also
   * the right revocation — `userinfo` authenticates a bearer token against its own row, so a
   * token outliving its client would keep reading user data.
   */
  app.delete('/clients/:clientId', (c) => {
    const clientId = c.req.param('clientId');
    if (!readClientRow(deps.sql, clientId)) throw new HTTPException(404, { message: `unknown client '${clientId}'` });
    /**
     * The console's row is the issuer's own, not an application anybody registered — and
     * removing it would take the theme and policy an operator put on it while the next boot
     * silently seeded a blank one back. Disabling it is the verb that means what a delete
     * here would be reaching for, and it is reversible.
     */
    if (isConsoleClient(clientId)) {
      throw new HTTPException(409, {
        message: `'${CONSOLE_CLIENT_ID}' is the ${CONSOLE_CLIENT_NAME.toLowerCase()}, not a registered application — disable it instead, which restores this issuer's plain sign-in screen`,
      });
    }
    for (const table of ['oauth_access_token', 'oauth_refresh_token', 'oauth_consent']) {
      deps.sql.exec(`DELETE FROM "${table}" WHERE client_id = ?`, clientId);
    }
    deps.sql.exec('DELETE FROM oauth_client WHERE client_id = ?', clientId);
    return c.json({ deleted: clientId });
  });

  /**
   * How ANOTHER person signs in — the one read the user-detail screen needs and Better Auth's
   * admin plugin does not answer. `list-accounts` is scoped to the caller's own session, so an
   * operator asked "why can this person not sign in with Google" and had nowhere to look.
   *
   * The columns are named rather than starred, and the names are the whole security argument:
   * `account` also holds `password` (the bcrypt hash) and the upstream's `access_token`,
   * `refresh_token` and `id_token`. None of them may leave the server, and a `SELECT *` here
   * would put all four on the wire the first time somebody added a field to the screen.
   *
   * `account_id` is included and is not a secret: it is the subject the upstream knows this
   * person by, which is exactly what an operator comparing two Google accounts is looking at.
   *
   * A password row is `provider_id = 'credential'`. It is returned like any other method
   * because the screen has to be able to say "this account has a password" — the fact, never
   * the hash — and `usable` is that fact, in the one shape a browser can be told it.
   */
  app.get('/users/:userId/sign-in-methods', (c) => {
    const userId = c.req.param('userId');
    const user = deps.sql.exec('SELECT id FROM user WHERE id = ?', userId).toArray();
    // 404 rather than an empty list: "no such person" and "a person with no way in" are
    // different answers, and the second one is a real state an operator has to be able to see.
    if (user.length === 0) throw new HTTPException(404, { message: `unknown user '${userId}'` });
    const rows = readSignInMethods(deps.sql, userId);
    return c.json({
      methods: rows.map((row) => ({
        id: row.id,
        provider: row.provider_id,
        accountId: row.account_id,
        issuer: row.issuer,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        usable: Boolean(row.usable),
      })),
    });
  });

  /**
   * Take one sign-in method away — the write half of the read above, and the other thing
   * Better Auth's `unlink-account` will not do for somebody else: it too is scoped to the
   * caller's own session, so an operator holding "this person's old Google account is not
   * theirs any more" had no lever at all.
   *
   * Two refusals, and both are the point of the endpoint rather than validation around it:
   *
   *  - The row must belong to the user in the path. `account.id` is globally unique, so a
   *    delete keyed on it alone would happily unlink somebody else's method through a URL
   *    naming the person an operator thought they were looking at.
   *  - It must not take away their LAST way in. An account with no method is not a lesser
   *    account, it is one nobody can sign into — recoverable here only by an administrator
   *    setting a password, and not at all by the person themselves.
   *
   * The second refusal is about what is LOST, not about how many rows are left, and the
   * difference is a real state: a `credential` row with no hash (`METHOD_IS_USABLE`) is listed
   * on the screen and is not a way in, so removing it takes nothing away and is exactly the
   * tidying an operator should be able to do — counting rows would refuse it and leave the
   * dead row there with no verb that reaches it.
   *
   * Sessions are deliberately untouched. Removing a method decides how they sign in NEXT
   * time; ending what they are in the middle of is `revoke-user-sessions`, a separate verb an
   * operator may or may not mean — and doing both from one button would take the choice away.
   */
  app.delete('/users/:userId/sign-in-methods/:accountId', (c) => {
    const userId = c.req.param('userId');
    const accountId = c.req.param('accountId');
    const rows = readSignInMethods(deps.sql, userId);
    // Same distinction the read makes: an unknown person and a person with nothing to remove
    // are different answers, and only the first is a 404 on the user.
    if (rows.length === 0) {
      const user = deps.sql.exec('SELECT id FROM user WHERE id = ?', userId).toArray();
      if (user.length === 0) throw new HTTPException(404, { message: `unknown user '${userId}'` });
    }
    const target = rows.find((row) => row.id === accountId);
    if (!target) throw new HTTPException(404, { message: `'${userId}' has no sign-in method '${accountId}'` });
    const othersUsable = rows.some((row) => row.id !== accountId && Boolean(row.usable));
    if (Boolean(target.usable) && !othersUsable) {
      throw new HTTPException(409, {
        message:
          'this is their only way to sign in — set a password or connect another provider first, or remove the account itself',
      });
    }
    deps.sql.exec('DELETE FROM account WHERE id = ? AND user_id = ?', accountId, userId);
    return c.json({ removed: accountId });
  });

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 400;
    return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
  });

  return app;
}
