import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { BACKFILL_MOVE_ID, carriedAwayDump, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  reapScopeScriptCopies,
  UNSAFE_devPlatformActorAuth,
  type CopyBackfillPage,
  type VerticalClient,
} from '../src/index.js';

/**
 * The copy-ledger backfill (#1722), on the pure adapter. Every scope here moves through direct
 * directory writes, the way scopes moved before the ledger existed: the admin log names each
 * script, the ledger names none. The backfill must find them, record them `retained`, report what
 * it cannot resolve as a failure, write nothing on a dry run or a re-run, and never touch a store.
 * The workerd twin is in adapter-cloudflare `preview-carry.test.ts`.
 */
describe('the copy-ledger backfill records historic copies (#1722)', () => {
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const slug = 'backfill-vert';

  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const storesOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  /** Every call a deployment took that could change a store. None is expected. */
  const writes: string[] = [];
  const unreachable = new Set<string>();
  const deployment = (ref: string): VerticalClient =>
    ({
      readScopeTable: async (sid: string) => {
        const meta = storesOf(ref).get(sid)?.find((tb) => tb.name === '_substrat_meta');
        return { table: '_substrat_meta', columns: meta?.columns ?? ['key', 'value'], rows: meta?.rows ?? [] };
      },
      wipeCarriedCopy: async () => { writes.push(`wipe ${ref}`); return { wiped: true }; },
      deleteScope: async () => { writes.push(`delete ${ref}`); },
      restoreScope: async () => { writes.push(`restore ${ref}`); return { tables: 0 }; },
    }) as unknown as VerticalClient;

  const versions: Record<string, { id: string; ref: string | null }> = {};
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const notes: ScopeDumpTable[] = [{ name: 'notes', ddl: 'CREATE TABLE notes(id TEXT)', columns: ['id'], rows: [['n1']] }];

  const backfill = async (body: object): Promise<CopyBackfillPage> => {
    const res = await app.request('/scope-copies/backfill', { method: 'POST', headers: asStaff, body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as CopyBackfillPage;
  };
  /** Walk the whole log, page by page, as an operator does. */
  const backfillAll = async (dryRun: boolean, limit = 2) => {
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
  const ledgerOf = async (sid: ScopeId) =>
    (await host.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: sid }))
      .map(({ scriptRef, moveId, state }) => ({ scriptRef, moveId, state }));
  const provision = async () => {
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sid, vertical: slug });
    return sid;
  };

  let moved: ScopeId; // v1 → v2 → serving: two historic copies, the route on the serving script
  let wiped: ScopeId; // v1 → v2, v1's store holds a wipe's tombstone
  let orphan: ScopeId; // bound to a version later dropped from the registry, and to a script-less one
  let reaped: ScopeId; // bound, then its directory row deleted

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-copy-backfill-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)) });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
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
    const v = (name: string) => versions[name]!;

    moved = await provision();
    await host.admin.bindScopeVersion(staff, t, moved, v('v1').id);
    storesOf(v('v1').ref!).set(moved, notes);
    await host.admin.bindScopeVersion(staff, t, moved, v('v2').id);
    storesOf(v('v2').ref!).set(moved, notes);
    await host.admin.setScopeServingRef(staff, t, moved, `${slug}-serving`);
    await host.admin.shredSubject(staff, t, moved, 'subject-1'); // an erasure before the backfill

    wiped = await provision();
    await host.admin.bindScopeVersion(staff, t, wiped, v('v1').id);
    storesOf(v('v1').ref!).set(wiped, carriedAwayDump({ to: v('v2').ref!, at: new Date().toISOString() }));
    await host.admin.bindScopeVersion(staff, t, wiped, v('v2').id);

    orphan = await provision();
    await host.admin.bindScopeVersion(staff, t, orphan, v('gone').id);
    await host.admin.bindScopeVersion(staff, t, orphan, v('bare').id);
    await host.admin.bindScopeVersion(staff, t, orphan, v('v2').id);
    // The registry forgets `gone`, as a deleted vertical's versions are: only the log still names it.
    const raw = new Database(join(dir, '_directory.sqlite'));
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM vertical_versions WHERE id = ?').run(v('gone').id);
    raw.close();

    reaped = scopeId.parse(ulid());
    await host.importScope(staff, { tenantId: t, scopeId: reaped, kind: 'snapshot', vertical: slug },
      { scopeId: moved, capturedAt: new Date().toISOString(), tables: [] });
    await host.admin.bindScopeVersion(staff, t, reaped, v('v1').id);
    await host.deleteSnapshot(staff, t, reaped);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a dry run reports every historic copy and every failure, and writes nothing', async () => {
    const pages = await backfillAll(true);
    expect(pages.every((p) => p.dryRun)).toBe(true);
    expect(entriesOf(pages, moved).map((e) => [e.scriptRef, e.outcome])).toEqual(expect.arrayContaining([
      [versions.v1!.ref, 'would-record'], [versions.v2!.ref, 'would-record'], [`${slug}-serving`, 'route'],
    ]));
    expect(entriesOf(pages, wiped).map((e) => [e.scriptRef, e.outcome]))
      .toEqual([[versions.v1!.ref, 'wiped'], [versions.v2!.ref, 'route']]);
    expect(pages.flatMap((p) => p.erasedBefore)).toContainEqual({ tenantId: t, scopeId: moved });
    for (const sid of [moved, wiped, orphan]) expect(await ledgerOf(sid)).toEqual([]);
    expect(await host.admin.listOpsFailures(staff, { operation: 'scope.copy-backfill' })).toEqual([]);
  });

  it('records each historic copy as retained, never the route and never a wiped store', async () => {
    const pages = await backfillAll(false);
    expect(entriesOf(pages, moved).filter((e) => e.outcome === 'recorded').map((e) => e.scriptRef).sort())
      .toEqual([versions.v1!.ref, versions.v2!.ref].sort());
    expect((await ledgerOf(moved)).sort((a, b) => a.scriptRef.localeCompare(b.scriptRef))).toEqual(
      [versions.v1!.ref!, versions.v2!.ref!].sort().map((scriptRef) => ({ scriptRef, moveId: BACKFILL_MOVE_ID, state: 'retained' })),
    );
    expect(await ledgerOf(wiped)).toEqual([]);
    // Nothing reached a store but the marker read.
    expect(writes).toEqual([]);
    expect(storesOf(versions.v1!.ref!).get(moved)).toEqual(notes);
    expect(storesOf(versions.v2!.ref!).get(moved)).toEqual(notes);
  });

  it('reports an unresolvable entry as a failure, with an ops record, and records nothing for it', async () => {
    const pages = await backfillAll(false);
    const failures = pages.flatMap((p) => p.entries).filter((e) => e.outcome === 'failure');
    expect(entriesOf(pages, orphan).filter((e) => e.outcome === 'failure').map((e) => e.reason)).toEqual([
      expect.stringContaining(`version ${versions.gone!.id} of '${slug}' is not in the registry`),
      expect.stringContaining(`version ${versions.bare!.id} of '${slug}' names no deployment script`),
    ]);
    expect(entriesOf(pages, reaped)).toEqual([expect.objectContaining({
      scriptRef: versions.v1!.ref, outcome: 'failure', reason: expect.stringContaining('no directory row'),
    })]);
    expect(await ledgerOf(orphan)).toEqual([]);
    const recorded = await host.admin.listOpsFailures(staff, { operation: 'scope.copy-backfill', limit: 100 });
    expect(recorded.filter((f) => f.scopeId === orphan || f.scopeId === reaped).length).toBeGreaterThanOrEqual(failures.length);
    expect(recorded.every((f) => f.stage === 'unresolved')).toBe(true);
  });

  it('a re-run records nothing new and still reports every failure', async () => {
    const before = await Promise.all([moved, wiped, orphan].map(ledgerOf));
    const pages = await backfillAll(false, 50);
    expect(pages.flatMap((p) => p.entries).some((e) => e.outcome === 'recorded')).toBe(false);
    expect(entriesOf(pages, moved).filter((e) => e.scriptRef !== `${slug}-serving`).map((e) => e.outcome))
      .toEqual(['ledgered', 'ledgered']);
    expect(entriesOf(pages, orphan).filter((e) => e.outcome === 'failure')).toHaveLength(2);
    expect(await Promise.all([moved, wiped, orphan].map(ledgerOf))).toEqual(before);
    expect(writes).toEqual([]);
  });

  it('an unreachable script is still recorded, unchecked: only a tombstone lets a script off', async () => {
    const sid = await provision();
    await host.admin.bindScopeVersion(staff, t, sid, versions.v1!.id);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v2!.id);
    unreachable.add(versions.v1!.ref!);
    try {
      const pages = await backfillAll(false, 50);
      expect(entriesOf(pages, sid)).toContainEqual(expect.objectContaining({
        scriptRef: versions.v1!.ref, outcome: 'recorded', reason: expect.stringContaining('recorded unchecked'),
      }));
      expect(await ledgerOf(sid)).toEqual([{ scriptRef: versions.v1!.ref, moveId: BACKFILL_MOVE_ID, state: 'retained' }]);
    } finally {
      unreachable.delete(versions.v1!.ref!);
    }
  });

  it('a scope under a reap claim is refused, and reported as a failure the reap will not reach', async () => {
    const sid = await provision();
    await host.admin.bindScopeVersion(staff, t, sid, versions.v1!.id);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v2!.id);
    await host.admin.beginScopeScriptReap(staff, t, sid);
    const pages = await backfillAll(false, 50);
    expect(entriesOf(pages, sid)).toContainEqual(expect.objectContaining({
      scriptRef: versions.v1!.ref, outcome: 'failure', reason: expect.stringContaining('being reaped'),
    }));
    expect(await ledgerOf(sid)).toEqual([]);
  });

  it('a recorded copy is reached by the reap, which drains it', async () => {
    await reapScopeScriptCopies({ admin: host.admin, actor: staff, resolveRef: async (ref) => deployment(ref) }, t, moved);
    expect(writes).toEqual(expect.arrayContaining([`delete ${versions.v1!.ref}`, `delete ${versions.v2!.ref}`]));
    expect((await ledgerOf(moved)).map((c) => c.state)).toEqual(['done', 'done']);
  });
});
