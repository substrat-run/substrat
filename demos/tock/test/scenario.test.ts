/**
 * The scenario from spec/concept.md section 8, replayed headlessly.
 *
 * Written from the CONCEPT, never from the model: a test derived from the model agrees with a
 * wrong model perfectly and forever. Inputs and expectations are literals here for the same
 * reason — a test that builds its input from the emitted schema cannot disagree with it.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frozenClock, type ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

type Who = 'ines' | 'tomas' | 'wren';
const as = (who: Who) => host.getScope(world[who].principal, world.tenant, world.scope);
/** Petra, acting on the FIRST publisher's workspace — a legitimate admin of her own, elsewhere. */
const asPetraHere = () => host.getScope(world.petra.principal, world.tenant, world.scope);
const asPetraHome = () => host.getScope(world.petra.principal, world.otherTenant, world.otherScope);

/**
 * The events one entity has on the audit spine, oldest first.
 *
 * Read straight out of `_substrat_outbox` — the vertical has no operation over it and should
 * not: this is a test asserting that a write left a trace, not a product surface.
 */
const outbox = (type: string, entityId: string) => {
  const db = new Database(join(dir, `${world.tenant}__${world.scope}.sqlite`), { readonly: true });
  const rows = db
    .prepare('SELECT payload FROM _substrat_outbox WHERE type = ? AND entity_id = ? ORDER BY id')
    .all(type, entityId) as { payload: string | null }[];
  db.close();
  return rows.map((r) => JSON.parse(r.payload ?? '{}') as { complete?: boolean; row_count?: number });
};

interface Run {
  id: string;
  status: string;
  row_count: number | null;
  rejected_count: number | null;
  schema_version: number | null;
  complete?: boolean;
}

/** A day of CDN log lines, as the host would hand them over already parsed. */
const dayOne = [
  { occurredAt: '2026-03-14T08:00:00.000Z', subject: '203.0.113.1|Podcatcher/2', fields: { episode_id: 'ep-114', episode_title: 'Harbour Lights', country: 'SE', bytes: '4200000' } },
  { occurredAt: '2026-03-14T09:30:00.000Z', subject: '203.0.113.2|Podcatcher/2', fields: { episode_id: 'ep-114', episode_title: 'Harbour Lights', country: 'NO', bytes: '4200000' } },
  { occurredAt: '2026-03-14T11:00:00.000Z', subject: '203.0.113.3|CrawlerBot/1', fields: { episode_id: 'ep-115', episode_title: 'Low Tide', country: 'SE', bytes: '3100000' } },
  // No country on this one, and no bytes — the two absences the design has opinions about.
  { occurredAt: '2026-03-14T12:00:00.000Z', subject: '203.0.113.4|Podcatcher/2', fields: { episode_id: 'ep-114', episode_title: 'Harbour Lights', country: null, bytes: null } },
];

