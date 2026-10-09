import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { BACKFILL_MOVE_ID, carriedAwayDump, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  reapScopeScriptCopies,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type CopyBackfillPage,
  type VerticalClient,
} from '../src/index.js';

/**
 * The copy-ledger backfill (#1722), on the pure adapter. Every scope here moves through direct
 * directory writes, the way scopes moved before the ledger existed: the admin log names each
 * script, the ledger names none. The backfill must derive each scope's real homes from its own
 * timeline (its pins, its binds while unpinned, the script its slug was born into, a fork's
 * source's route), record them `retained`, report what it cannot derive as a failure, read no
 * store on a dry run and no store that was never a home, and never write to one.
 * The workerd twin is in adapter-cloudflare `preview-carry.test.ts`.
 */
describe('the copy-ledger backfill records historic copies (#1722)', () => {
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const slug = 'backfill-vert';
  const serving = `${slug}-serving`;
  const TENANT_SECRET = 'backfill-tenant-token-secret';
  const PUSH_SECRET = 'backfill-push-token-secret';

  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const storesOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  /** Every store a deployment was asked to read, as `ref scope`, and every call that could write. */
  const reads: string[] = [];
  const writes: string[] = [];
  const unreachable = new Set<string>();
  const deployment = (ref: string): VerticalClient =>
    ({
      readScopeTable: async (sid: string) => {
        reads.push(`${ref} ${sid}`);
        const meta = storesOf(ref).get(sid)?.find((tb) => tb.name === '_substrat_meta');
        return { table: '_substrat_meta', columns: meta?.columns ?? ['key', 'value'], rows: meta?.rows ?? [] };
      },
      wipeCarriedCopy: async () => { writes.push(`wipe ${ref}`); return { wiped: true }; },
      deleteScope: async () => { writes.push(`delete ${ref}`); },
      restoreScope: async () => { writes.push(`restore ${ref}`); return { tables: 0 }; },
    }) as unknown as VerticalClient;

  const versions: Record<string, { id: string; ref: string | null }> = {};
  const refOf = (name: string) => versions[name]!.ref!;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  const notes: ScopeDumpTable[] = [{ name: 'notes', ddl: 'CREATE TABLE notes(id TEXT)', columns: ['id'], rows: [['n1']] }];

  const post = (body: unknown, headers: Record<string, string> = asStaff) =>
    app.request('/scope-copies/backfill', { method: 'POST', headers, body: JSON.stringify(body) });
  const backfill = async (body: object): Promise<CopyBackfillPage> => {
    const res = await post(body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as CopyBackfillPage;
  };
  /** Walk the whole log, page by page, as an operator does. */
  const backfillAll = async (dryRun: boolean, limit = 3) => {
    const pages: CopyBackfillPage[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await backfill({ dryRun, limit, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      if (page.done) return pages;
      cursor = page.nextCursor!;
    }
  };
  const entriesOf = (pages: CopyBackfillPage[], sid: string) =>
    pages.flatMap((p) => p.entries).filter((e) => e.scopeId === sid);
  /** The distinct (script, outcome) pairs a walk reported for one scope. */
  const outcomesOf = (pages: CopyBackfillPage[], sid: string) =>
    [...new Set(entriesOf(pages, sid).map((e) => `${e.scriptRef} ${e.outcome}`))].sort();
  const ledgerOf = async (sid: ScopeId) =>
    (await host.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: sid }))
      .map(({ scriptRef, moveId, state }) => ({ scriptRef, moveId, state }))
      .sort((a, b) => a.scriptRef.localeCompare(b.scriptRef));
  const retained = (...refs: string[]) =>
    refs.sort().map((scriptRef) => ({ scriptRef, moveId: BACKFILL_MOVE_ID, state: 'retained' }));
  /** Two writes the backfill orders against each other by time alone must not share a millisecond. */
  const tick = () => new Promise((r) => setTimeout(r, 3));
  const provision = async () => {
    await tick();
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sid, vertical: slug });
    return sid;
  };

  let moved: ScopeId; // born by slug on v1, bound v1 → v2, then pinned to the serving script
  let neverBound: ScopeId; // born by slug on v1, never bound; prod moved to v2 after
  let fork: ScopeId; // a fork of `neverBound`, taken once prod was v2
  let wiped: ScopeId; // v1 → v2, v1's store holds a wipe's tombstone
  let orphan: ScopeId; // bound to a version later dropped from the registry, and to a script-less one
  let reaped: ScopeId; // bound, then its directory row deleted
  let pinned: ScopeId; // born pinned to the serving script, bound across v1 and v2 by promotes

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-copy-backfill-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)) });
    const serviceActor = platformActorId.parse(ulid());
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
      platformBaseDomains: ['global.substrat.run'],
      resolveVerticalRef: async (ref: string) => unreachable.has(ref) ? undefined : deployment(ref),
    });
    await host.admin.createTenant(staff, { id: t, slug: 'backfill-co', name: 'Backfill Co' });
    await host.admin.registerVertical(staff, { slug, name: 'Backfill Vert', source: 'cli', ownerTenant: t });
    for (const [name, version, hasRef] of [['v1', '1.0.0', true], ['v2', '1.0.1', true], ['gone', '1.0.2', true], ['bare', '1.0.3', false]] as const) {
      const id = ulid();
      const ref = hasRef ? `${slug}-${id.toLowerCase()}` : null;
      await host.admin.publishVersion(staff, {
        id, verticalSlug: slug, version, manifestDigest: `m-${name}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
      });
      versions[name] = { id, ref };
    }
    const v = (name: string) => versions[name]!.id;
    await host.admin.promoteVersion(staff, slug, 'prod', v('v1'));
    await tick();

    moved = await provision();
    storesOf(refOf('v1')).set(moved, notes);
    await host.admin.bindScopeVersion(staff, t, moved, v('v1'));
    await host.admin.bindScopeVersion(staff, t, moved, v('v2'));
    storesOf(refOf('v2')).set(moved, notes);
    await host.admin.setScopeServingRef(staff, t, moved, serving);
    await host.admin.shredSubject(staff, t, moved, 'subject-1'); // an erasure before the backfill

    neverBound = await provision();
    storesOf(refOf('v1')).set(neverBound, notes);
    await tick();
    await host.admin.promoteVersion(staff, slug, 'prod', v('v2'));
    await tick();
    fork = scopeId.parse(ulid());
    await host.importScope(staff, { tenantId: t, scopeId: fork, kind: 'snapshot', vertical: slug, forkedFrom: neverBound },
      { scopeId: neverBound, capturedAt: new Date().toISOString(), tables: [] });

    wiped = await provision();
    await host.admin.bindScopeVersion(staff, t, wiped, v('v1'));
    storesOf(refOf('v1')).set(wiped, carriedAwayDump({ to: refOf('v2'), at: new Date().toISOString() }));
    await host.admin.bindScopeVersion(staff, t, wiped, v('v2'));

    orphan = await provision();
    await host.admin.bindScopeVersion(staff, t, orphan, v('gone'));
    await host.admin.bindScopeVersion(staff, t, orphan, v('bare'));
    await host.admin.bindScopeVersion(staff, t, orphan, v('v2'));
    // The registry forgets `gone`, as a deleted vertical's versions are: only the log still names it.
    const raw = new Database(join(dir, '_directory.sqlite'));
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM vertical_versions WHERE id = ?').run(v('gone'));
    raw.close();

    reaped = scopeId.parse(ulid());
    await host.importScope(staff, { tenantId: t, scopeId: reaped, kind: 'snapshot', vertical: slug },
      { scopeId: moved, capturedAt: new Date().toISOString(), tables: [] });
    await host.admin.bindScopeVersion(staff, t, reaped, v('v1'));
    await host.deleteSnapshot(staff, t, reaped);

    // From here the vertical serves in place: a new install is born pinned, and a promote moves only
    // its version pointer (`api.ts`'s private-vertical promote), routing nothing to either version.
    await tick();
    await host.admin.setVerticalServing(staff, slug, { ref: serving, versionId: v('v2'), doClasses: [], migrationTag: 't1' });
    pinned = await provision();
    await host.admin.bindScopeVersion(staff, t, pinned, v('v1'));
    await host.admin.bindScopeVersion(staff, t, pinned, v('v2'));

    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: t }) });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'backfill-co' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is staff only, and a dry run unless the body says otherwise', async () => {
    expect((await post({}, asTenant)).status).toBe(403);
    expect((await post({}, asBuilder)).status).toBe(403);
    expect((await post({ dryRun: 'false' })).status).toBe(400);
    const page = await backfill({});
    expect(page.dryRun).toBe(true);
    expect(page.counts.recorded).toBe(0);
    for (const sid of [moved, neverBound, fork, wiped, orphan, pinned]) expect(await ledgerOf(sid)).toEqual([]);
  });

  it('a dry run derives every historic home and every failure, and reads no store', async () => {
    reads.length = 0;
    const pages = await backfillAll(true);
    expect(pages.every((p) => p.dryRun)).toBe(true);
    expect(reads).toEqual([]);
    expect(outcomesOf(pages, moved)).toEqual([
      `${refOf('v1')} would-record`, `${refOf('v2')} would-record`, `${serving} route`,
    ].sort());
    // Born by slug while prod was v1; prod moving on later does not move its store.
    expect(outcomesOf(pages, neverBound)).toEqual([`${refOf('v1')} would-record`]);
    // A fork is born where its source was routed when it was taken: by slug, to prod's v2 then.
    expect(outcomesOf(pages, fork)).toEqual([`${refOf('v2')} would-record`]);
    // A pinned scope's binds routed nothing: no per-version candidate at all.
    expect(entriesOf(pages, pinned)).toEqual([]);
    for (const sid of [moved, neverBound, fork, wiped, orphan, pinned]) expect(await ledgerOf(sid)).toEqual([]);
    expect(await host.admin.listOpsFailures(staff, { operation: 'scope.copy-backfill' })).toEqual([]);
    expect(pages.flatMap((p) => p.erasedBefore)).toEqual([]); // nothing is backfilled yet
  });

  it('records each derived home as retained, never the route, a wiped store or a pinned bind', async () => {
    reads.length = 0;
    const pages = await backfillAll(false);
    expect(await ledgerOf(moved)).toEqual(retained(refOf('v1'), refOf('v2')));
    expect(await ledgerOf(neverBound)).toEqual(retained(refOf('v1')));
    expect(await ledgerOf(fork)).toEqual(retained(refOf('v2')));
    expect(await ledgerOf(wiped)).toEqual([]); // v1 wiped; v2, where it was born by slug, is the route
    expect(outcomesOf(pages, wiped)).toEqual([`${refOf('v1')} wiped`, `${refOf('v2')} route`]);
    expect(await ledgerOf(pinned)).toEqual([]);
    // Only derived homes were read, and the pinned scope's version scripts never were.
    expect(reads.filter((r) => r.endsWith(pinned))).toEqual([]);
    expect(writes).toEqual([]);
    expect(storesOf(refOf('v1')).get(moved)).toEqual(notes);
    // Each recorded entry is audited once.
    expect((await host.admin.auditLog(staff, { scopeId: moved, action: 'backfillScopeCopy' })).length).toBe(2);
  });

  it('reports an unresolvable entry as a failure, with an ops record, and records nothing for it', async () => {
    const pages = await backfillAll(false);
    expect(entriesOf(pages, orphan).filter((e) => e.outcome === 'failure').map((e) => e.reason)).toEqual([
      expect.stringContaining(`version ${versions.gone!.id} of '${slug}' is not in the registry`),
      expect.stringContaining(`version ${versions.bare!.id} of '${slug}' names no deployment script`),
    ]);
    expect(entriesOf(pages, reaped).every((e) => e.outcome === 'failure' && e.reason!.includes('no directory row'))).toBe(true);
    expect(entriesOf(pages, reaped).length).toBeGreaterThan(0);
    expect(await ledgerOf(orphan)).toEqual([]); // born by slug on v2, its route; the rest are failures
    const recorded = await host.admin.listOpsFailures(staff, { operation: 'scope.copy-backfill', limit: 200 });
    expect(recorded.some((f) => f.scopeId === orphan && f.stage === 'unresolved')).toBe(true);
    expect(recorded.some((f) => f.scopeId === reaped && f.stage === 'unresolved')).toBe(true);
  });

  it('every run reports the subjects erased before a scope was backfilled, until they are erased again', async () => {
    const first = await backfillAll(false, 50);
    expect(first.flatMap((p) => p.erasedBefore)).toEqual([{ tenantId: t, scopeId: moved, subjects: ['subject-1'] }]);
    const dry = await backfillAll(true, 50);
    expect(dry.flatMap((p) => p.erasedBefore)).toEqual([{ tenantId: t, scopeId: moved, subjects: ['subject-1'] }]);
    expect((await host.admin.listOpsFailures(staff, { operation: 'scope.copy-backfill', limit: 200 }))
      .some((f) => f.scopeId === moved && f.stage === 'erased-before')).toBe(true);
    await host.admin.shredSubject(staff, t, moved, 'subject-1'); // the operator erases again
    expect((await backfillAll(true, 50)).flatMap((p) => p.erasedBefore)).toEqual([]);
  });

  it('a re-run records nothing new and still reports every failure', async () => {
    const before = await Promise.all([moved, neverBound, fork, wiped, orphan].map(ledgerOf));
    const pages = await backfillAll(false, 50);
    expect(pages.flatMap((p) => p.entries).some((e) => e.outcome === 'recorded')).toBe(false);
    expect(outcomesOf(pages, moved)).toEqual([`${refOf('v1')} ledgered`, `${refOf('v2')} ledgered`, `${serving} route`].sort());
    expect(entriesOf(pages, orphan).filter((e) => e.outcome === 'failure')).toHaveLength(2);
    expect(await Promise.all([moved, neverBound, fork, wiped, orphan].map(ledgerOf))).toEqual(before);
    expect(writes).toEqual([]);
  });

  it('a script no deployment answers for is a failure, never an unchecked entry', async () => {
    const sid = await provision(); // born pinned now: its pin is the route
    await host.admin.setScopeServingRef(staff, t, sid, null);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v1!.id);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v2!.id);
    unreachable.add(refOf('v1'));
    try {
      const pages = await backfillAll(false, 50);
      expect(entriesOf(pages, sid)).toContainEqual(expect.objectContaining({
        scriptRef: refOf('v1'), outcome: 'failure', reason: expect.stringContaining('no deployment resolves'),
      }));
      expect(await ledgerOf(sid)).toEqual(retained(serving)); // the birth pin it left; v2 is the route
    } finally {
      unreachable.delete(refOf('v1'));
    }
  });

  it('a scope under a reap claim is refused, and reported as a failure the reap will not reach', async () => {
    const sid = await provision();
    await host.admin.setScopeServingRef(staff, t, sid, null);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v1!.id);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v2!.id);
    await host.admin.beginScopeScriptReap(staff, t, sid);
    const pages = await backfillAll(false, 50);
    expect(entriesOf(pages, sid)).toContainEqual(expect.objectContaining({
      scriptRef: refOf('v1'), outcome: 'failure', reason: expect.stringContaining('being reaped'),
    }));
    expect(await ledgerOf(sid)).toEqual([]);
  });

  it('a slug that moved in the same millisecond as a birth is a failure, not a guess', async () => {
    const tie = 'tie-vert';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.006Z'));
    let sid: ScopeId;
    try {
      await host.admin.registerVertical(staff, { slug: tie, name: 'Tie Vert', source: 'cli', ownerTenant: t });
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: tie, version: '1.0.0', manifestDigest: 'm-tie', permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: `${tie}-${id.toLowerCase()}`,
      });
      await host.admin.promoteVersion(staff, tie, 'prod', id);
      sid = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sid, vertical: tie });
    } finally {
      vi.useRealTimers();
    }
    const pages = await backfillAll(true, 50);
    expect(entriesOf(pages, sid!)).toEqual([expect.objectContaining({
      outcome: 'failure', reason: expect.stringContaining('same millisecond'),
    })]);
  });

  it('a recorded copy is reached by the reap, which drains it', async () => {
    await reapScopeScriptCopies({ admin: host.admin, actor: staff, resolveRef: async (ref) => deployment(ref) }, t, moved);
    expect(writes).toEqual(expect.arrayContaining([`delete ${refOf('v1')}`, `delete ${refOf('v2')}`]));
    expect((await ledgerOf(moved)).map((c) => c.state)).toEqual(['done', 'done']);
  });
});
