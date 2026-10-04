import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { PLATFORM_SECRET_HEADER, substratError } from '@substrat-run/contracts';
import { mountPlatformSurface, registeredScopeSweepHost, type VerticalScopeHost } from '../src/index.js';

const SECRET = 'sekret';
// Valid 26-char ULIDs (Crockford base32 — no I/L/O/U).
const SCOPE = '01JZ0000000000000000SCP001';
const TENANT = '01JZ0000000000000000TEN001';
// Any principal — the denial filter takes the LOGICAL actor, not its stored JSON spelling.
const ACTOR_ULID = '01JZ0000000000000000PRN001';
const OWNER = '01JZ0000000000000000PRN001';
// The record whose history the #1235 read walks — any id; the route only forwards it.
const ENTITY = '01JZ0000000000000000WO0001';
const EVENT = '01JZ0000000000000000EVT001';

type Env = { PLATFORM_SECRET: string };

/** A host whose methods all record their call and return a benign value — except the ones a
 *  test overrides to throw, exercising the error envelope. */
function fakeHost(overrides: Partial<VerticalScopeHost> = {}): VerticalScopeHost & { calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, v: T) => {
    calls.push(name);
    return v;
  };
  const base: VerticalScopeHost = {
    provisionScopeLocal: async () => note('provisionScopeLocal', undefined),
    restoreScopeLocal: async () => note('restoreScopeLocal', { tables: 3 }),
    markCopyLocal: async () => note('markCopyLocal', { marked: true }),
    clearCopyMarkLocal: async () => note('clearCopyMarkLocal', { cleared: true }),
    projectRolesLocal: async () => note('projectRolesLocal', undefined),
    exportScopeLocal: async () => note('exportScopeLocal', []),
    snapshotScopeLocal: async () => note('snapshotScopeLocal', { tables: 3 }),
    deleteScopeLocal: async () => note('deleteScopeLocal', undefined),
    migrationBookmarksLocal: async () => note('migrationBookmarksLocal', []),
    appliedMigrationsLocal: async () => note('appliedMigrationsLocal', []),
    // #1334: the drain's far end echoes what it was asked, like the reads around it.
    undrainedEventsLocal: async (_s: unknown, limit?: unknown) => note('undrainedEventsLocal', [{ limit }]) as never,
    markEventsDrainedLocal: async (_s: unknown, ids?: unknown, at?: unknown) =>
      note('markEventsDrainedLocal', (ids as string[]).length + (at === '2026-09-14T00:00:00.000Z' ? 0 : 1000)),
    // Answers 7 only when the instant arrives verbatim, so the route cannot quietly drop it.
    redrainEventsLocal: async (_s: unknown, before?: unknown) =>
      note('redrainEventsLocal', before === '2026-09-16T00:00:00.000Z' ? 7 : -1),
    // #1545: the read-only half, on the same "only with the exact instant" rule. 11, so a
    // reply that came from the reopen above is recognisable as the wrong verb.
    redrainCountLocal: async (_s: unknown, before?: unknown) =>
      note('redrainCountLocal', before === '2026-09-16T00:00:00.000Z' ? 11 : -1),
    loadMarkerLocal: async () => note('loadMarkerLocal', { loadStamp: 'st', revision: null }),
    keptCopyLocal: async () => note('keptCopyLocal', { carriedTo: 'v2-script', keptAt: '2026-10-03T00:00:00.000Z', revision: '4' }),
    releaseKeptCopyLocal: async (_s: unknown, revision?: unknown) =>
      note('releaseKeptCopyLocal', revision === '9' ? ({ released: true } as const) : ({ refused: 'changed' } as const)),
    discardKeptCopyLocal: async (_s: unknown, revision?: unknown) =>
      note('discardKeptCopyLocal', revision === '9' ? ({ discarded: true } as const) : ({ refused: 'changed' } as const)),
    // #1722: refuses unless the stamp and the tombstone arrive verbatim.
    wipeCarriedLocal: async (_s: unknown, stamp?: unknown, away?: unknown) =>
      note(
        'wipeCarriedLocal',
        stamp === 'stamp-1' && JSON.stringify(away) === JSON.stringify({ to: 'v2-script', at: '2026-10-03T00:00:00.000Z' }),
      ),
    entityHistoryLocal: async (_s: unknown, input?: unknown) =>
      note('entityHistoryLocal', { entries: [input], nextCursor: null }) as never,
    facetEventsLocal: async (_s: unknown, input?: unknown) =>
      note('facetEventsLocal', { buckets: [{ value: JSON.stringify(input), count: 1 }], erased: 0, total: 1, truncated: false }) as never,
    // #1237: echoes the parsed input back, like the two around it — the point of this
    // surface suite is that the route parses and forwards, not what the walk answers.
    eventCauseLocal: async (_s: unknown, input?: unknown) =>
      note('eventCauseLocal', { chain: [], terminal: JSON.stringify(input) }) as never,
    eventEffectsLocal: async (_s: unknown, input?: unknown) =>
      note('eventEffectsLocal', { root: null, terminal: JSON.stringify(input), count: 0 }) as never,
    invocationEventsLocal: async (_s: unknown, input?: unknown) =>
      note('invocationEventsLocal', { events: [input], truncated: false }) as never,
    deadLettersLocal: async (_s: unknown, input?: unknown) =>
      note('deadLettersLocal', { entries: [input], nextCursor: null }) as never,
    lifecycleFlowLocal: async (_s: unknown, input?: unknown) => note('lifecycleFlowLocal', { echoed: input }) as never,
    operationSeriesLocal: async (_s: unknown, input?: unknown) => note('operationSeriesLocal', { echoed: input }) as never,
    rewindScopeLocal: async () => note('rewindScopeLocal', { rewindingTo: 'bm' }),
    introspectScopeTables: async () => note('introspectScopeTables', []),
    introspectScopeTable: async () => note('introspectScopeTable', { rows: [] }),
    introspectScopeQuery: async () => note('introspectScopeQuery', { columns: [], rows: [] }) as never,
    listDenialsLocal: async (_s: unknown, filter?: unknown) => note('listDenialsLocal', [filter]) as never,
    summarizeDenialsLocal: async (_s: unknown, filter?: unknown) =>
      note('summarizeDenialsLocal', { buckets: [filter] }) as never,
    listCapabilitiesLocal: async (_s: unknown, filter?: unknown) => note('listCapabilitiesLocal', { entries: [filter], nextCursor: null }) as never,
    listPlatformRequests: async () => note('listPlatformRequests', []),
    listPlatformRequestHistory: async (_t: unknown, _s: unknown, filter?: unknown) =>
      note('listPlatformRequestHistory', [filter]) as never,
    settlePlatformRequest: async () => note('settlePlatformRequest', undefined),
    connectorInvokeLocal: async () => note('connectorInvokeLocal', { ok: true }),
    connectorAttachmentUploadLocal: async () => note('connectorAttachmentUploadLocal', { id: 'att1' }),
    connectorAttachmentOpenLocal: async () => note('connectorAttachmentOpenLocal', null),
    connectorGrantLocal: async () => note('connectorGrantLocal', undefined),
  };
  return Object.assign(base, overrides, { calls }) as VerticalScopeHost & { calls: string[] };
}

function appWith(
  host: VerticalScopeHost,
  deps: Partial<Parameters<typeof mountPlatformSurface<Env>>[1]> = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
    ...deps,
  });
  return app;
}

const ENV: Env = { PLATFORM_SECRET: SECRET };
const authed = (extra: Record<string, string> = {}) => ({ [PLATFORM_SECRET_HEADER]: SECRET, ...extra });

describe('mountPlatformSurface — the platform-secret gate', () => {
  it('403s an /internal call with no platform secret', async () => {
    const res = await appWith(fakeHost()).request('/internal/export?scopeId=' + SCOPE, {}, ENV);
    expect(res.status).toBe(403);
  });

  it('403s an /internal call with the wrong secret', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: { [PLATFORM_SECRET_HEADER]: 'nope' } },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('admits a correctly-signed call', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe('mountPlatformSurface — the error envelope (#510 regression)', () => {
  it('renders a thrown route as { error: <real message> }, never bare "Internal Server Error"', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('FOREIGN KEY constraint failed');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('FOREIGN KEY constraint failed');
    expect(await new Response(JSON.stringify(body)).text()).not.toBe('Internal Server Error');
  });

  it('maps an "invalid transition" throw to 409', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('invalid transition from draft to closed');
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(409);
  });

  it('answers a DO SQLite redacted fault ("internal error; reference = …") with 502, message intact (#559)', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('internal error; reference = 242sg7l0st8ldln5uqu8ei58');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('internal error; reference = 242sg7l0st8ldln5uqu8ei58');
  });

  it('answers a workerd-flagged transient (retryable) with 502 regardless of message', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw Object.assign(new Error('Durable Object reset because its code was updated.'), {
          retryable: true,
        });
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(502);
  });

  it('leaves an APP error that merely mentions "internal error" mid-sentence as 400', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('column check failed: expected no internal error marker');
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(400);
  });

  it('maps a "permission denied" throw to 403', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('permission denied for scope');
      },
    });
    const res = await appWith(host).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('honours a vertical-supplied mapError before the default', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('teapot');
      },
    });
    const res = await appWith(host, {
      mapError: (e) => (e instanceof Error && e.message === 'teapot' ? { status: 418, message: 'short and stout' } : undefined),
    }).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(418);
    expect(((await res.json()) as { error: string }).error).toBe('short and stout');
  });
});

