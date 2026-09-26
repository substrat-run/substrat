import { DurableObject } from 'cloudflare:workers';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { Hono } from 'hono';
import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  resolveScopedEnvSpec,
  type ScopeDumpTable,
  type ScopeTable,
  type ScopeTablePage,
} from '@substrat-run/contracts';
import { introspectTables, introspectTable } from './introspect.js';
import { exportDump } from './dump.js';
import { schema } from './auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { upgradeLegacySchema } from '../db/upgrade.js';
import { buildAuth } from './auth.js';
import { fetchClientMetadataResource } from './cimd-fetch.js';
import { createAdminApi } from './admin-api.js';
import { clientBranding } from './branding.js';
import { clientIdOrConsole, ensureConsoleClient } from './console-client.js';
import { clientSignIn, readSignInPolicy } from './sign-in-policy.js';
import { readSignInLog, signInLoggerFor, type SignInLogQuery } from './sign-in-log.js';
import { ACCOUNT_LINKING, ALLOW_SIGNUP, accountLinkingMode, deliveredConfig, isTruthy, putDeliveredConfig, supabaseBridgeFrom } from './settings.js';
import { genericProvidersFrom, publicProvidersFrom, readProviders, socialProvidersFrom, trustedProvidersFrom } from './providers.js';
import {
  bankIdApiUrl,
  fetchBankIdTransport,
  publicBankIdFrom,
  readBankIdConfig,
  type BankIdConfig,
} from './bankid.js';
import { PlatformRelayEmailTransport } from '@substrat-run/adapter-email';
import { transportFor, senderFor } from './email.js';
import { AUTH_SERVER_ENV } from './manifest.js';
import { isResourcesEntry, parseResourcesEntry, syncPlatformResources } from './resources.js';
import { isPlacesEntry, parsePlacesEntry, syncPlaceRegistrations } from './places.js';
import { authenticateClient, servePlaces, serveReport } from './places-http.js';
import { isDelegationsEntry, parseDelegationsEntry, syncDelegations } from './delegations.js';
import { exchangeToken } from './token-exchange.js';
import {
  PreviewClientRefusal,
  claimsParent,
  mintPreviewClient,
  retirePreviewClients,
  type RegisterClientFn,
} from './preview-clients.js';
import type { ConfigEntry, InstanceMeta, IssuerState, PreviewClientOutcome, SessionSubject } from './do-contract.js';
import type {
  MintedPreviewClient,
  PreviewClientCheck,
  PreviewClientClaim,
  PreviewClientMint,
  PreviewClientRetire,
  RetiredPreviewClients,
} from '@substrat-run/contracts';

/**
 * One issuer, as one Durable Object. STANDALONE (own worker, own hostname): a single
 * instance under a fixed name — the original shape. HOSTED (dispatch namespace, behind
 * the router): one instance PER SCOPE, addressed by the routed scope id, so every
 * installed Auth Server app is its own issuer. Either way the DO owns the ENTIRE
 * identity store — users, sessions, OAuth clients, access tokens, consent, and the JWKS
 * signing keys — in its own SQLite. Its Better Auth signing secret is generated here on
 * first init and persisted in its own `config` table, so there is no shared
 * `wrangler secret` to set, and no two issuers can ever share one.
 *
 * The worker never runs Better Auth; it forwards the `/api/auth/*` surface here. `fetch`
 * runs Better Auth's handler for everything except the small `/__*` control probes.
 */