const SCHEMA_V1 = {
  episode_id: { type: 'text' as const, role: 'dimension' as const, labelField: 'episode_title' },
  episode_title: { type: 'text' as const, role: 'ignored' as const },
  country: { type: 'text' as const, role: 'dimension' as const },
  bytes: { type: 'int' as const, role: 'measure' as const },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tock-scenario-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Day one's run. Two describes read it: the narrative, and the back-fill that must not move it. */
let runOne: string;

describe('a day of logs becomes a number', () => {

  it('1 — the workspace exists and has no sources yet', async () => {
    const wren = await as('wren');
    expect(await wren.invoke('tock/list-sources')).toEqual({ entries: [], nextCursor: null });
  });

  it('2 — Ines declares a source and Tomas opens a run over a delivered file', async () => {
    const ines = await as('ines');
    const source = await ines.invoke<{ key: string; title: string }>('tock/declare-source', {
      key: 'fjord-cdn',
      title: 'Fjord CDN logs',
      expectedCadence: 'daily',
    });
    expect(source.key).toBe('fjord-cdn');

    const tomas = await as('tomas');
    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-14.log',
      byteSize: 1024,
      contentHash: 'sha256:aaa',
      storageKey: 'runs/2026-03-14.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-14T00:00:00.000Z',
      periodTo: '2026-03-15T00:00:00.000Z',
    });
    runOne = run.id;
    // Received means stored, not read. Nothing has been counted or even looked at.
    expect(run.status).toBe('received');
    expect(run.row_count).toBeNull();
  });

  it('3 — profiling records what arrived, including a field nobody declared yet', async () => {
    const tomas = await as('tomas');
    const run = await tomas.invoke<Run>('tock/profile-run', { runId: runOne, batch: dayOne, final: true });
    expect(run.status).toBe('profiled');
    expect(run.row_count).toBe(4);
    expect(run.complete).toBe(true);

    const observed = await tomas.invoke<{ entries: { field: string; present_count: number; null_count: number }[] }>(
      'tock/list-observations',
      { runId: runOne },
    );
    const byField = new Map(observed.entries.map((o) => [o.field, o]));
    expect(byField.get('episode_id')?.present_count).toBe(4);
    // The row with no country is a null, not an absence and not a zero.
    expect(byField.get('country')?.present_count).toBe(3);
    expect(byField.get('country')?.null_count).toBe(1);
    // `campaign` was never in the file at all — a fact, and the absence of a row is how it reads.
    expect(byField.has('campaign')).toBe(false);
  });

  it('4 — the denials hold, step by step', async () => {
    const wren = await as('wren');
    // A viewer holds no lifecycle permission — asserted per transition, not inferred from one.
    await expect(
      wren.invoke('tock/receive-run', {
        sourceKey: 'fjord-cdn',
        filename: 'x.log',
        byteSize: 1,
        contentHash: 'sha256:x',
        storageKey: 'runs/x.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
        periodFrom: '2026-03-14T00:00:00.000Z',
        periodTo: '2026-03-15T00:00:00.000Z',
      }),
    ).rejects.toThrow();
    await expect(wren.invoke('tock/profile-run', { runId: runOne, batch: [], final: true })).rejects.toThrow();
    await expect(wren.invoke('tock/map-run', { runId: runOne, schemaVersion: 1 })).rejects.toThrow();
    await expect(wren.invoke('tock/count-run', { runId: runOne })).rejects.toThrow();
    await expect(wren.invoke('tock/save-schema', { sourceKey: 'fjord-cdn', fields: SCHEMA_V1 })).rejects.toThrow();
    // And the row/file line: a viewer reads counts and never the data behind them.
    await expect(wren.invoke('tock/list-rows', { runId: runOne })).rejects.toThrow();
    await expect(wren.invoke('tock/read-source-file', { runId: runOne })).rejects.toThrow();

    // Tomas holds the lifecycle and is denied only the schema write.
    const tomas = await as('tomas');
    await expect(tomas.invoke('tock/save-schema', { sourceKey: 'fjord-cdn', fields: SCHEMA_V1 })).rejects.toThrow();
    // The control beside the closed doors: he CAN read the rows, so the denials above are not
    // passing merely because everything is shut.
    const rows = await tomas.invoke<{ entries: unknown[] }>('tock/list-rows', { runId: runOne });
    expect(rows.entries).toHaveLength(4);
  });

  it('5 — Ines declares the shape and Tomas maps and counts', async () => {
    const ines = await as('ines');
    const schema = await ines.invoke<{ version: number }>('tock/save-schema', {
      sourceKey: 'fjord-cdn',
      fields: SCHEMA_V1,
    });
    expect(schema.version).toBe(1);

    const tomas = await as('tomas');
    const mapped = await tomas.invoke<Run>('tock/map-run', { runId: runOne, schemaVersion: 1 });
    expect(mapped.status).toBe('mapped');
    expect(mapped.schema_version).toBe(1);

    const counted = await tomas.invoke<Run>('tock/count-run', {
      runId: runOne,
      // What was applied upstream before these records were handed over. Recorded now so the
      // correction in step 11 has something to differ from.
      rules: [{ kind: 'bot_list', identifier: 'crawlers-2026-03', contentHash: 'sha256:botlist-v1' }],
    });
    expect(counted.status).toBe('counted');
  });

  it('6 — a viewer reads the same numbers an admin does', async () => {
    const wren = await as('wren');
    const ines = await as('ines');
    const args = {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    };
    const theirs = await wren.invoke<{ rows: { events: number }[] }>('tock/report', args);
    const hers = await ines.invoke<{ rows: { events: number }[] }>('tock/report', args);
    expect(theirs).toEqual(hers);
    expect(theirs.rows).toHaveLength(1);
    expect(theirs.rows[0]?.events).toBe(4);
  });

  it('7 — a missing measure leaves the sum alone, and an absent dimension is its own bucket', async () => {
    const ines = await as('ines');
    // Three rows carried bytes; the fourth carried none. 4.2M + 4.2M + 3.1M, and the null
    // contributes nothing rather than pulling the total down by counting as zero.
    const total = await ines.invoke<{ rows: { events: number; measure: string | null }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    expect(total.rows[0]?.measure).toBe('11500000');

    // Grouped by country, the row with no country is hidden by default and revealed on ask —
    // never folded into a fabricated bucket and never silently dropped from existence.
    const hidden = await ines.invoke<{ rows: { dim1: string }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'country',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    expect(hidden.rows.map((r) => r.dim1).sort()).toEqual(['NO', 'SE']);

    const revealed = await ines.invoke<{ rows: { dim1: string; events: number }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'country',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
      includeUnknown: true,
    });
    expect(revealed.rows).toHaveLength(3);
    expect(revealed.rows.reduce((n, r) => n + r.events, 0)).toBe(4);
  });

  it('8 — the label is captured per run, so the report reads a title rather than an id', async () => {
    const ines = await as('ines');
    const byEpisode = await ines.invoke<{ rows: { dim1: string; label1: string | null }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'episode_id',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    const ep114 = byEpisode.rows.find((r) => r.dim1 === 'ep-114');
    expect(ep114?.label1).toBe('Harbour Lights');
  });

  /**
   * The grouping the two dimension slots exist FOR.
   *
   * `dimsOfSet` has always parsed `a+b` and the rollup has always held two slots, but nothing
   * ever wrote the pair — so the one grouping the whole two-slot design is for came back
   * empty, which reads exactly like a day with no data.
   */
  it('8b — a two-dimension grouping has rows, and both of its labels resolve', async () => {
    const ines = await as('ines');
    const pair = await ines.invoke<{
      rows: { dim1: string; dim2: string; label1: string | null; events: number }[];
    }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'episode_id+country',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    // ep-114/SE, ep-114/NO, ep-115/SE — and ep-114 with no country, hidden by default.
    expect(pair.rows.map((r) => `${r.dim1}/${r.dim2}`).sort()).toEqual([
      'ep-114/NO',
      'ep-114/SE',
      'ep-115/SE',
    ]);
    // The label is joined on the COMPONENT dimension. Joined on the set — `episode_id+country`
    // — it matches no captured label at all and every one of these comes back null.
    expect(pair.rows.find((r) => r.dim1 === 'ep-114')?.label1).toBe('Harbour Lights');

    const all = await ines.invoke<{ rows: { events: number }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'episode_id+country',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
      includeUnknown: true,
    });
    // Every row is in exactly one bucket of this grouping, unknown included.
    expect(all.rows.reduce((n, r) => n + r.events, 0)).toBe(4);
  });

  /**
   * `hour` is one of three grains the report declares. Nothing wrote it, so asking for it
   * returned nothing, forever, and said nothing about why.
   */
  it('8c — the hour grain is counted, not merely offered', async () => {
    const ines = await as('ines');
    const hourly = await ines.invoke<{ rows: { periodStart: string; events: number }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'hour',
      dimSet: 'total',
      from: '2026-03-14T00:00:00.000Z',
      to: '2026-03-15T00:00:00.000Z',
    });
    // The four records of day one sit in four different hours.
    expect(hourly.rows.map((r) => r.periodStart)).toEqual([
      '2026-03-14T08:00:00.000Z',
      '2026-03-14T09:00:00.000Z',
      '2026-03-14T11:00:00.000Z',
      '2026-03-14T12:00:00.000Z',
    ]);
    expect(hourly.rows.reduce((n, r) => n + r.events, 0)).toBe(4);

    // And the month, which is computed from the rows rather than summed from the days.
    const monthly = await ines.invoke<{ rows: { periodStart: string; events: number }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'month',
      dimSet: 'total',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    expect(monthly.rows[0]?.periodStart).toBe('2026-03-01T00:00:00.000Z');
  });

  /**
   * `declared` is a filter `list-observations` publishes. Profiling writes 0 because no
   * schema is chosen yet, and mapping is the moment the answer exists — nothing wrote it
   * afterwards, so the filter said "undeclared" about every field forever.
   */
  it('8d — mapping records which observed fields the schema accounts for', async () => {
    const tomas = await as('tomas');
    const declared = await tomas.invoke<{ entries: { field: string }[] }>('tock/list-observations', {
      runId: runOne,
      declared: true,
    });
    expect(declared.entries.map((o) => o.field).sort()).toEqual([
      'bytes',
      'country',
      'episode_id',
      'episode_title',
    ]);
    // Day one carried no field outside schema v1, so nothing is left over.
    const undeclared = await tomas.invoke<{ entries: { field: string }[] }>('tock/list-observations', {
      runId: runOne,
      declared: false,
    });
    expect(undeclared.entries).toEqual([]);
  });
});