describe('mountPlatformSurface — the full route set is mounted', () => {
  const cases: [string, RequestInit][] = [
    ['/internal/export?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/bookmarks?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables/some_table?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/platform-requests?tenantId=' + TENANT + '&scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/platform-requests/history?tenantId=' + TENANT + '&scopeId=' + SCOPE, { headers: authed() }],
    [
      `/internal/history?scopeId=${SCOPE}&entityType=work-order&entityId=${ENTITY}`,
      { headers: authed() },
    ],
    [`/internal/facets?scopeId=${SCOPE}&groupBy=type`, { headers: authed() }],
    [`/internal/cause?scopeId=${SCOPE}&eventId=${EVENT}`, { headers: authed() }],
    [`/internal/effects?scopeId=${SCOPE}&eventId=${EVENT}`, { headers: authed() }],
    [`/internal/invocation?scopeId=${SCOPE}&invocationId=${EVENT}`, { headers: authed() }],
    [`/internal/dead-letters?scopeId=${SCOPE}`, { headers: authed() }],
    ['/internal/migrations?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/undrained-events?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/denials?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/denials/summary?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/capabilities?scopeId=' + SCOPE, { headers: authed() }],
  ];
  it.each(cases)('GET %s is served (not 404)', async (path, init) => {
    const res = await appWith(fakeHost()).request(path, init, ENV);
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  // #1334: the Tier-2 drain's two verbs. The read's `limit` is parsed and bounded at this
  // door — a platform asking for 5000 gets 400, not an unbounded page — and the stamp
  // carries the platform's instant through unchanged, so its admin receipt and the rows
  // it stamped name the same time.
  it('serves the drain read with a bounded limit, and the stamp with the instant carried through', async () => {
    const host = fakeHost();
    const read = await appWith(host).request(`/internal/undrained-events?scopeId=${SCOPE}&limit=50`, { headers: authed() }, ENV);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual([{ limit: 50 }]);
    const unbounded = await appWith(host).request(`/internal/undrained-events?scopeId=${SCOPE}&limit=5000`, { headers: authed() }, ENV);
    expect(unbounded.status).toBe(400);
    const stamp = await appWith(host).request('/internal/mark-drained', {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ scopeId: SCOPE, eventIds: ['e1', 'e2'], drainedAt: '2026-09-14T00:00:00.000Z' }),
    }, ENV);
    expect(stamp.status).toBe(200);
    // 2 = both ids, and the instant arrived verbatim (the fake adds 1000 otherwise).
    expect(await stamp.json()).toEqual({ drained: 2 });
    expect(host.calls).toEqual(expect.arrayContaining(['undrainedEventsLocal', 'markEventsDrainedLocal']));
  });

  // #1636: what the read stepped over has to CROSS this hop to reach the sweep's report, and a
  // property on an array does not survive `c.json`. So a caller that asks (`withSkipped=1`)
  // gets `{ events, skipped? }`, and one that does not — a platform deployed before this —
  // gets the bare array it parses, exactly as before.
  it('carries the drain read’s skip across the hop only to a caller that asks for it', async () => {
    const events = [{ id: 'e2' }];
    const skipped = { count: 1, eventIds: ['e1'] };
    const host = fakeHost({
      undrainedEventsLocal: async () => Object.assign([...events], { skipped }) as never,
    });
    const url = `/internal/undrained-events?scopeId=${SCOPE}&limit=50`;
    const asked = await appWith(host).request(`${url}&withSkipped=1`, { headers: authed() }, ENV);
    expect(await asked.json()).toEqual({ events, skipped });
    const old = await appWith(host).request(url, { headers: authed() }, ENV);
    expect(await old.json()).toEqual(events);

    // The positive twin: a clean read that was asked says nothing about skips at all.
    const clean = fakeHost({ undrainedEventsLocal: async () => [...events] as never });
    const cleanAnswer = await appWith(clean).request(`${url}&withSkipped=1`, { headers: authed() }, ENV);
    expect(await cleanAnswer.json()).toEqual({ events });
  });

  // #1334: the stamp's inverse. The instant is the guard against reopening rows that already
  // reached a rebuilt table, so a body without one is refused HERE rather than reaching a
  // host that would reopen everything.
  it('serves the redrain with the instant carried through, and refuses one without it', async () => {
    const host = fakeHost();
    const post = (body: unknown) =>
      appWith(host).request('/internal/redrain-events', {
        method: 'POST',
        headers: { ...authed(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, ENV);
    const ok = await post({ scopeId: SCOPE, drainedBefore: '2026-09-16T00:00:00.000Z' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ redrained: 7 });
    expect((await post({ scopeId: SCOPE })).status).toBe(400);
    expect((await post({ scopeId: SCOPE, drainedBefore: 'yesterday' })).status).toBe(400);
    // #1545: `countOnly` is REFUSED here rather than stripped by the Zod boundary. Stripping
    // it would reopen the window for a caller that asked to count it — silently, which is
    // the whole failure the separate count route exists to prevent.
    const flagged = await post({ scopeId: SCOPE, drainedBefore: '2026-09-16T00:00:00.000Z', countOnly: true });
    expect(flagged.status).toBe(400);
    expect((await flagged.json()).error).toMatch(/redrain-count/);
    expect(host.calls.filter((c) => c === 'redrainEventsLocal')).toHaveLength(1);
  });

  // #1545: the count is its OWN route, and that is the point of it. A `countOnly` field on
  // the route above would be stripped by a deployment built before this — which would reopen
  // the window and answer with a number the caller would print as a dry run's count. A path
  // that deployment does not serve refuses instead, and a host without the method answers
  // 501 rather than reaching for something that is not there.
  it('serves the redrain count as a route of its own, and 501s on a host that cannot count', async () => {
    const host = fakeHost();
    const post = (h: ReturnType<typeof fakeHost>, body: unknown) =>
      appWith(h).request('/internal/redrain-count', {
        method: 'POST',
        headers: { ...authed(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, ENV);
    const ok = await post(host, { scopeId: SCOPE, drainedBefore: '2026-09-16T00:00:00.000Z' });
    expect(ok.status).toBe(200);
    // `redrainable`, not `redrained`: the field name says nothing moved.
    expect(await ok.json()).toEqual({ redrainable: 11 });
    // The instant is the guard for the count as for the reopen — a count over a different
    // window is a rehearsal of a run that will not happen.
    expect((await post(host, { scopeId: SCOPE })).status).toBe(400);
    expect((await post(host, { scopeId: SCOPE, drainedBefore: 'yesterday' })).status).toBe(400);
    // And the reopen was never reached: a count that fell through to it would be the exact
    // failure this route exists to make impossible.
    expect(host.calls.filter((c) => c === 'redrainEventsLocal')).toHaveLength(0);
    expect(host.calls.filter((c) => c === 'redrainCountLocal')).toHaveLength(1);

    const older = fakeHost({ redrainCountLocal: undefined });
    const refused = await post(older, { scopeId: SCOPE, drainedBefore: '2026-09-16T00:00:00.000Z' });
    expect(refused.status).toBe(501);
    expect(older.calls).toHaveLength(0);
  });

  // #1722: the fenced wipe of a carried copy. Its own route, so a deployment built before it
  // answers 404 rather than stripping a field and wiping unconditionally; a host without the
  // method answers 501. Both read as "cannot fence" on the platform's side.
  it('serves the fenced wipe with the stamp carried through, and 501s on a host that cannot fence', async () => {
    const post = (h: ReturnType<typeof fakeHost>, body: unknown) =>
      appWith(h).request('/internal/wipe-carried', {
        method: 'POST',
        headers: { ...authed(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, ENV);
    const body = { scopeId: SCOPE, expectLoadStamp: 'stamp-1', carriedTo: 'v2-script', at: '2026-10-03T00:00:00.000Z' };
    const host = fakeHost();
    const ok = await post(host, body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ wiped: true });
    // A stamp is required, even if it is null: an absent one would read as "wipe whatever is there".
    expect((await post(host, { ...body, expectLoadStamp: undefined })).status).toBe(400);
    expect((await post(host, { ...body, expectLoadStamp: null })).status).toBe(200);
    expect(host.calls.filter((c) => c === 'wipeCarriedLocal')).toHaveLength(2);
    // The write revision the export read, the protect flag and the directory's classification
    // (#2005, Codex #2008 r10) ride through to the host.
    let seen: unknown;
    const revising = fakeHost({
      wipeCarriedLocal: async (_s, _st, _a, opts) => {
        seen = opts;
        return true;
      },
    });
    const lineage = { kind: 'preview', forkedFrom: null };
    expect((await post(revising, { ...body, expectRevision: '42', protectIfChanged: true, markCopy: lineage })).status).toBe(200);
    expect(seen).toEqual({ expectRevision: '42', protectIfChanged: true, markCopy: lineage });
    expect((await post(revising, body)).status).toBe(200);
    expect(seen).toEqual({});
    expect((await post(revising, { ...body, markCopy: { kind: 'preview' } })).status).toBe(400);
    // Behind the platform gate like every sibling.
    const unsigned = await appWith(host).request('/internal/wipe-carried', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, ENV);
    expect(unsigned.status).toBe(403);
    const older = fakeHost({ wipeCarriedLocal: undefined });
    expect((await post(older, body)).status).toBe(501);
    expect(older.calls).toHaveLength(0);
  });

  // #1722: the load stamp rides the export as a header, beside the unchanged table list, and a
  // restore hands the stamp a carry names to the host.
  it('serves the export with its load stamp, and forwards a carry\'s stamp on restore', async () => {
    const stamped = fakeHost({
      exportScopeStampedLocal: async () => ({ tables: [], loadStamp: 'stamp-7', revision: '42' }),
    });
    const res = await appWith(stamped).request(`/internal/export?scopeId=${SCOPE}&stamp=1`, { headers: authed() }, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-substrat-load-stamp')).toBe('stamp-7');
    expect(res.headers.get('x-substrat-write-revision')).toBe('42');
    expect(await res.json()).toEqual([]);
    expect(stamped.calls).toEqual([]);
    // Any other export (a pull, a snapshot) reads only: it never mints a stamp in the store.
    const plain = await appWith(stamped).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(plain.headers.get('x-substrat-load-stamp')).toBeNull();
    expect(stamped.calls).toEqual(['exportScopeLocal']);
    // A host without the stamped read answers the bare export, with no stamp to fence on.
    const older = await appWith(fakeHost()).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(older.headers.get('x-substrat-load-stamp')).toBeNull();

    let opts: unknown;
    const restoring = fakeHost({
      restoreScopeLocal: async (_s, _t, o) => {
        opts = o;
        return { tables: 0 };
      },
    });
    const restore = await appWith(restoring).request('/internal/restore', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ scopeId: SCOPE, tables: [], loadStamp: 'stamp-8' }),
    }, ENV);
    expect(restore.status).toBe(200);
    expect(opts).toMatchObject({ loadStamp: 'stamp-8' });

    // The marker a carry's restore expects, sent back as `expect`.
    const fenced = await appWith(restoring).request('/internal/restore', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ scopeId: SCOPE, tables: [], expect: { loadStamp: null, revision: 'ev-9' } }),
    }, ENV);
    expect(fenced.status).toBe(200);
    expect(opts).toMatchObject({ expect: { loadStamp: null, revision: 'ev-9' } });
  });

  it('serves the kept-copy read and discard behind the gate, and 501s on a host that keeps no copies (#1722)', async () => {
    const host = fakeHost();
    const read = await appWith(host).request('/internal/kept-copy?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ kept: { carriedTo: 'v2-script', keptAt: '2026-10-03T00:00:00.000Z', revision: '4' } });
    const discard = (h: ReturnType<typeof fakeHost>, body: unknown, headers: Record<string, string> = authed({ 'content-type': 'application/json' })) =>
      appWith(h).request('/internal/kept-copy/discard', { method: 'POST', headers, body: JSON.stringify(body) }, ENV);
    const body = { scopeId: SCOPE, revision: '9', carriedTo: 'v2-script', at: '2026-10-03T00:00:00.000Z' };
    expect(await (await discard(host, body)).json()).toEqual({ discarded: true });
    expect(await (await discard(host, { ...body, revision: '8' })).json()).toEqual({ refused: 'changed' });
    expect((await discard(host, { ...body, revision: undefined })).status).toBe(400);
    expect((await discard(host, body, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await appWith(host).request('/internal/kept-copy?scopeId=' + SCOPE, {}, ENV)).status).toBe(403);
    const release = (h: ReturnType<typeof fakeHost>, b: unknown) =>
      appWith(h).request('/internal/kept-copy/release', { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(b) }, ENV);
    expect(await (await release(host, { scopeId: SCOPE, revision: '9' })).json()).toEqual({ released: true });
    expect(await (await release(host, { scopeId: SCOPE, revision: '8' })).json()).toEqual({ refused: 'changed' });
    const older = fakeHost({ keptCopyLocal: undefined, discardKeptCopyLocal: undefined, releaseKeptCopyLocal: undefined });
    expect((await appWith(older).request('/internal/kept-copy?scopeId=' + SCOPE, { headers: authed() }, ENV)).status).toBe(501);
    expect((await discard(older, body)).status).toBe(501);
    expect((await release(older, { scopeId: SCOPE, revision: '9' })).status).toBe(501);
    expect(older.calls).toHaveLength(0);
  });

  it('serves the load marker behind the gate, and 501s on a host that cannot fence a restore (#1722)', async () => {
    const host = fakeHost();
    const ok = await appWith(host).request('/internal/load-marker?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ loadStamp: 'st', revision: null });
    expect((await appWith(host).request('/internal/load-marker?scopeId=' + SCOPE, {}, ENV)).status).toBe(403);
    const older = fakeHost({ loadMarkerLocal: undefined });
    expect((await appWith(older).request('/internal/load-marker?scopeId=' + SCOPE, { headers: authed() }, ENV)).status).toBe(501);
    expect(older.calls).toHaveLength(0);
  });

  // #1524: the size behind the on-demand storage reading. It sits behind the same
  // platform-secret gate as every sibling, and a host that predates the method answers
  // 501 rather than 0, because a 0 would be summed into a tenant's storage as a real scope.
  it('serves a scope database size behind the gate, and 501s on a host that cannot read one', async () => {
    const url = `/internal/database-size?scopeId=${SCOPE}`;
    const host = fakeHost({ databaseSizeLocal: async (s) => (s === SCOPE ? 12_288 : -1) });
    const ok = await appWith(host).request(url, { headers: authed() }, ENV);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ bytes: 12_288 });

    expect((await appWith(host).request(url, {}, ENV)).status).toBe(403);
    expect((await appWith(host).request(url, { headers: { [PLATFORM_SECRET_HEADER]: 'nope' } }, ENV)).status).toBe(403);
    expect((await appWith(host).request('/internal/database-size?scopeId=nope', { headers: authed() }, ENV)).status).toBe(400);

    const older = fakeHost();
    const refused = await appWith(older).request(url, { headers: authed() }, ENV);
    expect(refused.status).toBe(501);
    expect((await refused.json()).error).toMatch(/database size/);
  });

  // #618: the journal read is the platform's door to a settled intent's full `last_error`,
  // which lives in THIS deployment's DO. The query string is the filter — parsed here, not
  // trusted onward — so a console can ask for one provider's traffic.
  it('passes the history filter through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/platform-requests/history?tenantId=${TENANT}&scopeId=${SCOPE}&kind=connector:scrive&status=failed&limit=5`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ kind: 'connector:scrive', status: 'failed', limit: 5 }]);
  });

  it('refuses a malformed history filter rather than widening it', async () => {
    const res = await appWith(fakeHost()).request(
      `/internal/platform-requests/history?tenantId=${TENANT}&scopeId=${SCOPE}&status=nonsense`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  // #867: the denial log lives in THIS deployment's DO, so the platform pulls it the same
  // way it pulls the intent journal — and the query string is the filter, parsed here
  // rather than forwarded, because what it narrows is a SQL read of the scope's own log.
  it('passes the denial filter through to the host, on both reads', async () => {
    const host = fakeHost();
    const q = `scopeId=${SCOPE}&actor=${ACTOR_ULID}&permission=perm:use&limit=5`;
    const rows = await appWith(host).request(`/internal/denials?${q}`, { headers: authed() }, ENV);
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual([{ actor: ACTOR_ULID, permission: 'perm:use', limit: 5 }]);
    // The same filter reaches the bucketed read — one spelling, two routes.
    const sum = await appWith(host).request(`/internal/denials/summary?${q}`, { headers: authed() }, ENV);
    expect(sum.status).toBe(200);
    expect(await sum.json()).toEqual({
      buckets: [{ actor: ACTOR_ULID, permission: 'perm:use', limit: 5 }],
    });
  });

  // #1235: one record's history. Scope bytes DO cross here, so the query string is
  // parsed at this door rather than forwarded — what it names is the entity whose
  // payloads come back.
  it('passes the entity and the cursor page through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/history?scopeId=${SCOPE}&entityType=work-order&entityId=${ENTITY}&limit=5&cursor=01JZ0000000000000000EVT001`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        {
          entityType: 'work-order',
          entityId: ENTITY,
          limit: 5,
          cursor: '01JZ0000000000000000EVT001',
        },
      ],
      nextCursor: null,
    });
    // Proof the read went to the HOST, not to an accidentally-empty default.
    expect(host.calls).toContain('entityHistoryLocal');
  });

  // #1239: facets over the scope's outbox. Counts and grouped VALUES cross here, so the
  // query string is parsed at this door rather than forwarded — what it names decides
  // which column, or which payload field, is read out of the spine.
  it('passes the whole facet query through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&field=currency&type=order.placed` +
        `&since=2026-09-01T00:00:00.000Z&until=2026-09-08T00:00:00.000Z&limit=25`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    // The fake echoes its input back as the bucket value, so this is the input the host saw.
    const body = (await res.json()) as { buckets: { value: string }[] };
    expect(JSON.parse(body.buckets[0]!.value)).toEqual({
      groupBy: { kind: 'payload', field: 'currency' },
      type: 'order.placed',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-08T00:00:00.000Z',
      limit: 25,
    });
    expect(host.calls).toContain('facetEventsLocal');
  });

  /**
   * An envelope grouping is a NAMED dimension, not a column name — the route turns
   * `groupBy` into `{ kind }` and the contract's enum is what keeps the query shape
   * fixed. A `field` wins when both are present, which is the transport's one piece of
   * precedence and is pinned here so it cannot drift into the opposite rule.
   */
  it('reads an envelope dimension as a kind, and lets a payload field win over one', async () => {
    const host = fakeHost();
    const dimension = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&groupBy=operation`,
      { headers: authed() },
      ENV,
    );
    const dimensionBody = (await dimension.json()) as { buckets: { value: string }[] };
    expect(JSON.parse(dimensionBody.buckets[0]!.value).groupBy).toEqual({ kind: 'operation' });

    const both = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&groupBy=operation&field=currency`,
      { headers: authed() },
      ENV,
    );
    const bothBody = (await both.json()) as { buckets: { value: string }[] };
    expect(JSON.parse(bothBody.buckets[0]!.value).groupBy).toEqual({ kind: 'payload', field: 'currency' });
  });

  it('refuses a malformed facet input rather than widening it', async () => {
    const host = fakeHost();
    // A dimension the enum does not name — never a column spliced into the query.
    const unknown = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&groupBy=payload_json`,
      { headers: authed() },
      ENV,
    );
    expect(unknown.status).toBe(400);
    // A payload field that is not a bare name — the JSON path is bound, and the name's
    // own pattern is what keeps it one level deep.
    const nested = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&field=order.currency`,
      { headers: authed() },
      ENV,
    );
    expect(nested.status).toBe(400);
    // Over the contract ceiling. Refused at the boundary, never silently clamped.
    const wide = await appWith(host).request(
      `/internal/facets?scopeId=${SCOPE}&groupBy=type&limit=5000`,
      { headers: authed() },
      ENV,
    );
    expect(wide.status).toBe(400);
    expect(host.calls).not.toContain('facetEventsLocal');
  });

  // #1237: the causal walk. Payloads cross here — every step is a history entry — so
  // the query is parsed at this door like the two reads above it: the event id has
  // to be one, and the depth cap is the contract's, refused rather than clamped.
  it('passes the event and the depth cap through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/cause?scopeId=${SCOPE}&eventId=${EVENT}&maxDepth=5`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chain: unknown[]; terminal: string };
    expect(body.chain).toEqual([]);
    // The fake echoes the parsed input as `terminal`: `maxDepth` arrived as a number,
    // not the string the query carried.
    expect(JSON.parse(body.terminal)).toEqual({ eventId: EVENT, maxDepth: 5 });
    expect(host.calls).toContain('eventCauseLocal');
  });

  it('refuses a malformed cause input rather than widening it', async () => {
    const host = fakeHost();
    // No event named — a walk has to start somewhere.
    const bare = await appWith(host).request(`/internal/cause?scopeId=${SCOPE}`, { headers: authed() }, ENV);
    expect(bare.status).toBe(400);
    // Not an id at all.
    const junk = await appWith(host).request(
      `/internal/cause?scopeId=${SCOPE}&eventId=not-an-event`,
      { headers: authed() },
      ENV,
    );
    expect(junk.status).toBe(400);
    // Over the contract ceiling, and below the floor. Neither is clamped.
    for (const depth of ['5000', '0', '-1', 'ten']) {
      const res = await appWith(host).request(
        `/internal/cause?scopeId=${SCOPE}&eventId=${EVENT}&maxDepth=${depth}`,
        { headers: authed() },
        ENV,
      );
      expect(res.status, `maxDepth=${depth}`).toBe(400);
    }
    expect(host.calls).not.toContain('eventCauseLocal');
  });

  // #1237: one call's events. Payloads cross here too, so the id and the cap are parsed at
  // this door — and a missing id is refused, because a read matching nothing-in-particular
  // is the one that would gather every unattributed event under one imaginary call.
  it('passes the invocation and the cap through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/invocation?scopeId=${SCOPE}&invocationId=${EVENT}&limit=5`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    // The fake echoes the parsed input: `limit` arrived as a number, not the query's string.
    expect(await res.json()).toEqual({ events: [{ invocationId: EVENT, limit: 5 }], truncated: false });
    expect(host.calls).toContain('invocationEventsLocal');
  });

  it('refuses a malformed invocation input rather than widening it', async () => {
    const host = fakeHost();
    const bare = await appWith(host).request(`/internal/invocation?scopeId=${SCOPE}`, { headers: authed() }, ENV);
    expect(bare.status).toBe(400);
    for (const limit of ['5000', '0', 'ten']) {
      const res = await appWith(host).request(
        `/internal/invocation?scopeId=${SCOPE}&invocationId=${EVENT}&limit=${limit}`,
        { headers: authed() },
        ENV,
      );
      expect(res.status, `limit=${limit}`).toBe(400);
    }
    expect(host.calls).not.toContain('invocationEventsLocal');
  });

  // #1525: the scope's dead letters. Paged, so the cap and the cursor are parsed at this
  // door — a request for a page bigger than the ceiling is refused, not quietly clipped.
  it('passes the dead-letter page through to the host', async () => {
    const host = fakeHost();
    const cursor = `${EVENT}|@test/doomed`;
    const res = await appWith(host).request(
      `/internal/dead-letters?scopeId=${SCOPE}&limit=5&cursor=${encodeURIComponent(cursor)}`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    // The fake echoes the parsed input: `limit` arrived as a number, the cursor whole.
    expect(await res.json()).toEqual({ entries: [{ limit: 5, cursor }], nextCursor: null });
    expect(host.calls).toContain('deadLettersLocal');
  });

  // #1744: the lifecycle replay. POST — the declaration is the body — and parsed here, so a
  // window that is not an instant, or a machine bigger than any declared, never reaches it.
  const FLOW = {
    entityType: 'conversation',
    lifecycle: { field: 'state', initial: 'new', states: { new: { on: { 'desk/open': 'open' } }, open: { terminal: true } } },
    since: '2026-09-01T00:00:00Z',
    until: '2026-09-08T00:00:00Z',
  };
  const postFlow = (host: VerticalScopeHost, body: unknown) =>
    appWith(host).request(
      '/internal/lifecycle-flow',
      { method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body) },
      ENV,
    );

  it('passes a lifecycle replay through to the host', async () => {
    const host = fakeHost();
    const res = await postFlow(host, { scopeId: SCOPE, ...FLOW });
    expect(res.status).toBe(200);
    // The scope id is the route's; only the replay's own input reaches the host.
    expect(await res.json()).toEqual({ echoed: FLOW });
    expect(host.calls).toContain('lifecycleFlowLocal');
  });

  it('refuses a malformed lifecycle replay rather than running it', async () => {
    const host = fakeHost();
    const huge = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, {}]));
    for (const body of [
      { scopeId: SCOPE, ...FLOW, since: 'last tuesday' },
      { scopeId: SCOPE, ...FLOW, lifecycle: { ...FLOW.lifecycle, states: huge } },
      { ...FLOW },
    ]) {
      expect((await postFlow(host, body)).status).toBe(400);
    }
    expect(host.calls).not.toContain('lifecycleFlowLocal');
  });

  // #1750: business volumes per bucket. POST — the pairs are the body — and parsed here, so
  // a window past the cap or a fractional anchor never reaches the scope.
  const SERIES = {
    moves: [{ entityType: 'conversation', operation: 'desk/close' }],
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-02T00:00:00.000Z',
    bucketMinutes: 30,
  };
  const postSeries = (host: VerticalScopeHost, body: unknown) =>
    appWith(host).request(
      '/internal/operation-series',
      { method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: JSON.stringify(body) },
      ENV,
    );

  it('passes an operation series through to the host, without the scope id', async () => {
    const host = fakeHost();
    const res = await postSeries(host, { scopeId: SCOPE, ...SERIES });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: SERIES });
    expect(host.calls).toContain('operationSeriesLocal');
  });

  it('refuses a malformed operation series rather than running it', async () => {
    const host = fakeHost();
    for (const body of [
      { scopeId: SCOPE, ...SERIES, until: '2026-09-09T00:00:01.000Z' },
      { scopeId: SCOPE, ...SERIES, since: '2026-09-01T00:00:00.500Z' },
      { scopeId: SCOPE, ...SERIES, moves: [] },
      { ...SERIES },
    ]) {
      expect((await postSeries(host, body)).status).toBe(400);
    }
    expect(host.calls).not.toContain('operationSeriesLocal');
  });

  it('refuses a malformed dead-letter page rather than widening it', async () => {
    const host = fakeHost();
    for (const limit of ['5000', '0', 'ten']) {
      const res = await appWith(host).request(
        `/internal/dead-letters?scopeId=${SCOPE}&limit=${limit}`,
        { headers: authed() },
        ENV,
      );
      expect(res.status, `limit=${limit}`).toBe(400);
    }
    expect(host.calls).not.toContain('deadLettersLocal');
  });

  it('refuses a malformed history input rather than widening it', async () => {
    const host = fakeHost();
    // No entity named at all — a history read with no subject would walk the whole outbox.
    const bare = await appWith(host).request(`/internal/history?scopeId=${SCOPE}`, { headers: authed() }, ENV);
    expect(bare.status).toBe(400);
    // Over the contract ceiling. Refused at the boundary, never silently clamped.
    const wide = await appWith(host).request(
      `/internal/history?scopeId=${SCOPE}&entityType=work-order&entityId=${ENTITY}&limit=5000`,
      { headers: authed() },
      ENV,
    );
    expect(wide.status).toBe(400);
    expect(host.calls).not.toContain('entityHistoryLocal');
  });

  // #1686: the operator's capability read. The query string is the filter, decoded by the
  // contracts decoder (the same one the control plane's staff route uses), and the route sits
  // behind the platform secret like every /internal read.
  describe('the capability directory read (#1686)', () => {
    const path = (q = '') => `/internal/capabilities?scopeId=${SCOPE}${q}`;

    it('passes the filter through to the host, decoded', async () => {
      const host = fakeHost();
      const res = await appWith(host).request(
        path('&entityType=folder&entityId=F1&includeRevoked=true&limit=5&cursor=01JZ0000000000000000CPC001'),
        { headers: authed() },
        ENV,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        entries: [{ entity: { entityType: 'folder', entityId: 'F1' }, includeRevoked: true, limit: 5, cursor: '01JZ0000000000000000CPC001' }],
        nextCursor: null,
      });
      // The twin: an unnarrowed read forwards an empty filter, not an invented one.
      const bare = await appWith(host).request(path(), { headers: authed() }, ENV);
      expect(await bare.json()).toEqual({ entries: [{}], nextCursor: null });
    });

    it('is behind the platform secret, and reads nothing without it', async () => {
      const host = fakeHost();
      expect((await appWith(host).request(path(), {}, ENV)).status).toBe(403);
      expect((await appWith(host).request(path(), { headers: { [PLATFORM_SECRET_HEADER]: 'nope' } }, ENV)).status).toBe(403);
      expect(host.calls).not.toContain('listCapabilitiesLocal');
      expect((await appWith(host).request(path(), { headers: authed() }, ENV)).status).toBe(200);
    });

    it('refuses a malformed filter rather than widening it', async () => {
      const host = fakeHost();
      for (const bad of ['&limit=201', '&limit=0', '&cursor=nope', '&entityType=folder', '&entityId=F1', '&includeRevoked=maybe']) {
        const res = await appWith(host).request(path(bad), { headers: authed() }, ENV);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
      expect(host.calls).not.toContain('listCapabilitiesLocal');
    });
  });

  it('refuses a malformed denial filter rather than widening it', async () => {
    // Over the contract ceiling. Refused at the boundary, never silently clamped — the
    // log's volume is attacker-influenceable, so an unbounded read is the wrong default.
    const res = await appWith(fakeHost()).request(
      `/internal/denials?scopeId=${SCOPE}&limit=5000`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it('restore re-projects roles when a tenantId is present', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).toContain('projectRolesLocal');
  });

  it("restore hands the host the dump's source scope and exactness, and nothing when the platform sends none (#1869)", async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      restoreScopeLocal: async (_s, _t, opts) => {
        seen.push([opts?.sourceScopeId, opts?.exact]);
        return { tables: 0 };
      },
    });
    const SOURCE = '01JZ0000000000000000SCP002';
    // The last one is malformed, and refused rather than passed on.
    const cases = [
      [{ sourceScopeId: SOURCE, exact: true }, 200],
      [{}, 200],
      [{ sourceScopeId: 'scope:x' }, 400],
      // `exact` vouches for a named source: without one it is refused, never passed on.
      [{ exact: true }, 400],
    ] as const;
    for (const [extra, status] of cases) {
      const res = await appWith(host).request(
        '/internal/restore',
        {
          method: 'POST',
          headers: authed({ 'content-type': 'application/json' }),
          body: JSON.stringify({ scopeId: SCOPE, tables: [], ...extra }),
        },
        ENV,
      );
      expect(res.status).toBe(status);
    }
    expect(seen).toEqual([
      [SOURCE, true],
      [undefined, undefined],
    ]);
  });

  it('restore skips the role re-projection when no tenantId is given', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).not.toContain('projectRolesLocal');
  });
});

