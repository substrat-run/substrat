import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { countDumpRows, planDumpSample, sampleFilters, sampleGraph, type SampleReader, type SampleTable } from '../src/dump-sample.js';

// #3232: a sampled copy keeps the newest rows of every table, children follow their parents, and
// the spine follows the rows. A small world: owners → lists → items, a comment table that refers to
// itself (a cycle), a table without rowid, and the four spine tables the sample filters.
const SCHEMA = `
  CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE lists (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id));
  CREATE TABLE items (id TEXT PRIMARY KEY, list_id TEXT REFERENCES lists);
  CREATE TABLE comments (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), reply_to TEXT REFERENCES comments(id));
  CREATE TABLE tags (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
  CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL);
  CREATE TABLE _substrat_deliveries (event_id TEXT NOT NULL, consumer_module TEXT NOT NULL, PRIMARY KEY (event_id, consumer_module));
  CREATE TABLE _substrat_attachments (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL);
  CREATE TABLE _substrat_tuples (subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, PRIMARY KEY (subject, relation, object));
  CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const TABLES: SampleTable[] = ['owners', 'lists', 'items', 'comments', '_substrat_outbox', '_substrat_deliveries', '_substrat_attachments', '_substrat_tuples', '_substrat_meta']
  .map((name) => ({ name, byRowid: true }))
  .concat([{ name: 'tags', byRowid: false }]);

function world(): { db: DatabaseSync; reader: SampleReader } {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('BEGIN');
  // Owner o0 is the oldest. Each owner has 3 lists, each list 4 items; lists and items are
  // interleaved across owners so "newest" crosses parents.
  for (let o = 0; o < 10; o++) db.prepare('INSERT INTO owners VALUES (?, ?)').run(`o${o}`, `owner ${o}`);
  for (let l = 0; l < 3; l++) for (let o = 0; o < 10; o++) db.prepare('INSERT INTO lists VALUES (?, ?)').run(`l${o}-${l}`, `o${o}`);
  for (let i = 0; i < 4; i++) for (let o = 0; o < 10; o++) for (let l = 0; l < 3; l++) db.prepare('INSERT INTO items VALUES (?, ?)').run(`i${o}-${l}-${i}`, `l${o}-${l}`);
  db.prepare('INSERT INTO items VALUES (?, NULL)').run('i-orphan');
  for (let t = 0; t < 7; t++) db.prepare('INSERT INTO tags VALUES (?, ?)').run(`k${t}`, 'v');
  db.exec('COMMIT');
  return { db, reader: { all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] } };
}

const kept = (db: DatabaseSync, table: string, filters: Map<string, string>, column = 'id', order = 'rowid'): string[] =>
  (db.prepare(`SELECT ${column} AS v FROM "${table}" WHERE ${filters.get(table) ?? '1'} ORDER BY ${order}`).all() as { v: string }[]).map((r) => r.v);

describe('a sampled copy (#3232)', () => {
  it('keeps the newest rows of each table among those whose parents it kept', () => {
    const { db, reader } = world();
    db.exec(`INSERT INTO comments VALUES ('c-new', 'i9-2-3', NULL), ('c-reply', 'i9-2-3', 'c-new'), ('c-old', 'i0-0-0', NULL)`);
    const graph = sampleGraph(reader, TABLES);
    expect(graph.order.indexOf('owners')).toBeLessThan(graph.order.indexOf('lists'));
    expect(graph.order.indexOf('lists')).toBeLessThan(graph.order.indexOf('items'));
    const plan = planDumpSample(reader, graph, 4);
    const filters = sampleFilters(graph, plan);

    const owners = kept(db, 'owners', filters);
    expect(owners).toEqual(['o6', 'o7', 'o8', 'o9']);
    const lists = kept(db, 'lists', filters);
    // The newest 4 lists among the kept owners'.
    expect(lists).toEqual(['l6-2', 'l7-2', 'l8-2', 'l9-2']);
    const listOwners = db.prepare(`SELECT DISTINCT owner_id AS o FROM lists WHERE id IN (${lists.map(() => '?').join(',')})`).all(...lists) as { o: string }[];
    expect(listOwners.every(({ o }) => owners.includes(o))).toBe(true);
    const items = kept(db, 'items', filters);
    expect(items).toHaveLength(4);
    // The null reference has no parent to follow, and it is the newest row.
    expect(items).toContain('i-orphan');
    const itemLists = db.prepare(`SELECT list_id AS l FROM items WHERE list_id IS NOT NULL AND id IN (${items.map(() => '?').join(',')})`).all(...items) as { l: string }[];
    expect(itemLists.every(({ l }) => lists.includes(l))).toBe(true);
    // A cycle keeps every row whose parents outside the cycle were kept; a table without rowid, all.
    expect(kept(db, 'comments', filters)).toEqual(['c-new', 'c-reply']);
    expect(kept(db, 'tags', filters, 'k', 'k')).toHaveLength(7);
  });

  it('leaves the spine about a row it left behind, and copies the rest of the spine whole', () => {
    const { db, reader } = world();
    db.exec(`
      INSERT INTO _substrat_outbox VALUES ('e1', 'list', 'l9-2'), ('e2', 'list', 'l0-0'), ('e3', 'scope', 'the-scope');
      INSERT INTO _substrat_deliveries VALUES ('e1', 'm'), ('e2', 'm'), ('e3', 'm');
      INSERT INTO _substrat_attachments VALUES ('a1', 'item', 'i9-2-3'), ('a2', 'item', 'i0-0-0');
      INSERT INTO _substrat_tuples VALUES
        ('user:u1', 'role:admin', 'scope'),
        ('user:u1', 'list:read', 'list:l9-2'), ('user:u1', 'list:read', 'list:l0-0'),
        ('item:i9-2-3', 'parent', 'list:l9-2'), ('item:i0-0-0', 'parent', 'list:l9-2'), ('item:i9-2-3', 'parent', 'list:l0-0');
      INSERT INTO _substrat_meta VALUES ('k', 'v');
    `);
    const graph = sampleGraph(reader, TABLES);
    const filters = sampleFilters(graph, planDumpSample(reader, graph, 4));
    expect(kept(db, '_substrat_outbox', filters)).toEqual(['e1', 'e3']);
    expect(kept(db, '_substrat_deliveries', filters, 'event_id')).toEqual(['e1', 'e3']);
    expect(kept(db, '_substrat_attachments', filters)).toEqual(['a1']);
    expect(kept(db, '_substrat_tuples', filters, "subject || ' ' || relation || ' ' || object")).toEqual([
      'user:u1 role:admin scope',
      'user:u1 list:read list:l9-2',
      'item:i9-2-3 parent list:l9-2',
    ]);
    expect(filters.has('_substrat_meta')).toBe(false);
  });

  it('reads the same sample after the scope moves: new rows are in, deletes pull nothing older in', () => {
    const { db, reader } = world();
    const graph = sampleGraph(reader, TABLES);
    const plan = planDumpSample(reader, graph, 4);
    db.exec(`DELETE FROM items WHERE id = 'i-orphan'; INSERT INTO owners VALUES ('o-new', 'new'); INSERT INTO lists VALUES ('l-new', 'o-new'); INSERT INTO items VALUES ('i-new', 'l-new'), ('i-stray', 'l0-0')`);
    const filters = sampleFilters(graph, plan);
    expect(kept(db, 'owners', filters)).toEqual(['o6', 'o7', 'o8', 'o9', 'o-new']);
    // Three of the old four, and the new item; not the one now newest among the old, nor the stray.
    const items = kept(db, 'items', filters);
    expect(items).toHaveLength(4);
    expect(items).toContain('i-new');
    expect(items).not.toContain('i-stray');
  });

  it('counts what a copy would move, exactly or on a probe of a large table', () => {
    const { db, reader } = world();
    db.exec('BEGIN');
    // 60 000 events, a seventh about a kept list: past the exact count, so the outbox is probed.
    const insert = db.prepare('INSERT INTO _substrat_outbox VALUES (?, ?, ?)');
    for (let e = 0; e < 60_000; e++) insert.run(`e${e}`, 'list', e % 7 === 0 ? 'l9-2' : 'l0-0');
    db.exec('COMMIT');
    const graph = sampleGraph(reader, TABLES);
    const sample = planDumpSample(reader, graph, 4);
    const full = countDumpRows(reader, TABLES);
    expect(full.tables.find((t) => t.name === 'items')!.rows).toBe(121);
    expect(full.rows).toBe(10 + 30 + 121 + 7 + 60_000);
    const sampled = countDumpRows(reader, TABLES, { filters: sampleFilters(graph, sample), sample });
    const outbox = sampled.tables.find((t) => t.name === '_substrat_outbox')!;
    expect(outbox.estimated).toBe(true);
    expect(Math.abs(outbox.rows - 8_572)).toBeLessThan(500);
    expect(sampled.tables.find((t) => t.name === 'items')).toEqual({ name: 'items', rows: 4 });
  });

  it('refuses, by name, a sample whose references are too deep for one statement', () => {
    const db = new DatabaseSync(':memory:');
    // Each table refers to the three before it, so a filter repeats its ancestors' many times over.
    for (let i = 0; i < 16; i++) {
      const refs = [1, 2, 3].filter((d) => i - d >= 0).map((d) => `, p${d} TEXT REFERENCES d${i - d}(id)`).join('');
      db.exec(`CREATE TABLE d${i} (id TEXT PRIMARY KEY${refs})`);
    }
    const reader: SampleReader = { all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] };
    const graph = sampleGraph(reader, Array.from({ length: 16 }, (_, i) => ({ name: `d${i}`, byRowid: true })));
    const floors = Object.fromEntries(graph.order.map((n) => [n, 1]));
    expect(() => sampleFilters(graph, { rows: 10, floors })).toThrow(/cannot be copied as a sample: the references that d\d+ follows are too deep/);
  });

  it('refuses a sample size out of range', () => {
    const { reader } = world();
    expect(() => planDumpSample(reader, sampleGraph(reader, TABLES), 0)).toThrow(/1 to 100000 rows/);
  });
});
