import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergeDumpPages, scopeId, type ScopeDumpPage, type ScopeDumpSample, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';
import { SCOPE_WORK_POINTS } from './worker.js';

declare const __PROBE_SAMPLED_COPY__: boolean;

/**
 * #3232 on workerd: a preview fork that copies a sample, read by the Durable Object itself. The
 * references are the ones its tables declare (`pragma_foreign_key_list`), the newest rows are fixed
 * by the first page, and the capture's catch-up reads the same sample: a write it keeps lands, and a
 * row that leaves it is deleted at the destination.
 */
const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

/** owners → lists → items; each list and item announced by one outbox event. */
const world = (owners: number, listsPer: number, itemsPer: number): ScopeDumpTable[] => {
  const pad = (n: number) => String(n).padStart(4, '0');
  const lists: unknown[][] = [];
  for (let k = 0; k < listsPer; k++) for (let o = 0; o < owners; o++) lists.push([`l${pad(o)}-${k}`, `o${pad(o)}`, `list ${k} of ${o}`]);
  const items: unknown[][] = [];
  for (let i = 0; i < itemsPer; i++) for (const [list] of lists) items.push([`${list as string}-i${i}`, list, `item ${i} `.repeat(4)]);
  return [
    { name: 'sp_owners', ddl: 'CREATE TABLE sp_owners (id TEXT PRIMARY KEY, name TEXT)', columns: ['id', 'name'], rows: Array.from({ length: owners }, (_, o) => [`o${pad(o)}`, `owner ${o}`]), objects: [] },
    { name: 'sp_lists', ddl: 'CREATE TABLE sp_lists (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES sp_owners(id), title TEXT)', columns: ['id', 'owner_id', 'title'], rows: lists, objects: [] },
    { name: 'sp_items', ddl: 'CREATE TABLE sp_items (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES sp_lists(id), body TEXT)', columns: ['id', 'list_id', 'body'], rows: items, objects: [] },
  ];
};

