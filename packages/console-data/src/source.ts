import type { IngressModel, RequestTrace, TraceHead } from '@substrat-run/contracts';
import type { PermissionsView } from '@substrat-run/model-view';
import type { SourceCapabilities } from './capabilities.js';

/**
 * The contract every console data source implements (#2360).
 *
 * **Query-first, never tail-first.** Every read is a bounded question over a window: which
 * requests, how many of each kind, what one of them did. A hosted record can answer those
 * and cannot stream, so a view built on a stream would work locally and lie in production.
 * Tailing is an optional extra a source declares (`capabilities.tail`), and a view that uses
 * it must still draw from a query alone.
 *
 * The shapes are the contracts' own: a request is a `TraceHead`, the head of the hosted
 * invocation line (#1746) under the same field names, and a trace is a `RequestTrace`
 * (#2358). Nothing here redefines either, so a local view and a hosted one read the same
 * record.
 */
export interface ConsoleDataSource {
  describe(): SourceDescription;
  /** The vertical's declared artifacts. `null` parts are not held by this source. */
  artifacts(): Promise<SourceArtifacts>;
  /**
   * One page of the requests a query matches, in one total order: `startedAt` descending, then
   * `invocationId` descending for requests that started at the same instant. The tie-break is
   * part of the contract (the suite's world has a tie), because without it two pages can
   * overlap or skip. A source whose backend sorts by time alone, as the hosted log reader does,
   * adds it. A source holds one record per `invocationId`, the last one it was given.
   */
  queryRequests(query: RequestQuery): Promise<RequestPage>;
  /** Facet counts over the requests a query matches. */
  facets(query: RequestQuery): Promise<RequestFacets>;
  /** One request's trace, or `null` when this source holds no request with that id. */
  getTrace(invocationId: string): Promise<RequestTrace | null>;
  /**
   * Present exactly when `capabilities.tail` is declared. Calls `listener` with each request
   * that finishes inside the query's filters after the call (the window is ignored: a tail is
   * open-ended), until the returned function is called. A re-recorded request is delivered
   * again under the same `invocationId`: a listener that keeps a list replaces by id rather
   * than appending, the same last-record-wins rule the reads follow.
   */
  tail?(query: Omit<RequestQuery, 'from' | 'to' | 'cursor' | 'limit'>, listener: (request: TraceHead) => void): () => void;
}

export const SOURCE_KINDS = ['local', 'hosted', 'external'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceDescription {
  /** Stable for the life of the source; a view keys its cache by it. */
  readonly id: string;
  readonly kind: SourceKind;
  /** What the console shows as the source's name: a project path, a team and app, a tool. */
  readonly label: string;
  readonly capabilities: SourceCapabilities;
}

export interface SourceArtifacts {
  /** The emitted `model.json`, parsed: entities and declared lifecycles. */
  readonly model: IngressModel | null;
  /** Roles, entity grant shapes and key descriptions. */
  readonly permissions: PermissionsView | null;
}

/**
 * The head fields a request may be filtered and counted by. The same keys, in the same
 * order, as the hosted reader's request facets (`REQUEST_FACET_KEYS` in control-plane-api),
 * less `kind`, which the trace head does not carry, and `entity` (#2762), which no local view
 * asks for yet.
 */
export const FACET_KEYS = ['level', 'operation', 'principalKind', 'problemCode', 'surface', 'status'] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/**
 * For each key, the values a request may have: values under one key are alternatives (OR),
 * keys combine (AND), and an absent or empty key does not filter. Values are strings, so
 * `status` is matched as its decimal text.
 */
export type RequestWhere = Partial<Record<FacetKey, readonly string[]>>;

export interface RequestQuery {
  /** Epoch milliseconds, inclusive, on the request's `startedAt`. */
  readonly from: number;
  /** Epoch milliseconds, exclusive. */
  readonly to: number;
  readonly where?: RequestWhere;
  /** Most requests on one page; a source caps it at {@link MAX_PAGE}. */
  readonly limit?: number;
  /** A previous page's `nextCursor`, opaque. */
  readonly cursor?: string;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export interface RequestPage {
  /** In the order `queryRequests` defines: `(startedAt desc, invocationId desc)`. */
  readonly requests: readonly TraceHead[];
  /** Pass back as `cursor` for the next, older page; `null` when this is the last. */
  readonly nextCursor: string | null;
}

/** One facet value and how many matching requests carry it. */
export interface FacetValue {
  readonly value: string;
  readonly count: number;
}

/**
 * Counts per facet. Each key is counted with every OTHER filter applied and its own left
 * out, so a panel shows what choosing another value would give: the hosted reading.
 * A request with no value for a key (`null`) is not counted under it.
 */
export interface RequestFacets {
  /** Requests matching every filter. */
  readonly total: number;
  /** At most {@link FACET_TOP} values per key, most frequent first, ties by value. */
  readonly facets: Record<FacetKey, readonly FacetValue[]>;
  /** The counts were estimated from a sample. Never true from a source declaring `exactFacetCounts`. */
  readonly estimated: boolean;
}

/** How many values one facet lists, as the hosted reader does. */
export const FACET_TOP = 10;

/** A query the contract refuses: a window that is not one, or a cursor this source did not write. */
export class ConsoleQueryError extends Error {}
