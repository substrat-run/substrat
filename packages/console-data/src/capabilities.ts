import { traceHead, type TraceHead } from '@substrat-run/contracts';

/**
 * What a console data source can honestly answer (#2360).
 *
 * The console's views read the same contract from every source: the working tree under
 * `substrat dev`, the hosted request record, and (later) an external tool. They differ in
 * what they can know, so each source DECLARES it, and a view reads the declaration before it
 * draws. A view that wants something a source lacks degrades and says so. It never renders
 * an empty panel that reads as "nothing happened".
 *
 * Every flag is a promise the contract suite checks (`contract.ts`). A source that declares
 * one it cannot keep fails a named check.
 */
export const CAPABILITIES = ['tail', 'rawPayloads', 'exactFacetCounts', 'traceSteps', 'model', 'permissions'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The head fields a request read may fill: every key of the contracts' `TraceHead`, the
 * hosted invocation line's names (#1746). A source lists the ones it fills; the rest are
 * always `null` (or `[]` for a list) from it, and a view names them as missing instead of
 * showing a blank column.
 */
export const REQUEST_FIELDS: readonly (keyof TraceHead)[] = traceHead.keyof().options;
export type RequestField = keyof TraceHead;

/**
 * The fields every source fills: the head's non-nullable scalars, which have no "not
 * recorded" value to fall back on. A request is found by its id, every read is a window over
 * its start, and the level and outcome are what the request list is for. A local trace may
 * carry `tenantId: ''`, since no router names a tenant under `substrat dev`.
 */
export const REQUIRED_REQUEST_FIELDS = [
  'invocationId',
  'startedAt',
  'tenantId',
  'threw',
  'durationMs',
  'level',
] as const satisfies readonly RequestField[];

/**
 * A head with every field `fields` does not name set to "not recorded": `null`, or `[]` for
 * a list. What a source that fills only `fields` must return.
 */
export function blankUnfilled(head: TraceHead, fields: readonly RequestField[]): TraceHead {
  const out: Record<string, unknown> = { ...head };
  for (const key of unfilledFields(fields)) out[key] = Array.isArray(head[key]) ? [] : null;
  return out as unknown as TraceHead;
}

/** The head fields a source that fills `fields` leaves "not recorded": the rest, less the required ones. */
export function unfilledFields(fields: readonly RequestField[]): RequestField[] {
  const keep = new Set<RequestField>([...fields, ...REQUIRED_REQUEST_FIELDS]);
  return REQUEST_FIELDS.filter((f) => !keep.has(f));
}

export interface SourceCapabilities {
  /**
   * New requests can be pushed to a listener as they finish (`source.tail`). Local only: the
   * contract is query-first, so a view that tails must still work from a query alone.
   */
  readonly tail: boolean;
  /**
   * A trace may carry the values a statement was bound to (`params` on a `sql` step, and
   * `capture.sqlParams`). Off, no read returns one, whatever the recorder kept.
   */
  readonly rawPayloads: boolean;
  /**
   * Facet counts are exact counts of the requests a query matches. Off, they may be
   * estimated from a sample, and the answer says `estimated: true` when they are.
   */
  readonly exactFacetCounts: boolean;
  /**
   * `getTrace` returns the steps inside a call (checks, SQL, events…). Off, every trace is
   * the head alone, with `steps: []`, which a view reads as "not recorded".
   */
  readonly traceSteps: boolean;
  /** `artifacts()` returns the vertical's `model.json`, its entities and declared lifecycles. */
  readonly model: boolean;
  /** `artifacts()` returns the vertical's roles and permission keys. */
  readonly permissions: boolean;
  /** The head fields this source fills; see {@link REQUEST_FIELDS}. */
  readonly requestFields: readonly RequestField[];
}

/** What a console view needs from a source, and what it can draw without. */
export interface ViewNeeds {
  /** Without these the view cannot draw anything true, so it says why instead. */
  readonly requires?: readonly Capability[];
  /** Without these the view still draws, and marks what it lost. */
  readonly prefers?: readonly Capability[];
  /** The head fields the view shows; any the source does not fill are named as missing. */
  readonly fields?: readonly RequestField[];
}

/** One view's terms with one source. */
export interface Negotiated {
  /** Every required capability is present. */
  readonly available: boolean;
  /** Available, but a preferred capability or a shown field is missing. */
  readonly degraded: boolean;
  /** Required capabilities the source lacks. */
  readonly missing: readonly Capability[];
  /** Preferred capabilities the source lacks. */
  readonly lost: readonly Capability[];
  /** Fields the view shows that the source never fills. */
  readonly missingFields: readonly RequestField[];
}

/**
 * Settle what a view can show from a source. Pure: the same declaration always gives the
 * same terms, so a view can call it on every render.
 */
export function negotiate(capabilities: SourceCapabilities, needs: ViewNeeds): Negotiated {
  const lacks = (c: Capability) => !capabilities[c];
  const missing = (needs.requires ?? []).filter(lacks);
  const lost = (needs.prefers ?? []).filter(lacks);
  const filled = new Set<RequestField>(capabilities.requestFields);
  const missingFields = (needs.fields ?? []).filter((f) => !filled.has(f));
  const available = missing.length === 0;
  return { available, degraded: available && (lost.length > 0 || missingFields.length > 0), missing, lost, missingFields };
}

/**
 * The console's views and what each needs. A source is not told which views exist; a view
 * looks itself up here and calls {@link negotiate}.
 */
export const VIEW_NEEDS = {
  /** The request list with its facet panel and histogram. */
  requests: {
    prefers: ['exactFacetCounts'],
    fields: ['startedAt', 'method', 'path', 'status', 'durationMs', 'level', 'operation', 'principalKind', 'problemCode'],
  },
  /** One request's waterfall: the head, then the steps. */
  waterfall: { requires: ['traceSteps'], prefers: ['rawPayloads'], fields: ['operation', 'principal', 'status', 'durationMs'] },
  /** Requests appearing as they finish. */
  liveTail: { requires: ['tail'] },
  /** The declared lifecycles drawn as a map. */
  processMap: { requires: ['model'] },
  /** Who may do what. */
  permissions: { requires: ['permissions'] },
} as const satisfies Record<string, ViewNeeds>;
export type ConsoleView = keyof typeof VIEW_NEEDS;

/**
 * What a view says when a capability is missing: the reader's next question is "why is this
 * empty", and the answer is the source, not the app.
 */
export const MISSING_CAPABILITY_TEXT: Record<Capability, string> = {
  tail: 'This source cannot stream new requests. Refresh to see the latest.',
  rawPayloads: 'This source does not keep the values bound to SQL statements.',
  exactFacetCounts: 'Counts may be estimated from a sample.',
  traceSteps: 'This source records the request, not the steps inside it.',
  model: 'This source has no model for the vertical.',
  permissions: 'This source has no permission surface for the vertical.',
};
