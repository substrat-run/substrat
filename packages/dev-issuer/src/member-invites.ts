/**
 * Member invites for a vertical's local dev server (K-61 phase 3) — the half of the worker door a
 * dev server has no Durable Object for, so that a person invited locally gets in locally.
 *
 * Hosted, an invite is filed in the tenant's identity directory and the door admits the person it
 * names by the address their issuer verified. A dev server binds people through the host's identity
 * pool instead (`linkIdentity`, which the seed uses for the cast), and has no identity directory,
 * so `devLogin` answered nobody for anyone outside the seeded cast and an invitee could never reach
 * the join. This keeps the same invite rows in a SQLite file of the dev server's own, through
 * vertical-auth's member directory, mounts the same routes the worker door mounts
 * (`mountMemberInvites`), and admits by the same steps (`admitByAddress`): the open invite naming
 * the verified address, its link exchanged by id in the scope, then the subject linked in the pool.
 *
 * Unlike the door it is not told the scope: a local subject with no link has none yet. It looks in
 * every scope the file holds an open invite for, which is a handful, and only on a dev server.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  CapabilityExchange,
  CapabilityId,
  PlatformActorId,
  PrincipalId,
  ScopeId,
  TenantId,
} from '@substrat-run/contracts';
import type { DevLogin } from './harness.js';
import {
  admitByAddress,
  mountMemberInvites,
  type MemberInviteHost,
  type MemberInviteRouteDeps,
  type MemberInvites,
} from '@substrat-run/vertical-auth/invite-routes';
import {
  MEMBER_DIRECTORY_DDL,
  admitInvite,
  createInvite,
  getInvite,
  inviteLink,
  migrateInvites,
  migrateOwnerSeat,
  openInviteFor,
  revokeInvite,
  unbindPrincipal,
  type RegistrySql,
} from '@substrat-run/vertical-auth/member-directory';

/** The slice of a better-sqlite3 `Database` this reads — structural, so this package needs no driver. */
export interface DevSqliteDatabase {
  prepare(sql: string): { reader: boolean; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): unknown;
}

/** What it needs of the dev server's host: the member invite verbs, the exchange by id, and the pool. */
export interface DevInviteHost extends MemberInviteHost {
  exchangeBecomeLinkById(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId): Promise<CapabilityExchange | null>;
  admin: {
    linkIdentity(
      actor: PlatformActorId,
      input: { provider: string; externalId: string; principal: PrincipalId; tenantId: TenantId; scopeId?: ScopeId },
    ): Promise<void>;
    unlinkIdentity(actor: PlatformActorId, tenantId: TenantId, principal: PrincipalId): Promise<void>;
  };
}

export interface DevMemberInvitesOptions {
  /** A SQLite database of the dev server's own: `new Database(join(dataDir, 'members.sqlite'))`. */
  db: DevSqliteDatabase;
  /** Usually the `SqliteScopeHost` the dev server runs on. */
  host: DevInviteHost;
  /** The local platform actor the pool writes are stamped with — the one `devLogin` is given. */
  actor: PlatformActorId;
  /** The identity pool `devLogin` reads (e.g. `oidc:dev-issuer`). */
  provider: string;
}

/** Where an admitted subject now lives — what `devLogin`'s `admit` answers. */
export interface DevAdmission {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
}

/** The routed caller a dev server's `signedIn` answers, as the worker door's does. */
type SignedIn<E extends object> = Awaited<ReturnType<MemberInviteRouteDeps<E, { tenantId: TenantId; scopeId: ScopeId }>['signedIn']>>;