export interface AuthServerDoEnv {
  /** The Cloudflare Email Service `send_email` binding (password-reset / verification mail).
   *  Present only in a STANDALONE deploy; a hosted dispatch instance has no such binding and
   *  sends through the platform relay below instead. */
  EMAIL?: import('@substrat-run/adapter-email').SendEmailBinding;
  /** The sender address; its domain must be onboarded for sending. */
  EMAIL_FROM?: string;
  /** Optional issuer pin. Unset (the default), the issuer derives from each request's own
   *  origin — every hostname the router binds to this scope answers as itself, and discovery
   *  can never advertise an origin that doesn't route here. Set only when the request origin
   *  can't be trusted (standalone behind a rewriting proxy). */
  PUBLIC_ORIGIN?: string;
  /** Bootstrap admin address — when set with ADMIN_PASSWORD, seeded as `admin` on first init. */
  ADMIN_EMAIL?: string;
  /** Bootstrap admin password (a secret). Seeds the first admin deterministically, no setup race. */
  ADMIN_PASSWORD?: string;
  /** Injected into every dispatch script by the WfP uploader (#303, hosted mode): the shared
   *  platform secret this instance presents to the email relay, and the control plane's origin
   *  it POSTs to. Absent in a standalone deploy — there the `EMAIL` binding sends directly. */
  PLATFORM_SECRET?: string;
  CONTROL_PLANE_URL?: string;
  /** A Cloudflare mTLS-certificate binding (`mtls_certificates` in wrangler.jsonc) holding the
   *  BankID RP client certificate — the worker's only way to present one, since workerd's
   *  `fetch` takes no per-request client cert. STANDALONE deploys only; absent (every hosted
   *  dispatch instance), BankID stays configured-but-unoffered rather than half-working. */
  BANKID?: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export class AuthServerDO extends DurableObject<AuthServerDoEnv> {
  /** This issuer's Better Auth signing secret — generated in this DO, never a worker binding. */
  private authSecret!: string;
  constructor(ctx: DurableObjectState, env: AuthServerDoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // BEFORE the DDL: `CREATE TABLE IF NOT EXISTS` cannot fix a table whose shape changed,
      // and `oauthProvider` reuses two of the old plugin's table names with new columns.
      const upgrade = upgradeLegacySchema(ctx.storage.sql);
      if (upgrade.renamed.length || upgrade.added.length || upgrade.dropped.length) {
        console.log('auth-server: schema upgraded', JSON.stringify(upgrade));
      }
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
      // The issuer's own console, as a row in its own registry (`console-client.ts`).
      // Seeded here rather than at provisioning time because a STANDALONE deploy is never
      // provisioned, and both shapes need it — waking the DO is the one thing every install
      // does. Idempotent, and it never overwrites what an operator has put on the row.
      if (ensureConsoleClient(ctx.storage.sql)) console.log('auth-server: seeded the admin console client');
      const row = [...ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'auth_secret'")][0] as
        | { value: string }
        | undefined;
      if (row) {
        this.authSecret = row.value;
      } else {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        this.authSecret = btoa(String.fromCharCode(...bytes));
        ctx.storage.sql.exec("INSERT INTO config (key, value) VALUES ('auth_secret', ?)", this.authSecret);
      }
      await this.seedEnvAdmin();
    });
  }

  /**
   * Deterministic bootstrap: if `ADMIN_EMAIL` + `ADMIN_PASSWORD` are configured (worker
   * secrets, which a DO reads off `this.env` like any binding) and the issuer has no users
   * yet, create that admin on first init. This removes the "first user to sign in wins" race
   * of the setup screen — the operator owns the credentials up front. Runs once (guarded on a
   * zero-user store), never overwrites an existing admin, and never crashes the DO on failure.
   * When these are unset, the setup screen remains the fallback.
   */
  private async seedEnvAdmin(): Promise<void> {
    const cfg = this.effectiveCfg();
    const email = cfg.ADMIN_EMAIL?.trim();
    const password = cfg.ADMIN_PASSWORD;
    if (!email || !password) return;
    const count = ([...this.ctx.storage.sql.exec('SELECT count(*) AS n FROM user')][0] as { n: number }).n;
    if (count > 0) return;
    if (password.length < 8) {
      console.warn('auth-server: ADMIN_PASSWORD is shorter than 8 characters — skipping env admin seed');
      return;
    }
    try {
      // Password hashing is origin-independent, so the boot-time baseURL fallback is fine.
      // Sign-up forced on: seeding the FIRST administrator is not self-service registration,
      // and an issuer with `ALLOW_SIGNUP` off would otherwise have no way to create anybody.
      const auth = this.auth(cfg.PUBLIC_ORIGIN ?? 'http://localhost', { allowSignup: true });
      const created = await auth.api.signUpEmail({ body: { email, password, name: 'Administrator' } });
      this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", created.user.id);
    } catch (e) {
      console.error('auth-server: env admin seed failed', e);
    }
  }

