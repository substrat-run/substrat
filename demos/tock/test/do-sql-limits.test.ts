/**
 * A schema with more fields than a Durable Object binds parameters (#1759, found by #1741's
 * guard): mapping a run flags the observations the schema declares, and that used to bind
 * one `?` per declared field. It grows with the model, not the data, so one more field was
 * enough to make re-mapping refuse on a deployed scope.
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tock-do-sql-limits-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mapping a run onto a schema of a hundred and twenty fields', () => {
  it('flags every declared field, and only those', async () => {
    const ines = await host.getScope(world.ines.principal, world.tenant, world.scope);
    const tomas = await host.getScope(world.tomas.principal, world.tenant, world.scope);
    const names = Array.from({ length: 120 }, (_, i) => `field_${i}`);

    await ines.invoke('tock/declare-source', { key: 'wide-feed', title: 'Wide feed', expectedCadence: 'daily' });
    const run = await tomas.invoke<{ id: string }>('tock/receive-run', {
      sourceKey: 'wide-feed',
      filename: '2026-03-14.log',
      byteSize: 1024,
      contentHash: 'sha256:wide',
      storageKey: 'runs/wide.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-14T00:00:00.000Z',
      periodTo: '2026-03-15T00:00:00.000Z',
    });
    await tomas.invoke('tock/profile-run', {
      runId: run.id,
      final: true,
      batch: [
        {
          occurredAt: '2026-03-14T08:00:00.000Z',
          subject: 'a',
          // One field nobody declares, beside the hundred and twenty that are.
          fields: { ...Object.fromEntries(names.map((n) => [n, 'x'])), stray: 'y' },
        },
      ],
    });
    await ines.invoke('tock/save-schema', {
      sourceKey: 'wide-feed',
      fields: Object.fromEntries(names.map((n) => [n, { type: 'text', role: 'ignored' }])),
    });

    await tomas.invoke('tock/map-run', { runId: run.id, schemaVersion: 1 });

    const declared = await tomas.invoke<{ entries: { field: string }[] }>('tock/list-observations', {
      runId: run.id,
      declared: true,
      limit: 200,
    });
    expect(declared.entries.map((o) => o.field).sort()).toEqual([...names].sort());
    const undeclared = await tomas.invoke<{ entries: { field: string }[] }>('tock/list-observations', {
      runId: run.id,
      declared: false,
    });
    expect(undeclared.entries.map((o) => o.field)).toEqual(['stray']);
  });
});