export interface DevMemberInvites {
  /** For `devLogin({ admit })`: bind a subject no link names yet, by an invite naming their verified address. */
  admit(sub: string, verifiedEmail: string | null): Promise<DevAdmission | null>;
  /**
   * Mount `/api/member-invites` and its withdrawal: the caller is `login`'s, their stub the dev
   * server's own (the one its routes are handed), and `invites` the vertical's operations, named
   * as in the worker's `workerDoor({ invites })`.
   */
  mount<E extends object>(
    app: Hono<{ Bindings: E }>,
    deps: {
      login: Pick<DevLogin, 'caller'>;
      scope: (c: Context<{ Bindings: E }>) => Promise<SignedIn<E>['scope']>;
      invites: MemberInvites;
    },
  ): void;
}

function registrySqlOver(db: DevSqliteDatabase): RegistrySql {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  };
}

export function devMemberInvites(opts: DevMemberInvitesOptions): DevMemberInvites {
  const sql = registrySqlOver(opts.db);
  for (const stmt of MEMBER_DIRECTORY_DDL) opts.db.exec(stmt);
  migrateOwnerSeat(sql);
  migrateInvites(sql);
  // The tenant each scope's invites belong to: the hosted directory is the tenant's own and needs
  // no column for it, but this one file serves every tenant the dev server runs.
  opts.db.exec('CREATE TABLE IF NOT EXISTS dev_invite_tenant (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)');

  const tenantOf = (scopeId: string): TenantId | null =>
    (([...sql.exec('SELECT tenant_id FROM dev_invite_tenant WHERE scope_id = ?', scopeId)][0]?.tenant_id as TenantId | undefined) ?? null);

  return {
    async admit(sub, verifiedEmail) {
      if (verifiedEmail === null) return null;
      const scopes = [...sql.exec(
        'SELECT DISTINCT scope_id FROM invite WHERE claimed = 0 AND capability_id IS NOT NULL AND email IS NOT NULL',
      )];
      for (const { scope_id } of scopes) {
        const scopeId = scope_id as ScopeId;
        const tenantId = tenantOf(scopeId);
        if (!tenantId) continue;
        const principal = await admitByAddress(
          {
            directory: {
              openInviteFor: async (scope, email) => openInviteFor(sql, scope, email),
              admitInvite: async (scope, subject, capabilityId, invited) => admitInvite(sql, scope, subject, capabilityId, invited),
            },
            exchangeById: (id) => opts.host.exchangeBecomeLinkById(tenantId, scopeId, id),
          },
          scopeId,
          sub,
          verifiedEmail,
        );
        if (!principal) continue;
        const admitted = principal as PrincipalId;
        await opts.host.admin.linkIdentity(opts.actor, { provider: opts.provider, externalId: sub, principal: admitted, tenantId, scopeId });
        return { principal: admitted, tenantId, scopeId };
      }
      return null;
    },

    mount(app, deps) {
      mountMemberInvites(app, {
        signedIn: async (c) => {
          const caller = await deps.login.caller(c.req.raw.headers);
          if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
          return { node: { tenantId: caller.tenantId, scopeId: caller.scopeId }, principal: caller.principal, scope: await deps.scope(c) };
        },
        directory: (_env, node) => ({
          createInvite: async (scopeId, principal, roleKey, email, tokenHash, capabilityId) => {
            sql.exec('INSERT OR REPLACE INTO dev_invite_tenant (scope_id, tenant_id) VALUES (?, ?)', scopeId, node.tenantId);
            createInvite(sql, scopeId, principal, roleKey, email, tokenHash, capabilityId);
          },
          getInvite: async (scopeId, principal) => getInvite(sql, scopeId, principal),
          inviteLink: async (scopeId, principal) => inviteLink(sql, scopeId, principal),
          revokeInvite: async (scopeId, principal) => revokeInvite(sql, scopeId, principal),
          // The pool is where a local login lives, so a withdrawal unlinks there too.
          unbindPrincipal: async (scopeId, principal) => {
            const subjects = unbindPrincipal(sql, scopeId, principal);
            await opts.host.admin.unlinkIdentity(opts.actor, node.tenantId, principal as PrincipalId);
            return subjects;
          },
        }),
        host: () => opts.host,
        invites: deps.invites,
      });
    },
  };
}
