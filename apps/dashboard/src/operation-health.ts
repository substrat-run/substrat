/**
 * Per-operation health (#1234's overlay) — what each of an app's operations has
 * actually done, and how often it was refused.
 *
 * ## Why this is not built from spans
 *
 * #1237's waterfall wanted per-operation timing from `otel`. Nothing in the platform
 * emits a span for an operation: what reaches that dataset is what the runtime
 * produces by itself — outbound `fetch` and the DO entry hop. So the per-operation
 * facts that DO exist are the ones the spine wrote down, and those are the ones here.
 *
 * ## The two sources, and what each of them cannot see
 *
 * **Events, faceted by the emitting operation.** Records what an operation produced
 * and when it last did. It cannot see an operation that emits nothing: a read, or a
 * write whose module raises no event, is invisible to this source however often it
 * runs. So a count here is "events recorded", never "calls" — and an operation absent
 * from the facet has not been shown to be idle.
 *
 * **Refusals, from the denial log.** Records `assertAllowed` throwing, per operation,
 * which is the one failure the spine keeps for a vertical's own operations. It sees
 * operations the event facet cannot — a call refused at its first line emits nothing —
 * which is why the two are unioned rather than one being joined onto the other.
 *
 * Neither is a call count, and nothing here pretends to compute an error RATE: the
 * denominator would have to be invocations, and the platform does not record those
 * per operation. Refusals are reported as what they are.
 */
export interface OperationHealthRow {
  operation: string;
  /** Events this operation emitted, or null when the facet could not say. */
  events: number | null;
  /** When it last emitted one; null if it never has, or the facet could not say. */
  lastSeen: string | null;
  /** Permission refusals recorded for it inside the window the denial log still holds. */
  refusals: number;
  /**
   * True when the ONLY evidence for this operation is refusals — it has emitted
   * nothing. Worth saying rather than rendering a bare zero: an operation that only
   * ever gets refused looks identical to a quiet one until you know which source
   * carried it.
   */
  refusedOnly: boolean;
}

export interface OperationHealthView {
  rows: OperationHealthRow[];
  /**
   * False when the event facet was truncated: some operations are missing entirely and
   * the counts shown are only the largest. An absent operation proves nothing here.
   */
  observedComplete: boolean;
  /**
   * The oldest denial the log still holds, or null when it holds none.
   *
   * Load-bearing, because denial rows DRAIN rather than expire: what is retained is a
   * storage bound, not a retention promise. So `refusals: 0` means "none in what is
   * still held", never "never refused", and a view that omitted this floor would be
   * inviting exactly that reading.
   */
  refusalsSince: string | null;
}

export interface ObservedOperation {
  operation: string;
  count: number;
  lastSeen: string | null;
}

export interface RecordedDenial {
  operation: string | null;
  at: string;
}

export function deriveOperationHealth(input: {
  /** Outbox facet grouped by the emitting operation. */
  observed: readonly ObservedOperation[];
  /** False when that facet was cut at its cap. */
  observedComplete: boolean;
  /** A bounded page of the scope's denial log. */
  denials: readonly RecordedDenial[];
}): OperationHealthView {
  const { observed, observedComplete, denials } = input;

  const refusals = new Map<string, number>();
  let oldest: string | null = null;
  for (const d of denials) {
    // A denial whose operation was not recorded cannot be attributed to one. It still
    // moves the window floor below, because it is evidence about the log's extent even
    // when it is not evidence about an operation.
    if (d.at !== '' && (oldest === null || d.at < oldest)) oldest = d.at;
    if (d.operation === null) continue;
    refusals.set(d.operation, (refusals.get(d.operation) ?? 0) + 1);
  }

  const rows = new Map<string, OperationHealthRow>();
  for (const o of observed) {
    rows.set(o.operation, {
      operation: o.operation,
      events: o.count,
      lastSeen: o.lastSeen,
      refusals: refusals.get(o.operation) ?? 0,
      refusedOnly: false,
    });
  }
  // Union, not join: an operation refused at its first line emits nothing, so the
  // denial log is the only place it appears at all. Dropping it would hide precisely
  // the operation somebody is failing to call.
  for (const [operation, count] of refusals) {
    if (rows.has(operation)) continue;
    rows.set(operation, {
      operation,
      // Zero, not null: the facet DID answer and this operation was not in it. Null is
      // reserved for "the facet could not say", which is a different thing.
      events: observedComplete ? 0 : null,
      lastSeen: null,
      refusals: count,
      refusedOnly: true,
    });
  }

  return {
    rows: [...rows.values()].sort(
      (a, b) => b.refusals - a.refusals || (b.events ?? 0) - (a.events ?? 0) || a.operation.localeCompare(b.operation),
    ),
    observedComplete,
    refusalsSince: oldest,
  };
}
