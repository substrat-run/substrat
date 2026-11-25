import type { DirectoryLakeRow, DirectoryLakeSink } from '@substrat-run/kernel';
import { byteLength, sendPacked } from './pipelines-sink.js';

/**
 * K-70 (tenants × time data leaves the objects): the Pipelines implementation of the directory's
 * `DirectoryLakeSink`, shipping its outbox to the lake's directory table. The stream's fields are
 * `scripts/lake/directory-stream-schema.generated.json`, derived from `_substrat_directory_outbox`.
 *
 * The same delivery contract as the event sink (`pipelines-sink.ts`): rows are packed by bytes
 * and sent one request after another, a resolved `send` is Cloudflare confirming the records are
 * in the durable stream, and a failure part-way throws so nothing is acknowledged and the batch
 * goes again (at least once). The lake keeps every version of a row, keyed by
 * (`dataset`, `row_key`), ordered by `captured_at` and then `seq`; a duplicate is the same version.
 *
 * Two shape changes, forced by the stream schema as they are for events: `at` and `captured_at`
 * become epoch milliseconds (a day's `at`, `2026-11-24`, is that day's UTC midnight), and `row`
 * travels as the JSON object it is rather than as text.
 */
function toRow(r: DirectoryLakeRow): Record<string, unknown> {
  const at = Date.parse(r.at);
  const capturedAt = Date.parse(r.capturedAt);
  if (Number.isNaN(at) || Number.isNaN(capturedAt)) {
    // A row whose time is not a time would land as a null the schema refuses, or worse as a wrong
    // instant; failing keeps it queued and visible in the pass's errors.
    throw new Error(`directory lake sink: ${r.dataset} ${r.rowKey} has an unreadable time (at ${r.at}, captured ${r.capturedAt})`);
  }
  const row = {
    seq: r.seq,
    dataset: r.dataset,
    row_key: r.rowKey,
    tenant_id: r.tenantId,
    scope_id: r.scopeId,
    at,
    kind: r.kind,
    actor: r.actor,
    captured_at: capturedAt,
    row: JSON.parse(r.row) as unknown,
  };
  // The row's own size, without this field, as the event sink measures it: per-tenant volume.
  return { ...row, bytes: byteLength(row) };
}

export function createPipelinesDirectoryLakeSink(stream: unknown): DirectoryLakeSink {
  return {
    async ship(rows) {
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (!first || !last) throw new Error('directory lake sink: refusing to ship an empty batch');
      const requests = await sendPacked(
        stream,
        rows.map((r) => ({
          row: toRow(r),
          refuse: (bytes: number) =>
            new Error(`directory lake sink: ${r.dataset} ${r.rowKey} serializes to ${bytes} bytes, over one request; it stays queued`),
        })),
      );
      const span = first.seq !== null && last.seq !== null ? `${first.seq}..${last.seq}` : `${first.dataset}:${first.rowKey}..${last.rowKey}`;
      return { ref: `pipelines:directory/${span}#${requests}` };
    },
  };
}
