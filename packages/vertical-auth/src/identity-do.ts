import { DurableObject } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as schema from './auth-schema.js';
import type { AuthProvider, AuthSubject } from './provider.js';
import { resolveCookieDomain } from './cookie-domain.js';
import {
  SITE_REGISTRY_DDL,
  recordSite as recordSiteRow,
  listSites as listSiteRows,
  resolveSiteScope as resolveSiteScopeRow,
  forgetSite as forgetSiteRow,
  type RegistrySql,
  type SiteRow,
} from './site-registry.js';
import {
  OWNER_SEAT_DDL,
  migrateOwnerSeat,
  recordOwnerSeat,
  ownerOfRecord as ownerOfRecordRow,
  needsSetup as needsSetupRow,
  ownerSeat as ownerSeatRow,
  resolvePrincipal as resolvePrincipalRow,
  mintOwnerClaim as mintOwnerClaimRow,
  claimOwner as claimOwnerRow,
  type OwnerSeat,
} from './owner-seat.js';

/**
 * The per-tenant IDENTITY Durable Object — one per tenant, running its OWN Better Auth
 * over its OWN SQLite (Drizzle's Durable-Object driver, not a shared D1), and holding the
 * provider-agnostic `sub → principal` directory. A tenant's users/sessions/credentials are
 * isolated in its DO; there is NO per-worker `AUTH_DB` to leak across tenants.
 *
 * It runs in its own isolate (separate process + storage from the vertical's business-data
 * DO), and is one of the vertical's OWN DO classes — a legal sandbox-clean binding (the
 * contract refuses only cross-script / platform bindings).
 *
 * Two roles, either or both used per deployment:
 *   - `doAuthProvider` (below) exposes Better Auth here as an `AuthProvider` (the
 *     `better-auth-do` config). With an OIDC provider instead, Better Auth stays dormant.
 *   - `setPendingOwner` / `resolvePrincipal` / `claimOwner` are the identity directory —
 *     used under EVERY provider, since the subject → principal mapping is provider-independent.
 *     The owner seat's rules (the bounded first sign-in, the claim link) are in owner-seat.ts.
 */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)`,
  // The PROVIDER-AGNOSTIC identity directory (`identity`: a verified `sub` → the Substrat
  // PrincipalId it maps to, per scope — K-22, the same login is a different principal in each
  // scope, independent of WHICH provider verified it) and the OWNER SEAT around it —
  // `pending_owner` (claimed and consumed), `owner_of_record` (#332, never consumed: the
  // vertical's own durable memory of the owner, in this per-tenant DO rather than the scope's
  // data DO, so it survives a scope-DO wipe and a reconcile can re-grant from it) and
  // `owner_claim` (the claim link's hash, #925). The tables and the rules over them live in
  // `owner-seat.ts` so they are unit-tested without a DO; the methods below delegate there.
  ...OWNER_SEAT_DDL,
  // Outstanding member invites (the post-setup join path). Each is a pre-minted principal +
  // role the admin already granted at scope level, waiting for a login to claim it by token.
  // Only the token's HASH is stored — the token itself lives in the accept link, never here.
  `CREATE TABLE IF NOT EXISTS invite (
    token_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL, principal TEXT NOT NULL,
    role_key TEXT NOT NULL, email TEXT, claimed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS invite_by_scope ON invite (scope_id)`,
  // This DO's own config — notably its session-signing secret, generated here per tenant.
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // PER-SCOPE instance config, delivered by the platform via /internal/configure
  // (vertical-auth-detach.md §2.2) — notably the scope's `substrat:auth` issuer choice.
  // Lives here because this DO is the vertical's per-tenant harness store and the scope's
  // own data DO exposes no harness-writable surface.
  `CREATE TABLE IF NOT EXISTS scope_config (scope_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope_id, key))`,
  // The tenant's SITES (K-26 multi-scope) — each site IS a scope. Recorded here at provision so
  // the vertical can enumerate its own sites CP-lessly: the control-plane directory is the
  // platform's list, this is the vertical's own, in the per-tenant IdentityDO (survives a
  // scope-DO wipe). Powers the in-app switcher + the worker's slug → scope resolution. The
  // table/queries live in `site-registry.ts` so they are unit-testable without a DO.
  ...SITE_REGISTRY_DDL,
];

// The IdentityDO needs no injected env: its signing secret is generated per tenant and
// kept in its own storage (see below), so there is no shared worker secret to manage.
export type IdentityDoEnv = Record<string, never>;

export class IdentityDO extends DurableObject<IdentityDoEnv> {
  /** This tenant's Better Auth signing secret — generated in this DO, never shared, never a worker binding. */
  private authSecret!: string;

  constructor(ctx: DurableObjectState, env: IdentityDoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
      // Columns the DDL cannot add to a table that already exists (#925's `claim_until`).
      migrateOwnerSeat(ctx.storage.sql as unknown as RegistrySql);
      // Load-or-generate this tenant's OWN signing secret. Each IdentityDO mints its own on
      // first init and persists it here, so the secret is per-tenant, never leaves the DO,
      // and needs no `wrangler secret put` (which would be one value shared across every
      // tenant on the deployed script — the multi-tenant hazard we're avoiding).
      const row = [...ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'auth_secret'")][0] as { value: string } | undefined;
      if (row) {
        this.authSecret = row.value;
      } else {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        this.authSecret = btoa(String.fromCharCode(...bytes));
        ctx.storage.sql.exec("INSERT INTO config (key, value) VALUES ('auth_secret', ?)", this.authSecret);
      }
    });
  }

  /**
   * Upsert per-scope config delivered by the platform (vertical-auth-detach.md §2.2).
   * Key-by-key, never a replace, so partial deliveries compose; idempotent so the
   * reconciliation sweep can re-run it.
   */
  async setScopeConfig(scopeId: string, entries: Array<{ key: string; value: string }>): Promise<void> {
    for (const { key, value } of entries) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO scope_config (scope_id, key, value) VALUES (?, ?, ?)',
        scopeId, key, value,
      );
    }
  }

  /**
   * The config DELIVERED to one scope (dashboard Env tab → `/internal/configure` →
   * `setScopeConfig`), as a plain map — the `delivered` argument of the contracts helper
   * `resolveScopedEnvSpec(spec, env, delivered)`. This is the blessed read for a
   * vertical's ORDINARY env-spec keys (issue #398): overlay these values on worker env,
   * per-scope wins. `authWiring` below is the auth-specific composite (config + session
   * secret in one hop); use that when you also need the secret, this when you don't.
   */
  async getScopeConfig(scopeId: string): Promise<Record<string, string>> {
    const config: Record<string, string> = {};
    for (const row of this.ctx.storage.sql.exec('SELECT key, value FROM scope_config WHERE scope_id = ?', scopeId)) {
      config[row.key as string] = row.value as string;
    }
    return config;
  }

  /**
   * Everything the worker needs to build the scope's `AuthProvider`, in ONE round-trip:
   * the scope's delivered config (notably `substrat:auth`) plus this tenant's
   * session-signing secret (minted here on first use, never a worker binding — the same
   * per-tenant-secret move as `auth_secret`). One method rather than two keeps the
   * per-request cost at a single DO hop.
   */
  async authWiring(scopeId: string): Promise<{ config: Record<string, string>; sessionSecret: string }> {
    const config = await this.getScopeConfig(scopeId);
    let secret = ([...this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'session_secret'")][0] as { value: string } | undefined)?.value;
    if (!secret) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      secret = btoa(String.fromCharCode(...bytes));
      this.ctx.storage.sql.exec("INSERT INTO config (key, value) VALUES ('session_secret', ?)", secret);
    }
    return { config, sessionSecret: secret };
  }

  /**
   * Record a SITE (scope) at provision — the vertical's own memory of its sites (K-26
   * multi-scope), used to enumerate and switch between them without reaching the control-plane
   * directory. Idempotent: a re-provision (K-31) updates the slug/name but keeps `created_at`,
   * so the switcher's ordering is stable.
   */
  async recordSite(scopeId: string, slug: string, name: string): Promise<void> {
    recordSiteRow(this.registrySql, scopeId, slug, name);
  }

  /** Drop a site from the registry (the vertical's half of archiving it). Idempotent. */
  async forgetSite(scopeId: string): Promise<void> {
    forgetSiteRow(this.registrySql, scopeId);
  }

  /** The tenant's sites, oldest first — the in-app site switcher's list. */
  async listSites(): Promise<SiteRow[]> {
    return listSiteRows(this.registrySql);
  }

  /**
   * Resolve a site SLUG to its scope id within this tenant — how the worker turns the app's
   * `x-site` selection into the scope to open. Null ⇒ no such site (the caller falls back to the
   * routed home scope). Tenant-scoped by construction: this DO is per-tenant, so a slug can only
   * ever resolve to a scope of THIS tenant.
   */
  async resolveSiteScope(slug: string): Promise<string | null> {
    return resolveSiteScopeRow(this.registrySql, slug);
  }

  /** The DO's SQLite as the registry's minimal `exec` seam (see site-registry.ts). */
  private get registrySql(): RegistrySql {
    return this.ctx.storage.sql as unknown as RegistrySql;
  }

  /**
   * Record the owner seat at provision (#925): the transient `pending_owner`, bounded by the
   * first-sign-in window, and the durable `owner_of_record` (#332). Idempotent the way the
   * platform needs — a re-run (reconcile, retry) keeps the seat's existing window and never
   * re-opens a seat already claimed.
   */
  async setPendingOwner(scopeId: string, principal: string): Promise<void> {
    recordOwnerSeat(this.registrySql, scopeId, principal, Date.now());
  }

  /**
   * The scope's durable owner of record, or null if this scope was never provisioned through this
   * DO (a legacy scope predating #332, or a slug typo). Read by the reconcile path to re-grant the
   * owner their role after a scope-DO wipe left the scope enforcing against an empty tuple table.
   */
  async getOwnerOfRecord(scopeId: string): Promise<string | null> {
    return ownerOfRecordRow(this.registrySql, scopeId);
  }

  /**
   * Is this scope awaiting first-run setup? True while its owner seat is unclaimed — whether or
   * not a plain first sign-in can still claim it (`ownerSeat` says which). The worker uses this
   * to answer `needs-setup` instead of a bare 401, so the SPA can say what to do.
   */
  async needsSetup(scopeId: string): Promise<boolean> {
    return needsSetupRow(this.registrySql, scopeId);
  }

  /** The seat as the platform sees it: claimed / unclaimed (window open or closed, link live or not) / unknown. */
  async ownerSeat(scopeId: string): Promise<OwnerSeat> {
    return ownerSeatRow(this.registrySql, scopeId, Date.now());
  }

  /**
   * Map a verified subject to a PrincipalId in this scope. If already bound, return it. If
   * not, and the scope's owner seat is unclaimed with its first-sign-in window still open,
   * CLAIM it. Otherwise null — a valid login with no seat has no access, and after the
   * window the seat is reached by claim link only. Provider-agnostic: the subject may come
   * from Better Auth or an OIDC issuer.
   */
  async resolvePrincipal(scopeId: string, sub: string): Promise<string | null> {
    return resolvePrincipalRow(this.registrySql, scopeId, sub, Date.now());
  }

  /**
   * Mint a claim link for an unclaimed seat: the platform asks for this under its secret and
   * the dashboard hands the installer the link. Only `tokenHash` reaches the DO; a new mint
   * replaces the previous link. Null ⇒ the seat is already claimed (nothing to mint).
   */
  async mintOwnerClaim(scopeId: string, tokenHash: string): Promise<{ expiresAt: string } | null> {
    return mintOwnerClaimRow(this.registrySql, scopeId, tokenHash, Date.now());
  }

  /**
   * Claim the seat by link: bind this verified subject to the owner principal if the token's
   * hash matches the live claim. Consumes the seat and the link. Null ⇒ invalid or expired.
   */
  async claimOwner(scopeId: string, sub: string, tokenHash: string): Promise<string | null> {
    return claimOwnerRow(this.registrySql, scopeId, sub, tokenHash, Date.now());
  }

  /**
   * Record a member invite: a pre-minted `principal` + `roleKey` the caller has already
   * granted at scope level, claimable by whoever presents the token whose hash is `tokenHash`.
   * The plaintext token never reaches the DO — only its hash, so a DB read can't mint access.
   */
  async createInvite(scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT INTO invite (token_hash, scope_id, principal, role_key, email) VALUES (?, ?, ?, ?, ?)',
      tokenHash, scopeId, principal, roleKey, email,
    );
  }

  /** The scope's outstanding (unclaimed) invites — for the admin's pending-invites list. No token. */
  async listInvites(scopeId: string): Promise<Array<{ principal: string; roleKey: string; email: string | null; createdAt: number }>> {
    return [...this.ctx.storage.sql.exec(
      'SELECT principal, role_key, email, created_at FROM invite WHERE scope_id = ? AND claimed = 0 ORDER BY created_at DESC',
      scopeId,
    )].map((r) => ({ principal: r.principal as string, roleKey: r.role_key as string, email: (r.email as string | null) ?? null, createdAt: r.created_at as number }));
  }

  /** Is there an unclaimed invite for this token hash? (the sign-up gate consults this post-setup). */
  async inviteExists(scopeId: string, tokenHash: string): Promise<boolean> {
    const r = [...this.ctx.storage.sql.exec('SELECT 1 FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0', scopeId, tokenHash)][0];
    return r !== undefined;
  }

  /** Withdraw an unclaimed invite by its (pre-minted) principal — the id the admin sees. */
  async revokeInvite(scopeId: string, principal: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0', scopeId, principal);
  }

  /**
   * Claim an invite: bind this verified subject to the invite's pre-minted principal and
   * consume the invite. Returns the principal, or null if no unclaimed invite matches the
   * token hash. The role was granted at scope level when the invite was created, so the
   * bound principal resolves its permissions immediately.
   */
  async claimInvite(scopeId: string, sub: string, tokenHash: string): Promise<string | null> {
    const inv = [...this.ctx.storage.sql.exec('SELECT principal FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0', scopeId, tokenHash)][0] as
      | { principal: string }
      | undefined;
    if (!inv) return null;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scopeId, sub, inv.principal);
    this.ctx.storage.sql.exec('UPDATE invite SET claimed = 1 WHERE scope_id = ? AND token_hash = ?', scopeId, tokenHash);
    return inv.principal;
  }

  /** A Better Auth instance over THIS DO's SQLite, trusting the caller's origin. */
  private auth(origin: string, cookieDomain?: string | null) {
    const db = drizzle(this.ctx.storage, { schema });
    return betterAuth({
      database: drizzleAdapter(db, { provider: 'sqlite', schema }),
      emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
      // Per-tenant, generated + persisted in THIS DO (see the constructor) — never shared.
      secret: this.authSecret,
      baseURL: origin,
      trustedOrigins: [origin],
      // Shared login across a scope's surfaces (crm.…, eka.… — one parent domain): the
      // session cookie rides `Domain=…` instead of host-only. Verified everywhere already
      // (one per-tenant secret, this DO); the attribute is the only thing that was missing.
      ...(cookieDomain
        ? { advanced: { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } }
        : {}),
    });
  }

  /**
   * The DO's HTTP surface (used only when Better Auth is the chosen provider). `/__session`
   * resolves the request to an `AuthSubject`; everything else is a Better Auth request. The
   * worker forwards requests here; Better Auth never runs in the worker.
   *
   * `x-substrat-cookie-domain` is the worker relaying the scope's delivered `substrat:auth`
   * cookie-domain choice (the DO can't look it up itself — this fetch carries no scope id).
   * The stub is reachable only from the worker, so the header is as trusted as the config;
   * it is still re-validated against the request host before it touches a Set-Cookie.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const cookieDomain = resolveCookieDomain(
      request.headers.get('x-substrat-cookie-domain') ?? undefined,
      url.hostname,
    );
    const auth = this.auth(url.origin, cookieDomain);
    if (url.pathname === '/__session') {
      const session = await auth.api.getSession({ headers: request.headers });
      const subject: AuthSubject | null = session?.user
        ? { sub: session.user.id, email: session.user.email ?? null, name: session.user.name ?? null }
        : null;
      return Response.json(subject);
    }
    return auth.handler(request);
  }
}

/** A minimal stub shape — the identity DO's callable surface (avoids leaking the full class type). */
export type IdentityStub = {
  fetch(request: Request): Promise<Response>;
  setScopeConfig(scopeId: string, entries: Array<{ key: string; value: string }>): Promise<void>;
  getScopeConfig(scopeId: string): Promise<Record<string, string>>;
  authWiring(scopeId: string): Promise<{ config: Record<string, string>; sessionSecret: string }>;
  setPendingOwner(scopeId: string, principal: string): Promise<void>;
  getOwnerOfRecord(scopeId: string): Promise<string | null>;
  needsSetup(scopeId: string): Promise<boolean>;
  ownerSeat(scopeId: string): Promise<OwnerSeat>;
  resolvePrincipal(scopeId: string, sub: string): Promise<string | null>;
  mintOwnerClaim(scopeId: string, tokenHash: string): Promise<{ expiresAt: string } | null>;
  claimOwner(scopeId: string, sub: string, tokenHash: string): Promise<string | null>;
  createInvite(scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string): Promise<void>;
  listInvites(scopeId: string): Promise<Array<{ principal: string; roleKey: string; email: string | null; createdAt: number }>>;
  inviteExists(scopeId: string, tokenHash: string): Promise<boolean>;
  revokeInvite(scopeId: string, principal: string): Promise<void>;
  claimInvite(scopeId: string, sub: string, tokenHash: string): Promise<string | null>;
};

/**
 * The `AuthProvider` backed by a tenant's identity-DO stub (the `better-auth-do` config).
 * `handle` forwards the raw request; `resolve` asks the DO's `/__session` probe, carrying
 * the request's cookies. The worker holds only this — never Better Auth itself.
 *
 * `cookieDomain` (the scope's delivered `substrat:auth` choice) rides to the DO as a
 * header because the worker holds the config and the DO holds Better Auth — see fetch().
 */
export function doAuthProvider(
  stub: Pick<IdentityStub, 'fetch'>,
  origin: string,
  opts?: { cookieDomain?: string },
): AuthProvider {
  const forward = (request: Request): Request => {
    if (!opts?.cookieDomain) return request;
    const relayed = new Request(request);
    relayed.headers.set('x-substrat-cookie-domain', opts.cookieDomain);
    return relayed;
  };
  return {
    handle: (request) => stub.fetch(forward(request)),
    async resolve(headers) {
      const res = await stub.fetch(new Request(`${origin}/__session`, { headers }));
      return (await res.json()) as AuthSubject | null;
    },
  };
}
