import { DurableObject } from 'cloudflare:workers';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { Hono } from 'hono';
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
import { ALLOW_SIGNUP, deliveredConfig, isTruthy, putDeliveredConfig } from './settings.js';
import { publicProvidersFrom, readProviders, socialProvidersFrom, trustedProvidersFrom } from './providers.js';
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
import type { ConfigEntry, InstanceMeta, IssuerState, SessionSubject } from './do-contract.js';

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
      if (upgrade.renamed.length || upgrade.added.length) {
        console.log('auth-server: schema upgraded', JSON.stringify(upgrade));
      }
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
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
      trustedProviders: trustedProvidersFrom(providers),
      bankid: this.bankid(readBankIdConfig(this.ctx.storage.sql)),
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
    putDeliveredConfig(this.ctx.storage.sql, entries);
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
    const bankid = publicBankIdFrom(readBankIdConfig(this.ctx.storage.sql), Boolean(this.env.BANKID));
    return {
      needsSetup: this.needsSetup(),
      signupEnabled: isTruthy(this.effectiveCfg()[ALLOW_SIGNUP]),
      providers: [...publicProvidersFrom(readProviders(this.ctx.storage.sql)), ...(bankid ? [bankid] : [])],
    };
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
   * `{ sub, email, name, role }` (or null), `/__branding` is the public per-client theme read
   * for the login/consent screens (see `branding.ts` — it answers identically for unknown and
   * unthemed clients, so it needs no gate), and `/__admin/*` is the issuer's own admin API
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
    if (url.pathname === '/__branding') {
      return Response.json(clientBranding(this.ctx.storage.sql, url.searchParams.get('client_id')));
    }
    if (url.pathname.startsWith('/__admin')) {
      const api = new Hono().route(
        '/__admin',
        createAdminApi({
          sql: this.ctx.storage.sql,
          session,
          effectiveCfg: () => this.effectiveCfg(),
          auth: () => auth.api as never,
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