type TestStub = { testSql(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> };

describe('a sampled copy, read by the Durable Object (#3232)', () => {
  let host: CloudflareScopeHost;
  beforeAll(async () => {
    await warmControlPlane(env.PC_CONTROL_PLANE);
    host = new CloudflareScopeHost({ scope: env.PC_V1_SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
  });
  const sql = (sid: ScopeId, query: string, ...bindings: unknown[]) =>
    (env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as TestStub).testSql(query, ...bindings);

  const seed = async (owners: number, listsPer: number, itemsPer: number): Promise<ScopeId> => {
    const sid = scopeId.parse(ulid());
    await host.restoreScopeLocal(sid, world(owners, listsPer, itemsPer), { sourceScopeId: sid });
    for (const [table, type] of [['sp_lists', 'list'], ['sp_items', 'item']] as const) {
      await sql(
        sid,
        `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor, entity_type, entity_id, pii_class)
         SELECT 'e-' || id, 'sp.made', 1, '2026-11-01T00:00:00.000Z', 'tenant', ?, '"actor"', ?, id, 'none' FROM ${table}`,
        sid, type,
      );
    }
    return sid;
  };

  /** Every page of a sampled copy of `sid`, each read under the plan the first answered. */
  const pages = async (sid: ScopeId, rows: number, opts: { capture?: string; afterFirst?: () => Promise<unknown> } = {}) => {
    const out: ScopeDumpPage[] = [];
    let plan: ScopeDumpSample = { rows };
    let cursor: string | null = null;
    do {
      const page: ScopeDumpPage = await host.exportScopePageLocal(sid, cursor, { maxBytes: 600, sample: plan, ...(opts.capture ? { capture: opts.capture } : {}) });
      expect(page.sample?.floors).toBeDefined();
      plan = page.sample!;
      out.push(page);
      if (out.length === 1) await opts.afterFirst?.();
      cursor = page.next;
    } while (cursor !== null);
    return { pages: out, plan };
  };
  const rowsOf = (tables: ScopeDumpTable[], name: string) => tables.find((t) => t.name === name)?.rows ?? [];

  it('reads rows that reference only rows it kept, the events about them, and counts them before it starts', async () => {
    const source = await seed(10, 3, 4);
    const { pages: read } = await pages(source, 5);
    expect(read.length).toBeGreaterThan(2);
    const dump = mergeDumpPages(read.map((p) => p.tables));
    const owners = rowsOf(dump, 'sp_owners').map((r) => r[0]);
    const lists = rowsOf(dump, 'sp_lists');
    const items = rowsOf(dump, 'sp_items');
    expect(owners).toHaveLength(5);
    expect(lists).toHaveLength(5);
    expect(items).toHaveLength(5);
    expect(lists.every((l) => owners.includes(l[1]))).toBe(true);
    expect(items.every((i) => lists.some((l) => l[0] === i[1]))).toBe(true);
    const events = rowsOf(dump, '_substrat_outbox').filter((e) => e[1] === 'sp.made').map((e) => e[8]);
    expect(events.sort()).toEqual([...lists, ...items].map((r) => r[0]).sort());
    // The estimate is the copy's own count, under the same sample, and whole without one.
    const rowsIn = (tables: ScopeDumpTable[]) => tables.reduce((n, t) => n + t.rows.length, 0);
    expect((await host.estimateScopeCopyLocal(source, { sample: { rows: 5 } })).rows).toBe(rowsIn(dump));
    expect((await host.estimateScopeCopyLocal(source)).rows).toBe(rowsIn(await host.exportScopeLocal(source)));
  });

  it('catches a sampled copy up: a write it keeps lands, and a row that left it is deleted there', async () => {
    const source = await seed(10, 3, 4);
    const one = async (query: string) => String((await sql(source, query))[0]!['id']);
    const keptList = await one('SELECT id FROM sp_lists ORDER BY rowid DESC LIMIT 1');
    const droppedList = await one('SELECT id FROM sp_lists ORDER BY rowid LIMIT 1');
    const moved = await one('SELECT id FROM sp_items ORDER BY rowid DESC LIMIT 1');
    const copyId = ulid();
    const dest = scopeId.parse(ulid());
    const stageId = ulid();
    const { pages: read, plan } = await pages(source, 5, {
      capture: copyId,
      afterFirst: async () => {
        await sql(source, `INSERT INTO sp_items (id, list_id, body) VALUES ('i-kept', ?, 'new'), ('i-dropped', ?, 'new')`, keptList, droppedList);
        await sql(source, 'UPDATE sp_items SET list_id = ? WHERE id = ?', droppedList, moved);
      },
    });
    let seq = 0;
    for (const page of read) await host.stageScopePageLocal(dest, stageId, seq++, page.tables);
    for (let batch = 0; ; batch++) {
      const changes = await host.exportScopeChangesLocal(source, copyId, batch, { sample: plan });
      await host.stageScopeChangesLocal(dest, stageId, seq++, changes.tables);
      if (changes.final) break;
    }
    await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source });
    const items = rowsOf(await host.exportScopeLocal(dest), 'sp_items').map((r) => r[0]);
    expect(items).toContain('i-kept');
    expect(items).not.toContain('i-dropped');
    expect(items).not.toContain(moved);
  });

  // Opt-in (`SUBSTRAT_PROBE_SAMPLED_COPY=1`): what the destination writes for a whole copy and for a
  // sample of the same scope, read off #3316's meter (`load`, the stage and the commit).
  it.runIf(__PROBE_SAMPLED_COPY__)('probe: rows written at the destination, whole vs sampled', async () => {
    const source = await seed(100, 10, 10);
    const metered = new CloudflareScopeHost({ scope: env.METERED_SCOPE });
    const written = (dest: ScopeId) => {
      const object = env.METERED_SCOPE.idFromName(dest).toString();
      const points = ((globalThis as unknown as Record<symbol, unknown>)[SCOPE_WORK_POINTS] ?? []) as { blobs: string[]; doubles: number[] }[];
      return points.filter((p) => p.blobs[2] === object && p.blobs[5] === 'load').reduce((n, p) => n + p.doubles[0]!, 0);
    };
    const copy = async (sample?: number) => {
      const dest = scopeId.parse(ulid());
      const stageId = ulid();
      let cursor: string | null = null;
      let plan: ScopeDumpSample | undefined = sample === undefined ? undefined : { rows: sample };
      let seq = 0;
      let rows = 0;
      do {
        const page: ScopeDumpPage = await host.exportScopePageLocal(source, cursor, plan ? { sample: plan } : {});
        plan = page.sample;
        rows += page.tables.reduce((n, t) => n + t.rows.length, 0);
        await metered.stageScopePageLocal(dest, stageId, seq++, page.tables);
        cursor = page.next;
      } while (cursor !== null);
      await metered.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source });
      return { rows, written: written(dest) };
    };
    const whole = await copy();
    const sampled = { 100: await copy(100), 1000: await copy(1000) };
    console.log(JSON.stringify({ whole, sampled }));
    expect(sampled[100].written).toBeLessThan(whole.written);
  }, 120_000);
});
