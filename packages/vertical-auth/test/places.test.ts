import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MAX_PLACE_MEMBERS, placeReport } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import {
  observePlace,
  placesReporter,
  reportScopeMembers,
  resetPlacesMemo,
  unbindMember,
} from '../src/places.js';
import { OWNER_SEAT_DDL, migrateOwnerSeat, recordOwnerSeat, resolvePrincipal, subjectsOf, unbindSubject } from '../src/owner-seat.js';
import type { RegistrySql } from '../src/site-registry.js';

/**
 * The vertical's half of a login's places (#1670): what it tells the identity pool, when, and
 * — as much — when it tells it nothing. The pool's half, and the checks that make a report
 * unforgeable, are pinned in `demos/auth-server/test/workerd/reconcile.test.ts`.
 */

const ISSUER = 'https://auth.acme.test';
const SCOPE = '01J9ZQ3V8Y5K2N4M6P8R0T2V4X';
const identity = { mode: 'oidc' as const, issuer: ISSUER, clientId: 'desk-client', clientSecret: 'desk-secret' };

/** A fake issuer: records every request, answers discovery and reports as told. */
function issuer(opts: { index?: boolean; discovery?: number; report?: number; throwOnReport?: boolean } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = (status: number, body?: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body ?? null),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as Awaited<ReturnType<FetchLike>>;
    if (url === `${ISSUER}/.well-known/substrat-places`) {
      if (opts.discovery) return answer(opts.discovery);
      return opts.index === false ? answer(404) : answer(200, { report_endpoint: `${ISSUER}/api/places/report` });
    }
    if (opts.throwOnReport) throw new Error('connection reset');
    return answer(opts.report ?? 204);
  };
  const reports = () => calls.filter((c) => c.url.endsWith('/api/places/report'));
  const discoveries = () => calls.filter((c) => c.url.endsWith('/.well-known/substrat-places'));
  return { fetch, calls, reports, discoveries };
}

beforeEach(() => resetPlacesMemo());

describe('placesReporter', () => {
  it('exists only for an identity that can authenticate a report', () => {
    expect(placesReporter({ identity: null })).toBeNull();
    expect(placesReporter({ identity: { ...identity, clientSecret: undefined } })).toBeNull();
    expect(placesReporter({ identity: { ...identity, issuer: undefined } })).toBeNull();
    expect(placesReporter({ identity })).not.toBeNull();
  });

  it("sends exactly the contracts' report — the client, the scope, the op, and nothing else", async () => {
    const iss = issuer();
    const reporter = placesReporter({ identity, fetch: iss.fetch })!;
    expect(await reporter.present(SCOPE, 'sub-ann')).toEqual({ outcome: 'sent' });
    expect(await reporter.absent(SCOPE, 'sub-ann')).toEqual({ outcome: 'sent' });
    expect(await reporter.replace(SCOPE, ['sub-ann', 'sub-ben'])).toEqual({ outcome: 'sent' });
    const bodies = iss.reports().map((r) => r.body);
    expect(bodies).toEqual([
      { client_id: 'desk-client', client_secret: 'desk-secret', scope_id: SCOPE, op: 'present', sub: 'sub-ann' },
      { client_id: 'desk-client', client_secret: 'desk-secret', scope_id: SCOPE, op: 'absent', sub: 'sub-ann' },
      { client_id: 'desk-client', client_secret: 'desk-secret', scope_id: SCOPE, op: 'replace', subs: ['sub-ann', 'sub-ben'] },
    ]);
    // The issuer's strict parse accepts every one of them.
    for (const body of bodies) expect(placeReport.safeParse(body).success).toBe(true);
    // Discovery was asked once and believed for the rest.
    expect(iss.discoveries()).toHaveLength(1);
  });

  it('sends an external issuer nothing: no index, no report', async () => {
    const iss = issuer({ index: false });
    const reporter = placesReporter({ identity, fetch: iss.fetch })!;
    expect(await reporter.present(SCOPE, 'sub-ann')).toEqual({ outcome: 'no-index' });
    expect(await reporter.replace(SCOPE, ['sub-ann'])).toEqual({ outcome: 'no-index' });
    expect(iss.reports()).toEqual([]);
    // Asked once; the "no" is believed rather than re-asked on every report.
    expect(iss.discoveries()).toHaveLength(1);
  });

  it('does not write off an issuer that hiccuped: a 5xx discovery is retried next time', async () => {
    const down = issuer({ discovery: 503 });
    expect(await placesReporter({ identity, fetch: down.fetch })!.present(SCOPE, 'sub-ann')).toMatchObject({
      outcome: 'failed',
    });
    const up = issuer();
    expect(await placesReporter({ identity, fetch: up.fetch })!.present(SCOPE, 'sub-ann')).toEqual({ outcome: 'sent' });
    expect(up.reports()).toHaveLength(1);
  });

  it('never throws — a refusal and a network failure are results', async () => {
    expect(await placesReporter({ identity, fetch: issuer({ report: 403 }).fetch })!.present(SCOPE, 's')).toEqual({
      outcome: 'refused',
      status: 403,
    });
    expect(
      await placesReporter({ identity, fetch: issuer({ throwOnReport: true }).fetch })!.present(SCOPE, 's'),
    ).toEqual({ outcome: 'failed', reason: 'connection reset' });
  });

  it(`refuses to send a whole set over ${MAX_PLACE_MEMBERS} rather than truncate it`, async () => {
    const iss = issuer();
    const reporter = placesReporter({ identity, fetch: iss.fetch })!;
    const many = Array.from({ length: MAX_PLACE_MEMBERS + 1 }, (_, i) => `sub-${i}`);
    expect(await reporter.replace(SCOPE, many)).toMatchObject({ outcome: 'failed' });
    expect(iss.reports()).toEqual([]);
    // Its twin: exactly at the cap goes out.
    expect(await reporter.replace(SCOPE, many.slice(0, MAX_PLACE_MEMBERS))).toEqual({ outcome: 'sent' });
  });
});

