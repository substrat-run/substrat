/**
 * The dependent's half of the person contract, against a real SQLite through the directory's
 * `exec` seam: what a login is answered from, when the master is asked, and what a changed
 * answer does to the roles a person holds here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { PersonResolveInput, PersonResolveOutput } from '@substrat-run/contracts';
import { PEOPLE_DDL, PEOPLE_TTL_SECONDS, admitPerson, sqlPeopleStore, type PeopleDeps } from '../src/people.js';
import type { RegistrySql } from '../src/site-registry.js';

const SCOPE = '01SCOPENOTES';
const BJORN = '01JZ0000000000000000BJ0RN0';
const login = (sub: string): PersonResolveInput => ({ issuer: 'https://issuer.test', sub, verifiedEmail: `${sub}@example.com` });

function sqlOver(db: InstanceType<typeof Database>): RegistrySql {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  };
}

/** A master whose answer and reachability a test sets, and a record of what the door did. */
function world() {
  const db = new Database(':memory:');
  for (const stmt of PEOPLE_DDL) db.exec(stmt);
  const state = {
    now: Date.UTC(2026, 10, 13),
    answer: { person: { id: BJORN, status: 'active', roles: ['member'] } } as unknown,
    down: false,
    asked: 0,
    bound: [] as string[],
    seats: [] as { add: string[]; remove: string[] }[],
  };
  const deps: PeopleDeps = {
    resolve: async () => {
      state.asked += 1;
      if (state.down) throw new Error('master unreachable');
      return state.answer;
    },
    store: sqlPeopleStore(sqlOver(db)),
    roles: (master) => master.flatMap((role) => (role === 'member' ? ['writer'] : role === 'guest' ? ['reader'] : [])),
    bind: async (sub, principal) => void state.bound.push(`${sub}=${principal}`),
    seat: async (_principal, change) => void state.seats.push(change),
    now: () => new Date(state.now),
  };
  const later = (seconds: number) => void (state.now += seconds * 1000);
  return { state, deps, later };
}

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

describe('admitPerson', () => {
  it('asks the master once, seats the mapped roles, and answers from the copy until it expires', async () => {
    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual({ admitted: true, principal: BJORN });
    expect(w.state.bound).toEqual([`bjorn=${BJORN}`]);
    expect(w.state.seats).toEqual([{ add: ['writer'], remove: [] }]);

    w.later(PEOPLE_TTL_SECONDS - 1);
    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual({ admitted: true, principal: BJORN });
    expect(w.state.asked).toBe(1);

    w.later(1);
    await admitPerson(w.deps, SCOPE, login('bjorn'));
    expect(w.state.asked).toBe(2);
    // Nothing changed at the master, so nothing is seated again.
    expect(w.state.seats).toHaveLength(1);
  });

  it.each<[string, PersonResolveOutput, 'blocked' | null, { add: string[]; remove: string[] }]>([
    ['blocked', { person: { id: BJORN, status: 'blocked', roles: ['member'] } }, 'blocked', { add: [], remove: ['writer'] }],
    ['a changed role', { person: { id: BJORN, status: 'active', roles: ['guest'] } }, null, { add: ['reader'], remove: ['writer'] }],
    ['no role the door maps', { person: { id: BJORN, status: 'active', roles: ['auditor'] } }, null, { add: [], remove: ['writer'] }],
  ])('a person the master now answers as %s is re-seated at the next refresh', async (_name, answer, refusal, change) => {
    await admitPerson(w.deps, SCOPE, login('bjorn'));
    w.state.answer = answer;
    w.later(PEOPLE_TTL_SECONDS);

    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual(
      refusal ? { admitted: false, reason: refusal } : { admitted: true, principal: BJORN },
    );
    expect(w.state.seats.at(-1)).toEqual(change);
  });

  it('fails closed: a copy past its time with no answer admits nobody, and keeps what was seated', async () => {
    await admitPerson(w.deps, SCOPE, login('bjorn'));
    w.state.down = true;
    w.later(PEOPLE_TTL_SECONDS);

    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual({ admitted: false, reason: 'unavailable' });
    expect(w.state.seats).toHaveLength(1);

    // The master is back: the same person is let in again without anything being re-seated.
    w.state.down = false;
    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual({ admitted: true, principal: BJORN });
    expect(w.state.seats).toHaveLength(1);
  });

  it.each<[string, PersonResolveOutput, 'unknown' | 'invited']>([
    ['nobody', { person: null }, 'unknown'],
    ['an invited person', { person: { id: BJORN, status: 'invited', roles: ['member'] } }, 'invited'],
  ])('%s is refused, bound to nothing, and not asked about again inside the time', async (_name, answer, reason) => {
    w.state.answer = answer;
    expect(await admitPerson(w.deps, SCOPE, login('dan'))).toEqual({ admitted: false, reason });
    expect(await admitPerson(w.deps, SCOPE, login('dan'))).toEqual({ admitted: false, reason });
    expect(w.state).toMatchObject({ asked: 1, bound: [], seats: [] });
  });

  it.each([
    ['not the contract', { person: { id: BJORN, status: 'suspended', roles: [] } }],
    ['an id that is no principal', { person: { id: 'bjorn', status: 'active', roles: [] } }],
  ])('an answer that is %s is the master not answering', async (_name, answer) => {
    w.state.answer = answer;
    expect(await admitPerson(w.deps, SCOPE, login('bjorn'))).toEqual({ admitted: false, reason: 'unavailable' });
    expect(w.state.bound).toEqual([]);
  });

  it('seats a person once for two logins', async () => {
    await admitPerson(w.deps, SCOPE, login('bjorn'));
    expect(await admitPerson(w.deps, SCOPE, login('bjorn-work'))).toEqual({ admitted: true, principal: BJORN });
    expect(w.state.bound).toEqual([`bjorn=${BJORN}`, `bjorn-work=${BJORN}`]);
    expect(w.state.seats).toHaveLength(1);
  });
});
