import { DurableObject } from 'cloudflare:workers';
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
  ownerClaimTarget as ownerClaimTargetRow,
  recordOwnerClaim as recordOwnerClaimRow,
  ownerClaimMatches as ownerClaimMatchesRow,
  claimOwnerByCapability as claimOwnerByCapabilityRow,
  type OwnerClaimLinkRow,
  unbindSubject as unbindSubjectRow,
  unbindPrincipal as unbindPrincipalRow,
  subjectsOf as subjectsOfRows,
  transferOwner as transferOwnerRow,
  completeOwnerTransfer as completeOwnerTransferRow,
  abandonOwnerTransfer as abandonOwnerTransferRow,
  type OwnerSeat,
  type OwnerTransfer,
  type OwnerTransferAbandon,
} from './owner-seat.js';
import {
  INVITE_DDL,
  createInvite as createInviteRow,
  listInvites as listInviteRows,
  getInvite as getInviteRow,
  inviteExists as inviteExistsRow,
  revokeInvite as revokeInviteRow,
  claimInvite as claimInviteRow,
  claimInviteByCapability as claimInviteByCapabilityRow,
  inviteMatches as inviteMatchesRow,
  countLegacyInvites as countLegacyInvitesRow,
  inviteLink as inviteLinkRow,
  migrateInvites,
  listMemberBindings as listMemberBindingRows,
  type InviteRow,
  type MemberBinding,
} from './member-directory.js';
export type { InviteRow, MemberBinding } from './member-directory.js';

/**
 * Per-tenant identity directory and configuration store. Authentication belongs to
 * the configured OIDC issuer; this DO maps verified subjects to scope principals
 * and retains ownership, invites, sites, and the relying party's session secret.
 */