describe('a deviation is caught rather than dropped', () => {
  let runTwo: string;

  it('9 — an undeclared field still counts, and is reported as a finding', async () => {
    const tomas = await as('tomas');
    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-15.log',
      byteSize: 512,
      contentHash: 'sha256:bbb',
      storageKey: 'runs/2026-03-15.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-15T00:00:00.000Z',
      periodTo: '2026-03-16T00:00:00.000Z',
    });
    runTwo = run.id;

    const profiled = await tomas.invoke<Run>('tock/profile-run', {
      runId: runTwo,
      final: true,
      batch: [
        {
          occurredAt: '2026-03-15T08:00:00.000Z',
          subject: '203.0.113.9|Podcatcher/3',
          // `client_hint` is not in schema v1. It must not be dropped.
          fields: { episode_id: 'ep-116', episode_title: 'Spring Line', country: 'SE', bytes: '5000000', client_hint: 'ios' },
        },
      ],
    });
    expect(profiled.row_count).toBe(1);

    const findings = await tomas.invoke<{ findings: { kind: string; field: string }[] }>('tock/deviations', {
      sourceKey: 'fjord-cdn',
    });
    const undeclared = findings.findings.filter((f) => f.kind === 'undeclared_field').map((f) => f.field);
    expect(undeclared).toContain('client_hint');
  });

  it('10 — field history says when a field first arrived, which is what a back-fill needs', async () => {
    const ines = await as('ines');
    const history = await ines.invoke<{ entries: { field: string; day: string }[]; capped: boolean }>(
      'tock/field-history',
      { sourceKey: 'fjord-cdn', field: 'client_hint' },
    );
    expect(history.capped).toBe(false);
    expect(history.entries.map((e) => e.day)).toEqual(['2026-03-15']);
    // The point of the affordance: `episode_id` goes back a day further, so "before this date
    // there is no value" is answerable rather than guessed at.
    const older = await ines.invoke<{ entries: { day: string }[] }>('tock/field-history', {
      sourceKey: 'fjord-cdn',
      field: 'episode_id',
    });
    expect(older.entries.map((e) => e.day).sort()).toEqual(['2026-03-14', '2026-03-15']);
  });

  /**
   * Concept section 8 step 7, which the suite claimed and did not replay: it read history
   * under v1 and stopped, so nothing here ever saw a second schema version at all.
   *
   * The affordance is a refusal to invent. Ines adds `client_hint` to v2; Tock does not ask
   * her for a default, and the rows that predate the field stay empty rather than acquiring
   * one. "Leave history as it stands" is the path taken here — so the assertion is that
   * nothing about day one moved.
   */
  it('10b — a new schema version leaves the rows that predate the field empty', async () => {
    const ines = await as('ines');
    const tomas = await as('tomas');

    const before = await ines.invoke<{ rows: { events: number; measure: string | null }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-14T00:00:00.000Z',
      to: '2026-03-15T00:00:00.000Z',
    });

    const v2 = await ines.invoke<{ version: number }>('tock/save-schema', {
      sourceKey: 'fjord-cdn',
      fields: { ...SCHEMA_V1, client_hint: { type: 'text', role: 'ignored' } },
    });
    // Saving never edits a version: v1 is still there and still explains run one.
    expect(v2.version).toBe(2);

    // What the affordance is built on, and it answers without a re-run: the field has data
    // from the second day and none before it.
    const history = await ines.invoke<{ entries: { day: string }[] }>('tock/field-history', {
      sourceKey: 'fjord-cdn',
      field: 'client_hint',
    });
    expect(history.entries.map((e) => e.day)).toEqual(['2026-03-15']);

    // And she leaves it. Day one's rows carry no `client_hint` — not an empty string, not a
    // default, the key simply is not there.
    const rows = await tomas.invoke<{ entries: { dims_json: string }[] }>('tock/list-rows', { runId: runOne });
    for (const row of rows.entries) {
      expect(Object.keys(JSON.parse(row.dims_json) as Record<string, unknown>)).not.toContain('client_hint');
    }
    // Nothing about the number moved either: a schema version is not a re-count.
    const after = await ines.invoke<{ rows: { events: number; measure: string | null }[] }>('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-14T00:00:00.000Z',
      to: '2026-03-15T00:00:00.000Z',
    });
    expect(after).toEqual(before);
  });

  /**
   * The observed half is a SET, and a field is not obliged to be consistent.
   *
   * The column used to be written by whichever record reached the field first: a field whose
   * first value was null stayed `unknown` however many integers followed, and one carrying
   * two types reported one of them — so `deviations`, whose entire job is to notice that,
   * could not.
   */
  it('10c — a field that arrives as two types is reported as both', async () => {
    const tomas = await as('tomas');
    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-17.log',
      byteSize: 128,
      contentHash: 'sha256:ddd',
      storageKey: 'runs/2026-03-17.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-17T00:00:00.000Z',
      periodTo: '2026-03-18T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', {
      runId: run.id,
      final: true,
      batch: [
        // The first record carries nothing, which is what used to pin the type to `unknown`.
        { occurredAt: '2026-03-17T08:00:00.000Z', subject: 'a', fields: { country: null } },
        { occurredAt: '2026-03-17T09:00:00.000Z', subject: 'b', fields: { country: '123' } },
        { occurredAt: '2026-03-17T10:00:00.000Z', subject: 'c', fields: { country: 'SE' } },
      ],
    });

    const observed = await tomas.invoke<{ entries: { field: string; inferred_type: string }[] }>(
      'tock/list-observations',
      { runId: run.id },
    );
    expect(observed.entries.find((o) => o.field === 'country')?.inferred_type).toBe('int,text');

    // And the disagreement reaches the screen it exists for. `country` is declared text.
    const findings = await tomas.invoke<{ findings: { kind: string; field: string; detail: string }[] }>(
      'tock/deviations',
      { sourceKey: 'fjord-cdn', schemaVersion: 1 },
    );
    const mismatch = findings.findings.find((f) => f.kind === 'type_mismatch' && f.field === 'country');
    expect(mismatch?.detail).toContain('int');
  });

  /**
   * A file is not obliged to be sorted, and one record out of order used to drag `last_seen`
   * backwards or leave `first_seen` late — the two facts a back-fill decision is made on.
   */
  it('10d — field history holds the true window even when a batch arrives out of order', async () => {
    const tomas = await as('tomas');
    const ines = await as('ines');
    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-18.log',
      byteSize: 128,
      contentHash: 'sha256:eee',
      storageKey: 'runs/2026-03-18.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-18T00:00:00.000Z',
      periodTo: '2026-03-19T00:00:00.000Z',
    });
    // Across TWO batches, which is where the merge actually happens: within one batch the
    // window is folded in memory, but a resumed delivery meets a row that is already there —
    // and that is the path where last-write-wins used to drag `last_seen` backwards.
    await tomas.invoke('tock/profile-run', {
      runId: run.id,
      final: false,
      batch: [
        { occurredAt: '2026-03-18T18:00:00.000Z', subject: 'a', fields: { late_field: 'x' } },
        { occurredAt: '2026-03-18T12:00:00.000Z', subject: 'c', fields: { late_field: 'z' } },
      ],
    });
    await tomas.invoke('tock/profile-run', {
      runId: run.id,
      final: true,
      // Earlier than everything the first batch carried, and delivered last.
      batch: [{ occurredAt: '2026-03-18T06:00:00.000Z', subject: 'b', fields: { late_field: 'y' } }],
    });

    const history = await ines.invoke<{ entries: { field: string; day: string; first_seen: string; last_seen: string }[] }>(
      'tock/field-history',
      { sourceKey: 'fjord-cdn', field: 'late_field' },
    );
    const day = history.entries.find((e) => e.day === '2026-03-18');
    // Earliest and latest, not first-delivered and last-delivered.
    expect(day?.first_seen).toBe('2026-03-18T06:00:00.000Z');
    expect(day?.last_seen).toBe('2026-03-18T18:00:00.000Z');

    // And the resumed run counted every record once across the two batches.
    const counted = await tomas.invoke<Run>('tock/get-run', { runId: run.id });
    expect(counted.row_count).toBe(3);
    expect(counted.status).toBe('profiled');

    /**
     * Both batches are on the spine, and the first one is the reason this assertion exists.
     *
     * A non-final batch writes rows, observations and field history and used to emit nothing
     * at all — a mutation with no audit entry, which is the one thing the event rule is for.
     * `complete` is what tells the two apart, and it is on the payload rather than inferred
     * from `status` so a consumer never has to know this vertical's state names.
     */
    const emitted = outbox('tock.run-profiled', run.id);
    expect(emitted.map((e) => e.complete)).toEqual([false, true]);
    expect(emitted.map((e) => e.row_count)).toEqual([2, 3]);
  });
});

