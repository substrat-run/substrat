/**
 * The scenario from spec/concept.md section 8, replayed headlessly.
 *
 * Written from the CONCEPT, never from the model: a test derived from the model agrees with a
 * wrong model perfectly and forever. Inputs and expectations are literals here for the same
 * reason — a test that builds its input from the emitted schema cannot disagree with it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

type Who = 'ines' | 'tomas' | 'wren';
const as = (who: Who) => host.getScope(world[who].principal, world.tenant, world.scope);
/** Petra, acting on the FIRST publisher's workspace — a legitimate admin of her own, elsewhere. */
const asPetraHere = () => host.getScope(world.petra.principal, world.tenant, world.scope);
const asPetraHome = () => host.getScope(world.petra.principal, world.otherTenant, world.otherScope);

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

describe('a day of logs becomes a number', () => {
  let runOne: string;

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

    const counted = await tomas.invoke<Run>('tock/count-run', { runId: runOne });
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
});

describe('a correction supersedes without destroying', () => {
  it('11 — the re-run becomes current and the first run keeps its own number', async () => {
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

    // Day one again, with the bot excluded this time — three records rather than four.
    const rerun = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-14.log',
      byteSize: 1024,
      contentHash: 'sha256:aaa',
      storageKey: 'runs/2026-03-14.log',
      periodFrom: '2026-03-14T00:00:00.000Z',
      periodTo: '2026-03-15T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', {
      runId: rerun.id,
      final: true,
      batch: dayOne.filter((r) => !r.subject.includes('CrawlerBot')),
    });
    await tomas.invoke('tock/map-run', { runId: rerun.id, schemaVersion: 1 });
    await tomas.invoke('tock/count-run', { runId: rerun.id });

    const after = await ines.invoke<{ rows: { events: number; runId: string }[] }>('tock/report', window);
    expect(after.rows[0]?.events).toBe(3);
    expect(after.rows[0]?.runId).toBe(rerun.id);
    expect(after.rows[0]?.runId).not.toBe(firstRunId);

    // And the displaced run is still there, still counted, still holding what it reported.
    const original = await ines.invoke<Run>('tock/get-run', { runId: firstRunId! });
    expect(original.status).toBe('counted');
    expect(original.row_count).toBe(4);
  });

  it('12 — the lifecycle cannot be skipped, and a counted run cannot be moved', async () => {
    const tomas = await as('tomas');
    const fresh = await tomas.invoke<Run>('tock/receive-run', {
      sourceKey: 'fjord-cdn',
      filename: '2026-03-16.log',
      byteSize: 64,
      contentHash: 'sha256:ccc',
      storageKey: 'runs/2026-03-16.log',
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
});
