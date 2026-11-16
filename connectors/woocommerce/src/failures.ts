import { errorCodeOf, type ErrorCode } from '@substrat-run/contracts';
import { WooCommerceApiError } from './api.js';
import { WooCommerceMappingError } from './commerce.js';

/**
 * One record a pass could not land (#3241): where it is, why, and since when.
 *
 * The walk is a keyset walk in change order, so a record that cannot land used to hold its
 * resource's cursor for good: every pass read up to it, failed on it, and stopped, and nothing after
 * it — every later product, and every order — ever arrived. A failure is now judged per record:
 *
 * - **Unreadable** — the connector's own mapping refuses the row (a price that is not a decimal, a
 *   date that is not a date, a row that does not have WooCommerce's shape). Trying again reads the
 *   same row and fails the same way, so the walk moves past it at once and lists it as `skipped`.
 * - **Failing** — anything else that happened to this record alone: its variations read failed, or
 *   the vertical's landing operation threw. That may pass, so the walk STALLS there (the resource's
 *   walk waits at it; the other resource's walk and the reconcile still run) and tries it first on
 *   the next pass. After {@link WOOCOMMERCE_ROW_ATTEMPTS} passes in a row on the same record it is
 *   skipped too.
 * - **Not the record's** — the key was refused, the store is rate-limiting or is not a store, the
 *   connection may no longer land (a permission, a missing operation, an unavailable scope). Those
 *   say nothing about the record and would fail every one after it, so the pass ends there, as it
 *   always did, and nothing is skipped.
 *
 * A skipped record is tried again by id on every reconcile pass ({@link WOOCOMMERCE_SKIPPED_RETRIES}
 * at a time, longest-waiting first), and leaves the list the moment it lands — then, or because a
 * merchant saved it and the walk met it again.
 */
export interface WooCommerceRowFailure {
  resource: 'products' | 'orders';
  id: number;
  /** The record's change time when it failed — its place in the walk; `null` when it had no readable date. */
  modifiedAt: string | null;
  /** Why, in the connector's words: the mapping's refusal, the landing operation's error, the store's status. */
  error: string;
  firstFailedAt: string;
  failedAt: string;
  /** How many passes failed on it. */
  attempts: number;
}

/** How many passes in a row may fail on one record before the walk moves past it. */
export const WOOCOMMERCE_ROW_ATTEMPTS = 3;

/**
 * The most records one resource keeps skipped. Past it the walk stalls at the next failure instead:
 * a hundred records failing alike is the connection's problem, not theirs, and skipping more would
 * only hide it.
 */
export const WOOCOMMERCE_MAX_SKIPPED = 100;

/** Skipped records tried again per resource on one reconcile pass. */
export const WOOCOMMERCE_SKIPPED_RETRIES = 10;

const ERROR_LIMIT = 300;
const clip = (s: string, n = ERROR_LIMIT): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A landing refusal that says nothing about the record: every record after it would fail the same way. */
const NOT_THE_RECORDS: ReadonlySet<ErrorCode> = new Set([
  'unauthenticated',
  'permission_denied',
  'forbidden',
  'not_found',
  'rate_limited',
  'unavailable',
  'precondition_failed',
]);

export type RowVerdict = 'unreadable' | 'failing' | 'pass';

/**
 * The landing call's own failure, unwrapped from the connector's `WooCommerceLandingRefusal` (#3235),
 * which carries the tenant's line as `said` and the thrown error as `cause`. Matched by name, since
 * that class lives beside the sync.
 */
function landingOf(err: unknown): { cause: unknown; said: string | undefined } {
  if (err instanceof Error && err.name === 'WooCommerceLandingRefusal') {
    const said = (err as { said?: unknown }).said;
    return { cause: (err as { cause?: unknown }).cause, said: typeof said === 'string' ? said : undefined };
  }
  return { cause: err, said: undefined };
}

/**
 * A status the hosted hop answered a landing call with that says nothing about the record: the
 * platform's own authentication or authorization of the call, an operation or scope it cannot find,
 * a rate limit, a timeout, or the platform failing.
 */
