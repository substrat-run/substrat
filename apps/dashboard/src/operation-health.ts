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
 * The counts come from the log's own per-operation aggregate (`groupBy: 'operation'`
 * on the denial summary, #1456) — one bucket per operation, busiest first, capped at
 * the route's ceiling — never from a page of raw rows. A page could not answer this:
 * newest-first and capped, one noisy operation crowds every other out of it (K-35's
 * flooding prober), and every count it yields is a floor. A bucket is every row of its
 * operation, so a count here is exact; what a cap can cost is the QUIETEST operations,
 * missing entirely, which is why the summary's two facts about the whole log ride
 * beside the buckets: how many rows it holds, so a cut bucket list knows it was cut,
 * and the log's own floor.
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
  /**
   * Permission refusals recorded for it — its bucket in the per-operation aggregate,
   * so a count here is exact whatever `refusals.complete` on the view says; what an
   * incomplete view withholds is operations, not rows. Null when the log could not be
   * read at all, and ALSO when the bucket list was cut short and this operation had no
   * bucket in it: it may be one of the quiet operations the cap dropped, so its count is
   * unknown, not zero. Zero is reserved for a complete list this operation was not in.
   */
  refusals: number | null;
  /**
   * True when the ONLY evidence for this operation is refusals — the event facet was
   * complete and did not carry it, so it has emitted nothing. Worth saying rather than
   * rendering a bare zero: an operation that only ever gets refused looks identical to
   * a quiet one until you know which source carried it. Never true when the facet was
   * cut short: absence from a truncated facet is unknown, not proof of silence.
   */
  refusedOnly: boolean;
}

/**
 * What the refusal side can vouch for, or null when the log could not be read — which
 * is a different thing from a log that holds nothing, and the two must not collapse
 * into one another: an unread log shows no badges either, and a screen that rendered
 * that as "no refusals" would be reporting a retrieval failure as a clean bill.
 */
export interface RefusalWindow {
  /**
   * True when the buckets account for every row the log holds, so every operation
   * with a refusal has a row here and an operation with none genuinely has no refusal
   * in the window. False when the log holds more distinct operations than one page of
   * buckets carries: the counts shown are still exact, but the buckets are busiest
   * first, so what is missing is the quietest operations — absent entirely, not
   * undercounted.
   */
  complete: boolean;
  /** Rows the log holds in total, so a reader can see how much the buckets cover. */
  held: number;
  /** Rows the buckets account for — the sum of their counts. */
  counted: number;
  /**
   * The oldest denial the log still holds, or null when it holds none. The LOG's floor,
   * not the page's: denial rows DRAIN rather than expire, so what is retained is a
   * storage bound, not a retention promise. `refusals: 0` means "none in what is still
   * held", never "never refused", and a view that omitted this floor would be inviting
   * exactly that reading.
   */
  since: string | null;
}

export interface OperationHealthView {
  rows: OperationHealthRow[];
  /**
   * False when the event facet was truncated: some operations are missing entirely and
   * the counts shown are only the largest. An absent operation proves nothing here.
   */
  observedComplete: boolean;
  /** The refusal side's own account of itself; null when the log could not be read. */
  refusals: RefusalWindow | null;
}

export interface ObservedOperation {
  operation: string;
  count: number;
  lastSeen: string | null;
}

/** One per-operation bucket of the denial log; null for refusals that unwound no operation. */
export interface RefusalBucket {
  operation: string | null;
  count: number;
}

/** The denial log as read: its per-operation buckets plus the summary's facts about the whole. */
export interface DenialRead {
  /** The scope's denial log grouped by operation, busiest first, capped at the route's ceiling. */
  buckets: readonly RefusalBucket[];
  /** How many rows the log holds, from the same summary — what the buckets are a page of. */
  held: number;
  /** The log's own floor, from the summary; null when it holds nothing. */
  windowOldestAt: string | null;
}

export function deriveOperationHealth(input: {
  /** Outbox facet grouped by the emitting operation. */
  observed: readonly ObservedOperation[];
  /** False when that facet was cut at its cap. */
  observedComplete: boolean;
  /** The denial log, or null when reading it failed. */
  denials: DenialRead | null;
}): OperationHealthView {
  const { observed, observedComplete, denials } = input;

  const refusals = new Map<string, number>();
  let counted = 0;
  if (denials !== null) {
    for (const b of denials.buckets) {
      // Every bucket's rows are rows the buckets account for, the null one included:
      // a denial whose operation was not recorded cannot be attributed to one, but it
      // is still a row the log holds, and leaving it out would make the buckets look
      // cut short when they are not.
      counted += b.count;
      if (b.operation === null) continue;
      refusals.set(b.operation, b.count);
    }
  }

  // The contract's own test for an uncapped bucket list: the counts sum to the total.
  // Cheaper and truer than comparing lengths against a cap the derive would otherwise
  // have to be told. Decided before the rows because it decides what an absence means.
  const refusalsComplete = denials !== null && counted >= denials.held;

  const rows = new Map<string, OperationHealthRow>();
  for (const o of observed) {
    rows.set(o.operation, {
      operation: o.operation,
      events: o.count,
      lastSeen: o.lastSeen,
      // The same rule as `events` below, read the other way: zero only when the list
      // was complete and this operation was not in it. A cut list is busiest first, so
      // an observed operation with no bucket may be one the cap dropped — unknown, and
      // printing zero would turn that gap into a measurement.
      refusals: denials === null ? null : (refusals.get(o.operation) ?? (refusalsComplete ? 0 : null)),
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
      // reserved for "the facet could not say", which is a different thing — and in
      // that case "nothing emitted" is not a claim this row can make either.
      events: observedComplete ? 0 : null,
      lastSeen: null,
      refusals: count,
      refusedOnly: observedComplete,
    });
  }

  return {
    rows: [...rows.values()].sort(
      (a, b) =>
        (b.refusals ?? 0) - (a.refusals ?? 0) ||
        (b.events ?? 0) - (a.events ?? 0) ||
        a.operation.localeCompare(b.operation),
    ),
    observedComplete,
    refusals:
      denials === null
        ? null
        : {
            complete: refusalsComplete,
            held: denials.held,
            counted,
            since: denials.windowOldestAt,
          },
  };
}
