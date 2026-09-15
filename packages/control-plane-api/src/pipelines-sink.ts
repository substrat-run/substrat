import type { DrainedEvent } from '@substrat-run/contracts';
import type { EventSink } from '@substrat-run/kernel';

/**
 * The minimal slice of a Workers `[[pipelines]]` binding this sink relies on.
 *
 * A binding, deliberately, and not the stream's HTTP endpoint: the endpoint needs a
 * Workers Pipeline Send token, and a credential that ships the audit spine is one more
 * thing to store, rotate and leak. A binding carries none — it cannot expire, and it
 * cannot be replayed from somewhere else.
 */
interface PipelineStreamLike {
  send(records: readonly Record<string, unknown>[]): Promise<unknown>;
}

/**
 * Cloudflare's documented ceiling is 5 MB per ingestion request. This is the budget the
 * sink packs to, left deliberately under it: `JSON.stringify` here and the encoder on
 * Cloudflare's side need not agree byte for byte, and a batch rejected for being one
 * kilobyte over is a scope that never drains again — its next pass builds the same
 * oversized batch, forever.
 */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The serialized size of one row in BYTES.
 *
 * `JSON.stringify(x).length` is not this, and the difference is not academic: `.length`
 * counts UTF-16 code units, so ordinary Swedish text measures ~13% under its real UTF-8
 * size and CJK or emoji can measure at a third of it. Cloudflare's ceiling is bytes.
 * Measuring a byte budget with a code-unit ruler means a batch can pass the check here
 * and be rejected there — and a rejected batch is a scope that never drains, because the
 * next pass rebuilds exactly the same one.
 *
 * `TextEncoder` is the web-standard UTF-8 encoder, available identically in Workers and
 * Node — the same reason the repo reaches for `globalThis.crypto` over a node import.
 */
const UTF8 = new TextEncoder();
const byteLength = (row: Record<string, unknown>): number => UTF8.encode(JSON.stringify(row)).length;

/**
 * An event the platform cannot ship at all, because one event exceeds a whole request.
 * Left as a throw rather than a skip: skipping it would drain the scope past a row the
 * lake never received, and `drainedAt` would then claim exact history that has a hole in
 * it. Failing keeps the row undrained and visible in the sweep's errors.
 */
function tooLarge(event: DrainedEvent, bytes: number): Error {
  return new Error(
    `event sink: event ${event.id} (${event.type}) serializes to ${bytes} bytes, over the ` +
      `${MAX_REQUEST_BYTES}-byte request budget — it cannot be shipped and the scope will not drain past it`,
  );
}

/**
 * One drained event as the stream's declared schema wants it.
 *
 * Three shape changes, each forced by the schema rather than chosen:
 *
 * - **`entity` flattens** to `entity_type` / `entity_id`. The envelope holds one ref; the
 *   outbox has always held two columns, and the generated schema follows the outbox.
 * - **`occurredAt` becomes epoch milliseconds.** The spine stores ISO 8601 text — the
 *   repo's rule, and the one that keeps a row and the event announcing it agreeing about
 *   when — while the stream column is a millisecond `timestamp`. The conversion belongs
 *   here, at the seam, and nowhere upstream of it.
 * - **`undefined` becomes `null`.** The envelope spells "absent" by omission for the
 *   optional fields; the stream's columns are nullable and JSON drops an undefined value
 *   entirely. Omitting a declared column and stating it is null are different rows.
 */
function toRow(e: DrainedEvent): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    schema_version: e.schemaVersion,
    occurred_at: Date.parse(e.occurredAt),
    tenant_id: e.tenantId,
    scope_id: e.scopeId,
    actor: e.actor,
    entity_type: e.entity.entityType,
    entity_id: e.entity.entityId,
    pii_class: e.piiClass,
    subject_id: e.subjectId ?? null,
    payload: e.payload ?? null,
    authorization: e.authorization ?? null,
    impersonation: e.impersonation ?? null,
    operation: e.operation,
    version: e.version,
    // #1237 — the column the drain dropped until it was made part of `DrainedEvent`.
    // A null here is the ordinary case (an operation emitted this directly); a null
    // because nothing supplied it would read as the same thing, which is why the shape
    // makes it required.
    caused_by: e.causedBy,
  };
}