const notTheRecordsStatus = (status: number): boolean =>
  status === 401 || status === 403 || status === 404 || status === 407 || status === 408 || status === 429 || status >= 500;

/** How a failure on one record is judged (see {@link WooCommerceRowFailure}). */
export function verdictOf(err: unknown): RowVerdict {
  if (err instanceof WooCommerceMappingError) return 'unreadable';
  // A Zod refusal of the store's row: matched by name, since the contracts' Zod and ours may be two copies.
  if (err instanceof Error && err.name === 'ZodError') return 'unreadable';
  if (err instanceof WooCommerceApiError) return err.refused || err.notStore || err.status === 429 ? 'pass' : 'failing';
  const { cause } = landingOf(err);
  // Over the hosted hop the landing call fails as the control-plane client's error: a status and the
  // raw body, read structurally as `landingRefusalSaid` reads it. In process, a coded error.
  const hop = cause as { status?: unknown; body?: unknown } | null;
  if (hop !== null && typeof hop === 'object' && typeof hop.status === 'number' && 'body' in hop) {
    return notTheRecordsStatus(hop.status) ? 'pass' : 'failing';
  }
  const code = errorCodeOf(cause);
  return code !== undefined && NOT_THE_RECORDS.has(code) ? 'pass' : 'failing';
}

/**
 * The failure as a line the binding's tenant may read — it is shown on the connection's activity and
 * in a scope's binding health. Never the request, the key, or a page body the store answered; of a
 * landing failure only what `landingRefusalSaid` lets the tenant read (#3235), the rest staff's.
 */
export function failureMessage(err: unknown, operation: string): string {
  if (err instanceof WooCommerceMappingError) return clip(err.message);
  if (err instanceof Error && err.name === 'ZodError') {
    const issue = (err as { issues?: { path?: (string | number)[]; message?: string }[] }).issues?.[0];
    const at = issue?.path && issue.path.length > 0 ? issue.path.join('.') : 'the row';
    return clip(`the store's row does not read as WooCommerce's: ${at}: ${issue?.message ?? 'malformed'}`);
  }
  if (err instanceof WooCommerceApiError) return clip(`reading it, the store answered ${err.status}${err.code ? ` (${err.code})` : ''}`);
  const { said } = landingOf(err);
  return clip(said ?? `the app's '${operation}' did not take it; the reason is on the platform's failure record`);
}

/** The failure in full, for staff's row: the thrown error's own text. */
const staffText = (err: unknown): string => clip(err instanceof Error ? err.message : String(err), 1000);

/** Why a walk stopped at one record and waits there (#3241): the pass ends failed, and the next starts here. */
export class WooCommerceRowStall extends Error {
  readonly failure: WooCommerceRowFailure;
  constructor(failure: WooCommerceRowFailure, why: string, cause: unknown) {
    // The message is staff's (the sweep row's `error`); `said()` is the tenant's.
    super(`${failure.resource === 'products' ? 'product' : 'order'} ${failure.id}: ${staffText(cause)} — ${why}`, { cause });
    this.name = 'WooCommerceRowStall';
    this.failure = failure;
  }

  /** What the connection's tenant may read about it: the connector's own words, one line. */
  said(): string {
    const record = `${this.failure.resource === 'products' ? 'product' : 'order'} ${this.failure.id}`;
    return clip(`${record} did not land, and its walk waits there: ${this.failure.error}`, 200);
  }
}

/**
 * The stalled and skipped records of one binding, carried from the pass before and changed by this
 * one. `changed` says whether the binding needs writing for them.
 */
export class RowFailures {
  private readonly stalled: Map<WooCommerceRowFailure['resource'], WooCommerceRowFailure>;
  private readonly skippedRows: WooCommerceRowFailure[];
  /** Records that failed in this pass, which a retry in the same pass would only read again. */
  private readonly failedNow = new Set<string>();
  changed = false;

  constructor(
    previous: { stalled?: readonly WooCommerceRowFailure[]; skipped?: readonly WooCommerceRowFailure[] } | undefined,
    private readonly now: () => string,
  ) {
    this.stalled = new Map((previous?.stalled ?? []).map((f) => [f.resource, f]));
    this.skippedRows = [...(previous?.skipped ?? [])];
  }

