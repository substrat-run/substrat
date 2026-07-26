import { DurableObject } from 'cloudflare:workers';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { resolveEnvSpec, type ScopeTable, type ScopeTablePage } from '@substrat-run/contracts';
import { introspectTables, introspectTable } from './introspect.js';
import { schema } from './auth-schema.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.js';
import { buildAuth } from './auth.js';
import { transportFor, senderFor } from './email.js';
import { AUTH_SERVER_ENV } from './manifest.js';
import type { ConfigEntry, InstanceMeta } from './do-contract.js';

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
  /** The Cloudflare Email Service `send_email` binding (password-reset / verification mail). */
  EMAIL?: import('@substrat-run/adapter-email').SendEmailBinding;
  /** The sender address; its domain must be onboarded for sending. */
  EMAIL_FROM?: string;
  /** The canonical issuer origin (e.g. https://auth.substrat.run). Falls back to the request origin. */
  PUBLIC_ORIGIN?: string;
  /** Bootstrap admin address — when set with ADMIN_PASSWORD, seeded as `admin` on first init. */
  ADMIN_EMAIL?: string;
  /** Bootstrap admin password (a secret). Seeds the first admin deterministically, no setup race. */
  ADMIN_PASSWORD?: string;
}

export class AuthServerDO extends DurableObject<AuthServerDoEnv> {
  /** This issuer's Better Auth signing secret — generated in this DO, never a worker binding. */
  private authSecret!: string;
  /** The declared config (manifest env-spec) resolved against this DO's env — the BASE
   *  layer of `effectiveCfg()`, which overlays per-instance `cfg:` rows delivered via
   *  `setInstanceConfig` (hosted mode). The env-spec stays the single source of which
   *  keys exist (PUBLIC_ORIGIN, ADMIN_EMAIL/PASSWORD, EMAIL_FROM). */
  private readonly cfg: Record<string, string | undefined>;

  constructor(ctx: DurableObjectState, env: AuthServerDoEnv) {
    super(ctx, env);
    this.cfg = resolveEnvSpec(AUTH_SERVER_ENV, env as Record<string, unknown>).values;
    ctx.blockConcurrencyWhile(async () => {
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
      const auth = this.auth(cfg.PUBLIC_ORIGIN ?? 'http://localhost');
      const created = await auth.api.signUpEmail({ body: { email, password, name: 'Administrator' } });
      this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", created.user.id);
    } catch (e) {
      console.error('auth-server: env admin seed failed', e);
    }
  }

  /** A Better Auth instance over THIS DO's SQLite, issuing for `origin`. */
  private auth(origin: string) {
    const cfg = this.effectiveCfg();
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
      transport: transportFor(this.env),
      sender: senderFor(cfg.EMAIL_FROM),
    });
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
    for (const { key, value } of entries) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", `cfg:${key}`, value);
    }
    await this.seedEnvAdmin();
  }

  /**
   * The instance's live config: worker env (resolved through the declared env-spec)
   * overlaid with per-instance `cfg:` rows — instance config wins, and only DECLARED
   * keys are read, so a stray delivered key can never reach Better Auth.
   */
  private effectiveCfg(): Record<string, string | undefined> {
    const out = { ...this.cfg };
    for (const spec of AUTH_SERVER_ENV) {
      const row = [...this.ctx.storage.sql.exec('SELECT value FROM config WHERE key = ?', `cfg:${spec.key}`)][0] as
        | { value: string }
        | undefined;
      if (row) out[spec.key] = row.value;
    }
    return out;
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

  /** Is the issuer un-bootstrapped (no users yet)? The worker shows "create the first admin". */
  async needsSetup(): Promise<boolean> {
    const row = [...this.ctx.storage.sql.exec('SELECT count(*) AS n FROM user')][0] as { n: number };
    return row.n === 0;
  }

  /**
   * Bootstrap the first administrator — the only account creation that needs no existing
   * admin. Allowed ONLY while the issuer has zero users (fail-closed against a second call
   * racing in). Creates the account through Better Auth, then promotes it to the `admin`
   * role and marks the address verified, so the operator can sign straight into the
   * dashboard. Returns the new user id.
   */
  async setupFirstAdmin(origin: string, creds: { email: string; password: string; name: string }): Promise<{ id: string }> {
    if (!(await this.needsSetup())) throw new Error('the auth server is already set up');
    const auth = this.auth(origin);
    const created = await auth.api.signUpEmail({
      body: { email: creds.email, password: creds.password, name: creds.name },
    });
    const id = created.user.id;
    this.ctx.storage.sql.exec("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?", id);
    return { id };
  }

  /**
   * The DO's HTTP surface. `/__session` resolves the request to `{ sub, email, name, role }`
   * (or null); everything else is a Better Auth request — sign-in, the whole OIDC surface
   * (discovery, authorize, token, jwks, userinfo), and the admin API.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = this.auth(url.origin);
    if (url.pathname === '/__session') {
      const session = await auth.api.getSession({ headers: request.headers });
      const u = session?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return Response.json(
        u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null,
      );
    }
    return auth.handler(request);
  }
}

// The callable-surface + session types live in `do-contract.ts` (no `cloudflare:workers`
// import there, so the HTTP layer and node tests can share them); re-exported for
// worker-build importers.
export type { AuthServerStub, SessionSubject, InstanceMeta } from './do-contract.js';