describe('observePlace', () => {
  it('reports a resolve once per state, and again when the state flips', async () => {
    const iss = issuer();
    const reporter = placesReporter({ identity, fetch: iss.fetch });
    await observePlace(reporter, SCOPE, 'sub-ann', 'principal-ann');
    await observePlace(reporter, SCOPE, 'sub-ann', 'principal-ann');
    await observePlace(reporter, SCOPE, 'sub-ann', 'principal-ann');
    expect(iss.reports().map((r) => (r.body as { op: string }).op)).toEqual(['present']);
    await observePlace(reporter, SCOPE, 'sub-ann', null);
    expect(iss.reports().map((r) => (r.body as { op: string }).op)).toEqual(['present', 'absent']);
  });

  it('retries a report that failed, and re-reports a landed one after an hour', async () => {
    let now = 0;
    const clock = () => now;
    const flaky = issuer({ throwOnReport: true });
    await observePlace(placesReporter({ identity, fetch: flaky.fetch }), SCOPE, 'sub-ann', 'p', clock);
    const iss = issuer();
    const reporter = placesReporter({ identity, fetch: iss.fetch });
    await observePlace(reporter, SCOPE, 'sub-ann', 'p', clock);
    expect(iss.reports()).toHaveLength(1);
    now += 59 * 60_000;
    await observePlace(reporter, SCOPE, 'sub-ann', 'p', clock);
    expect(iss.reports()).toHaveLength(1);
    now += 2 * 60_000;
    await observePlace(reporter, SCOPE, 'sub-ann', 'p', clock);
    expect(iss.reports()).toHaveLength(2);
  });

  it('does nothing without a reporter', async () => {
    expect(await observePlace(null, SCOPE, 'sub-ann', 'p')).toBeNull();
  });
});

function sqlOver(db: InstanceType<typeof Database>): RegistrySql {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...(params as never[])) as Record<string, unknown>[];
      stmt.run(...(params as never[]));
      return [];
    },
  };
}

describe("the directory's removal half, and the whole set a repair sends", () => {
  let sql: RegistrySql;
  beforeEach(() => {
    const db = new Database(':memory:');
    for (const stmt of OWNER_SEAT_DDL) db.exec(stmt);
    sql = sqlOver(db);
    migrateOwnerSeat(sql);
    recordOwnerSeat(sql, SCOPE, 'principal-owner', 0);
    resolvePrincipal(sql, SCOPE, 'sub-owner', 1);
    sql.exec('INSERT INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', SCOPE, 'sub-ann', 'principal-ann');
    sql.exec('INSERT INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', 'OTHER-SCOPE', 'sub-ann', 'principal-x');
  });

  it('unbinds one subject from one scope, and says whether there was a binding', () => {
    expect(unbindSubject(sql, SCOPE, 'sub-ann')).toBe(true);
    expect(resolvePrincipal(sql, SCOPE, 'sub-ann', 2)).toBeNull();
    // The same login in another scope keeps its binding, and so does everyone else here.
    expect(resolvePrincipal(sql, 'OTHER-SCOPE', 'sub-ann', 2)).toBe('principal-x');
    expect(resolvePrincipal(sql, SCOPE, 'sub-owner', 2)).toBe('principal-owner');
    expect(unbindSubject(sql, SCOPE, 'sub-ann')).toBe(false);
  });

  it('lists the subjects bound in a scope, bounded, in a stable order', () => {
    expect(subjectsOf(sql, SCOPE, 10)).toEqual(['sub-ann', 'sub-owner']);
    expect(subjectsOf(sql, SCOPE, 1)).toEqual(['sub-ann']);
    expect(subjectsOf(sql, 'NO-SUCH-SCOPE', 10)).toEqual([]);
  });

  it('unbindMember unbinds and reports the place gone', async () => {
    const iss = issuer();
    const directory = { unbind: async (scope: string, sub: string) => unbindSubject(sql, scope, sub) };
    const result = await unbindMember(directory, placesReporter({ identity, fetch: iss.fetch }), SCOPE, 'sub-ann');
    expect(result).toEqual({ unbound: true, report: { outcome: 'sent' } });
    expect(iss.reports().map((r) => r.body)).toEqual([
      expect.objectContaining({ op: 'absent', sub: 'sub-ann', scope_id: SCOPE }),
    ]);
  });

  it('reportScopeMembers sends the whole set, and refuses (logged) a scope over the cap', async () => {
    const iss = issuer();
    const reporter = placesReporter({ identity, fetch: iss.fetch });
    const directory = { subjectsOf: async (scope: string, limit: number) => subjectsOf(sql, scope, limit) };
    expect(await reportScopeMembers(directory, reporter, SCOPE)).toEqual({ outcome: 'sent' });
    expect(iss.reports().map((r) => r.body)).toEqual([
      expect.objectContaining({ op: 'replace', subs: ['sub-ann', 'sub-owner'] }),
    ]);

    const logged: string[] = [];
    const huge = { subjectsOf: async (_s: string, limit: number) => Array.from({ length: limit }, (_, i) => `s${i}`) };
    expect(await reportScopeMembers(huge, reporter, SCOPE, (l) => logged.push(l))).toMatchObject({ outcome: 'failed' });
    expect(logged).toHaveLength(1);
    expect(iss.reports()).toHaveLength(1);
  });
});
