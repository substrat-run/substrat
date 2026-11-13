/**
 * People owned by ANOTHER app of the same tenant: the dependent's half of the person contract
 * (`identity.person@1`, `@substrat-run/contracts`).
 *
 * A vertical normally owns who is in its scope: an owner claims the seat, members are invited,
 * and the identity directory maps each login to a principal. A DEPENDENT vertical, a plugin of
 * another app, owns none of that. The other app, the MASTER, decides who exists and what they
 * hold, and this door asks it.
 *
 * The copy is LAZY. Nothing is synchronised ahead of time: the first request from a login this
 * scope has not seen asks the master who it is, by a peer call, and the answer is kept for
 * `ttlSeconds`. Within that time a request costs one read here and no call. After it the
 * master is asked again, so a person blocked there, or one whose roles changed, is refused or
 * re-seated here within `ttlSeconds` of the change. That number is the revocation bound.
 *
 * Three rules hold it together:
 *
 * - **The master's id is the principal.** A person is one principal in the master's scope and
 *   the same one here, so what they did in either reads as the same person.
 * - **It fails closed.** A copy past its time with a master that cannot be reached admits
 *   nobody: the answer is `unavailable`, never the stale copy.
 * - **Roles are seated per person, copies are kept per login.** Two logins of one person share
 *   one set of roles, so one of them moving away takes nothing from the other.
 *
 * What is kept is a login's principal and status and a person's seated roles. No name and no
 * address: the contract carries neither.
 */
import {
  personResolveOutput,
  principalId,
  type PersonResolveInput,
  type PersonResolveOutput,
  type PersonStatus,
  type PrincipalId,
} from '@substrat-run/contracts';
import type { RegistrySql } from './site-registry.js';

/** How long an answer from the master is kept: the bound on how late a block or a role change lands. */
export const PEOPLE_TTL_SECONDS = 300;

/** Why a signed-in login is not let in. */
export type PersonRefusal =
  /** The master has nobody for this login. */
  | 'unknown'
  /** The master knows them and they have not arrived there yet. */
  | 'invited'
  /** The master refuses them. */
  | 'blocked'
  /** The copy is past its time and the master did not answer. */
  | 'unavailable';

export type PersonAnswer =
  | { admitted: true; principal: PrincipalId }
  | { admitted: false; reason: PersonRefusal };

/** What is kept per login: who the master said it is, until when. */
export interface LoginCopy {
  /** The person's principal, or null for a login the master has nobody for. */
  principal: string | null;
  status: PersonStatus | 'unknown';
  /** ISO 8601. The copy answers until this instant and not after. */
  expiresAt: string;
}

/** Where the copies live: the identity directory hosted, a SQLite file on a dev server. */
export interface PeopleStore {
  login(scopeId: string, sub: string): Promise<LoginCopy | null>;
  saveLogin(scopeId: string, sub: string, copy: LoginCopy): Promise<void>;
  /** The roles this door seated for a person, in this vertical's own keys. */
  seated(scopeId: string, principal: string): Promise<string[]>;
  saveSeated(scopeId: string, principal: string, roles: string[]): Promise<void>;
}

export interface PeopleDeps {
  /** The master's resolve operation, by peer call. A throw is the master not answering. */
  resolve(login: PersonResolveInput): Promise<unknown>;
  store: PeopleStore;
  /** Map the master's role keys onto this vertical's own. A key it does not name maps to nothing. */
  roles(masterRoles: readonly string[]): readonly string[];
  /** Bind the login to the principal in this scope's identity directory. Safe to repeat. */
  bind(sub: string, principal: PrincipalId): Promise<void>;
  /** Assign and unassign this vertical's roles for the principal in this scope. Safe to repeat. */
  seat(principal: PrincipalId, change: { add: string[]; remove: string[] }): Promise<void>;
  /** The door's clock, injected so a test moves time instead of waiting for it. */
  now(): Date;
  /** Defaults to {@link PEOPLE_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Told when the master did not answer, or answered something that is not the contract. */
  onUnavailable?(error: unknown): void;
}

