/**
 * People owned by another app, for a DEPENDENT vertical's local dev server: the person
 * contract's door (`@substrat-run/vertical-auth/people`) over the pieces a dev server has.
 *
 * A dependent vertical, a plugin of another app, has no cast of its own and no invitations.
 * Whoever signs in is asked about at the app that owns the people, and let in as the person it
 * names. Hosted, that question is a peer call and the answer is kept in the tenant's identity
 * directory. Here the dev server passes the call in (the local broker's, usually), and the
 * answers are kept in a SQLite file of its own, as `devMemberInvites` keeps its invites.
 *
 * It replaces `devLogin`'s `caller` for such a vertical rather than extending it: that one asks
 * the pool which tenant a login lives in, and a dependent's login lives wherever the other app
 * says. The dev server serves ONE scope of the dependent, and names it.
 *
 * The same door takes a call the other app makes AS a person (#3161): `delegated` reads the token
 * the local broker carried, and admits the person it names exactly as their own sign-in would be.
 */
import type { PersonResolveInput, PlatformActorId, PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { AuthSubject } from '@substrat-run/vertical-auth/provider';
import { verifiedEmailOf } from '@substrat-run/vertical-auth/oidc-rp-provider';
import {
  PEOPLE_DDL,
  admitDelegated,
  admitPerson,
  sqlPeopleStore,
  type DelegatedRefusal,
  type PeopleDeps,
  type PersonRefusal,
} from '@substrat-run/vertical-auth/people';
import type { DevCaller, DevLogin } from './harness.js';
import type { DevSqliteDatabase } from './member-invites.js';

/** What it needs of the dev server's host: the pool link and the two role verbs. */
export interface DevPeopleHost {
  admin: {
    linkIdentity(
      actor: PlatformActorId,
      input: { provider: string; externalId: string; principal: PrincipalId; tenantId: TenantId; scopeId?: ScopeId },
    ): Promise<void>;
    assignRole(
      actor: PlatformActorId,
      assignment: { principalId: PrincipalId; roleKey: string; node: { tenantId: TenantId; scopeId: ScopeId | null } },
    ): Promise<void>;
    unassignRole(
      actor: PlatformActorId,
      assignment: { principalId: PrincipalId; roleKey: string; node: { tenantId: TenantId; scopeId: ScopeId | null } },
    ): Promise<void>;
  };
}

export interface DevPeopleOptions {
  /**
   * `devLogin(…)`: the relying party. Its verified subject is read, and `resolveOnBehalf` for a
   * call made for a person; without it, `delegated` refuses every token.
   */
  login: Pick<DevLogin, 'subject' | 'issuer'> & Partial<Pick<DevLogin, 'resolveOnBehalf'>>;
  /**
   * The registry slug of the app this vertical takes its people from (#3161): the only caller
   * whose calls made for a person `delegated` takes. Absent, it takes none.
   */
  master?: string;
  /** A SQLite database of the dev server's own: `new Database(join(dataDir, 'people.sqlite'))`. */
  db: DevSqliteDatabase;
  /** Usually the `SqliteScopeHost` the dev server runs on. */
  host: DevPeopleHost;
  /** The local platform actor the pool and role writes are stamped with. */
  actor: PlatformActorId;
  /** The identity pool the logins belong to (e.g. `oidc:dev-issuer`). */
  provider: string;
  /** The one scope of this vertical the dev server serves. */
  node: { tenantId: TenantId; scopeId: ScopeId };
  /** The other app's resolve operation: `(login) => peer.invoke('todo', 'todo/resolve-person', login)`. */
  resolve: (login: PersonResolveInput) => Promise<unknown>;
  /** The other app's role keys mapped onto this vertical's own. */
  roles: (masterRoles: readonly string[]) => readonly string[];
  /** How long an answer is kept. Defaults to the door's own. */
  ttlSeconds?: number;
  /** The door's clock. A test hands one in to move time; a dev server leaves it out. */
  now?: () => Date;
}

export interface DevPeople {
  /**
   * The caller behind this request: null when nobody is signed in, the refusal when the other
   * app does not let this login in (or did not answer), the caller otherwise.
   */
  caller(headers: Headers): Promise<{ caller: DevCaller } | { refused: PersonRefusal } | null>;
  /**
   * Who a peer call made for a person is (#3161): `token` is what the call's `onBehalf` carried,
   * `callerVertical` the vertical the broker says is calling. The person is admitted as their own
   * sign-in would be; `scope` is the ceiling the caller applies to this one call, and is written
   * nowhere. `not-master` for any caller but `master`, `token-refused` for a token that does not
   * verify as a `peer` delegation for this client.
   */
  delegated(call: { token: string; callerVertical: string }): Promise<
    { caller: DevCaller; scope: string[]; actor: string } | { refused: DelegatedRefusal }
  >;
}

export function devPeople(opts: DevPeopleOptions): DevPeople {
  for (const stmt of PEOPLE_DDL) opts.db.exec(stmt);
  const store = sqlPeopleStore({
    exec(query, ...params) {
      const stmt = opts.db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  });
  const { tenantId, scopeId } = opts.node;
  const deps: PeopleDeps = {
    resolve: opts.resolve,
    store,
    roles: opts.roles,
    bind: (sub, principal) =>
      opts.host.admin.linkIdentity(opts.actor, { provider: opts.provider, externalId: sub, principal, tenantId, scopeId }),
    seat: async (principalId, { add, remove }) => {
      const node = { tenantId, scopeId };
      for (const roleKey of remove) await opts.host.admin.unassignRole(opts.actor, { principalId, roleKey, node });
      for (const roleKey of add) await opts.host.admin.assignRole(opts.actor, { principalId, roleKey, node });
    },
    now: opts.now ?? (() => new Date()),
    ...(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds }),
    onUnavailable: (error) =>
      console.warn(`dev-issuer: the app that owns the people did not answer: ${error instanceof Error ? error.message : String(error)}`),
  };

  return {
    async caller(headers) {
      const subject = await opts.login.subject(headers);
      if (!subject) return null;
      const verifiedEmail = verifiedEmailOf(subject);
      const answer = await admitPerson(deps, scopeId, { issuer: opts.login.issuer, sub: subject.sub, verifiedEmail });
      if (!answer.admitted) return { refused: answer.reason };
      return {
        caller: {
          principal: answer.principal,
          tenantId,
          scopeId,
          sub: subject.sub,
          display: subject.name ?? subject.email ?? subject.sub,
          email: subject.email,
          verifiedEmail,
        },
      };
    },

    async delegated(call) {
      if (opts.master === undefined) return { refused: 'not-master' };
      const verify = opts.login.resolveOnBehalf;
      // The verified subject, kept for the caller's name and address.
      const seen: { subject?: AuthSubject | null } = {};
      const answer = await admitDelegated(deps, scopeId, call, {
        master: opts.master,
        issuer: opts.login.issuer,
        verify: async (token) => (seen.subject = verify ? await verify(token) : null),
      });
      if (!answer.admitted) return { refused: answer.reason };
      // Admitted only after `verify` answered this subject.
      const person = seen.subject!;
      return {
        caller: {
          principal: answer.principal,
          tenantId,
          scopeId,
          sub: person.sub,
          display: person.name ?? person.email ?? person.sub,
          email: person.email,
          // A delegated token proves nothing about the address (K-61): another app is acting.
          verifiedEmail: null,
        },
        scope: answer.scope,
        actor: answer.actor,
      };
    },
  };
}
