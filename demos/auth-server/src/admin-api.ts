import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { SqlExec } from './introspect.js';
import type { SessionSubject } from './do-contract.js';
import { ALLOW_SIGNUP, boolValue, isTruthy, putDeliveredConfig } from './settings.js';
import {
  PROVIDER_CATALOGUE,
  deleteProvider,
  descriptorOf,
  readProvider,
  readProviders,
  toWireProvider,
  upsertProvider,
} from './providers.js';
import { deleteBankIdConfig, putBankIdConfig, readBankIdConfig, toWireBankId } from './bankid.js';

/**
 * The issuer's own admin surface — what neither Better Auth nor `oauthProvider` has an
 * endpoint for. Two things:
 *
 *  1. **Whether people may create their own account** (`ALLOW_SIGNUP`).
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
}

const CLIENT_COLUMNS = `client_id, name, icon, metadata, redirect_uris, disabled, skip_consent,
  token_endpoint_auth_method, application_type, user_id, client_secret, created_at, scopes`;

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
    /** Whether a secret exists — never the secret, which is stored hashed. */
    client_secret_set: Boolean(row.client_secret),
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

const clientPatch = z
  .object({
    client_name: z.string().min(1),
    logo_uri: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    skip_consent: z.boolean(),
    disabled: z.boolean(),
    application_type: z.enum(['web', 'native']),
    redirect_uris: z.array(z.string().min(1)).min(1),
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

/** Loopback hosts, where OAuth 2.1 still permits plain HTTP for a native client. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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
  if (applicationType === 'web' && url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new HTTPException(400, {
      message: `web clients require https redirect URIs on non-loopback hosts: ${value}`,
    });
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

  const settingsView = () => ({ allowSignup: isTruthy(deps.effectiveCfg()[ALLOW_SIGNUP]) });

  app.get('/settings', (c) => c.json(settingsView()));

  app.patch('/settings', async (c) => {
    const parsed = z
      .object({ allowSignup: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    putDeliveredConfig(deps.sql, [{ key: ALLOW_SIGNUP, value: boolValue(parsed.data.allowSignup) }]);
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
   * Add or edit one upstream. A PUT because the id is the operator's choice from a closed
   * catalogue rather than something minted here — enabling Microsoft twice is enabling it once.
   *
   * `clientSecret` is optional on an edit and absent means "keep the stored one", so changing a
   * tenant id or a toggle does not require re-pasting a credential the operator may not have
   * kept. It is required the first time, which is where `upsertProvider` refuses.
   */
  app.put('/providers/:providerId', async (c) => {
    const providerId = c.req.param('providerId');
    if (!descriptorOf(providerId)) throw new HTTPException(400, { message: `unknown provider '${providerId}'` });
    const input = parsedBody(providerPut, await c.req.json().catch(() => null));
    const existing = readProvider(deps.sql, providerId);
    if (!input.clientSecret && !existing) {
      throw new HTTPException(400, { message: 'a client secret is required to enable a provider' });
    }
    upsertProvider(deps.sql, providerId, input, existing);
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
    const exists = deps.sql
      .exec('SELECT client_id, application_type FROM oauth_client WHERE client_id = ?', clientId)
      .toArray()[0] as { application_type: string | null } | undefined;
    if (!exists) throw new HTTPException(404, { message: `unknown client '${clientId}'` });

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.client_name !== undefined) set('name', patch.client_name);
    if (patch.logo_uri !== undefined) set('icon', patch.logo_uri || null);
    if (patch.metadata !== undefined) set('metadata', JSON.stringify(patch.metadata));
    if (patch.skip_consent !== undefined) set('skip_consent', patch.skip_consent ? 1 : 0);
    if (patch.disabled !== undefined) set('disabled', patch.disabled ? 1 : 0);
    if (patch.application_type !== undefined) set('application_type', patch.application_type);
    if (patch.redirect_uris !== undefined) {
      const type = patch.application_type ?? exists.application_type ?? 'web';
      for (const uri of patch.redirect_uris) assertRedirectUri(uri, type);
      set('redirect_uris', JSON.stringify(patch.redirect_uris));
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
    for (const table of ['oauth_access_token', 'oauth_refresh_token', 'oauth_consent']) {
      deps.sql.exec(`DELETE FROM "${table}" WHERE client_id = ?`, clientId);
    }
    deps.sql.exec('DELETE FROM oauth_client WHERE client_id = ?', clientId);
    return c.json({ deleted: clientId });
  });

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 400;
    return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
  });

  return app;
}