describe('mountPlatformSurface — flavored routes and their hooks', () => {
  it('provision runs the host then the onProvision hook, 201', async () => {
    const host = fakeHost();
    let hooked: string | null = null;
    const res = await appWith(host, {
      onProvision: async (_env, b) => {
        hooked = b.owner;
      },
    }).request(
      '/internal/provision',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(host.calls).toContain('provisionScopeLocal');
    expect(hooked).toBe(OWNER);
  });

  it('provision and reconcile hand the delivered connection grants to the host (#592)', async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      provisionScopeLocal: async (input) => {
        seen.push(input.connectionGrants);
      },
    });
    const grants = [{ connectionId: '01JZ0000000000000000CON001', permission: 'protocol:record-signature' }];
    const provision = await appWith(host).request(
      '/internal/provision',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER, connectionGrants: grants }),
      },
      ENV,
    );
    expect(provision.status).toBe(201);
    const reconcile = await appWith(host, { resolveOwner: async () => OWNER as never }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, connectionGrants: grants }),
      },
      ENV,
    );
    expect(reconcile.status).toBe(200);
    expect(seen).toEqual([grants, grants]);
  });

  /**
   * The repair has to include the vertical's OWN half, or it repairs nothing a vertical
   * created for itself. An install that predates a new service principal has no other
   * route to one: `/internal/provision` is called at install and never again.
   */
  it('reconcile runs onProvision with the resolved owner', async () => {
    const seen: unknown[] = [];
    const res = await appWith(fakeHost(), {
      resolveOwner: async () => OWNER as never,
      onProvision: async (_env, body) => {
        seen.push(body);
      },
    }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    // The owner it was handed is the RE-SOURCED one — the body carries none.
    expect(seen).toEqual([{ tenantId: TENANT, scopeId: SCOPE, owner: OWNER }]);
  });

  it('reconcile 501s when no resolveOwner is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('reconcile 409s when the owner-of-record is missing', async () => {
    const res = await appWith(fakeHost(), { resolveOwner: async () => null }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(409);
  });

  it('reconcile re-provisions with the resolved owner', async () => {
    const host = fakeHost();
    const res = await appWith(host, { resolveOwner: async () => OWNER as never }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('provisionScopeLocal');
  });

  it('delete-scope runs the host then the onDeleteScope hook', async () => {
    const host = fakeHost();
    let forgotten: { scopeId: string; tenantId: string | undefined } | null = null;
    const res = await appWith(host, {
      onDeleteScope: async (_env, scopeId, tenantId) => {
        forgotten = { scopeId, tenantId };
      },
    }).request(
      '/internal/delete-scope',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('deleteScopeLocal');
    expect(forgotten).toEqual({ scopeId: SCOPE, tenantId: TENANT });
  });

  it('still accepts delete-scope requests from older control planes', async () => {
    let tenant: string | undefined = 'not called';
    const res = await appWith(fakeHost(), {
      onDeleteScope: async (_env, _scopeId, tenantId) => { tenant = tenantId; },
    }).request('/internal/delete-scope', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ scopeId: SCOPE }),
    }, ENV);
    expect(res.status).toBe(200);
    expect(tenant).toBeUndefined();
  });

  it('configure 501s when no onConfigure is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('configure runs the onConfigure hook when supplied', async () => {
    let got: number | null = null;
    const res = await appWith(fakeHost(), {
      onConfigure: async (_env, b) => {
        got = b.entries.length;
      },
    }).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(got).toBe(1);
  });
});