describe('a correction supersedes without destroying', () => {
  /**
   * Concept section 8 step 8, and the previous version of this test could not fail.
   *
   * It filtered the bot row out of the fixture before Tock ever saw it, so the corrected
   * number was arithmetic done in the test file: it passed identically against an
   * implementation with no notion of a bot list and no captured rule state, which is what
   * the implementation in fact was.
   *
   * The rule now goes THROUGH the system. `count-run` records what list was applied, and the
   * assertion that matters is the last one — the displaced run still names the version it
   * used. That is the whole of section 1's complaint ("nobody can say six months later which
   * bot list produced March's figure") and it is either answerable or it is not.
   */
  const BOT_LIST_V1 = { kind: 'bot_list' as const, identifier: 'crawlers-2026-03', contentHash: 'sha256:botlist-v1' };
  const BOT_LIST_V2 = { kind: 'bot_list' as const, identifier: 'crawlers-2026-03', contentHash: 'sha256:botlist-v2' };

  it('11 — the re-run becomes current and the first run keeps its own number and its own rules', async () => {
    const tomas = await as('tomas');
    const ines = await as('ines');
    const window = {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-14T00:00:00.000Z',
      to: '2026-03-15T00:00:00.000Z',
    };
    const before = await ines.invoke<{ rows: { events: number; runId: string }[] }>('tock/report', window);
    expect(before.rows[0]?.events).toBe(4);
    const firstRunId = before.rows[0]?.runId;
    expect(firstRunId).toBe(runOne);

    // Day one again, under an UPDATED bot list. Same file, same four records handed over —
    // the correction is the rule, not a different delivery, which is what makes the two runs
    // comparable at all.
    const rerun = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-14.log',
      byteSize: 1024,
      contentHash: 'sha256:aaa',
      storageKey: 'runs/2026-03-14.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-14T00:00:00.000Z',
      periodTo: '2026-03-15T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', {
      runId: rerun.id,
      final: true,
      // The bot list is applied upstream of Tock — section 10 keeps fetching the lists
      // themselves out of scope — so what arrives is the records that survived it, and what
      // Tock records is WHICH list did the surviving.
      batch: dayOne.filter((r) => !r.subject.includes('CrawlerBot')),
    });
    await tomas.invoke('tock/map-run', { runId: rerun.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: rerun.id, rules: [BOT_LIST_V2] });

    const after = await ines.invoke<{ rows: { events: number; runId: string }[] }>('tock/report', window);
    expect(after.rows[0]?.events).toBe(3);
    expect(after.rows[0]?.runId).toBe(rerun.id);
    expect(after.rows[0]?.runId).not.toBe(firstRunId);
    // Exactly one row: the displaced run's rollup is still on disk, and a report that
    // returned both numbers for one day would be worse than one that returned neither.
    expect(after.rows).toHaveLength(1);

    // And the displaced run is still there, still counted, still holding what it reported.
    const original = await ines.invoke<Run>('tock/get-run', { runId: firstRunId! });
    expect(original.status).toBe('counted');
    expect(original.row_count).toBe(4);

    // The assertion the old test could not make. Each run names the list it was counted
    // under, and they are different lists — so "which bot list produced this number" has an
    // answer per run rather than one answer that moved.
    const originalRules = await ines.invoke<{ entries: { rule_kind: string; content_hash: string }[] }>(
      'tock/run-rules',
      { runId: firstRunId! },
    );
    const rerunRules = await ines.invoke<{ entries: { rule_kind: string; content_hash: string }[] }>(
      'tock/run-rules',
      { runId: rerun.id },
    );
    const botListOf = (r: { entries: { rule_kind: string; content_hash: string }[] }) =>
      r.entries.find((e) => e.rule_kind === 'bot_list')?.content_hash;
    expect(botListOf(originalRules)).toBe(BOT_LIST_V1.contentHash);
    expect(botListOf(rerunRules)).toBe(BOT_LIST_V2.contentHash);

    // Both also name the daily salt their subject keys were hashed with — same day, same
    // salt, so a re-run's de-duplication is comparable to the original's rather than merely
    // looking like it. The hash used to be the SCHEMA's id, which answers a different
    // question and would have been equal here for the wrong reason.
    const saltOf = (r: { entries: { rule_kind: string; content_hash: string }[] }) =>
      r.entries.find((e) => e.rule_kind === 'salt')?.content_hash;
    expect(saltOf(originalRules)).toBeDefined();
    expect(saltOf(originalRules)).toBe(saltOf(rerunRules));
    expect(saltOf(originalRules)).not.toBe(botListOf(originalRules));
  });

  it('12 — the lifecycle cannot be skipped, and a counted run cannot be moved', async () => {
    const tomas = await as('tomas');
    const fresh = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-16.log',
      byteSize: 64,
      contentHash: 'sha256:ccc',
      storageKey: 'runs/2026-03-16.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-16T00:00:00.000Z',
      periodTo: '2026-03-17T00:00:00.000Z',
    });
    // Mapping an unprofiled run is guessing with the evidence unread.
    await expect(tomas.invoke('tock/map-run', { runId: fresh.id, schemaVersion: 1 })).rejects.toThrow();
    // Counting an unmapped run has no shape to count by.
    await expect(tomas.invoke('tock/count-run', { runId: fresh.id })).rejects.toThrow();

    await tomas.invoke('tock/profile-run', { runId: fresh.id, batch: [], final: true });
    await tomas.invoke('tock/map-run', { runId: fresh.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: fresh.id });
    // A counted run is frozen: it cannot be profiled again, mapped again or counted again.
    await expect(tomas.invoke('tock/profile-run', { runId: fresh.id, batch: [], final: true })).rejects.toThrow();
    await expect(tomas.invoke('tock/map-run', { runId: fresh.id, schemaVersion: 1 })).rejects.toThrow();
    await expect(tomas.invoke('tock/count-run', { runId: fresh.id })).rejects.toThrow();
  });
});

describe('two publishers cannot see each other', () => {
  it('13 — Petra is an admin at home and a nobody here', async () => {
    const home = await asPetraHome();
    // The control: she is a real admin somewhere, so the denials below are about the
    // workspace and not about her.
    const mine = await home.invoke<{ entries: unknown[] }>('tock/list-sources');
    expect(mine.entries).toEqual([]);
    await home.invoke('tock/declare-source', { key: 'backlot-cdn', title: 'Backlot CDN', expectedCadence: 'daily' });

    const here = await asPetraHere();
    await expect(here.invoke('tock/list-sources')).rejects.toThrow();
    await expect(here.invoke('tock/report', {
      sourceKey: 'fjord-cdn',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    })).rejects.toThrow();
  });

  it('14 — and the first publisher sees nothing of the second', async () => {
    const ines = await as('ines');
    const sources = await ines.invoke<{ entries: { key: string }[] }>('tock/list-sources');
    expect(sources.entries.map((s) => s.key)).toEqual(['fjord-cdn']);
  });
});