/**
 * The row, plus its own serialized size.
 *
 * Every tenant's events share one parquet file — a Data Catalog sink cannot partition —
 * so R2 reports no per-tenant storage and `SUM(bytes) GROUP BY tenant_id` is the only
 * honest per-tenant measure the lake can offer. It is the row AS SHIPPED, not as stored;
 * see SINK_COMPUTED in tools/lake-schema-emit.mjs for why that is the better billing
 * basis rather than a concession.
 *
 * Measured on the row WITHOUT this field, then the field added — the alternative is a
 * fixpoint, since writing the number changes the length that produced it. So `bytes` is
 * the size of the event's own data and excludes itself, which is both computable and the
 * quantity anyone would actually want to be charged for.
 */
function toSizedRow(e: DrainedEvent): Record<string, unknown> {
  const row = toRow(e);
  return { ...row, bytes: byteLength(row) };
}

/**
 * The Pipelines implementation of the `EventSink` seam (#1334) — Tier 2 proper, the row
 * kernel-design §5.3 names for the Cloudflare adapter: "Event transport | Pipelines →
 * Iceberg/R2". `createR2EventSink` is the same seam's NDJSON staging shape, and the pure
 * adapter's counterpart; the drain never learns which it is bound to.
 *
 * **Ordering, and what a partial ship means.** A batch over the request budget is packed
 * into several requests and sent one after another. If the third fails, `ship` throws,
 * the sweep stamps NOTHING, and the whole batch is offered again next tick — so the
 * first two chunks land twice. That is the trade the seam's contract already names: at
 * least once, never fewer, because the lake is keyed by event id and a duplicate is
 * reconcilable where a hole is not. Sending sequentially rather than in parallel keeps
 * the duplicated prefix small and bounded instead of arbitrary.
 *
 * **What a resolved `send` claims.** Cloudflare documents the promise as resolving "when
 * records are confirmed as ingested" into the durable stream. That is what licenses the
 * `drainedAt` stamp, and it is the one assumption this sink rests on: if a future runtime
 * resolves early, "the lake has everything" silently stops being checkable. It is stated
 * here so that a change to it is a change to something written down.
 */
export function createPipelinesEventSink(stream: unknown): EventSink {
  const pipeline = stream as PipelineStreamLike;
  return {
    async ship(scope, events) {
      const first = events[0];
      const last = events[events.length - 1];
      if (!first || !last) {
        // The sweep never ships an empty batch; returning a ref for records that were
        // never sent would be a lie, and the stamp it licenses would be one too.
        throw new Error('event sink: refusing to ship an empty batch');
      }

      // Packed by BYTES, not by count. The drain's budget is a row count (200 by
      // default) and the ceiling here is a size, so one scope emitting fat payloads
      // reaches the limit in far fewer rows than one emitting thin ones. A count-based
      // split would work until the day a vertical started attaching documents.
      let batch: Record<string, unknown>[] = [];
      let bytes = 0;
      let requests = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await pipeline.send(batch);
        requests += 1;
        batch = [];
        bytes = 0;
      };
      for (const event of events) {
        const row = toSizedRow(event);
        // The BUDGET measures the row as actually sent, `bytes` field included — what
        // Cloudflare weighs is the request, not the event. Deliberately not the same
        // number as the column: one answers "will this request fit", the other "what did
        // this tenant store". +1 for the comma this row contributes to the encoded array.
        const size = byteLength(row) + 1;
        if (size > MAX_REQUEST_BYTES) throw tooLarge(event, size);
        if (bytes + size > MAX_REQUEST_BYTES) await flush();
        batch.push(row);
        bytes += size;
      }
      await flush();

      // Not addressable, and shaped so it cannot be mistaken for something that is: a
      // stream has no key to hand back the way an R2 object does. What the caller's
      // report can honestly carry is which scope's events went, over what id range, in
      // how many requests.
      return { ref: `pipelines:${scope.scopeId}/${first.id}..${last.id}#${requests}` };
    },
  };
}