  /** A Better Auth instance over THIS DO's SQLite, issuing for `origin`. The issuer is the
   *  request's own origin unless PUBLIC_ORIGIN pins it — per-hostname derivation keeps
   *  discovery self-consistent on every hostname bound to this scope (OIDC requires the
   *  advertised `issuer` to match the URL discovery was fetched from). */
  private auth(origin: string, overrides?: { allowSignup?: boolean }) {
    const cfg = this.effectiveCfg();
    const providers = readProviders(this.ctx.storage.sql);
    const baseURL = cfg.PUBLIC_ORIGIN ?? origin;
    const db = drizzle(this.ctx.storage, { schema });
    return buildAuth({
      database: drizzleAdapter(db, { provider: 'sqlite', schema }),
      secret: this.authSecret,
      baseURL,
      // Both the canonical origin and the actual request origin are trusted, so local
      // `wrangler dev` (no PUBLIC_ORIGIN) and a real deploy both work.
      trustedOrigins: [...new Set([baseURL, origin])],
      // EMAIL is a Cloudflare binding (infra, not a declared string key), so it's read from
      // env directly; the sender address is the manifest-declared EMAIL_FROM.
      transport: this.transport(),
      sender: senderFor(cfg.EMAIL_FROM),
      // workerd has no DNS API, so this honours three of the transport contract's four
      // clauses and says which one it cannot. `cimd-fetch.ts` carries the reasoning.
      fetchClientMetadataResource,
      // Re-read per request (this whole method is), so the dashboard's sign-up toggle takes
      // effect on the next request rather than the next deploy.
      allowSignup: overrides?.allowSignup ?? isTruthy(cfg[ALLOW_SIGNUP]),
      // Federated sign-in, read from the registry on the same per-request basis — a provider
      // enabled in the dashboard answers the next request.
      socialProviders: socialProvidersFrom(providers),
      genericProviders: genericProvidersFrom(providers),
      trustedProviders: trustedProvidersFrom(providers),
      // Read on the same per-request basis, so switching the mode in the dashboard decides the
      // very next federated sign-in rather than the next deploy.
      autoLinkAccounts: accountLinkingMode(cfg[ACCOUNT_LINKING]) === 'link',
      // The legacy-secret bridge, when configured. It is handed the SAME linking answer:
      // a plugin mints accounts through the internal adapter and so never passes through
      // Better Auth's own implicit-linking rules, which would leave a second door
      // quietly ignoring the operator's policy.
      supabase: supabaseBridgeFrom(cfg, accountLinkingMode(cfg[ACCOUNT_LINKING]) === 'link'),
      bankid: this.bankid(readBankIdConfig(this.ctx.storage.sql)),
      // Read per request like everything else here, so narrowing a client in the dashboard
      // decides the very next authorize request rather than the next deploy.
      signInPolicyFor: (clientId) => readSignInPolicy(this.ctx.storage.sql, clientId),
      // The sign-in log writes into THIS issuer's own SQLite, which is what makes it readable
      // where a hosted install can actually be read: the admin console, the dashboard's Data
      // tab, and `/internal/export`. A dispatch-namespace script's `console.log` is none of
      // those.
      recordSignIn: signInLoggerFor(this.ctx.storage.sql),
      // `ctx.waitUntil`, which is the DO's own way of saying "finish this, but not before the
      // response". Better Auth cannot find it by itself — it is handed a `Request` and nothing
      // else — so without this line a new user's verification email is awaited inside the
      // callback and the browser's redirect waits on the platform mail relay.
      runInBackground: (promise) => {
        this.ctx.waitUntil(promise.catch((e: unknown) => console.error('auth-server: background task failed', e)));
      },
    });
  }

