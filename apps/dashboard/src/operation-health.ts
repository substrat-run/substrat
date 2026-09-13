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
 * The log has no per-operation aggregate today (its summary buckets by actor and
 * permission, K-35's question), so the counts come from a page of raw rows, newest
 * first and capped. That page is honest only beside two facts the summary DOES carry:
 * how many rows the log holds, so a capped page knows it is capped, and the log's own
 * floor, which is not the same as the page's oldest row. Both are read and both are
 * reported; the aggregate is a follow-up, not something to fake from a page.
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
   * Permission refusals recorded for it in the page read, or null when the log could
   * not be read at all. A count is exact when `refusals.complete` on the view is true,
   * and a floor otherwise — the page held the newest rows, and this operation's older
   * refusals may lie beyond it.
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
   * True when the page read held every row the log holds, so per-operation counts are
   * exact and an operation with no row genuinely has no refusal in the window. False
   * when the log holds more than one page: counts are floors, and an operation whose
   * refusals all predate the page is missing entirely — one noisy operation can crowd
   * out every other.
   */
  complete: boolean;
  /** Rows the log holds in total, so a reader can see how much a capped page covers. */
  held: number;
  /** Rows the page actually carried. */
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

export interface RecordedDenial {
  operation: string | null;
  at: string;
}

/** The denial log as read: a capped page of rows plus the summary's facts about the whole. */
export interface DenialRead {
  /** A bounded, newest-first page of the scope's denial log. */
  rows: readonly RecordedDenial[];
  /** How many rows the log holds, from the summary — filter-free, so page-independent. */
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
  if (denials !== null) {
    for (const d of denials.rows) {
      // A denial whose operation was not recorded cannot be attributed to one. It is
      // still a row the log holds, which the summary's `held` already counts.
      if (d.operation === null) continue;
      refusals.set(d.operation, (refusals.get(d.operation) ?? 0) + 1);
    }
  }

  const rows = new Map<string, OperationHealthRow>();
  for (const o of observed) {
    rows.set(o.operation, {
      operation: o.operation,
      events: o.count,
      lastSeen: o.lastSeen,
      refusals: denials === null ? null : (refusals.get(o.operation) ?? 0),
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
            complete: denials.rows.length >= denials.held,
            held: denials.held,
            counted: denials.rows.length,
            since: denials.windowOldestAt,
          },
  };
}