describe('mountPlatformSurface — the connector write-back verbs (#574)', () => {
  const CONN = '01JZ0000000000000000CNN001';

  it('connector-invoke: parses, delegates, and envelopes the result', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      connectorInvokeLocal: async (...args: unknown[]) => {
        got = args;
        return { recorded: 2 };
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          connectionId: CONN,
          tenantId: TENANT,
          scopeId: SCOPE,
          operation: 'protocol/record-signature',
          input: { requestId: 'r1' },
        }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { recorded: 2 } });
    expect(got).toEqual([CONN, TENANT, SCOPE, 'protocol/record-signature', { requestId: 'r1' }]);
  });

  it('connector-invoke: an undefined result still answers valid JSON ({ result: null })', async () => {
    const host = fakeHost({ connectorInvokeLocal: async () => undefined });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(await res.json()).toEqual({ result: null });
  });

  it("connector-invoke: the scope DO's permission denial surfaces as 403, not 400", async () => {
    const host = fakeHost({
      connectorInvokeLocal: async () => {
        throw new Error('permission denied: protocol:record-signature');
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('connector-attachment: multipart meta + bytes reach the host intact', async () => {
    let seen: { upload?: { filename: string; contentType: string; body: Uint8Array } } = {};
    const host = fakeHost({
      connectorAttachmentUploadLocal: async (_c, _t, _s, upload) => {
        seen = { upload };
        return { id: 'att1', filename: upload.filename };
      },
    });
    const form = new FormData();
    form.append(
      'meta',
      JSON.stringify({
        connectionId: CONN,
        tenantId: TENANT,
        scopeId: SCOPE,
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'sealed.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
      }),
    );
    form.append('body', new Blob([new TextEncoder().encode('pdf bytes')]), 'sealed.pdf');
    const res = await appWith(host).request(
      '/internal/connector-attachment',
      { method: 'POST', headers: authed(), body: form },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe('att1');
    expect(seen.upload!.filename).toBe('sealed.pdf');
    expect(seen.upload!.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(seen.upload!.body)).toBe('pdf bytes');
  });

  /**
   * The outbound leg (#711): the platform runs this vertical's signing connector
   * and must send the document the VERTICAL rendered, whose bytes live here.
   *
   * Raw bytes in the body with the record in a header, rather than base64 in JSON —
   * a contract is megabytes, and re-encoding it on both ends buys nothing. So the
   * shape of the response is load-bearing, and this is what holds it.
   */
  it('connector-attachment GET: bytes in the body, record in the header', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 the avtal');
    let asked: unknown[] = [];
    const host = fakeHost({
      connectorAttachmentOpenLocal: async (...args: unknown[]) => {
        asked = args;
        return {
          record: {
            id: 'att-1',
            entity: { entityType: 'protocol', entityId: 'p1' },
            filename: 'avtal.pdf',
            contentType: 'application/pdf',
            size: bytes.byteLength,
            sha256: 'a'.repeat(64),
            visibility: 'customer',
            createdBy: CONN,
            createdAt: '2026-08-17T00:00:00.000Z',
          },
          body: bytes,
          contentType: 'application/pdf',
        };
      },
    });
    const q = `connectionId=${CONN}&tenantId=${TENANT}&scopeId=${SCOPE}`;
    const res = await appWith(host).request(
      `/internal/connector-attachment/att-1?${q}`,
      { headers: authed() },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const record = JSON.parse(res.headers.get('x-substrat-attachment')!) as { filename: string };
    expect(record.filename).toBe('avtal.pdf');
    // The id comes from the PATH, and tenant/scope/connection from the query — all
    // four reach the host, so nothing is read from a body the platform never sends.
    // `eventId` is absent here, which is the pre-#726 shape: no delivery named, so the
    // far end falls back to the ordinary grant check rather than admitting anything.
    expect(asked).toEqual([CONN, TENANT, SCOPE, 'att-1', undefined]);
  });

  /**
   * The delivery leg (#726 remedy B). What crosses this seam is the NAME of a delivery,
   * not a claim about which entity the platform may reach — the deployment resolves it
   * against its own outbox — so the only thing the transport has to get right is that
   * the name arrives at all. A dropped `eventId` would silently fall back to the grant
   * check, which is the failure mode worth a test: it looks like it works, right up
   * until the grant is the one that was removed.
   */
  it('connector-attachment GET: carries the delivery through to the host', async () => {
    let asked: unknown[] = [];
    const host = fakeHost({
      connectorAttachmentOpenLocal: async (...args: unknown[]) => {
        asked = args;
        return null;
      },
    });
    const q = `connectionId=${CONN}&tenantId=${TENANT}&scopeId=${SCOPE}&eventId=01JZEVENT`;
    await appWith(host).request(
      `/internal/connector-attachment/att-1?${q}`,
      { headers: authed() },
      ENV,
    );
    expect(asked).toEqual([CONN, TENANT, SCOPE, 'att-1', '01JZEVENT']);
  });

  it('connector-attachment GET: an id this scope does not know is a 404, not an error', async () => {
    // Distinct from a refusal on purpose: `null` lets a connector fall back rather
    // than fail a dispatch over a missing file, and only a 404 can say that without
    // being confused for the vertical being broken.
    const host = fakeHost({ connectorAttachmentOpenLocal: async () => null });
    const q = `connectionId=${CONN}&tenantId=${TENANT}&scopeId=${SCOPE}`;
    const res = await appWith(host).request(
      `/internal/connector-attachment/nope?${q}`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it('connector-attachment: a body-less form is a 400 naming the field', async () => {
    const form = new FormData();
    form.append('meta', JSON.stringify({}));
    const res = await appWith(fakeHost()).request(
      '/internal/connector-attachment',
      { method: 'POST', headers: authed(), body: form },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it('connector-grant: parses and delivers the tuple write', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      connectorGrantLocal: async (...args: unknown[]) => {
        got = args;
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-grant',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, scopeId: SCOPE, permission: 'protocol:record-signature' }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ granted: 'protocol:record-signature', scopeId: SCOPE });
    expect(got).toEqual([CONN, SCOPE, 'protocol:record-signature', undefined]);
  });

  it('connector verbs sit behind the platform-secret gate like the rest of the surface', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(res.status).toBe(403);
  });
});

/**
 * The far end of the schedule kill switch (#1666). A module the scope holds nothing for is
 * a 200 carrying `held: false`, never a 404 — the platform reads a 404 from this path as
 * "the deployment predates the route", and those two must not be confusable.
 */
describe('mountPlatformSurface — the schedule switch (#1666)', () => {
  const post = (host: VerticalScopeHost, body: unknown, headers: Record<string, string> = authed({ 'content-type': 'application/json' })) =>
    appWith(host).request('/internal/system-switch', { method: 'POST', headers, body: JSON.stringify(body) }, ENV);
  const body = { scopeId: SCOPE, moduleId: '@substrat-run/engine-absence', to: 'off' };

  it('parses and hands the switch to the host, answering its outcome verbatim', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      systemSwitchLocal: async (...args: unknown[]) => {
        got = args;
        return { held: true, changed: true, permissions: ['absence:expire-stale'] } as never;
      },
    });
    const res = await post(host, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ held: true, changed: true, permissions: ['absence:expire-stale'] });
    expect(got).toEqual([SCOPE, '@substrat-run/engine-absence', 'off', { tenantHeld: undefined }]);
  });

  it("carries the platform's tenantHeld through to the host (#1823), and refuses one that is not a boolean", async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      systemSwitchLocal: async (...args: unknown[]) => {
        got = args;
        return { held: true, changed: true, permissions: [] } as never;
      },
    });
    expect((await post(host, { ...body, tenantHeld: true })).status).toBe(200);
    expect(got).toEqual([SCOPE, '@substrat-run/engine-absence', 'off', { tenantHeld: true }]);
    got = [];
    expect((await post(host, { ...body, tenantHeld: 'yes' })).status).toBe(400);
    expect(got).toEqual([]);
  });

  it('a module the scope never held is a 200 with held: false, not a 404', async () => {
    const host = fakeHost({ systemSwitchLocal: async () => ({ held: false, changed: false, permissions: [] }) });
    const res = await post(host, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ held: false, changed: false, permissions: [] });
  });

  it('a host without the method answers 501, and nothing is called', async () => {
    const host = fakeHost();
    const res = await post(host, body);
    expect(res.status).toBe(501);
    expect(JSON.stringify(await res.json())).toMatch(/redeploy/);
  });

  it('refuses a position that is neither on nor off', async () => {
    let called = false;
    const host = fakeHost({
      systemSwitchLocal: async () => {
        called = true;
        return { held: true, changed: true, permissions: [] };
      },
    });
    expect((await post(host, { ...body, to: 'paused' })).status).toBe(400);
    expect(called).toBe(false);
  });

  it('sits behind the platform-secret gate like the rest of the surface', async () => {
    let called = false;
    const host = fakeHost({
      systemSwitchLocal: async () => {
        called = true;
        return { held: true, changed: true, permissions: [] };
      },
    });
    expect((await post(host, body, { 'content-type': 'application/json' })).status).toBe(403);
    expect(called).toBe(false);
  });
});

/**
 * The far end of the lifecycle delivery (#1713): the platform pushes a scope's lifecycle here,
 * parsed before the host sees it. 501 for a host without the method, so the platform records a
 * delivery that did not land and its heal sweep asks again.
 */
describe('mountPlatformSurface — the lifecycle delivery (#1713)', () => {
  const post = (host: VerticalScopeHost, body: unknown, headers: Record<string, string> = authed({ 'content-type': 'application/json' })) =>
    appWith(host).request('/internal/lifecycle', { method: 'POST', headers, body: JSON.stringify(body) }, ENV);
  const lifecycle = { scope: 'suspended', tenant: 'active', at: '2026-10-01T00:00:00.000Z', revision: { epoch: 0, scope: 1, tenant: 0 } };
  const body = { scopeId: SCOPE, lifecycle };

  it('parses and hands the lifecycle to the host, answering its outcome verbatim', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      setLifecycleLocal: async (...args: unknown[]) => {
        got = args;
        return { applied: true, changed: true, lifecycle } as never;
      },
    });
    const res = await post(host, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, changed: true, lifecycle });
    // An older platform names no tenant: the host is handed none.
    expect(got).toEqual([SCOPE, lifecycle, undefined]);
  });

  it('#2016: hands the host the tenant the platform names, and answers its tenant refusal 409', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      setLifecycleLocal: async (...args: unknown[]) => {
        got = args;
        throw substratError('conflict', 'lifecycle delivery refused: this scope was provisioned for tenant X, not Y');
      },
    });
    const res = await post(host, { ...body, tenantId: TENANT });
    expect(got).toEqual([SCOPE, lifecycle, TENANT]);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('provisioned for tenant');
  });

  it('a host without the method answers 501', async () => {
    const res = await post(fakeHost(), body);
    expect(res.status).toBe(501);
    expect(JSON.stringify(await res.json())).toMatch(/redeploy/);
  });

  it.each([
    ['a status no scope can hold', { ...lifecycle, scope: 'paused' }],
    ['no read time', { scope: 'suspended', tenant: 'active', revision: { epoch: 0, scope: 1, tenant: 0 } }],
    ['no revision (a delivery must be ordered)', { scope: 'suspended', tenant: 'active', at: '2026-10-01T00:00:00.000Z' }],
    ['a negative revision', { ...lifecycle, revision: { epoch: 0, scope: -1, tenant: 0 } }],
  ])('refuses %s, and calls nothing', async (_name, bad) => {
    let called = false;
    const host = fakeHost({
      setLifecycleLocal: async () => {
        called = true;
        return { applied: true, changed: true, lifecycle } as never;
      },
    });
    expect((await post(host, { scopeId: SCOPE, lifecycle: bad })).status).toBe(400);
    expect(called).toBe(false);
  });

  it('sits behind the platform-secret gate like the rest of the surface', async () => {
    let called = false;
    const host = fakeHost({
      setLifecycleLocal: async () => {
        called = true;
        return { applied: true, changed: true, lifecycle } as never;
      },
    });
    expect((await post(host, body, { 'content-type': 'application/json' })).status).toBe(403);
    expect(called).toBe(false);
  });
});