  /** BankID for `buildAuth` — only when configured, enabled, AND this worker can present the
   *  client certificate (the mTLS binding above). The binding's certificate is fixed at deploy
   *  time; the panel's environment choice still decides which API it is presented to. */
  private bankid(cfg: BankIdConfig | undefined) {
    const binding = this.env.BANKID;
    if (!cfg || cfg.disabled || !binding) return undefined;
    return {
      apiUrl: bankIdApiUrl(cfg.environment),
      transport: fetchBankIdTransport((url, init) => binding.fetch(url, init)),
      allowSignup: cfg.allowSignup,
      // Set by Cloudflare's edge on every request and not forgeable through it — the one
      // address this worker can honestly report to BankID as the end user's.
      clientIpHeader: 'cf-connecting-ip',
    };
  }

  /**
   * The instance's `InstanceMeta` (its tenant + scope), recorded by `provisionInstance` in
   * hosted mode. Absent in a standalone deploy (nothing provisions it), which is exactly the
   * signal used to choose the transport below.
   */
  private instanceMeta(): InstanceMeta | undefined {
    const row = [...this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'instance'")][0] as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as InstanceMeta) : undefined;
  }

  /**
   * Choose how this issuer sends mail (#303). HOSTED — a dispatch instance with the platform
   * secret, the control-plane URL, and a recorded `(tenant, scope)` — sends through the
   * `PlatformRelayEmailTransport`: it holds no `send_email` binding (the §4 sandbox refuses one),
   * so the platform sends on its behalf, gated by the `emailSender` grant. STANDALONE — its own
   * worker with an `EMAIL` binding — sends directly. Missing either way ⇒ the drop-mock, so a
   * reset never crashes; the link is still observable in `wrangler tail` / the dev terminal.
   */
  private transport() {
    const meta = this.instanceMeta();
    if (this.env.PLATFORM_SECRET && this.env.CONTROL_PLANE_URL && meta) {
      return new PlatformRelayEmailTransport({
        controlPlaneUrl: this.env.CONTROL_PLANE_URL,
        platformSecret: this.env.PLATFORM_SECRET,
        tenantId: meta.tenantId,
        scopeId: meta.scopeId,
      });
    }
    return transportFor(this.env);
  }

  /**
   * Record what this instance IS — called by the platform-gated `/internal/provision`
   * (K-31, hosted mode). Waking the DO is what materializes the issuer (the constructor
   * creates the schema and mints the signing secret), so this only has to persist the
   * metadata — and any config delivered WITH provisioning, so an instance can arrive
   * with its bootstrap admin in the same call. INSERT OR REPLACE keeps it idempotent —
   * the control plane's reconciliation sweep re-runs provisioning, and a retry must
   * converge, not duplicate.
   */
  async provisionInstance(meta: InstanceMeta, config?: ConfigEntry[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('instance', ?)",
      JSON.stringify(meta),
    );
    if (config?.length) await this.setInstanceConfig(config);
  }

  /**
   * The provisioning reconcile's half (#1660, the sweep of #1172/#1653): what this issuer
   * recorded at provision, or `null` if it never was. Writes NOTHING.
   *
   * Everything `provisionInstance` delivers is the instance metadata plus optional config,
   * and a reconcile carries neither — its body names a tenant and a scope and nothing more.
   * Re-running the provision would therefore overwrite `{slug, name}` with nothing, so this
   * does the part of a reconcile that is true of this vertical instead: the DO is awake,
   * which means its constructor has run against the CURRENT code — the schema brought to
   * this version, the console client seeded — and the caller learns whether the install it
   * is about to write a receipt for is one this issuer knows.
   */
  async reconcileInstance(): Promise<InstanceMeta | null> {
    return this.instanceMeta() ?? null;
  }

  /**
   * A preview's own client (#1704, `preview-clients.ts`) — check, mint, retire. Each is the
   * far end of a platform-gated `/internal/preview-client*` call and answers only for THIS
   * instance: the call names a tenant and a scope, and both must be what `provisionInstance`
   * recorded here. The platform secret proves the caller is the platform, never which tenant
   * the platform is acting for, so without this a tenant's preview could be wired to another
   * tenant's issuer. A never-provisioned DO (a stray id) has no record and refuses everything.
   */
  private foreignCall(input: { tenantId: string; scopeId: string }): PreviewClientRefusal | null {
    const meta = this.instanceMeta();
    if (!meta || meta.tenantId !== input.tenantId || meta.scopeId !== input.scopeId) {
      return new PreviewClientRefusal(403, `scope ${input.scopeId} is not an issuer of tenant ${input.tenantId}`);
    }
    return null;
  }

  private async previewCall<T>(input: { tenantId: string; scopeId: string }, fn: () => Promise<T> | T): Promise<PreviewClientOutcome<T>> {
    const refused = this.foreignCall(input);
    if (refused) return { ok: false, status: refused.status, error: refused.message };
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof PreviewClientRefusal) return { ok: false, status: e.status, error: e.message };
      throw e;
    }
  }

  async checkPreviewClient(input: PreviewClientCheck): Promise<PreviewClientOutcome<PreviewClientClaim>> {
    return this.previewCall(input, () => ({ claimed: claimsParent(this.ctx.storage.sql, input) }));
  }

  async mintPreviewClient(input: PreviewClientMint): Promise<PreviewClientOutcome<MintedPreviewClient>> {
    return this.previewCall(input, () =>
      mintPreviewClient(this.ctx.storage.sql, this.registerClient(), input, (fn) => this.ctx.storage.transactionSync(fn)),
    );
  }

  async retirePreviewClients(input: PreviewClientRetire): Promise<PreviewClientOutcome<RetiredPreviewClients>> {
    return this.previewCall(input, () =>
      this.ctx.storage.transactionSync(() => retirePreviewClients(this.ctx.storage.sql, input)),
    );
  }

  /**
   * Dynamic client registration, in-process: the plugin's own `/oauth2/register`, the endpoint
   * the dashboard's install-time registration POSTs to. So a preview's client is registered by
   * exactly the code an app's is — the plugin mints the id, hashes the secret and judges the
   * URIs. A platform call has no request origin, and registration does not depend on one.
   */
  private registerClient(): RegisterClientFn {
    const origin = this.env.PUBLIC_ORIGIN ?? 'https://preview-client.platform.invalid';
    const auth = this.auth(origin);
    return async (body) => {
      const res = await auth.handler(
        new Request(`${origin}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const out = (await res.json().catch(() => null)) as
        | { client_id?: string; client_secret?: string; error_description?: string; error?: string }
        | null;
      if (!res.ok || !out?.client_id || !out.client_secret) {
        const why = out?.error_description ?? out?.error ?? `status ${res.status}`;
        throw new PreviewClientRefusal(400, `the issuer refused the preview client's registration: ${why}`);
      }
      return { client_id: out.client_id, client_secret: out.client_secret };
    };
  }

  /**
   * Upsert per-instance config (vertical-auth-detach.md §2.2) — the delivery half of
   * the dashboard's Env tab, arriving via the platform-gated `/internal/configure`.
   * Stored under `cfg:<key>` in this DO's own config table and overlaid over worker env
   * by `effectiveCfg()`, so a hosted instance is configured per-scope while a standalone
   * deploy keeps using `wrangler` vars/secrets. Key-by-key upserts (never a replace), so
   * partial deliveries compose. Seeding the bootstrap admin re-runs afterward: config
   * delivering `ADMIN_EMAIL`/`ADMIN_PASSWORD` is exactly how a hosted instance gets its
   * deterministic first admin (the seed itself stays guarded on a zero-user store).
   */
  async setInstanceConfig(entries: ConfigEntry[]): Promise<void> {
    // `substrat:resources:<scope>` is not config but the platform's registration of a
    // vertical's MCP endpoint (#1619, `resources.ts`). It becomes rows in `oauth_resource`,
    // which is the registry the plugin reads, and is NOT also kept as a `cfg:` row: one
    // source of truth, so the two cannot disagree. Every such entry is parsed before
    // anything is written, so a malformed one refuses the whole delivery.
    const resources = entries.filter((e) => isResourcesEntry(e.key)).map((e) => parseResourcesEntry(e.key, e.value));
    // `substrat:places:<tenant>` is the same kind of entry for a login's places (#1670,
    // `places.ts`): the platform's registration of which of a team's apps sign in here. Rows
    // in `place_app`, never a `cfg:` row, and parsed up front for the same reason.
    const places = entries.filter((e) => isPlacesEntry(e.key)).map((e) => parsePlacesEntry(e.key, e.value));
    // `substrat:delegations:<host scope>` likewise (#1824, `delegations.ts`): which apps may act
    // for the host's users. Rows in `delegation_grant`, which token exchange re-reads on every
    // request, and never a `cfg:` row.
    const delegations = entries
      .filter((e) => isDelegationsEntry(e.key))
      .map((e) => parseDelegationsEntry(e.key, e.value));
    const config = entries.filter((e) => !isResourcesEntry(e.key) && !isPlacesEntry(e.key) && !isDelegationsEntry(e.key));
    // ONE transaction for the whole delivery. DO SQLite commits each `exec` on its own
    // unless it is wrapped, so a statement that fails halfway through a multi-host
    // un-registration would leave part of the set removed, and a deleted app has no later
    // reconcile to finish the job. `transactionSync` rolls every write back on a throw.
    // It is synchronous, which is why the admin seed below, which awaits, stays outside it.
    const now = Date.now();
    const synced = this.ctx.storage.transactionSync(() => {
      const results = resources.map((delivery) => ({
        app: delivery.appScopeId,
        ...syncPlatformResources(this.ctx.storage.sql, delivery, now),
      }));
      const placeResults = places.map((delivery) => ({
        tenant: delivery.tenantId,
        ...syncPlaceRegistrations(this.ctx.storage.sql, delivery, now),
      }));
      const delegationResults = delegations.map((delivery) => ({
        host: delivery.hostAppScopeId,
        ...syncDelegations(this.ctx.storage.sql, delivery, now),
      }));
      if (config.length) putDeliveredConfig(this.ctx.storage.sql, config);
      return { results, placeResults, delegationResults };
    });
    // Logged only once committed, so a line never describes writes that rolled back.
    for (const sync of synced.results) {
      if (sync.added.length || sync.removed.length || sync.operatorOwned.length) {
        console.log('auth-server: platform resources synced', JSON.stringify(sync));
      }
    }
    for (const sync of synced.placeResults) {
      if (sync.registered.length || sync.updated.length || sync.cleared.length) {
        console.log('auth-server: place registrations synced', JSON.stringify(sync));
      }
    }
    for (const sync of synced.delegationResults) {
      if (sync.granted.length || sync.updated.length || sync.revoked.length) {
        console.log('auth-server: delegation grants synced', JSON.stringify(sync));
      }
    }
    await this.seedEnvAdmin();
  }

  /**
   * The instance's live config: worker env (resolved through the declared env-spec)
   * overlaid with per-instance `cfg:` rows — instance config wins, and only DECLARED
   * keys are read, so a stray delivered key can never reach Better Auth. The merge is
   * the shared `resolveScopedEnvSpec` (contracts); this method only supplies the
   * delivered map from THIS DO's own `cfg:` storage.
   */
  private effectiveCfg(): Record<string, string | undefined> {
    const delivered = deliveredConfig(this.ctx.storage.sql, AUTH_SERVER_ENV);
    return resolveScopedEnvSpec(AUTH_SERVER_ENV, this.env as Record<string, unknown>, delivered).values;
  }

  /**
   * Read-only introspection of THIS issuer's SQLite (§5.4's admin-query RPC) — the
   * dashboard Data tab, arriving via the platform-gated `/internal/tables` routes.
   * Secret-bearing columns (password hashes, tokens, JWKS private keys, the signing
   * secret) are redacted inside the DO, before anything crosses its boundary.
   */
  async introspectTables(): Promise<ScopeTable[]> {
    return introspectTables(this.ctx.storage.sql);
  }

  async introspectTable(table: string, limit: number, offset: number): Promise<ScopeTablePage> {
    return introspectTable(this.ctx.storage.sql, table, limit, offset);
  }

  /**
   * The COMPLETE dump of this issuer's SQLite (#590) — full fidelity, secrets included,
   * because a dump exists to rebuild the issuer elsewhere (see `dump.ts` for why it must
   * NOT redact). Arrives via the platform-gated `/internal/export`; the control-plane
   * route in front is the gate, the auditor, and the default masker.
   */
  async exportDump(): Promise<ScopeDumpTable[]> {
    return exportDump(this.ctx.storage.sql);
  }

  /**
   * Wipe this issuer's storage irreversibly (#590) — the vertical's half of a reap or a
   * data-carrying rebind, via the platform-gated `/internal/delete-scope`. The refusals
   * (backup-first, directory cleanup) live on the control plane, which calls this before
   * deleting the directory row; this DO just destroys its own bytes. After deleteAll the
   * instance is inert; a stray re-open re-runs the constructor against empty storage and
   * mints a fresh signing secret for a schema no directory row points at.
   */
  async destroyStorage(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /**
   * The DO's bindings for `exchangeToken`: this issuer's own client authentication, keys and
   * clock. Verification is by the JWKS the issuer publishes, read in-process from the plugin's
   * own endpoint, so it trusts exactly the keys a relying party would; and it checks the
   * signature ONLY, because `token-exchange.ts` judges every claim against one clock.
   */
  private async tokenExchange(auth: ReturnType<typeof buildAuth>, origin: string, request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    // The same issuer the plugin stamps into its own tokens (`jwt({ jwt: { issuer: baseURL } })`).
    const issuer = this.effectiveCfg().PUBLIC_ORIGIN ?? origin;
    const jwks = (await (await auth.handler(new Request(`${origin}/api/auth/jwks`))).json()) as JSONWebKeySet;
    const keys = createLocalJWKSet(jwks);
    const answer = await exchangeToken(
      {
        sql: this.ctx.storage.sql,
        issuer,
        nowSeconds: Math.floor(Date.now() / 1000),
        authenticate: (clientId, secret) =>
          authenticateClient(this.ctx.storage.sql, (r) => auth.handler(r), origin, clientId, secret),
        verify: async (token) => {
          try {
            const { payload } = await compactVerify(token, keys);
            const claims: unknown = JSON.parse(new TextDecoder().decode(payload));
            return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
          } catch {
            return null;
          }
        },
        sign: async (payload) => (await auth.api.signJWT({ body: { payload } })).token,
        log: (line) => console.log(line),
      },
      form,
      request.headers.get('authorization'),
    );
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' };
    if (answer.wwwAuthenticate) headers['www-authenticate'] = answer.wwwAuthenticate;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
  }

  /** Is the issuer un-bootstrapped (no users yet)? The worker shows "create the first admin". */
  private needsSetup(): boolean {
    const row = [...this.ctx.storage.sql.exec('SELECT count(*) AS n FROM user')][0] as { n: number };
    return row.n === 0;
  }

  /**
   * What the SPA needs BEFORE anyone is signed in: whether to show "create the first admin",
   * and whether to offer a sign-up link. Both are pre-auth by nature — the sign-up screen has
   * to be reachable by someone who has no account — so this is the one unauthenticated read,
   * and it says nothing a visitor could not learn by posting to the endpoints themselves.
   */
  async issuerState(): Promise<IssuerState> {
    return {
      needsSetup: this.needsSetup(),
      signupEnabled: isTruthy(this.effectiveCfg()[ALLOW_SIGNUP]),
      providers: this.offeredProviders(),
    };
  }

  /**
   * Every sign-in button this issuer could draw: the enabled upstream rows, plus BankID when
   * it is both configured and presentable. The issuer-wide answer — a client's own policy
   * narrows it (`sign-in-policy.ts`), and both readers below go through here so the two
   * cannot come to disagree about what exists.
   */
  private offeredProviders(): { id: string; label: string }[] {
    const bankid = publicBankIdFrom(readBankIdConfig(this.ctx.storage.sql), Boolean(this.env.BANKID));
    return [...publicProvidersFrom(readProviders(this.ctx.storage.sql)), ...(bankid ? [bankid] : [])];
  }

  /**
   * Bootstrap the first administrator — the only account creation that needs no existing
   * admin. Allowed ONLY while the issuer has zero users (fail-closed against a second call
   * racing in). Creates the account through Better Auth, then promotes it to the `admin`
   * role and marks the address verified, so the operator can sign straight into the
   * dashboard. Returns the new user id.
   */
  async setupFirstAdmin(origin: string, creds: { email: string; password: string; name: string }): Promise<{ id: string }> {
    if (!this.needsSetup()) throw new Error('the auth server is already set up');
    // Same reason as `seedEnvAdmin`: bootstrapping an administrator is not sign-up.
    const auth = this.auth(origin, { allowSignup: true });
    const created = await auth.api.signUpEmail({
      body: { email: creds.email, password: creds.password, name: creds.name },
    });
    const id = created.user.id;
    this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", id);
    return { id };
  }

  /**
   * The DO's HTTP surface. Three `/__*` control paths — `/__session` resolves the request to
   * `{ sub, email, name, role }` (or null), `/__client-options` is the public per-client read
   * for the login/consent screens — the theme (`branding.ts`) and the sign-in methods that
   * client accepts (`sign-in-policy.ts`), which answer identically for an unknown and an
   * unconfigured client, so it needs no gate, and `/__admin/*` is the issuer's own admin API
   * (the relying-party registry + settings, `admin`-gated inside). Everything else is a
   * Better Auth request — sign-in, sign-up, the whole OIDC surface (discovery, authorize,
   * token, jwks, userinfo), and Better Auth's own admin API.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.auth(url.origin);
    const session = (headers: Headers): Promise<SessionSubject | null> =>
      auth.api.getSession({ headers }).then((s) => {
        const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
        return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
      });
    if (url.pathname === '/__session') return Response.json(await session(request.headers));
    // A login's places (#1670, `places.ts`). The read takes its subject from the session and
    // nothing else; the report is a vertical's, held to the checks `places.ts` describes.
    if (url.pathname === '/__places' && request.method === 'GET') {
      return servePlaces(this.ctx.storage.sql, session, request.headers);
    }
    if (url.pathname === '/__places/report' && request.method === 'POST') {
      return serveReport({
        sql: this.ctx.storage.sql,
        handler: (r) => auth.handler(r),
        origin: url.origin,
        body: await request.json().catch(() => null),
        transaction: (fn) => this.ctx.storage.transactionSync(fn),
        log: (line) => console.log(line),
      });
    }
    // RFC 8693 token exchange (#1824, `token-exchange.ts`). The worker sends a token-endpoint
    // POST here only when its `grant_type` is token exchange; every other grant reaches the
    // plugin's own `/oauth2/token` below, untouched.
    if (url.pathname === '/__token-exchange' && request.method === 'POST') {
      return this.tokenExchange(auth, url.origin, request);
    }
    if (url.pathname === '/__client-options') {
      // No `client_id` is the console asking about ITSELF — the one caller with no relying
      // party to name. `clientIdOrConsole` is where that resolution lives, so this route and
      // the dev server's cannot come to disagree.
      const clientId = clientIdOrConsole(url.searchParams.get('client_id'));
      return Response.json({
        ...clientBranding(this.ctx.storage.sql, clientId),
        signIn: clientSignIn(this.ctx.storage.sql, clientId, this.offeredProviders()),
      });
    }
    if (url.pathname.startsWith('/__admin')) {
      const api = new Hono().route(
        '/__admin',
        createAdminApi({
          sql: this.ctx.storage.sql,
          session,
          effectiveCfg: () => this.effectiveCfg(),
          auth: () => auth.api as never,
          // The same list the login screen is drawn from, so the console's lock-out guard
          // (`console-client.ts`) judges a policy against what this runtime can actually
          // offer — BankID's mTLS binding included, which no SQL read could know about.
          offeredProviders: () => this.offeredProviders(),
        }),
      );
      return api.fetch(request);
    }
    return auth.handler(request);
  }
}

// The callable-surface + session types live in `do-contract.ts` (no `cloudflare:workers`
// import there, so the HTTP layer and node tests can share them); re-exported for
// worker-build importers.
export type { AuthServerStub, SessionSubject, InstanceMeta } from './do-contract.js';