  /**
   * Record that `id` failed this pass. Answers whether the walk may move past it (`skip`) or must
   * wait at it (`stall`); a `pass` verdict is never handed here.
   */
  fail(resource: WooCommerceRowFailure['resource'], id: number, modifiedAt: string | null, err: unknown, verdict: Exclude<RowVerdict, 'pass'>, operation: string): 'skip' | WooCommerceRowStall {
    const at = this.now();
    this.failedNow.add(`${resource}:${id}`);
    const before = this.stalled.get(resource);
    const same = before !== undefined && before.id === id && before.modifiedAt === modifiedAt ? before : this.skippedRows.find((f) => f.resource === resource && f.id === id);
    const failure: WooCommerceRowFailure = {
      resource,
      id,
      modifiedAt,
      error: failureMessage(err, operation),
      firstFailedAt: same?.firstFailedAt ?? at,
      failedAt: at,
      attempts: (same?.attempts ?? 0) + 1,
    };
    this.changed = true;
    const listed = this.skippedRows.findIndex((f) => f.resource === resource && f.id === id);
    const room = listed >= 0 || this.skippedRows.filter((f) => f.resource === resource).length < WOOCOMMERCE_MAX_SKIPPED;
    if ((verdict === 'unreadable' || failure.attempts >= WOOCOMMERCE_ROW_ATTEMPTS) && room) {
      if (listed >= 0) this.skippedRows[listed] = failure;
      else this.skippedRows.push(failure);
      if (this.stalled.get(resource)?.id === id) this.stalled.delete(resource);
      return 'skip';
    }
    this.stalled.set(resource, failure);
    return new WooCommerceRowStall(
      failure,
      room
        ? `the walk waits at it (pass ${failure.attempts} of ${WOOCOMMERCE_ROW_ATTEMPTS} before it is skipped)`
        : `${WOOCOMMERCE_MAX_SKIPPED} ${resource} are skipped already, so the walk waits at it`,
      err,
    );
  }

  /** A skipped record failed its retry: it stays skipped, with this pass's reason. */
  retryFailed(skipped: WooCommerceRowFailure, modifiedAt: string | null, err: unknown, operation: string): void {
    const listed = this.skippedRows.findIndex((f) => f.resource === skipped.resource && f.id === skipped.id);
    if (listed < 0) return;
    this.skippedRows[listed] = { ...skipped, modifiedAt, error: failureMessage(err, operation), failedAt: this.now(), attempts: skipped.attempts + 1 };
    this.changed = true;
  }

  /** `id` landed: it is neither stalled nor skipped any more. */
  landed(resource: WooCommerceRowFailure['resource'], id: number): void {
    if (this.stalled.get(resource)?.id === id) {
      this.stalled.delete(resource);
      this.changed = true;
    }
    const listed = this.skippedRows.findIndex((f) => f.resource === resource && f.id === id);
    if (listed >= 0) {
      this.skippedRows.splice(listed, 1);
      this.changed = true;
    }
  }

  /** `id` is gone from the store: nothing is left to retry. */
  forget(resource: WooCommerceRowFailure['resource'], id: number): void {
    this.landed(resource, id);
  }

  /** The resource's walk finished without stalling: whatever it waited at before is behind it now. */
  walked(resource: WooCommerceRowFailure['resource']): void {
    if (this.stalled.delete(resource)) this.changed = true;
  }

  /** The skipped records of `resource` to try again this pass, the longest-waiting first; never one this pass failed on. */
  retryable(resource: WooCommerceRowFailure['resource']): WooCommerceRowFailure[] {
    return this.skippedRows
      .filter((f) => f.resource === resource && !this.failedNow.has(`${resource}:${f.id}`))
      .sort((a, b) => (a.failedAt < b.failedAt ? -1 : a.failedAt > b.failedAt ? 1 : a.id - b.id))
      .slice(0, WOOCOMMERCE_SKIPPED_RETRIES);
  }

  get stalledRows(): WooCommerceRowFailure[] {
    return [...this.stalled.values()];
  }

  get skipped(): WooCommerceRowFailure[] {
    return [...this.skippedRows];
  }
}