describe('the schema editor refuses what the rollup cannot hold', () => {
  it('15 — a third grouping dimension is refused at save time, naming the reason', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/save-schema', {
        sourceKey: 'fjord-cdn',
        fields: {
          episode_id: { type: 'text', role: 'dimension' },
          country: { type: 'text', role: 'dimension' },
          client_hint: { type: 'text', role: 'dimension' },
          bytes: { type: 'int', role: 'measure' },
        },
      }),
    ).rejects.toThrow(/at most 2 grouping dimensions/);
  });

  it('16 — and a label field that is not a field is refused too', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/save-schema', {
        sourceKey: 'fjord-cdn',
        fields: { episode_id: { type: 'text', role: 'dimension', labelField: 'nope' } },
      }),
    ).rejects.toThrow(/labelField/);
  });

  /**
   * The same shape of refusal as the dimension cap, for the same reason.
   *
   * A rollup row holds one measure and one unit. Counting used to take the first declared
   * measure and drop the rest without a word, so a schema naming two looked accepted and
   * produced a number that was quietly about one of them.
   */
  it('17 — a second measure is refused at save time, naming the reason', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/save-schema', {
        sourceKey: 'fjord-cdn',
        fields: {
          episode_id: { type: 'text', role: 'dimension' },
          bytes: { type: 'int', role: 'measure' },
          requests: { type: 'int', role: 'measure' },
        },
      }),
    ).rejects.toThrow(/at most 1 measure/);
  });
});

/**
 * Which run is current for a period, when two of them were counted in the same instant.
 *
 * Its own world and its own clock, because the question cannot be asked of the wall clock:
 * "the latest counted run wins" was compared with `MAX(counted_at)`, which is not a unique
 * ordering token, and two runs sharing an ISO millisecond were BOTH equal to the maximum. A
 * frozen clock guarantees the tie every time; a fast machine produces it occasionally, which
 * is the worse version of the same bug.
 */
describe('two runs counted in the same instant still yield one current run', () => {
  let tied: ScopeHost;
  let tiedDir: string;
  let tiedWorld: World;

  beforeAll(async () => {
    tiedDir = mkdtempSync(join(tmpdir(), 'tock-tied-'));
    tied = buildHost(tiedDir, frozenClock('2026-04-01T00:00:00.000Z'));
    tiedWorld = await seed(tied);
  });

  afterAll(() => rmSync(tiedDir, { recursive: true, force: true }));

  it('17b — the report returns exactly one row, and it is the later run', async () => {
    const ines = await tied.getScope(tiedWorld.ines.principal, tiedWorld.tenant, tiedWorld.scope);
    await ines.invoke('tock/declare-source', { key: 'tied', title: 'Tied', expectedCadence: 'daily' });
    await ines.invoke('tock/save-schema', {
      sourceKey: 'tied',
      fields: { country: { type: 'text', role: 'dimension' } },
    });

    const count = async (batch: { occurredAt: string; subject: string; fields: Record<string, string> }[]) => {
      const run = await ines.invoke<Run>('tock/receive-run', {
        sourceKey: 'tied',
        filename: 'tied.log',
        byteSize: 1,
        contentHash: 'sha256:tied',
        storageKey: 'runs/tied.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
        periodFrom: '2026-03-14T00:00:00.000Z',
        periodTo: '2026-03-15T00:00:00.000Z',
      });
      await ines.invoke('tock/profile-run', { runId: run.id, batch, final: true });
      await ines.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });
      await ines.invoke('tock/count-run', { runId: run.id });
      return run.id;
    };

    const first = await count([
      { occurredAt: '2026-03-14T08:00:00.000Z', subject: 'a', fields: { country: 'SE' } },
      { occurredAt: '2026-03-14T09:00:00.000Z', subject: 'b', fields: { country: 'SE' } },
    ]);
    const second = await count([{ occurredAt: '2026-03-14T08:00:00.000Z', subject: 'a', fields: { country: 'SE' } }]);

    // The clock did not move, so the two runs carry the same `counted_at` to the millisecond.
    const both = await ines.invoke<Run>('tock/get-run', { runId: first });
    const other = await ines.invoke<Run>('tock/get-run', { runId: second });
    expect((both as unknown as { counted_at: string }).counted_at).toBe(
      (other as unknown as { counted_at: string }).counted_at,
    );

    const report = await ines.invoke<{ rows: { events: number; runId: string }[] }>('tock/report', {
      sourceKey: 'tied',
      grain: 'day',
      dimSet: 'total',
      from: '2026-03-14T00:00:00.000Z',
      to: '2026-03-15T00:00:00.000Z',
    });
    // One row, not two. Both runs' rollups are on disk and only one of them is current.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.runId).toBe(second);
    expect(report.rows[0]?.events).toBe(1);
  });
});

