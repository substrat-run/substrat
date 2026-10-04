/**
 * The one sanctioned reading of `outputFields` (#1923 part c): per-(operation, field) counts for
 * ONE tenant, from the stamped invocation lines its app's scripts wrote.
 *
 * ## Why the reading needs rules at all
 *
 * The report on a line is written by the vertical's own code, like `operation` and
 * `problemCode` on the router's header. A vertical can mislabel its own responses, and it can
 * `console.log` a line that looks exactly like the platform's, naming any tenant id it likes.
 * So nothing on a line is taken as given except what the reader resolved itself:
 *
 * - **The tenant is the caller's, never the line's.** `tenantId` is required, there is no
 *   "every tenant" spelling, and a line naming a different tenant is dropped without trace —
 *   not even counted as refused, since a count of someone else's lines is a fact about them.
 * - **The script is the app's, never the line's.** A line counts only if one of the app's
 *   own script families wrote it (`$metadata.service`, stamped by the log platform, which a
 *   vertical cannot set). That is what stops one vertical inflating another app's counts for
 *   a tenant both serve: its forged lines come from its own script.
 * - **Names are bounded, and declared when the caller can say so.** A report is refused whole
 *   when it is not three string arrays, names a field twice, names more than the declared
 *   half's cap, or names a field longer than an operation name may be. Given the operation's
 *   declared output (`declared`), a report naming anything outside it is refused too, so a
 *   vertical cannot grow the tally with names its own declaration never had.
 *
 * ## Why aggregate only
 *
 * One report is a fact about one response, and the line it rides also carries a path that
 * can name a record (`/customers/{id}`): "this customer's `phone` is null". The question field
 * coverage asks is "is this field ever returned", and a count answers it without holding a
 * fact about any one record. So the tally keeps counts per (operation, field) and the number
 * of responses behind them, and nothing per request: no path, scope, time, invocation id or
 * value. It does not pass any of those through, so a view built on it cannot either.
 *
 * Every count is per response serialisation, never per row: a paged read of 200 rows is one
 * response (#1331).
 */
import { DECLARED_OUTPUT_FIELDS_MAX, INVOCATION_RECORD_FIELD_MAX } from '@substrat-run/contracts';
import type { OutputFieldsReport } from '@substrat-run/kernel';
import { ownsInvocation } from './cf-observability.js';
import { serviceFamilyMatcher } from './service-family.js';

/** How often one declared field was carried, across the responses counted. */
export interface FieldCoverageCount {
  field: string;
  /** Carried with a value. */
  present: number;
  /** Carried as `null`. */
  empty: number;
  /** Not carried. */
  absent: number;
}

/** One operation's counts. `responses` is how many reports were counted for it. */
export interface OperationFieldCoverage {
  operation: string;
  responses: number;
  /** In first-seen order, which for a well-behaved vertical is declaration order. */
  fields: FieldCoverageCount[];
}

export interface FieldCoverageTally {
  /** The tenant the caller asked about — echoed, so a view never has to take it from a line. */
  tenantId: string;
  /** By operation name. */
  operations: OperationFieldCoverage[];
  /**
   * This tenant's lines, from this app's scripts, whose report was refused (malformed, over a
   * cap, or naming an undeclared field). Lines of other tenants or other scripts are not in
   * it. A view shows it so a refused report reads as refused, not as "never returned".
   */
  refused: number;
}

/** What the tally is for. Every field is the CALLER's resolution, never a line's. */
export interface FieldCoverageScope {
  /** The tenant, forced from the principal the way every tenant read forces it. */
  tenantId: string;
  /** The app's script family stems. Empty names no script, so nothing counts. */
  services: readonly string[];
  /**
   * The declared output field names per operation, when the caller has the manifest. A report
   * on an operation not in this map, or naming a field outside its list, is refused.
   */
  declared?: Readonly<Record<string, readonly string[]>>;
}

/**
 * How many distinct operations one tally keeps. Past it, a report on a new operation is
 * refused: a vertical cannot grow the answer without bound by inventing names.
 */
export const FIELD_COVERAGE_OPERATIONS_MAX = 1000;

/** The report's buckets — the writer's own shape, so a renamed bucket is a compile error here. */
const BUCKETS = ['present', 'empty', 'absent'] as const satisfies ReadonlyArray<keyof OutputFieldsReport>;