/**
 * The far end of the schedule kill switch's status read (#1674) — the read half of the
 * #1666 block above. No admin-log join happens here (this deployment holds none), so it
 * answers the bare per-module position `systemGrantsStatusLocal` gives it, verbatim.
 */
describe('mountPlatformSurface — the schedule switch status read (#1674)', () => {
  const get = (host: VerticalScopeHost, scopeId: string = SCOPE, headers: Record<string, string> = authed()) =>
    appWith(host).request(`/internal/system-grants?scopeId=${scopeId}`, { method: 'GET', headers }, ENV);

  it('parses the scope id and hands it to the host, answering its entries verbatim', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      systemGrantsStatusLocal: async (...args: unknown[]) => {
        got = args;
        return [{ moduleId: '@substrat-run/engine-absence', schedules: 'off' }] as never;
      },
    });
    const res = await get(host);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ moduleId: '@substrat-run/engine-absence', schedules: 'off' }]);
    expect(got).toEqual([SCOPE]);
  });

  it('a scope holding nothing is a 200 with an empty array', async () => {
    const host = fakeHost({ systemGrantsStatusLocal: async () => [] });
    const res = await get(host);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a host without the method answers 501, and nothing is called', async () => {
    const host = fakeHost();
    const res = await get(host);
    expect(res.status).toBe(501);
    expect(JSON.stringify(await res.json())).toMatch(/redeploy/);
  });

  it('sits behind the platform-secret gate like the rest of the surface', async () => {
    let called = false;
    const host = fakeHost({
      systemGrantsStatusLocal: async () => {
        called = true;
        return [];
      },
    });
    expect((await get(host, SCOPE, {})).status).toBe(403);
    expect(called).toBe(false);
  });
});

/**
 * The far end of the PEER kill switch's status read (#1706) — the schedule read's twin, and
 * held to the same three things: the scope id is parsed and handed over, the entries come
 * back verbatim (no admin-log join here; this deployment holds none), and a host that
 * predates the method answers a 501 naming the redeploy rather than an empty list, which a
 * control plane would otherwise read as "no peer may call in".
 */
describe('mountPlatformSurface — the peer switch status read (#1706)', () => {
  const get = (host: VerticalScopeHost, scopeId: string = SCOPE, headers: Record<string, string> = authed()) =>
    appWith(host).request(`/internal/peer-grants?scopeId=${scopeId}`, { method: 'GET', headers }, ENV);

  it('parses the scope id and hands it to the host, answering its entries verbatim', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      peerGrantsStatusLocal: async (...args: unknown[]) => {
        got = args;
        return [{ vertical: 'acme/board-room', calls: 'off' }] as never;
      },
    });
    const res = await get(host);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ vertical: 'acme/board-room', calls: 'off' }]);
    expect(got).toEqual([SCOPE]);
  });

  it('a scope no peer holds anything on is a 200 with an empty array', async () => {
    const host = fakeHost({ peerGrantsStatusLocal: async () => [] });
    const res = await get(host);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a host without the method answers 501, and nothing is called', async () => {
    const host = fakeHost();
    const res = await get(host);
    expect(res.status).toBe(501);
    expect(JSON.stringify(await res.json())).toMatch(/redeploy/);
  });

  it('sits behind the platform-secret gate like the rest of the surface', async () => {
    let called = false;
    const host = fakeHost({
      peerGrantsStatusLocal: async () => {
        called = true;
        return [];
      },
    });
    expect((await get(host, SCOPE, {})).status).toBe(403);
    expect(called).toBe(false);
  });
});

/**
 * #113 phase 4: the envelope is a problem document, served as one. `{ error }` survives
 * inside it for one deprecation window (§1) — which is why every assertion above this
 * block still reads.
 */
describe('mountPlatformSurface — the envelope is problem+json', () => {
  it('serves the RFC media type, not application/json', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('FOREIGN KEY constraint failed');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    // An untyped throw: the status is still the caller's 400 (#559), and the body says
    // exactly that much rather than naming a taxonomy entry it cannot vouch for.
    expect(body.type).toBe('about:blank');
    expect(body.code).toBeUndefined();
    expect(body.status).toBe(400);
    expect(body.instance).toBe('/internal/restore');
    expect(body.error).toBe('FOREIGN KEY constraint failed');
  });

  it("renders a vertical's own mapError as a problem body too", async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('this vertical knows what this is');
      },
    });
    const app = appWith(host, { mapError: () => ({ status: 409, message: 'seat taken' }) });
    const res = await app.request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.title).toBe('Conflict');
    expect(body.error).toBe('seat taken');
  });
});