describe('one file, several kinds of record', () => {
  const SRC = 'firehose';
  /** An envelope every record carries, plus properties that differ by kind. */
  const batch = [
    { occurredAt: '2026-04-01T08:00:00.000Z', subject: 'a', fields: { type: 'page', country: 'SE', url: '/home' } },
    { occurredAt: '2026-04-01T08:01:00.000Z', subject: 'b', fields: { type: 'track', event: 'scroll', country: 'SE', depth: '80' } },
    { occurredAt: '2026-04-01T08:02:00.000Z', subject: 'c', fields: { type: 'track', event: 'viewArticle', country: 'NO', name: 'Tide' } },
    // A kind nobody declared. It must survive.
    { occurredAt: '2026-04-01T08:03:00.000Z', subject: 'd', fields: { type: 'podcast', country: 'DK', sku: 'p-1' } },
  ];

  const openRun = async (who: Who, filename: string) => {
    const s = await as(who);
    return s.invoke<Run>('tock/receive-run', {
      sourceKey: SRC,
      filename,
      byteSize: 64,
      contentHash: `sha256:${filename}`,
      storageKey: `runs/${filename}`,
      format: 'jsonl',
      delimiter: null,
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-04-01T00:00:00.000Z',
      periodTo: '2026-04-02T00:00:00.000Z',
    });
  };

  it('18 — a source declares which fields tell kinds apart, and the kinds', async () => {
    const ines = await as('ines');
    await ines.invoke('tock/declare-source', { key: SRC, title: 'Firehose', expectedCadence: 'daily' });
    const out = await ines.invoke<{ discriminators: string[]; variants: { key: string }[] }>('tock/declare-variants', {
      sourceKey: SRC,
      discriminators: ['type', 'event'],
      variants: [{ selector: ['page'] }, { selector: ['track'] }, { selector: ['track', 'scroll'] }, { selector: ['track', 'viewArticle'] }],
    });
    expect(out.discriminators).toEqual(['type', 'event']);
    expect(out.variants.map((v) => v.key).sort()).toEqual(['page', 'track', 'track/scroll', 'track/viewArticle']);
  });

  it('19 — a selector longer than the discriminators is refused, and so is a duplicate', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/declare-variants', {
        sourceKey: SRC,
        discriminators: ['type'],
        variants: [{ selector: ['track', 'scroll'] }],
      }),
    ).rejects.toThrow(/PREFIX/);
    await expect(
      ines.invoke('tock/declare-variants', {
        sourceKey: SRC,
        discriminators: ['type'],
        variants: [{ selector: ['page'] }, { selector: ['page'] }],
      }),
    ).rejects.toThrow(/share the selector/);
  });

  it('20 — each record lands in the LONGEST kind that matches, and an undeclared kind still lands', async () => {
    const ines = await as('ines');
    // Restore the four-variant declaration that 19's refusals left untouched.
    await ines.invoke('tock/declare-variants', {
      sourceKey: SRC,
      discriminators: ['type', 'event'],
      variants: [{ selector: ['page'] }, { selector: ['track'] }, { selector: ['track', 'scroll'] }, { selector: ['track', 'viewArticle'] }],
    });

    const run = await openRun('tomas', 'day-1.jsonl');
    const tomas = await as('tomas');
    await tomas.invoke('tock/profile-run', { runId: run.id, batch, final: true });

    const rows = await tomas.invoke<{ entries: { variant_key: string }[] }>('tock/list-rows', { runId: run.id });
    const kinds = rows.entries.map((r) => r.variant_key).sort();
    // `track/scroll` beats `track`: the longest matching selector wins. `podcast` matched
    // nothing and is the empty string — kept, classified, not dropped.
    expect(kinds).toEqual(['', 'page', 'track/scroll', 'track/viewArticle']);
    expect(rows.entries).toHaveLength(4);
  });

  it('21 — observations are per kind, so "not carried here" stops looking like "missing"', async () => {
    const tomas = await as('tomas');
    const run = (await tomas.invoke<{ entries: Run[] }>('tock/list-runs', { sourceKey: SRC })).entries[0]!;
    const obs = await tomas.invoke<{ entries: { variant_key: string; field: string; present_count: number }[] }>(
      'tock/list-observations',
      { runId: run.id },
    );
    const at = (v: string, f: string) => obs.entries.find((o) => o.variant_key === v && o.field === f);
    // `depth` is a scroll field. It is present there and has no row at all for a page —
    // which is the point: absence of the OBSERVATION says the kind does not carry it.
    expect(at('track/scroll', 'depth')?.present_count).toBe(1);
    expect(at('page', 'depth')).toBeUndefined();
    // The envelope is carried by every kind, so it is observed under each of them.
    expect(at('page', 'country')?.present_count).toBe(1);
    expect(at('track/scroll', 'country')?.present_count).toBe(1);
  });

  it('22 — the undeclared kind is reported as a finding, naming what it cost (nothing)', async () => {
    const ines = await as('ines');
    await ines.invoke('tock/save-schema', { sourceKey: SRC, fields: { country: { type: 'text', role: 'dimension' } } });
    const found = await ines.invoke<{ findings: { kind: string; detail: string }[] }>('tock/deviations', { sourceKey: SRC });
    const unmatched = found.findings.find((f) => f.kind === 'unmatched_records');
    expect(unmatched).toBeDefined();
    expect(unmatched!.detail).toMatch(/1 record\(s\)/);
    expect(unmatched!.detail).toMatch(/never dropped/);
  });

  it('23 — the envelope is declared once and a kind adds only what it adds', async () => {
    const ines = await as('ines');
    // The envelope already declares `country` as a dimension. A kind adding a second one is
    // fine; a kind adding a second dimension ON TOP of it would exceed the rollup's two slots.
    await ines.invoke('tock/save-schema', {
      sourceKey: SRC,
      variantKey: 'track/scroll',
      fields: { depth: { type: 'int', role: 'measure' } },
    });
    const schemas = await ines.invoke<{ entries: { variant_key: string; version: number }[] }>('tock/list-schemas', {
      sourceKey: SRC,
    });
    const keys = schemas.entries.map((s) => `${s.variant_key}@${s.version}`).sort();
    // Versions run per kind: the envelope's v1 and the variant's v1 are different things.
    expect(keys).toEqual(['@1', 'track/scroll@1']);
  });

  it('24 — the kinds freeze once a run has been counted', async () => {
    const tomas = await as('tomas');
    const ines = await as('ines');
    const run = (await tomas.invoke<{ entries: Run[] }>('tock/list-runs', { sourceKey: SRC })).entries[0]!;
    await tomas.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: run.id });
    // Rows were classified by the kinds declared when they were profiled. Changing them now
    // would leave a current number nobody could reproduce.
    await expect(
      ines.invoke('tock/declare-variants', { sourceKey: SRC, discriminators: ['type'], variants: [{ selector: ['page'] }] }),
    ).rejects.toThrow(/counted runs/);
  });

  /**
   * Versions run PER KIND, so the row a save reads back must name the kind it just wrote.
   *
   * It defaulted to the envelope, which is the same read with a different answer: `track/scroll`
   * v2 and the envelope's v2 are different rows, and the operation returned whichever one the
   * envelope happened to have — so the caller got another schema's id and the event announced a
   * save that had not happened. Test 23 saved a variant schema and never looked at the returned
   * row, which is exactly how this survived a green suite.
   */
  it('25 — saving a kind’s schema answers with THAT kind’s row, not the envelope’s', async () => {
    const ines = await as('ines');
    const saved = await ines.invoke<{ id: string; variant_key: string; version: number }>('tock/save-schema', {
      sourceKey: SRC,
      variantKey: 'track/scroll',
      fields: { depth: { type: 'int', role: 'measure' } },
    });
    expect(saved.variant_key).toBe('track/scroll');
    expect(saved.version).toBe(2);
    // …and it is a different row from the envelope's version of the same number.
    const envelope = await ines.invoke<{ id: string }>('tock/save-schema', {
      sourceKey: SRC,
      fields: { country: { type: 'text', role: 'dimension' } },
    });
    expect(envelope.id).not.toBe(saved.id);
  });

  /**
   * A declared filter that reaches no handler is worse than an undeclared one: it is a
   * documented parameter that answers every question with everything. `declared` had this
   * defect on `list-observations` and `variant_key` arrived with it on both paged reads.
   */
  it('26 — the kind filters actually narrow, and the empty key means the envelope', async () => {
    const ines = await as('ines');
    const all = await ines.invoke<{ entries: { variant_key: string }[] }>('tock/list-schemas', { sourceKey: SRC });
    expect(new Set(all.entries.map((e) => e.variant_key))).toEqual(new Set(['', 'track/scroll']));

    const scroll = await ines.invoke<{ entries: { variant_key: string }[] }>('tock/list-schemas', {
      sourceKey: SRC,
      variantKey: 'track/scroll',
    });
    expect(scroll.entries.length).toBeGreaterThan(0);
    expect(scroll.entries.every((e) => e.variant_key === 'track/scroll')).toBe(true);

    // `''` is an ASK, not an absence — it names the envelope, whose fields every record carries.
    const envelope = await ines.invoke<{ entries: { variant_key: string }[] }>('tock/list-schemas', {
      sourceKey: SRC,
      variantKey: '',
    });
    expect(envelope.entries.length).toBeGreaterThan(0);
    expect(envelope.entries.every((e) => e.variant_key === '')).toBe(true);
  });

  it('27 — and the same filter narrows the observations', async () => {
    const tomas = await as('tomas');
    const run = (await tomas.invoke<{ entries: Run[] }>('tock/list-runs', { sourceKey: SRC })).entries[0]!;
    const scroll = await tomas.invoke<{ entries: { variant_key: string; field: string }[] }>('tock/list-observations', {
      runId: run.id,
      variantKey: 'track/scroll',
    });
    expect(scroll.entries.length).toBeGreaterThan(0);
    expect(scroll.entries.every((o) => o.variant_key === 'track/scroll')).toBe(true);
    expect(scroll.entries.map((o) => o.field)).toContain('depth');
  });

  /**
   * The key is a PATH, and `pathOf` reads it back as one. A selector value carrying the
   * delimiter would make a one-level kind read as two — inheriting from a prefix nobody
   * declared — and an empty one would join to `''`, which IS the envelope's key, so the kind
   * would be indistinguishable from a record that matched nothing.
   */
  it('28 — a selector value may not carry the key delimiter, nor be empty', async () => {
    const ines = await as('ines');
    // A source of its own: SRC has a counted run by now, and its freeze would refuse these
    // for the wrong reason — a test that cannot fail for the reason it names is not a test.
    const FRESH = 'firehose-2';
    await ines.invoke('tock/declare-source', { key: FRESH, title: 'Firehose II', expectedCadence: 'daily' });
    await expect(
      ines.invoke('tock/declare-variants', {
        sourceKey: FRESH,
        discriminators: ['type'],
        variants: [{ selector: ['ui/click'] }],
      }),
    ).rejects.toThrow(/may not contain/);
    await expect(
      ines.invoke('tock/declare-variants', {
        sourceKey: FRESH,
        discriminators: ['type'],
        variants: [{ selector: [''] }],
      }),
    ).rejects.toThrow(/may not be empty/);
    // The same declaration with key-safe values is accepted, so the refusal is about the
    // VALUES and not about this source.
    await ines.invoke('tock/declare-variants', {
      sourceKey: FRESH,
      discriminators: ['type'],
      variants: [{ selector: ['click'] }],
    });
  });

  /**
   * A kind's label field routinely lives in the envelope — that is what declaring the envelope
   * once is for. Resolving it against the file in front of you refused a schema whose record
   * does carry the field, while the dimension cap directly above already used the effective shape.
   */
  it('29 — a kind may label a dimension with a field the envelope declares', async () => {
    const ines = await as('ines');
    // `country` is the envelope's; the kind declares only the dimension that points at it.
    const saved = await ines.invoke<{ variant_key: string }>('tock/save-schema', {
      sourceKey: SRC,
      variantKey: 'track/scroll',
      fields: { country_id: { type: 'text', role: 'dimension', labelField: 'country' } },
    });
    expect(saved.variant_key).toBe('track/scroll');
    // A label field nothing declares, at any level, is still refused.
    await expect(
      ines.invoke('tock/save-schema', {
        sourceKey: SRC,
        variantKey: 'track/scroll',
        fields: { x: { type: 'text', role: 'dimension', labelField: 'nowhere' } },
      }),
    ).rejects.toThrow(/inherits/);
  });
});