const SCHEMA_STATEMENTS: string[] = [
  // The PROVIDER-AGNOSTIC identity directory (`identity`: a verified `sub` → the Substrat
  // PrincipalId it maps to, per scope — K-22, the same login is a different principal in each
  // scope, independent of WHICH provider verified it) and the OWNER SEAT around it —
  // `pending_owner` (claimed and consumed), `owner_of_record` (#332, never consumed: the
  // vertical's own durable memory of the owner, in this per-tenant DO rather than the scope's
  // data DO, so it survives a scope-DO wipe and a reconcile can re-grant from it) and
  // `owner_claim_capability` (which `become` capability is the current claim link, #1686). The tables and
  // the rules over them live in `owner-seat.ts` so they are unit-tested without a DO; the
  // methods below delegate there.
  ...OWNER_SEAT_DDL,
  // Outstanding member invites (the post-setup join path) — the table and its rows are in
  // `member-directory.ts`, tested there without a DO.
  ...INVITE_DDL,
  // This DO's own config, including the OIDC session-signing secret.
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

// The OIDC session secret is generated per tenant and kept in this DO's storage.
export type IdentityDoEnv = Record<string, never>;

export class IdentityDO extends DurableObject<IdentityDoEnv> {
  constructor(ctx: DurableObjectState, env: IdentityDoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA_STATEMENTS) ctx.storage.sql.exec(stmt);
      // Columns the DDL cannot add to a table that already exists (#925's `claim_until`,
      // #1686's `invite.capability_id`).
      migrateOwnerSeat(ctx.storage.sql as unknown as RegistrySql);
      migrateInvites(ctx.storage.sql as unknown as RegistrySql);
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

  /** Remove a reaped scope's delivered settings from this tenant's shared directory. */
  async deleteScopeConfig(scopeId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM scope_config WHERE scope_id = ?', scopeId);
  }

  /**
   * Everything the worker needs to build the scope's `AuthProvider`, in ONE round-trip:
   * the scope's delivered config (notably `substrat:auth`) plus this tenant's
   * session-signing secret (minted here on first use, never a worker binding). One method rather than two keeps the
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
   * Hand the owner of record from `from` to `to` (#1665): the principal a reconcile's lockout
   * repair re-seats. Moves the record only, and refuses (writing nothing) on an unclaimed seat,
   * a stale `from`, or a `to` no subject is bound to. `owner-seat.ts` has the rules; the
   * seat-then-revoke around it is vertical-host's `/internal/owner-transfer`.
   */
  async transferOwner(scopeId: string, from: string, to: string, toHoldsRole: boolean): Promise<OwnerTransfer> {
    return transferOwnerRow(this.registrySql, scopeId, from, to, toHoldsRole);
  }

  /** Close the hand-over `from → to` once the platform has seated and revoked around it (#1665). */
  async completeOwnerTransfer(scopeId: string, from: string, to: string): Promise<boolean> {
    return completeOwnerTransferRow(this.registrySql, scopeId, from, to);
  }

  /** Abandon the open hand-over `from → to`, writing no seat or revoke (#1665). */
  async abandonOwnerTransfer(scopeId: string, from: string, to: string, toHoldsRole: boolean): Promise<OwnerTransferAbandon> {
    return abandonOwnerTransferRow(this.registrySql, scopeId, from, to, toHoldsRole);
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
   * window the seat is reached by claim link only. The subject is verified by the configured OIDC issuer.
   */
  async resolvePrincipal(scopeId: string, sub: string): Promise<string | null> {
    return resolvePrincipalRow(this.registrySql, scopeId, sub, Date.now());
  }

  /**
   * The principal a claim link would bind — the pending owner — or null when the seat is not
   * pending (#1686). What a mint reads before asking the scope for a `become` capability.
   */
  async ownerClaimTarget(scopeId: string): Promise<string | null> {
    return ownerClaimTargetRow(this.registrySql, scopeId);
  }

  /**
   * Record a minted `become` capability as the scope's one claim link (#1686), replacing the
   * previous link. Returns the previous capability id for the caller to revoke; null (nothing
   * written) when the seat is no longer pending for `principal`.
   */
  async recordOwnerClaim(scopeId: string, principal: string, link: OwnerClaimLinkRow): Promise<{ previous: string | null } | null> {
    return recordOwnerClaimRow(this.registrySql, scopeId, principal, link);
  }

  /** Is `tokenHash` the scope's live claim link? Asked before an exchange spends a use (#1686). */
  async ownerClaimMatches(scopeId: string, tokenHash: string): Promise<boolean> {
    return ownerClaimMatchesRow(this.registrySql, scopeId, tokenHash, Date.now());
  }

  /**
   * Claim the seat with an exchanged claim-link capability (#1686): binds the subject when the
   * capability is the recorded live link and names the pending owner. Null otherwise.
   */
  async claimOwnerByCapability(scopeId: string, sub: string, capabilityId: string, principal: string): Promise<string | null> {
    return claimOwnerByCapabilityRow(this.registrySql, scopeId, sub, capabilityId, principal, Date.now());
  }

  /**
   * Record a member invite: a pre-minted `principal` + `roleKey` the caller has already
   * granted at scope level, whose link is the `become` capability `capabilityId` and whose
   * secret hashes to `tokenHash`. The plaintext token never reaches the DO — only its hash, so a
   * DB read can't mint access. A missing capability id is refused (#2496): no hash-only row.
   */
  async createInvite(
    scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string, capabilityId: string,
  ): Promise<void> {
    createInviteRow(this.registrySql, scopeId, principal, roleKey, email, tokenHash, capabilityId);
  }

  /** The scope's outstanding (unclaimed) invites — for the admin's pending-invites list. No token. */
  async listInvites(scopeId: string): Promise<InviteRow[]> {
    return listInviteRows(this.registrySql, scopeId);
  }

  /**
   * One outstanding (unclaimed) invite by its pre-minted principal, or null (#1931). What the
   * revoke route reads first: the role an invite confers is the role its removal is bounded by.
   */
  async getInvite(scopeId: string, principal: string): Promise<InviteRow | null> {
    return getInviteRow(this.registrySql, scopeId, principal);
  }

  /** Pending legacy hash-only invites at a scope (#2175) — a count, nothing identifying. */
  async legacyInviteCount(scopeId: string): Promise<number> {
    return countLegacyInvitesRow(this.registrySql, scopeId);
  }

  /** Is there an unclaimed invite for this token hash? (the sign-up gate consults this post-setup). */
  async inviteExists(scopeId: string, tokenHash: string): Promise<boolean> {
    return inviteExistsRow(this.registrySql, scopeId, tokenHash);
  }

  /** Withdraw an unclaimed invite by its (pre-minted) principal — the id the admin sees. */
  async revokeInvite(scopeId: string, principal: string): Promise<string | null> {
    return revokeInviteRow(this.registrySql, scopeId, principal);
  }

  /**
   * Claim an invite: bind this verified subject to the invite's pre-minted principal and
   * consume the invite. Returns the principal, or null if no unclaimed invite matches the
   * token hash. The role was granted at scope level when the invite was created, so the
   * bound principal resolves its permissions immediately.
   */
  async claimInvite(scopeId: string, sub: string, tokenHash: string): Promise<string | null> {
    return claimInviteRow(this.registrySql, scopeId, sub, tokenHash);
  }

  /** The `become` capability an open invite's link is (#1686), or null — what a withdrawal revokes first. */
  async inviteLink(scopeId: string, principal: string): Promise<string | null> {
    return inviteLinkRow(this.registrySql, scopeId, principal);
  }

  /** Is this hash an open capability-era invite (#1686)? Asked before the scope spends its use. */
  async inviteMatches(scopeId: string, tokenHash: string): Promise<boolean> {
    return inviteMatchesRow(this.registrySql, scopeId, tokenHash);
  }

  /** Accept an invite with an exchanged `become` capability (#1686) — `claimInviteByCapability`. */
  async claimInviteByCapability(scopeId: string, sub: string, capabilityId: string, principal: string): Promise<string | null> {
    return claimInviteByCapabilityRow(this.registrySql, scopeId, sub, capabilityId, principal);
  }

  /**
   * Unbind a subject from this scope — the removal half of the directory (#1670). True when a
   * binding was there. `unbindMember` in `places.ts` pairs it with telling the identity pool.
   */
  async unbind(scopeId: string, sub: string): Promise<boolean> {
    return unbindSubjectRow(this.registrySql, scopeId, sub);
  }

  /** Remove all of a principal's bindings in this scope, returning their subjects so the
   * caller can report each absent place. A removal cannot miss a login behind a scan cap. */
  async unbindPrincipal(scopeId: string, principal: string): Promise<string[]> {
    return unbindPrincipalRow(this.registrySql, scopeId, principal);
  }

  /** The subjects bound in this scope, at most `limit` — the whole set a places repair sends. */
  async subjectsOf(scopeId: string, limit: number): Promise<string[]> {
    return subjectsOfRows(this.registrySql, scopeId, limit);
  }

  /**
   * Who this directory knows at the scope, by principal (#1150): how many subjects are bound to
   * each, and the address an invite to it named — the identity half of the dashboard's member
   * roster. The role half is the scope's own (`listScopeRoleHolders`). One scope, never a walk.
   */
  async listMemberBindings(scopeId: string): Promise<MemberBinding[]> {
    return listMemberBindingRows(this.registrySql, scopeId);
  }
}

/** A minimal stub shape — the identity DO's callable surface (avoids leaking the full class type). */
export type IdentityStub = {
  setScopeConfig(scopeId: string, entries: Array<{ key: string; value: string }>): Promise<void>;
  getScopeConfig(scopeId: string): Promise<Record<string, string>>;
  deleteScopeConfig(scopeId: string): Promise<void>;
  authWiring(scopeId: string): Promise<{ config: Record<string, string>; sessionSecret: string }>;
  recordSite(scopeId: string, slug: string, name: string): Promise<void>;
  forgetSite(scopeId: string): Promise<void>;
  listSites(): Promise<SiteRow[]>;
  resolveSiteScope(slug: string): Promise<string | null>;
  setPendingOwner(scopeId: string, principal: string): Promise<void>;
  getOwnerOfRecord(scopeId: string): Promise<string | null>;
  transferOwner(scopeId: string, from: string, to: string, toHoldsRole: boolean): Promise<OwnerTransfer>;
  completeOwnerTransfer(scopeId: string, from: string, to: string): Promise<boolean>;
  abandonOwnerTransfer(scopeId: string, from: string, to: string, toHoldsRole: boolean): Promise<OwnerTransferAbandon>;
  needsSetup(scopeId: string): Promise<boolean>;
  ownerSeat(scopeId: string): Promise<OwnerSeat>;
  resolvePrincipal(scopeId: string, sub: string): Promise<string | null>;
  ownerClaimTarget(scopeId: string): Promise<string | null>;
  recordOwnerClaim(scopeId: string, principal: string, link: OwnerClaimLinkRow): Promise<{ previous: string | null } | null>;
  ownerClaimMatches(scopeId: string, tokenHash: string): Promise<boolean>;
  claimOwnerByCapability(scopeId: string, sub: string, capabilityId: string, principal: string): Promise<string | null>;
  createInvite(
    scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string, capabilityId: string,
  ): Promise<void>;
  listInvites(scopeId: string): Promise<InviteRow[]>;
  getInvite(scopeId: string, principal: string): Promise<InviteRow | null>;
  legacyInviteCount(scopeId: string): Promise<number>;
  inviteExists(scopeId: string, tokenHash: string): Promise<boolean>;
  revokeInvite(scopeId: string, principal: string): Promise<string | null>;
  claimInvite(scopeId: string, sub: string, tokenHash: string): Promise<string | null>;
  inviteMatches(scopeId: string, tokenHash: string): Promise<boolean>;
  inviteLink(scopeId: string, principal: string): Promise<string | null>;
  claimInviteByCapability(scopeId: string, sub: string, capabilityId: string, principal: string): Promise<string | null>;
  unbind(scopeId: string, sub: string): Promise<boolean>;
  unbindPrincipal(scopeId: string, principal: string): Promise<string[]>;
  subjectsOf(scopeId: string, limit: number): Promise<string[]>;
  listMemberBindings(scopeId: string): Promise<MemberBinding[]>;
};

// Drift pin (#1802): every public IdentityDO method must be on IdentityStub, with the class's
// own signature. Fails typecheck when the stub lacks or mistypes one, or when the class gains a
// public method the stub omits. Type-only — erased at build.
type _StubCarriesClass = IdentityDO extends IdentityStub ? true : never;
type _ClassMethodsMissingFromStub = Exclude<keyof IdentityDO, keyof DurableObject | keyof IdentityStub>;
export const _identityStubPin: [_StubCarriesClass, _ClassMethodsMissingFromStub] extends [true, never] ? true : never = true;