describe('mountPlatformSurface — the owner seat (#925)', () => {
  const REF = { tenantId: TENANT, scopeId: SCOPE };
  const SEAT = {
    state: 'unclaimed',
    owner: OWNER,
    firstSignIn: { open: false, until: '2026-08-28T12:15:00.000Z' },
    claimLink: null,
  } as const;

  it('reads the seat through the hook, and parses what the hook returns on the way out', async () => {
    const seen: unknown[] = [];
    const app = appWith(fakeHost(), {
      ownerSeat: async (_env, ref) => {
        seen.push(ref);
        return SEAT;
      },
    });
    const res = await app.request(
      `/internal/owner-seat?tenantId=${TENANT}&scopeId=${SCOPE}`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SEAT);
    expect(seen).toEqual([REF]);

    // A hook answering a shape the contract does not know is refused HERE — a 400 with the
    // parse's reason, never a half-rendered seat on the dashboard.
    const drifted = appWith(fakeHost(), { ownerSeat: async () => ({ state: 'open' }) as never });
    const bad = await drifted.request(`/internal/owner-seat?tenantId=${TENANT}&scopeId=${SCOPE}`, { headers: authed() }, ENV);
    expect(bad.status).toBe(400);
  });

  it('mints a claim link with the platform-supplied origin, 409s a claimed seat, 501s without the hook', async () => {
    const seen: unknown[] = [];
    const app = appWith(fakeHost(), {
      mintOwnerClaim: async (_env, ref, input) => {
        seen.push({ ref, input });
        return { claimUrl: `${input.origin}/?claim=tok`, expiresAt: '2026-08-28T12:30:00.000Z' };
      },
    });
    const res = await app.request(
      '/internal/owner-claim',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ...REF, origin: 'https://desk.example.test' }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ claimUrl: 'https://desk.example.test/?claim=tok', expiresAt: '2026-08-28T12:30:00.000Z' });
    expect(seen).toEqual([{ ref: REF, input: { origin: 'https://desk.example.test' } }]);

    // The origin is parsed, not forwarded: a bare host is refused before the hook runs.
    const bareHost = await app.request(
      '/internal/owner-claim',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, origin: 'desk.example.test' }) },
      ENV,
    );
    expect(bareHost.status).toBe(400);
    expect(seen).toHaveLength(1);

    // The platform actor who asked is forwarded when the control plane names one (#1686) — and
    // parsed, so a body naming something that is not a platform actor id is refused.
    const ACTOR = '01J00000000000000000000ACT';
    const withActor = await app.request(
      '/internal/owner-claim',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, origin: 'https://desk.example.test', actor: ACTOR }) },
      ENV,
    );
    expect(withActor.status).toBe(201);
    expect(seen[1]).toEqual({ ref: REF, input: { origin: 'https://desk.example.test', actor: ACTOR } });
    const badActor = await app.request(
      '/internal/owner-claim',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, origin: 'https://desk.example.test', actor: 'someone' }) },
      ENV,
    );
    expect(badActor.status).toBe(400);
    expect(seen).toHaveLength(2);

    // Already claimed: the hook says null, the surface says 409 with the reason.
    const claimed = appWith(fakeHost(), { mintOwnerClaim: async () => null });
    const conflict = await claimed.request(
      '/internal/owner-claim',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, origin: 'https://desk.example.test' }) },
      ENV,
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toMatch(/already claimed/);

    // No hook at all: both routes are honestly unimplemented.
    const none = appWith(fakeHost());
    expect((await none.request(`/internal/owner-seat?tenantId=${TENANT}&scopeId=${SCOPE}`, { headers: authed() }, ENV)).status).toBe(501);
    expect(
      (
        await none.request(
          '/internal/owner-claim',
          { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, origin: 'https://desk.example.test' }) },
          ENV,
        )
      ).status,
    ).toBe(501);
  });

  it('is behind the platform-secret gate like every other /internal route', async () => {
    const app = appWith(fakeHost(), { ownerSeat: async () => SEAT });
    expect((await app.request(`/internal/owner-seat?tenantId=${TENANT}&scopeId=${SCOPE}`, {}, ENV)).status).toBe(403);
    expect((await app.request('/internal/owner-claim', { method: 'POST' }, ENV)).status).toBe(403);
  });
});

/**
 * #1742: the platform carries the record's off list on provision, reconcile and restore, and
 * the host switches those modules off inside the unit that re-creates the scope's grants.
 * The list names modules only. The scope it applies to is the one the request provisions or
 * restores, so no body can aim it anywhere else.
 */
describe('mountPlatformSurface — the recorded-off list rides provision, reconcile and restore (#1742)', () => {
  const SCHED = '@test/sched';
  const OTHER_SCOPE = '01JZ0000000000000000SCP002';
  const moved = { moduleId: SCHED, held: true, changed: true, permissions: ['sched:tick'] };
  const post = (host: VerticalScopeHost, path: string, body: unknown) =>
    appWith(host, { resolveOwner: async () => OWNER as never }).request(
      path,
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(body) },
      ENV,
    );
  /** A host that records what the provision and restore halves were handed, and answers a move. */
  const recording = () => {
    const seen: { verb: string; scopeId: string; switchedOff: unknown; tenantHeld?: unknown }[] = [];
    const host = fakeHost({
      provisionScopeLocal: async (input) => {
        seen.push({ verb: 'provision', scopeId: input.scopeId, switchedOff: input.switchedOff, tenantHeld: input.tenantHeld });
        return input.switchedOff ? { switchedOff: [moved] } : undefined;
      },
      restoreScopeLocal: async (scopeId, _tables, opts) => {
        seen.push({ verb: 'restore', scopeId, switchedOff: opts?.switchedOff, tenantHeld: opts?.tenantHeld });
        return { tables: 0, ...(opts?.switchedOff ? { switchedOff: [moved] } : {}) };
      },
    });
    return { host, seen };
  };

  it("hands the list to the host with the request's own scope, and answers what the unit moved", async () => {
    const { host, seen } = recording();
    const provision = await post(host, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER, switchedOff: [SCHED] });
    expect(provision.status).toBe(201);
    expect(await provision.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER, switchedOff: [moved] });
    const reconcile = await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE, switchedOff: [SCHED] });
    expect(await reconcile.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER, switchedOff: [moved] });
    const restore = await post(host, '/internal/restore', { tenantId: TENANT, scopeId: SCOPE, tables: [], switchedOff: [SCHED] });
    expect(await restore.json()).toEqual({ tables: 0, switchedOff: [moved] });
    expect(seen).toEqual([
      { verb: 'provision', scopeId: SCOPE, switchedOff: [SCHED] },
      { verb: 'provision', scopeId: SCOPE, switchedOff: [SCHED] },
      { verb: 'restore', scopeId: SCOPE, switchedOff: [SCHED] },
    ]);
  });

  it('hands the host the tenant-held modules beside the list, on all three routes (#1823)', async () => {
    const { host, seen } = recording();
    const carry = { switchedOff: [SCHED], tenantHeld: [SCHED] };
    await post(host, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER, ...carry });
    await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE, ...carry });
    await post(host, '/internal/restore', { tenantId: TENANT, scopeId: SCOPE, tables: [], ...carry });
    expect(seen.map((x) => x.tenantHeld)).toEqual([[SCHED], [SCHED], [SCHED]]);
    // A malformed one is refused before the host is called.
    const bad = await post(host, '/internal/restore', { scopeId: SCOPE, tables: [], switchedOff: [SCHED], tenantHeld: 'all' });
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(3);
  });

  it('a body without the list hands the host none, and the answer carries none — the pre-#1742 shape', async () => {
    const { host, seen } = recording();
    const reconcile = await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE });
    expect(await reconcile.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER });
    const restore = await post(host, '/internal/restore', { scopeId: SCOPE, tables: [] });
    expect(await restore.json()).toEqual({ tables: 0 });
    expect(seen.map((s) => s.switchedOff)).toEqual([undefined, undefined]);
  });

  it('cannot be aimed at another scope: an entry naming a scope is refused before the host is called', async () => {
    const { host, seen } = recording();
    for (const path of ['/internal/provision', '/internal/reconcile', '/internal/restore']) {
      const res = await post(host, path, {
        tenantId: TENANT,
        scopeId: SCOPE,
        owner: OWNER,
        tables: [],
        switchedOff: [{ scopeId: OTHER_SCOPE, moduleId: SCHED }],
      });
      expect(res.status, path).toBe(400);
    }
    // A field beside it naming another scope is stripped, never read: the host still sees
    // only the request's own scope.
    await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE, switchedOffScopeId: OTHER_SCOPE, switchedOff: [SCHED] });
    expect(seen).toEqual([{ verb: 'provision', scopeId: SCOPE, switchedOff: [SCHED] }]);
  });

  it('an older host that ignores the list answers without one, so the platform falls back to its re-assert', async () => {
    const host = fakeHost(); // provisionScopeLocal → void, restoreScopeLocal → { tables: 3 }
    const reconcile = await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE, switchedOff: [SCHED] });
    expect(await reconcile.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER });
    const restore = await post(host, '/internal/restore', { scopeId: SCOPE, tables: [], switchedOff: [SCHED] });
    expect(await restore.json()).toEqual({ tables: 3 });
  });

  // Parsed on the way out, but the operation has already committed by then: a report that
  // does not parse is left out of a successful answer, never relayed, and never turned into
  // a failure of the provision, reconcile or restore that succeeded.
  it('a host reporting a malformed move still answers success, without the field', async () => {
    const malformed = [{ moduleId: SCHED, held: 'yes' }] as never;
    const host = fakeHost({
      provisionScopeLocal: async () => ({ switchedOff: malformed }),
      restoreScopeLocal: async () => ({ tables: 2, switchedOff: malformed }),
    });
    const reconcile = await post(host, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE, switchedOff: [SCHED] });
    expect(reconcile.status).toBe(200);
    expect(await reconcile.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER });
    const provision = await post(host, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER, switchedOff: [SCHED] });
    expect(provision.status).toBe(201);
    expect(await provision.json()).toEqual({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER });
    const restore = await post(host, '/internal/restore', { scopeId: SCOPE, tables: [], switchedOff: [SCHED] });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toEqual({ tables: 2 });
  });
});

/**
 * The owner hand-over (#1665). Four writes in two Durable Objects with no transaction across
 * them, so what these pin is the ORDER (record, seat `to`, revoke `from`, close), that every
 * refusal is decided before anything is written, that a failure at any step leaves one owner of
 * record, at least one live owner seat, and a state the same request completes on retry, and
 * that once closed, a repeat writes nothing.
 *
 * The directory and the host share one in-memory model here, so the assertions read the
 * scope's state rather than which mocks were called. The directory's rules are vertical-auth
 * owner-seat.ts `transferOwner` / `completeOwnerTransfer`, in the same order.
 */