describe('two kinds collapse into one thing you count', () => {
  const SRC = 'engagement-src';
  /** The firehose case: two event names, identical shape, the same measurement. */
  const batch = [
    { occurredAt: '2026-05-01T08:00:00.000Z', subject: 'a', fields: { type: 'track', event: 'activeDuration', country: 'SE', duration: '30' } },
    { occurredAt: '2026-05-01T08:01:00.000Z', subject: 'b', fields: { type: 'track', event: 'idleDuration', country: 'SE', duration: '12' } },
    { occurredAt: '2026-05-01T08:02:00.000Z', subject: 'c', fields: { type: 'track', event: 'activeDuration', country: 'NO', duration: '45' } },
  ];

  it('25 — an output shape is declared, and it is additive only', async () => {
    const ines = await as('ines');
    await ines.invoke('tock/declare-source', { key: SRC, title: 'Engagement', expectedCadence: 'daily' });
    await ines.invoke('tock/declare-variants', {
      sourceKey: SRC,
      discriminators: ['type', 'event'],
      variants: [{ selector: ['track', 'activeDuration'] }, { selector: ['track', 'idleDuration'] }],
    });
    await ines.invoke('tock/save-output-schema', {
      sourceKey: SRC,
      key: 'engagement',
      fields: { country: { type: 'text', role: 'dimension' }, seconds: { type: 'int', role: 'measure' } },
    });
    // Dropping a declared field is refused: numbers already counted under it cannot be un-counted.
    await expect(
      ines.invoke('tock/save-output-schema', {
        sourceKey: SRC,
        key: 'engagement',
        fields: { country: { type: 'text', role: 'dimension' } },
      }),
    ).rejects.toThrow(/additive/);
    // And repurposing one is refused by name.
    await expect(
      ines.invoke('tock/save-output-schema', {
        sourceKey: SRC,
        key: 'engagement',
        fields: { country: { type: 'text', role: 'measure' }, seconds: { type: 'int', role: 'measure' } },
      }),
    ).rejects.toThrow(/never changes meaning/);
  });

  it('26 — a rule that writes a field the output does not have is refused', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/save-mapping', {
        sourceKey: SRC,
        variantKey: 'track/activeDuration',
        outputKey: 'engagement',
        rules: [{ from: 'duration', to: 'nope' }],
      }),
    ).rejects.toThrow(/no field 'nope'/);
  });

  it('27 — both kinds map to one output, and the counts are comparable', async () => {
    const ines = await as('ines');
    const tomas = await as('tomas');
    // The envelope maps what every record carries; each kind maps only its own field.
    await ines.invoke('tock/save-mapping', { sourceKey: SRC, outputKey: 'engagement', rules: [{ from: 'country', to: 'country' }] });
    for (const v of ['track/activeDuration', 'track/idleDuration']) {
      await ines.invoke('tock/save-mapping', {
        sourceKey: SRC,
        variantKey: v,
        outputKey: 'engagement',
        rules: [{ from: 'duration', to: 'seconds' }],
      });
    }
    await ines.invoke('tock/save-schema', { sourceKey: SRC, fields: { country: { type: 'text', role: 'dimension' } } });

    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: SRC, filename: 'e.jsonl', byteSize: 64, contentHash: 'sha256:e', storageKey: 'runs/e.jsonl',
      format: 'jsonl', delimiter: null, timeField: 'occurred_at', subjectField: 'subject',
      periodFrom: '2026-05-01T00:00:00.000Z', periodTo: '2026-05-02T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', { runId: run.id, batch, final: true });
    await tomas.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: run.id });

    // All three records reach ONE output, so SE's two events are comparable — which they
    // would not be if each arriving event name were its own shape.
    const byCountry = await ines.invoke<{ rows: { dim1: string; events: number; measure: string | null }[] }>('tock/report', {
      sourceKey: SRC, outputKey: 'engagement', grain: 'day', dimSet: 'country',
      from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z',
    });
    const se = byCountry.rows.find((r) => r.dim1 === 'SE');
    expect(se?.events).toBe(2);
    // 30 + 12, the envelope's country and each kind's own duration, stacked.
    expect(se?.measure).toBe('42');
    expect(byCountry.rows.find((r) => r.dim1 === 'NO')?.measure).toBe('45');
  });

  it('28 — the run records which mapping made the numbers', async () => {
    const ines = await as('ines');
    const run = (await ines.invoke<{ entries: Run[] }>('tock/list-runs', { sourceKey: SRC })).entries[0]!;
    const rules = await ines.invoke<{ entries: { rule_kind: string; identifier: string }[] }>('tock/run-rules', { runId: run.id });
    const mapping = rules.entries.find((r) => r.rule_kind === 'mapping');
    expect(mapping).toBeDefined();
    // Names every mapping version in force, so a re-run under a corrected one is explainable
    // rather than merely different.
    expect(mapping!.identifier).toMatch(/envelope->engagement@v1/);
    expect(mapping!.identifier).toMatch(/track\/activeDuration->engagement@v1/);
  });

  it('29 — a source with no output shapes still counts against the envelope', async () => {
    // The whole of the backward-compatibility claim, asserted rather than assumed: the
    // firehose source from the previous block declares no outputs and still reports.
    const ines = await as('ines');
    const plain = await ines.invoke<{ rows: { events: number }[] }>('tock/report', {
      sourceKey: 'firehose', grain: 'day', dimSet: 'total',
      from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z',
    });
    expect(plain.rows[0]?.events).toBe(4);
  });

  /**
   * The promise the deviations view makes in as many words: a record matching no declared
   * kind is "kept and counted under the envelope, never dropped". Declaring an output used
   * to REPLACE the envelope target, so an unmatched record either fell out of counting
   * altogether or was counted into an output whose shape says nothing about it — and the
   * finding went on claiming otherwise.
   */
  it('30 — an unmatched record is still counted under the envelope once outputs exist', async () => {
    // A source of its own, whose only mapping is VARIANT-level: nothing maps the envelope
    // into the output, which is the arrangement that used to lose the record entirely.
    // Declaring an output replaced the envelope target, so a record matching no declared
    // kind reached no target at all and was silently dropped from counting — while the
    // deviations finding went on saying it had been "kept and counted under the envelope".
    const OWN = 'unmatched-src';
    const ines = await as('ines');
    const tomas = await as('tomas');
    await ines.invoke('tock/declare-source', { key: OWN, title: 'Unmatched', expectedCadence: 'daily' });
    await ines.invoke('tock/declare-variants', {
      sourceKey: OWN,
      discriminators: ['type'],
      variants: [{ selector: ['track'] }],
    });
    await ines.invoke('tock/save-schema', { sourceKey: OWN, fields: { country: { type: 'text', role: 'dimension' } } });
    await ines.invoke('tock/save-output-schema', {
      sourceKey: OWN,
      key: 'engagement',
      fields: { country: { type: 'text', role: 'dimension' } },
    });
    await ines.invoke('tock/save-mapping', {
      sourceKey: OWN,
      variantKey: 'track',
      outputKey: 'engagement',
      rules: [{ from: 'country', to: 'country' }],
    });

    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: OWN, filename: 'u.jsonl', byteSize: 64, contentHash: 'sha256:u', storageKey: 'runs/u.jsonl',
      format: 'jsonl', delimiter: null, timeField: 'occurred_at', subjectField: 'subject',
      periodFrom: '2026-05-02T00:00:00.000Z', periodTo: '2026-05-03T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', {
      runId: run.id,
      batch: [
        // `page` matches no declared kind — the record this test exists for.
        { occurredAt: '2026-05-02T08:00:00.000Z', subject: 'z', fields: { type: 'page', country: 'DK' } },
        { occurredAt: '2026-05-02T08:01:00.000Z', subject: 'y', fields: { type: 'track', country: 'SE' } },
      ],
      final: true,
    });
    await tomas.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: run.id });

    const envelope = await ines.invoke<{ rows: { events: number }[] }>('tock/report', {
      sourceKey: OWN, grain: 'day', dimSet: 'total',
      from: '2026-05-02T00:00:00.000Z', to: '2026-05-03T00:00:00.000Z',
    });
    // The unmatched record, kept — and ONLY it, since the matched kind belongs to the output.
    expect(envelope.rows[0]?.events).toBe(1);

    const output = await ines.invoke<{ rows: { events: number }[] }>('tock/report', {
      sourceKey: OWN, outputKey: 'engagement', grain: 'day', dimSet: 'total',
      from: '2026-05-02T00:00:00.000Z', to: '2026-05-03T00:00:00.000Z',
    });
    expect(output.rows[0]?.events).toBe(1);
  });

  /**
   * `salt` and `mapping` are DERIVED from what the run actually did, and the caller's loop
   * runs after the derived insert with an `ON CONFLICT … DO UPDATE` — so accepting them
   * from a request let one call rewrite the record of which mapping produced the numbers.
   * An audit row that says whatever its subject prefers is worse than no audit row.
   */
  it('31 — a caller cannot declare the rules the run derives for itself', async () => {
    const tomas = await as('tomas');
    const run = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: SRC, filename: 'r.jsonl', byteSize: 64, contentHash: 'sha256:r', storageKey: 'runs/r.jsonl',
      format: 'jsonl', delimiter: null, timeField: 'occurred_at', subjectField: 'subject',
      periodFrom: '2026-05-01T00:00:00.000Z', periodTo: '2026-05-02T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', { runId: run.id, batch, final: true });
    await tomas.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });
    await expect(
      tomas.invoke('tock/count-run', {
        runId: run.id,
        rules: [{ kind: 'mapping', identifier: 'whatever-I-say', contentHash: 'deadbeef' }],
      }),
    ).rejects.toThrow();
    await expect(
      tomas.invoke('tock/count-run', {
        runId: run.id,
        rules: [{ kind: 'salt', identifier: 'mine', contentHash: 'deadbeef' }],
      }),
    ).rejects.toThrow();

    // The kinds a caller CAN declare still land, and the derived mapping survives beside them.
    await tomas.invoke('tock/count-run', {
      runId: run.id,
      rules: [{ kind: 'bot_list', identifier: 'iab/2026-05', contentHash: 'abc123' }],
    });
    const rules = await tomas.invoke<{ entries: { rule_kind: string; identifier: string }[] }>('tock/run-rules', {
      runId: run.id,
    });
    expect(rules.entries.find((r) => r.rule_kind === 'bot_list')?.identifier).toBe('iab/2026-05');
    expect(rules.entries.find((r) => r.rule_kind === 'mapping')?.identifier).toMatch(/->engagement@v/);
  });

  /** A second measure is silently dropped by `groupingsOf`, so the shape is refused instead. */
  it('32 — an output shape may declare only one measure', async () => {
    const ines = await as('ines');
    await expect(
      ines.invoke('tock/save-output-schema', {
        sourceKey: SRC,
        key: 'two-measures',
        fields: { seconds: { type: 'int', role: 'measure' }, bytes: { type: 'int', role: 'measure' } },
      }),
    ).rejects.toThrow(/at most 1 measure/);
  });
});
