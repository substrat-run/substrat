import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DirectoryLakeRow } from '@substrat-run/kernel';
import { createPipelinesDirectoryLakeSink } from '../src/directory-lake-sink.js';

/** The schema the directory stream is created from (`pnpm lint:lake-schema` holds it to the outbox). */
const declared = JSON.parse(
  readFileSync(new URL('../../../scripts/lake/directory-stream-schema.generated.json', import.meta.url), 'utf8'),
) as { fields: { name: string }[] };

const fake = () => {
  const requests: Record<string, unknown>[][] = [];
  return { requests, stream: { async send(records: readonly Record<string, unknown>[]) { requests.push([...records]); } } };
};

const row = (over: Partial<DirectoryLakeRow> = {}): DirectoryLakeRow => ({
  seq: 7, dataset: 'meter_days', rowKey: '["2026-11-24","T1"]', tenantId: 'T1', scopeId: null,
  at: '2026-11-24', kind: 'active', actor: null, capturedAt: '2026-11-25T01:00:00.000Z',
  row: '{"day":"2026-11-24","tenant_id":"T1","billable":1}', ...over,
});

describe('createPipelinesDirectoryLakeSink (K-70)', () => {
  it('ships every declared column, times as epoch milliseconds and the row as JSON', async () => {
    const { requests, stream } = fake();
    const { ref } = await createPipelinesDirectoryLakeSink(stream).ship([row(), row({ seq: 9 })]);
    const shipped = requests[0]![0]!;
    expect(Object.keys(shipped).sort()).toEqual(declared.fields.map((f) => f.name).sort());
    expect(shipped).toMatchObject({
      at: Date.parse('2026-11-24T00:00:00.000Z'),
      captured_at: Date.parse('2026-11-25T01:00:00.000Z'),
      row: { day: '2026-11-24', tenant_id: 'T1', billable: 1 },
    });
    expect(ref).toBe('pipelines:directory/7..9#1');
  });

  it('refuses an empty batch and a row whose time is unreadable, sending nothing', async () => {
    const { requests, stream } = fake();
    const sink = createPipelinesDirectoryLakeSink(stream);
    await expect(sink.ship([])).rejects.toThrow(/empty batch/);
    await expect(sink.ship([row({ at: 'yesterday' })])).rejects.toThrow(/unreadable time/);
    expect(requests).toEqual([]);
  });
});