describe('mountPlatformSurface — the owner hand-over (#1665)', () => {
  const A = '01JZ0000000000000000PRNAAA';
  const B = '01JZ0000000000000000PRNBBB';
  const C = '01JZ0000000000000000PRNCCC';
  const STRANGER = '01JZ0000000000000000PRNZZZ';
  const REF = { tenantId: TENANT, scopeId: SCOPE };
  type Step = 'record' | 'assign' | 'revoke' | 'complete';

  /** One scope's owner state: the record, the last hand-over, members, owner-role holders. */
  function world(
    init: { record?: string | null; claimed?: boolean; members?: string[]; seats?: string[]; roles?: string[] } = {},
  ) {
    const w = {
      record: init.record === undefined ? A : init.record,
      last: null as null | { from: string; to: string; state: 'pending' | 'done' | 'abandoned' },
      claimed: init.claimed ?? true,
      members: new Set(init.members ?? [A, B, C]),
      seats: new Set(init.seats ?? [A]),
      /** Who holds SOME live role in the scope (a member role), besides the owner seats. */
      roles: new Set(init.roles ?? [A, B, C]),
      steps: [] as string[],
      /** Throw on the named step, once — the failure "between" steps. */
      failOn: null as null | Step,
    };
    const failIf = (step: Step) => {
      if (w.failOn === step) {
        w.failOn = null;
        throw new Error(`injected failure at ${step}`);
      }
    };
    const transferOwner = async (
      _env: Env,
      _ref: unknown,
      { from, to, toHoldsRole }: { from: string; to: string; toHoldsRole: boolean },
    ) => {
      w.steps.push('record');
      failIf('record');
      if (w.record === null) return { outcome: 'refused', owner: null, reason: 'unknown' } as const;
      if (!w.claimed) return { outcome: 'refused', owner: w.record, reason: 'unclaimed' } as const;
      const member = toHoldsRole && w.members.has(to);
      if (w.last?.state === 'pending') {
        const inFlight = { from: w.last.from, to: w.last.to };
        if (w.last.from !== from || w.last.to !== to) {
          return { outcome: 'refused', owner: w.record, reason: 'in-flight', inFlight } as const;
        }
        if (!member) return { outcome: 'refused', owner: w.record, reason: 'wedged', inFlight } as const;
        return { outcome: 'already', owner: to } as const;
      }
      if (!w.members.has(to)) return { outcome: 'refused', owner: w.record, reason: 'not-member' } as const;
      if (!toHoldsRole) return { outcome: 'refused', owner: w.record, reason: 'no-role' } as const;
      if (w.record === to) {
        if (w.last?.from === from && w.last.to === to && w.last.state === 'done') return { outcome: 'done', owner: to } as const;
        return { outcome: 'refused', owner: w.record, reason: 'not-owner' } as const;
      }
      if (w.record !== from) return { outcome: 'refused', owner: w.record, reason: 'not-owner' } as const;
      w.record = to;
      w.last = { from, to, state: 'pending' };
      return { outcome: 'transferred', owner: to } as const;
    };
    const completeOwnerTransfer = async (_env: Env, _ref: unknown, { from, to }: { from: string; to: string }) => {
      w.steps.push('complete');
      failIf('complete');
      if (w.last?.state !== 'pending' || w.last.from !== from || w.last.to !== to) return false;
      w.last.state = 'done';
      return true;
    };
    const abandonOwnerTransfer = async (
      _env: Env,
      _ref: unknown,
      { from, to, toHoldsRole }: { from: string; to: string; toHoldsRole: boolean },
    ) => {
      w.steps.push('abandon');
      if (w.last?.state !== 'pending' || w.last.from !== from || w.last.to !== to) return 'not-open' as const;
      if (toHoldsRole && w.members.has(to)) return 'healthy' as const;
      w.last.state = 'abandoned';
      return 'abandoned' as const;
    };
    const host = fakeHost({
      assignScopeRole: async (_s, principal, roleKey) => {
        w.steps.push(`assign ${principal} ${roleKey}`);
        failIf('assign');
        w.seats.add(principal);
      },
      revokeScopeRole: async (_s, principal, roleKey) => {
        w.steps.push(`revoke ${principal} ${roleKey}`);
        failIf('revoke');
        return w.seats.delete(principal);
      },
      hasScopeRoleLocal: async (_t, _s, principal) => w.roles.has(principal) || w.seats.has(principal),
    });
    const app = appWith(host, {
      transferOwner: transferOwner as never,
      completeOwnerTransfer,
      abandonOwnerTransfer,
      resolveOwner: async () => w.record as never,
    });
    const send = (body: unknown) =>
      app.request(
        '/internal/owner-transfer',
        { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(body) },
        ENV,
      );
    const state = () => ({ record: w.record, seats: [...w.seats].sort(), last: w.last });
    return { w, host, app, send, state };
  }

  it('moves the record, seats `to`, revokes `from`, then closes the hand-over — in that order', async () => {
    const { w, send, state } = world();
    const res = await send({ ...REF, from: A, to: B });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scopeId: SCOPE, from: A, owner: B, outcome: 'transferred', fromRevoked: true });
    expect(w.steps).toEqual(['record', `assign ${B} admin`, `revoke ${A} admin`, 'complete']);
    expect(state()).toEqual({ record: B, seats: [B], last: { from: A, to: B, state: 'done' } });
  });

  it('a repeat of a finished hand-over is a 200 that seats and revokes nothing', async () => {
    const { w, send, state } = world();
    await send({ ...REF, from: A, to: B });
    // Since then the scope decided to give A the owner role back. A stale resend must not undo it.
    w.seats.add(A);
    w.steps = [];
    const again = await send({ ...REF, from: A, to: B });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ scopeId: SCOPE, from: A, owner: B, outcome: 'done', fromRevoked: false });
    expect(w.steps).toEqual(['record']);
    expect(state().seats).toEqual([A, B].sort());
  });

  it("refuses a `from` other than the one the record was handed from — and revokes nobody (review MAJOR)", async () => {
    // Record = B after A → B, and C also holds the owner role. `{ from: C, to: B }` finds the
    // record naming `to`, but it is not the hand-over the record came from, so it is no retry.
    const { w, send, state } = world({ seats: [A, C] });
    expect((await send({ ...REF, from: A, to: B })).status).toBe(200);
    w.steps = [];
    const res = await send({ ...REF, from: C, to: B });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not owned by `from`/);
    expect(w.steps).toEqual(['record']);
    expect(state().seats).toEqual([B, C].sort()); // C still holds its seat
    // Also while the A → B hand-over is still OPEN: only its own retry is `already`.
    const open = world({ seats: [A, C] });
    open.w.failOn = 'revoke';
    expect((await open.send({ ...REF, from: A, to: B })).ok).toBe(false);
    open.w.steps = [];
    expect((await open.send({ ...REF, from: C, to: B })).status).toBe(409);
    expect(open.w.steps).toEqual(['record']);
    expect(open.state().seats).toEqual([A, B, C].sort());
  });

  it('refuses a hand-over chained onto one still open, and takes it once that one is finished', async () => {
    const { w, send, state } = world();
    w.failOn = 'revoke'; // A → B stops with both seated, the hand-over open
    expect((await send({ ...REF, from: A, to: B })).ok).toBe(false);
    w.steps = [];
    const chained = await send({ ...REF, from: B, to: C });
    expect(chained.status).toBe(409);
    expect(((await chained.json()) as { error: string }).error).toMatch(new RegExp(`in flight.*${A} → ${B}`));
    expect(w.steps).toEqual(['record']);
    expect(state().seats).toEqual([A, B].sort());
    // The open one first, then the chained one: each revokes exactly its own `from`.
    expect((await send({ ...REF, from: A, to: B })).status).toBe(200);
    expect((await send({ ...REF, from: B, to: C })).status).toBe(200);
    expect(state()).toEqual({ record: C, seats: [C], last: { from: B, to: C, state: 'done' } });
  });

  it('a hand-over wedged by removing `to` stays refused — and an abandon clears it for a fresh one', async () => {
    const { w, send, state } = world();
    w.failOn = 'assign'; // step 1 ran, step 2 did not
    expect((await send({ ...REF, from: A, to: B })).ok).toBe(false);
    // While B can still take it, it is not wedged: an abandon is refused — resend it instead.
    const healthy = await send({ ...REF, from: A, to: B, abandon: true });
    expect(healthy.status).toBe(409);
    expect(((await healthy.json()) as { error: string }).error).toMatch(/can still finish — resend it instead/);
    expect(w.last?.state).toBe('pending');
    w.roles.delete(B); // then the tenant removes B
    w.steps = [];
    // The resend is refused and names the stuck hand-over; nothing is seated.
    const resend = await send({ ...REF, from: A, to: B });
    expect(resend.status).toBe(409);
    expect(((await resend.json()) as { error: string }).error).toMatch(/can no longer finish.*abandon it/);
    // A fresh hand-over is stuck behind it too.
    const fresh = await send({ ...REF, from: B, to: C });
    expect(fresh.status).toBe(409);
    expect(((await fresh.json()) as { error: string }).error).toMatch(/in flight/);
    expect(w.steps).toEqual(['record', 'record']);
    expect(state()).toEqual({ record: B, seats: [A], last: { from: A, to: B, state: 'pending' } });
    // The twin of the abandon: a pair that is not the open one is refused, and closes nothing.
    expect((await send({ ...REF, from: B, to: C, abandon: true })).status).toBe(409);
    // The abandon: closed, and nothing seated or revoked.
    w.steps = [];
    const abandoned = await send({ ...REF, from: A, to: B, abandon: true });
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toEqual({ scopeId: SCOPE, from: A, owner: B, outcome: 'abandoned', fromRevoked: false });
    expect(w.steps).toEqual(['abandon']);
    expect(state()).toEqual({ record: B, seats: [A], last: { from: A, to: B, state: 'abandoned' } });
    // A second abandon of it is refused: it is closed.
    expect((await send({ ...REF, from: A, to: B, abandon: true })).status).toBe(409);
    // From the record, a fresh hand-over goes through. A keeps the seat it never lost: an
    // abandon revokes nothing, and the next owner removes it in the app.
    expect((await send({ ...REF, from: B, to: C })).status).toBe(200);
    expect(state().record).toBe(C);
    expect(state().seats).toEqual([A, C].sort());
  });

  it('a close that finds the hand-over no longer open is a logged 500 — writes happened — not a quiet 200', async () => {
    const { w, host, send } = world();
    // An abandon lands between the revoke and the close.
    const revoke = host.revokeScopeRole!;
    host.revokeScopeRole = async (s, p, r) => {
      const out = await revoke(s, p, r);
      if (w.last) w.last.state = 'abandoned';
      return out;
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await send({ ...REF, from: A, to: B });
      expect(res.status).toBe(500); // never 409, which says nothing was written
      expect(((await res.json()) as { error: string }).error).toMatch(/no longer open to close/);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^owner-transfer: .*no longer open to close/));
    } finally {
      logged.mockRestore();
    }
  });

  it('two hand-overs racing from one owner: one wins, the other is refused, and one owner is seated', async () => {
    const { send, state } = world();
    const [toB, toC] = await Promise.all([send({ ...REF, from: A, to: B }), send({ ...REF, from: A, to: C })]);
    expect([toB.status, toC.status].sort()).toEqual([200, 409]);
    const winner = toB.status === 200 ? B : C;
    expect(state()).toEqual({ record: winner, seats: [winner], last: { from: A, to: winner, state: 'done' } });
  });

  it.each([
    ['a `from` that is not the owner of record', { record: STRANGER }, /not owned by `from`/],
    ['an unclaimed seat', { claimed: false }, /claim it first/],
    ['a `to` no subject is bound to', { members: [A] }, /no login in it is bound to `to`/],
    ['a bound `to` holding no role', { roles: [A] }, /holding no role here — grant `to` a role first/],
    ['a scope with no owner of record', { record: null }, /no owner of record/],
  ])('refuses %s with 409, and no seat moves', async (_label, init, message) => {
    const { w, send, state } = world(init);
    const before = state();
    const res = await send({ ...REF, from: A, to: B });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(w.steps).toEqual(['record']); // decided at the record, before any seat write
    expect(state()).toEqual(before);
  });

  it('refuses a `to` still bound but whose role was taken back — before anything is written', async () => {
    const { w, send, state } = world({ roles: [A] }); // B signs in, but holds no role any more
    const before = state();
    const res = await send({ ...REF, from: A, to: B });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/holding no role here/);
    expect(w.steps).toEqual(['record']); // the directory decided, on the host's read, and wrote nothing
    expect(state()).toEqual(before);
    // The twin: give B a role back, and the same request goes through.
    w.roles.add(B);
    expect((await send({ ...REF, from: A, to: B })).status).toBe(200);
    expect(state().record).toBe(B);
  });

  it('refuses a malformed body before the directory is reached', async () => {
    const { w, send } = world();
    for (const body of [
      { ...REF, from: A, to: A }, // one principal on both sides
      { ...REF, from: A }, // no `to`
      { ...REF, from: A, to: 'not-a-principal' },
      { ...REF, from: A, to: B, owner: STRANGER }, // strict: nothing else rides along
    ]) {
      expect((await send(body)).status).toBe(400);
    }
    expect(w.steps).toEqual([]);
    expect(w.record).toBe(A);
  });

  it('a hook answering an owner other than `to` stops before any seat moves', async () => {
    const { w, host } = world();
    const app = appWith(host, {
      transferOwner: async () => ({ outcome: 'transferred', owner: STRANGER }) as never,
      completeOwnerTransfer: async () => true,
    });
    const res = await app.request(
      '/internal/owner-transfer',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, from: A, to: B }) },
      ENV,
    );
    expect(res.status).toBe(500);
    expect(w.steps).toEqual([]);
    expect([...w.seats]).toEqual([A]);
  });

  it.each([
    // [the step that fails, the state it leaves, the retry's outcome and fromRevoked]
    ['record', { record: A, seats: [A], last: null }, 'transferred', true],
    ['assign', { record: B, seats: [A], last: { from: A, to: B, state: 'pending' } }, 'already', true],
    ['revoke', { record: B, seats: [A, B].sort(), last: { from: A, to: B, state: 'pending' } }, 'already', true],
    ['complete', { record: B, seats: [B], last: { from: A, to: B, state: 'pending' } }, 'already', false],
  ] as const)(
    'a failure at the %s step leaves one owner of record and a live owner seat — and the retry completes',
    async (step, left, outcome, fromRevoked) => {
      const { w, send, state } = world();
      w.failOn = step;
      expect((await send({ ...REF, from: A, to: B })).ok).toBe(false); // the envelope's status, never a 2xx
      expect(state()).toEqual(left);
      expect(state().seats.length).toBeGreaterThan(0);
      const retry = await send({ ...REF, from: A, to: B });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome, fromRevoked });
      expect(state()).toEqual({ record: B, seats: [B], last: { from: A, to: B, state: 'done' } });
    },
  );

  it('after a hand-over, a reconcile re-sources the NEW owner — never the one it replaced', async () => {
    const { host, app, send } = world();
    const provisioned: unknown[] = [];
    host.provisionScopeLocal = async (input) => {
      provisioned.push(input.owner);
    };
    await send({ ...REF, from: A, to: B });
    const reconcile = await app.request(
      '/internal/reconcile',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(REF) },
      ENV,
    );
    expect(reconcile.status).toBe(200);
    expect(provisioned).toEqual([B]);
  });

  it('after a hand-over, a re-PROVISION seats the new owner, not the one the platform minted', async () => {
    const { host, app, send } = world();
    const seated: unknown[] = [];
    host.provisionScopeLocal = async (input) => {
      seated.push(input.owner);
    };
    const provision = () =>
      app.request(
        '/internal/provision',
        { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, owner: A }) },
        ENV,
      );
    expect((await provision()).status).toBe(201); // the install: the record names A
    await send({ ...REF, from: A, to: B });
    const again = await provision(); // the platform re-runs it with the principal it minted: A
    expect(again.status).toBe(201);
    expect(((await again.json()) as { owner: string }).owner).toBe(B);
    expect(seated).toEqual([A, B]);
  });

  it('…and its twin: a scope with no owner of record yet seats the owner the platform sent', async () => {
    const { host, app } = world({ record: null });
    const seated: unknown[] = [];
    host.provisionScopeLocal = async (input) => {
      seated.push(input.owner);
    };
    const res = await app.request(
      '/internal/provision',
      { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, owner: A }) },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(seated).toEqual([A]);
  });

  it('501s without either hook, and without the host verbs — before the record is touched', async () => {
    const REQ = { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ ...REF, from: A, to: B }) };
    const touched: unknown[] = [];
    const begin = async () => {
      touched.push(1);
      return { outcome: 'transferred', owner: B } as never;
    };
    expect((await appWith(fakeHost()).request('/internal/owner-transfer', REQ, ENV)).status).toBe(501);
    expect((await appWith(fakeHost(), { transferOwner: begin }).request('/internal/owner-transfer', REQ, ENV)).status).toBe(501);
    const oldHost = appWith(fakeHost(), { transferOwner: begin, completeOwnerTransfer: async () => true });
    const res = await oldHost.request('/internal/owner-transfer', REQ, ENV);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/redeploy/);
    expect(touched).toEqual([]);
  });

  it('is behind the platform-secret gate — and its twin with the secret gets through', async () => {
    const { w, app } = world();
    const body = JSON.stringify({ ...REF, from: A, to: B });
    const headers = { 'content-type': 'application/json' };
    expect((await app.request('/internal/owner-transfer', { method: 'POST', headers, body }, ENV)).status).toBe(403);
    const wrong = { ...headers, [PLATFORM_SECRET_HEADER]: 'not-the-secret' };
    expect((await app.request('/internal/owner-transfer', { method: 'POST', headers: wrong, body }, ENV)).status).toBe(403);
    expect(w.steps).toEqual([]);
    const right = { ...headers, [PLATFORM_SECRET_HEADER]: SECRET };
    expect((await app.request('/internal/owner-transfer', { method: 'POST', headers: right, body }, ENV)).status).toBe(200);
  });
});