/** A report's three name lists, or `undefined` when it is not a well-formed one. */
function namesOf(report: unknown, allowed: ReadonlySet<string> | undefined): OutputFieldsReport | undefined {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined;
  const seen = new Set<string>();
  const out: OutputFieldsReport = { present: [], empty: [], absent: [] };
  for (const bucket of BUCKETS) {
    const list = (report as Record<string, unknown>)[bucket];
    if (!Array.isArray(list)) return undefined;
    for (const name of list) {
      if (typeof name !== 'string' || name.length === 0 || name.length > INVOCATION_RECORD_FIELD_MAX) return undefined;
      if (seen.has(name)) return undefined;
      if (allowed && !allowed.has(name)) return undefined;
      seen.add(name);
      out[bucket].push(name);
    }
  }
  if (seen.size === 0 || seen.size > DECLARED_OUTPUT_FIELDS_MAX) return undefined;
  return out;
}

/**
 * Tally the field coverage in `events` — raw Workers Logs events (`{ source, $metadata }`), as
 * the telemetry query returns them — for one tenant and one app.
 *
 * The query that fetched them should already filter on both; this checks them again, because
 * the tally is the thing a view trusts, and a query is one forgotten parameter from fleet-wide.
 */
export function tallyFieldCoverage(events: Iterable<unknown>, scope: FieldCoverageScope): FieldCoverageTally {
  if (typeof scope.tenantId !== 'string' || scope.tenantId.length === 0) {
    throw new TypeError('a field-coverage tally is for one tenant, and names it');
  }
  const operations = new Map<string, { responses: number; fields: Map<string, FieldCoverageCount> }>();
  const ownService = serviceFamilyMatcher(scope.services);
  // Each operation's declared names as a set, built the first time a report needs it.
  const declaredSets = new Map<string, ReadonlySet<string>>();
  let refused = 0;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    // The same isolation predicate the tenant log reads use: a stamped line naming this tenant.
    if (!ownsInvocation(event as Record<string, unknown>, { tenantId: scope.tenantId })) continue;
    const line = (event as { source: Record<string, unknown> }).source;
    const metadata = (event as Record<string, unknown>)['$metadata'];
    const service = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)['service'] : undefined;
    if (!ownService(service)) continue;
    // A line with no report was not walked (unarmed, failed, or nothing declared): no data.
    if (!('outputFields' in line)) continue;

    // From here the line is this tenant's, from this app: a bad report is the app's own fault,
    // and is counted as refused rather than ignored.
    const operation = line['operation'];
    // An async line (`kind`) has no response to report on, whatever it says.
    if (line['kind'] !== undefined || typeof operation !== 'string' || operation.length === 0 || operation.length > INVOCATION_RECORD_FIELD_MAX) {
      refused++;
      continue;
    }
    let allowed: ReadonlySet<string> | undefined;
    if (scope.declared) {
      if (!Object.hasOwn(scope.declared, operation)) {
        refused++;
        continue;
      }
      allowed = declaredSets.get(operation);
      if (!allowed) declaredSets.set(operation, (allowed = new Set(scope.declared[operation])));
    }
    const names = namesOf(line['outputFields'], allowed);
    if (!names) {
      refused++;
      continue;
    }
    let entry = operations.get(operation);
    if (!entry) {
      if (operations.size >= FIELD_COVERAGE_OPERATIONS_MAX) {
        refused++;
        continue;
      }
      entry = { responses: 0, fields: new Map() };
    }
    // The field cap holds per operation across reports too, so a vertical naming a different
    // field each time cannot grow one operation past what one declaration could hold.
    let fresh = 0;
    for (const bucket of BUCKETS) for (const field of names[bucket]) if (!entry.fields.has(field)) fresh++;
    if (entry.fields.size + fresh > DECLARED_OUTPUT_FIELDS_MAX) {
      refused++;
      continue;
    }
    operations.set(operation, entry);
    entry.responses++;
    for (const bucket of BUCKETS) {
      for (const field of names[bucket]) {
        let count = entry.fields.get(field);
        if (!count) {
          count = { field, present: 0, empty: 0, absent: 0 };
          entry.fields.set(field, count);
        }
        count[bucket]++;
      }
    }
  }

  return {
    tenantId: scope.tenantId,
    operations: [...operations]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([operation, e]) => ({ operation, responses: e.responses, fields: [...e.fields.values()] })),
    refused,
  };
}