const answerOf = (copy: LoginCopy): PersonAnswer => {
  if (copy.status === 'active' && copy.principal !== null) {
    return { admitted: true, principal: copy.principal as PrincipalId };
  }
  return { admitted: false, reason: copy.status === 'active' ? 'unknown' : copy.status };
};

/**
 * Who this login is here, from the copy while it is fresh and from the master otherwise.
 *
 * On a fresh answer the person's roles are brought to what the master now says, the login is
 * bound, and both are recorded, in that order: a failure part-way leaves the old record, so the
 * next request asks again and repeats steps that are safe to repeat.
 */
export async function admitPerson(deps: PeopleDeps, scopeId: string, login: PersonResolveInput): Promise<PersonAnswer> {
  const now = deps.now().getTime();
  const held = await deps.store.login(scopeId, login.sub);
  if (held && Date.parse(held.expiresAt) > now) return answerOf(held);

  let answer: PersonResolveOutput;
  let principal: PrincipalId | null;
  try {
    answer = personResolveOutput.parse(await deps.resolve(login));
    principal = answer.person ? principalId.parse(answer.person.id) : null;
  } catch (error) {
    deps.onUnavailable?.(error);
    return { admitted: false, reason: 'unavailable' };
  }

  const status = answer.person?.status ?? 'unknown';
  if (principal !== null && answer.person) {
    // Only someone let in holds anything: a blocked or invited person is brought to no roles.
    const wanted = status === 'active' ? [...new Set(deps.roles(answer.person.roles))].sort() : [];
    const seated = await deps.store.seated(scopeId, principal);
    const add = wanted.filter((role) => !seated.includes(role));
    const remove = seated.filter((role) => !wanted.includes(role));
    if (status === 'active') await deps.bind(login.sub, principal);
    if (add.length > 0 || remove.length > 0) {
      await deps.seat(principal, { add, remove });
      await deps.store.saveSeated(scopeId, principal, wanted);
    }
  }

  const copy: LoginCopy = {
    principal,
    status,
    expiresAt: new Date(now + (deps.ttlSeconds ?? PEOPLE_TTL_SECONDS) * 1000).toISOString(),
  };
  await deps.store.saveLogin(scopeId, login.sub, copy);
  return answerOf(copy);
}

/** The two tables behind {@link sqlPeopleStore}. */
export const PEOPLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS person_login (scope_id TEXT NOT NULL, sub TEXT NOT NULL, principal TEXT,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (scope_id, sub))`,
  `CREATE TABLE IF NOT EXISTS person_seat (scope_id TEXT NOT NULL, principal TEXT NOT NULL, roles TEXT NOT NULL,
    PRIMARY KEY (scope_id, principal))`,
];

/** A {@link PeopleStore} over the directory's own SQL seam. The caller runs {@link PEOPLE_DDL} first. */
export function sqlPeopleStore(sql: RegistrySql): PeopleStore {
  return {
    async login(scopeId, sub) {
      const row = [...sql.exec('SELECT principal, status, expires_at FROM person_login WHERE scope_id = ? AND sub = ?', scopeId, sub)][0];
      if (!row) return null;
      return {
        principal: (row.principal as string | null) ?? null,
        status: row.status as LoginCopy['status'],
        expiresAt: row.expires_at as string,
      };
    },
    async saveLogin(scopeId, sub, copy) {
      sql.exec(
        `INSERT INTO person_login (scope_id, sub, principal, status, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, sub) DO UPDATE SET principal = excluded.principal, status = excluded.status, expires_at = excluded.expires_at`,
        scopeId,
        sub,
        copy.principal,
        copy.status,
        copy.expiresAt,
      );
    },
    async seated(scopeId, principal) {
      const row = [...sql.exec('SELECT roles FROM person_seat WHERE scope_id = ? AND principal = ?', scopeId, principal)][0];
      return row ? (JSON.parse(row.roles as string) as string[]) : [];
    },
    async saveSeated(scopeId, principal, roles) {
      sql.exec(
        `INSERT INTO person_seat (scope_id, principal, roles) VALUES (?, ?, ?)
         ON CONFLICT(scope_id, principal) DO UPDATE SET roles = excluded.roles`,
        scopeId,
        principal,
        JSON.stringify(roles),
      );
    },
  };
}