/**
 * #2005: the platform marks a scope its directory says is not primary as a copy, in the scope's
 * own storage, where a CP-less coordinator reads it for primacy. Two doors: a flag on the restore
 * a carry already makes, and a verb of its own for the repair over existing copies.
 */
describe('marking a copy (#2005)', () => {
  const post = (
    host: VerticalScopeHost,
    path: string,
    body: unknown,
    headers: Record<string, string> = authed({ 'content-type': 'application/json' }),
  ) => appWith(host).request(path, { method: 'POST', headers, body: JSON.stringify(body) }, ENV);
  const PREVIEW = { kind: 'preview', forkedFrom: null };
  const INSTALL = { kind: 'scope', forkedFrom: null };

  it("the restore hands the directory's classification to the host, and a body without it hands none", async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      restoreScopeLocal: async (_s, _t, opts) => {
        seen.push(opts?.markCopy);
        return { tables: 0 };
      },
    });
    expect((await post(host, '/internal/restore', { scopeId: SCOPE, tables: [], markCopy: PREVIEW })).status).toBe(200);
    expect((await post(host, '/internal/restore', { scopeId: SCOPE, tables: [] })).status).toBe(200);
    expect(seen).toEqual([PREVIEW, undefined]);
    // The old boolean shape carries no classification, so it is refused rather than guessed.
    expect((await post(host, '/internal/restore', { scopeId: SCOPE, tables: [], markCopy: true })).status).toBe(400);
  });

  for (const [path, verb] of [['/internal/mark-copy', 'markCopyLocal'], ['/internal/clear-copy-mark', 'clearCopyMarkLocal']] as const) {
    it(`${path} hands the host the request's scope and classification, and answers what it did`, async () => {
      const asked: unknown[] = [];
      const host = fakeHost({
        [verb]: async (scopeId: string, lineage: unknown) => {
          asked.push([scopeId, lineage]);
          return verb === 'markCopyLocal' ? { marked: false } : { cleared: false };
        },
      } as Partial<VerticalScopeHost>);
      const lineage = verb === 'markCopyLocal' ? PREVIEW : INSTALL;
      const res = await post(host, path, { scopeId: SCOPE, lineage });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(verb === 'markCopyLocal' ? { marked: false } : { cleared: false });
      expect(asked).toEqual([[SCOPE, lineage]]);
    });

    it(`${path} refuses a body with no classification, and a caller without the platform secret`, async () => {
      const host = fakeHost();
      expect((await post(host, path, { scopeId: SCOPE })).status).toBe(400);
      expect((await post(host, path, { scopeId: SCOPE, lineage: PREVIEW }, { 'content-type': 'application/json' })).status).toBe(403);
      expect(host.calls).not.toContain(verb);
    });
  }
});

/**
 * The platform's scope sweeper (#1902): `mountPlatformSurface` hands it the vertical's host
 * and keeps its roster — but only when the upload says it supplied one.
 */
describe('mountPlatformSurface — the platform-supplied sweeper (#1902)', () => {
  type SweepEnv = Env & Record<string, unknown>;
  /** A namespace whose singleton records what the surface told it. */
  function sweeperNamespace() {
    const told: string[] = [];
    const named: string[] = [];
    return {
      told,
      named,
      idFromName: (name: string) => (named.push(name), name),
      get: () => ({
        noteScope: async (t: string, s: string) => void told.push(`note ${t} ${s}`),
        forgetScope: async (s: string) => void told.push(`forget ${s}`),
      }),
    };
  }
  const call = (app: Hono<{ Bindings: Env }>, path: string, body: unknown, env: SweepEnv) =>
    app.request(path, { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(body) }, env);

  it('notes a provisioned and a reconciled scope, after the vertical’s hook, and forgets a deleted one', async () => {
    const ns = sweeperNamespace();
    const env: SweepEnv = { ...ENV, SUBSTRAT_SCOPE_SWEEPER: 'SWEEPER', SWEEPER: ns };
    const order: string[] = [];
    const app = appWith(fakeHost(), {
      resolveOwner: async () => OWNER as never,
      onProvision: async () => void order.push(`hook (roster: ${ns.told.length})`),
    });
    expect((await call(app, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER }, env)).status).toBe(201);
    expect((await call(app, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE }, env)).status).toBe(200);
    expect((await call(app, '/internal/delete-scope', { tenantId: TENANT, scopeId: SCOPE }, env)).status).toBe(200);
    expect(ns.told).toEqual([`note ${TENANT} ${SCOPE}`, `note ${TENANT} ${SCOPE}`, `forget ${SCOPE}`]);
    // The hook ran before each note: a scope whose provision throws in the hook is never swept.
    expect(order).toEqual(['hook (roster: 0)', 'hook (roster: 1)']);
    expect(ns.named).toEqual(['scope-sweeper', 'scope-sweeper', 'scope-sweeper']);
  });

  it('a provision whose hook throws leaves the scope off the roster', async () => {
    const ns = sweeperNamespace();
    const app = appWith(fakeHost(), {
      onProvision: async () => {
        throw new Error('the vertical half failed');
      },
    });
    const res = await call(app, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER }, {
      ...ENV,
      SUBSTRAT_SCOPE_SWEEPER: 'SWEEPER',
      SWEEPER: ns,
    });
    expect(res.ok).toBe(false);
    expect(ns.told).toEqual([]);
  });

  it('touches nothing when the upload supplied no sweeper — a vertical’s own SWEEPER is its hooks’ business', async () => {
    const ns = sweeperNamespace();
    const app = appWith(fakeHost(), { resolveOwner: async () => OWNER as never });
    const env: SweepEnv = { ...ENV, SWEEPER: ns };
    expect((await call(app, '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER }, env)).status).toBe(201);
    expect((await call(app, '/internal/reconcile', { tenantId: TENANT, scopeId: SCOPE }, env)).status).toBe(200);
    expect((await call(app, '/internal/delete-scope', { tenantId: TENANT, scopeId: SCOPE }, env)).status).toBe(200);
    expect(ns.told).toEqual([]);
  });

  it('says so when the var names a binding the script does not have', async () => {
    const res = await call(appWith(fakeHost()), '/internal/provision', { tenantId: TENANT, scopeId: SCOPE, owner: OWNER }, {
      ...ENV,
      SUBSTRAT_SCOPE_SWEEPER: 'SWEEPER',
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(await res.json())).toMatch(/names the binding 'SWEEPER', but this script has no Durable Object namespace/);
  });

  it('registers the vertical’s hostFor where the platform’s copy of the reader finds it', () => {
    const host = fakeHost();
    const hostFor = vi.fn(() => host);
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, { platformSecret: (env) => env.PLATFORM_SECRET, hostFor, roles: [], ownerRoleKey: 'admin' });
    // Read the way the generated sweeper does: the global symbol, not this module's export.
    const registered = (globalThis as unknown as Record<symbol, (env: unknown) => unknown>)[Symbol.for('substrat.scope-sweep-host')];
    expect(registered).toBe(hostFor);
    expect(registeredScopeSweepHost()).toBe(hostFor);
    expect(registered!(ENV)).toBe(host);
  });
});

/**
 * #2016: the copy verbs carry the tenant the platform copies for, so the scope that receives the
 * bytes records its own tenant. Absent from an older platform, and then the host is called as before.
 */
describe('mountPlatformSurface — the copy verbs carry the tenant (#2016)', () => {
  const NEW = '01JZ0000000000000000SCP002';
  const post = (host: VerticalScopeHost, path: string, body: unknown) =>
    appWith(host).request(path, { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify(body) }, ENV);

  it('a snapshot hands the host the tenant, and an older platform\'s none', async () => {
    const seen: unknown[][] = [];
    const host = fakeHost({
      snapshotScopeLocal: async (...args: unknown[]) => {
        seen.push(args);
        return { tables: 3 };
      },
    });
    expect((await post(host, '/internal/snapshot', { sourceScopeId: SCOPE, newScopeId: NEW, tenantId: TENANT })).status).toBe(201);
    expect((await post(host, '/internal/snapshot', { sourceScopeId: SCOPE, newScopeId: NEW })).status).toBe(201);
    expect(seen).toEqual([[SCOPE, NEW, TENANT], [SCOPE, NEW, undefined]]);
  });

  it('a restore hands the host the tenant it then repairs for, and an older platform\'s none', async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      restoreScopeLocal: async (_s: unknown, _t: unknown, opts?: unknown) => {
        seen.push((opts as { tenantId?: string }).tenantId);
        return { tables: 0 };
      },
    });
    expect((await post(host, '/internal/restore', { tenantId: TENANT, scopeId: SCOPE, tables: [] })).status).toBe(200);
    expect((await post(host, '/internal/restore', { scopeId: SCOPE, tables: [] })).status).toBe(200);
    expect(seen).toEqual([TENANT, undefined]);
  });
});
