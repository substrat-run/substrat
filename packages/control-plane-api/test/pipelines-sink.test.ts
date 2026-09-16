import { describe, expect, it } from 'vitest';
import { createPipelinesEventSink } from '../src/pipelines-sink.js';

/** Captures what a `[[pipelines]]` binding would have received. */
function fakeStream(onSend?: (n: number) => void) {
  const requests: Record<string, unknown>[][] = [];
  return {
    requests,
    stream: {
      async send(records: readonly Record<string, unknown>[]) {
        onSend?.(requests.length);
        requests.push([...records]);
      },
    },
  };
}

const scope = { tenantId: 'T1', scopeId: 'S1' } as never;

const event = (over: Record<string, unknown> = {}) =>
  ({
    id: '01J0000000000000000000000A',
    type: 'thing.happened',
    schemaVersion: 3,
    occurredAt: '2026-08-01T23:30:00.000Z',
    tenantId: 'T1',
    scopeId: 'S1',
    actor: '01J0000000000000000000000C',
    entity: { entityType: 'thing', entityId: 'x1' },
    piiClass: 'none',
    payload: { hello: 'world' },
    operation: 'mod/op',
    version: 'v-7',
    causedBy: null,
    invocationId: null,
    ...over,
  }) as never;

describe('createPipelinesEventSink', () => {
  it('encodes the envelope into the stream’s declared columns', async () => {
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [event()]);
    const row = requests[0]![0]!;

    // The stream declares snake_case columns; the envelope is camelCase. A key the
    // schema does not declare is a rejected row, not an ignored field.
    expect(Object.keys(row).sort()).toEqual(
      [
        'actor', 'caused_by', 'entity_id', 'entity_type', 'id', 'impersonation',
        'occurred_at', 'operation', 'payload', 'pii_class', 'authorization',
        'schema_version', 'scope_id', 'subject_id', 'tenant_id', 'type', 'version',
        'invocation_id', 'bytes',
      ].sort(),
    );
    // `entity` is ONE ref on the envelope and TWO columns in the outbox; the schema
    // follows the outbox, so the flattening happens here or not at all.
    expect(row.entity_type).toBe('thing');
    expect(row.entity_id).toBe('x1');
    // The spine stores ISO 8601 text and the column is a millisecond timestamp.
    expect(row.occurred_at).toBe(Date.parse('2026-08-01T23:30:00.000Z'));
    expect(typeof row.occurred_at).toBe('number');
    expect(row.caused_by).toBeNull();
  });

  it('states absent optional fields as null rather than omitting them', async () => {
    // JSON drops an `undefined` value entirely, so an omitted key and a declared-null
    // column are different rows — and the stream rejects a row missing a column it
    // declares. The envelope spells absence by omission; the lake cannot.
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [
      event({ subjectId: undefined, authorization: undefined, impersonation: undefined, payload: undefined }),
    ]);
    const row = requests[0]![0]!;
    for (const column of ['subject_id', 'authorization', 'impersonation', 'payload']) {
      expect(row).toHaveProperty(column);
      expect(row[column]).toBeNull();
    }
  });

  it('carries causedBy through, which is the whole reason the shape was widened (#1237)', async () => {
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [event({ causedBy: '01J0000000000000000000000B' })]);
    expect(requests[0]![0]!.caused_by).toBe('01J0000000000000000000000B');
  });

  it('carries invocationId through, so the lake can group a call (#1237)', async () => {
    // The schema derives its columns from the outbox, so declaring `invocation_id` there
    // is not what fills it — this mapper is. Asserted against a NON-NULL id, because the
    // failure being guarded is a column that is null on every row: a presence check over
    // the default would pass against a mapper that never wrote the field at all.
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [event({ invocationId: '01J0000000000000000000000D' })]);
    expect(requests[0]![0]!.invocation_id).toBe('01J0000000000000000000000D');
  });

  it('splits on BYTES, not on a row count, so one fat payload cannot overflow a request', async () => {
    // Cloudflare's ceiling is 5 MB per ingestion request while the drain's budget is a
    // row count, so a scope emitting large payloads reaches the limit in far fewer rows
    // than one emitting small ones. A count-based split works until a vertical starts
    // attaching documents.
    const { requests, stream } = fakeStream();
    const fat = 'x'.repeat(1_500_000);
    await createPipelinesEventSink(stream).ship(scope, [
      event({ id: '01J000000000000000000000A1', payload: { blob: fat } }),
      event({ id: '01J000000000000000000000A2', payload: { blob: fat } }),
      event({ id: '01J000000000000000000000A3', payload: { blob: fat } }),
      event({ id: '01J000000000000000000000A4', payload: { blob: fat } }),
    ]);
    // 4 x ~1.5 MB against a 4 MB budget ⇒ more than one request, and every request
    // under the ceiling.
    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests) expect(JSON.stringify(r).length).toBeLessThan(5 * 1024 * 1024);
    // Nothing is dropped in the packing, and order is preserved across the split.
    expect(requests.flat().map((r) => r.id)).toEqual([
      '01J000000000000000000000A1', '01J000000000000000000000A2',
      '01J000000000000000000000A3', '01J000000000000000000000A4',
    ]);
  });

  it('carries the row’s own UTF-8 size, so per-tenant volume is answerable', async () => {
    // Every tenant's events share one parquet file (a Data Catalog sink cannot partition),
    // so R2 reports no per-tenant storage and this column is the only honest measure —
    // summed over rows deduplicated by `(tenant_id, id)`, since shipping is at-least-once
    // and a retried batch re-lands its prefix. `bytes` is deterministic per event, which
    // is what lets a DISTINCT collapse those duplicates instead of doubling them.
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [event({ payload: { blob: 'x'.repeat(1000) } })]);
    const row = requests[0]![0]!;
    expect(typeof row.bytes).toBe('number');
    // It measures the event's data and EXCLUDES itself — the alternative is a fixpoint,
    // since writing the number changes the length that produced it.
    const { bytes, ...withoutBytes } = row;
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(withoutBytes)).length);
    expect(bytes as number).toBeGreaterThan(1000);
  });

  it('counts multibyte characters as their UTF-8 size, so billing is not 1/3 short', async () => {
    // The same ruler bug, on the billing side rather than the budget: `.length` would
    // report a third of the truth for three-byte characters, and undercharge every tenant
    // whose data is not ASCII — which in this repo's own market is most of them.
    const { requests, stream } = fakeStream();
    await createPipelinesEventSink(stream).ship(scope, [event({ payload: { blob: '一'.repeat(100) } })]);
    const row = requests[0]![0]!;
    const { bytes, ...rest } = row;
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(rest)).length);
    // 100 three-byte characters ⇒ ~300 bytes of payload alone; a code-unit count is ~100.
    expect(bytes as number).toBeGreaterThan(300);
  });

  it('measures UTF-8 bytes, not UTF-16 code units, against the request budget', async () => {
    // `.length` counts code units: ordinary Swedish text measures ~13% under its real
    // UTF-8 size, and a three-byte character measures at a third. Cloudflare's ceiling is
    // BYTES, so the wrong ruler lets a batch pass here and be rejected there — and a
    // rejected batch is a scope that never drains, because the next pass rebuilds the
    // same one. Every character below is 3 bytes and 1 code unit, so a budget measured
    // the old way sees a third of the truth and packs everything into one request.
    const { requests, stream } = fakeStream();
    const threeByte = '一'.repeat(700_000); // 2.1 MB in UTF-8, 700k UTF-16 units
    await createPipelinesEventSink(stream).ship(scope, [
      event({ id: '01J000000000000000000000B1', payload: { blob: threeByte } }),
      event({ id: '01J000000000000000000000B2', payload: { blob: threeByte } }),
    ]);
    // 2 x 2.1 MB = 4.2 MB against a 4 MB budget ⇒ must split. Measured by `.length` it
    // would read as 1.4 MB and ship as one request.
    expect(requests.length).toBe(2);
    for (const r of requests) {
      expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThan(5 * 1024 * 1024);
    }
  });

  it('refuses a single event too large to ship, instead of skipping it', async () => {
    // Skipping would drain the scope PAST a row the lake never received, and the
    // `drainedAt` stamp would then claim exact history with a hole in it. Failing
    // keeps the row undrained and the scope visible in the sweep's errors.
    const { stream } = fakeStream();
    await expect(
      createPipelinesEventSink(stream).ship(scope, [event({ payload: { blob: 'x'.repeat(5_000_000) } })]),
    ).rejects.toThrow(/cannot be shipped/);
  });

  it('throws when a later chunk fails, so nothing is stamped and the batch replays', async () => {
    // The trade the seam's contract already names: at least once, never fewer. The
    // first chunk lands twice on the retry, which is reconcilable; a stamped batch
    // whose tail never arrived is not.
    const { stream } = fakeStream((n) => {
      if (n === 1) throw new Error('stream unavailable');
    });
    const fat = 'x'.repeat(1_500_000);
    await expect(
      createPipelinesEventSink(stream).ship(scope, [
        event({ id: '01J000000000000000000000A1', payload: { blob: fat } }),
        event({ id: '01J000000000000000000000A2', payload: { blob: fat } }),
        event({ id: '01J000000000000000000000A3', payload: { blob: fat } }),
      ]),
    ).rejects.toThrow(/stream unavailable/);
  });

  it('refuses an empty batch rather than returning a ref to nothing', async () => {
    const { stream } = fakeStream();
    await expect(createPipelinesEventSink(stream).ship(scope, [])).rejects.toThrow(/empty batch/);
  });

  it('returns a ref that cannot be mistaken for an addressable object', async () => {
    // A stream has no key to hand back the way an R2 object does, so the ref says what
    // is true instead: which scope, over what id range, in how many requests.
    const { stream } = fakeStream();
    const { ref } = await createPipelinesEventSink(stream).ship(scope, [
      event({ id: '01J000000000000000000000A1' }),
      event({ id: '01J000000000000000000000A2' }),
    ]);
    expect(ref).toBe('pipelines:S1/01J000000000000000000000A1..01J000000000000000000000A2#1');
  });
});
