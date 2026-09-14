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
        const row = toRow(event);
        // +1 for the comma this row would contribute to the encoded array.
        const size = JSON.stringify(row).length + 1;
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
