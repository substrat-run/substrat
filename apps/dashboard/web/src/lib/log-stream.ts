import type { EventFacetAnswer } from './api';
import type { ObsQuery } from './observability-query';

/**
 * The Logs stream card's modes (#1767) and the Events mode's derivations, kept pure so
 * the card and its tests read the same rules.
 *
 * A mode is still a sub-view in the URL — `?view=logs` is Lines, `?view=events` is
 * Events — so every link written before the card existed lands on the mode it meant.
 * Requests and Patterns are in the design but not here: nothing reads a per-request
 * row or a line template yet (#1746, #1747), and a tab over no data is a dead end.
 */
export type LogMode = 'logs' | 'events';

export const LOG_MODES: { value: LogMode; label: string }[] = [
  { value: 'logs', label: 'Lines' },
  { value: 'events', label: 'Events' },
];

/** The one line at the right of the tab strip: what this mode shows and what a click does. */
export function modeHint(mode: LogMode): string {
  return mode === 'events'
    ? 'Events the app emitted, grouped · click an event type to narrow to it'
    : 'Click a row for structured fields · any underlined value filters';
}

/**
 * What the Events mode groups by. `field` is not a spine dimension but the payload
 * grouping, which the read takes as its own parameter. Any top-level field can be named;
 * the read groups only events not classed as personal data and counts the rest in
 * `withheldPersonal` (#1762), so naming `email` cannot list people.
 */
export type EventGroup = 'type' | 'operation' | 'actor' | 'version' | 'entityType' | 'piiClass' | 'field';

export const EVENT_GROUPS: { value: EventGroup; label: string }[] = [
  { value: 'type', label: 'Event type' },
  { value: 'operation', label: 'Operation' },
  { value: 'actor', label: 'Actor' },
  { value: 'version', label: 'Version' },
  { value: 'entityType', label: 'Entity type' },
  { value: 'piiClass', label: 'PII class' },
  { value: 'field', label: 'Payload field' },
];

/** The column header over the bucket labels. */
export function dimensionLabel(group: EventGroup, field: string): string {
  if (group === 'field') return field ? `payload.${field}` : 'Payload field';
  // A grouping the buttons do not offer can still arrive by URL (the read also groups
  // by `invocation`); its header is then the key itself rather than nothing.
  return EVENT_GROUPS.find((g) => g.value === group)?.label ?? group;
}

export interface BucketRow {
  key: string;
  label: string;
  /** The extraction-null bucket: no value, which is weaker than absent and is not erased. */
  isNull: boolean;
  count: number;
  /** Bar width against the largest bucket, as a CSS percentage. */
  width: string;
  lastSeen: string | null;
  /** Where a click goes, or null when no read can narrow to this bucket. */
  narrow: Partial<ObsQuery> | null;
}

/**
 * Where a click on a bucket leads. Only an event type can be narrowed to: it is the one
 * filter the facet read takes, and log lines carry no event type, operation or actor to
 * filter by. Narrowing to a type while still grouped by type would draw one bar, so the
 * narrowed view regroups by operation — "what emitted this" is the next question.
 */
export function bucketNarrow(group: EventGroup, value: string | null): Partial<ObsQuery> | null {
  if (group !== 'type' || value === null) return null;
  return { type: value, groupBy: 'operation', field: undefined };
}

export function bucketRows(result: EventFacetAnswer, group: EventGroup): BucketRow[] {
  const widest = Math.max(1, ...result.buckets.map((b) => b.count));
  return result.buckets.map((b) => ({
    key: b.value ?? '\u0000null',
    label: b.value ?? 'no value',
    isNull: b.value === null,
    count: b.count,
    width: `${((b.count / widest) * 100).toFixed(1)}%`,
    lastSeen: b.lastSeen,
    narrow: bucketNarrow(group, b.value),
  }));
}

/**
 * The withheld count (#1762), or null when the answer does not carry it — an app still
 * running a kernel from before the rule, which groups personal-data events instead of
 * withholding them. Null is "unknown" and must never be drawn as 0.
 */
export function withheldOf(result: EventFacetAnswer): number | null {
  return typeof result.withheldPersonal === 'number' ? result.withheldPersonal : null;
}

/**
 * True when the control plane refused to relay a payload grouping because the app's
 * kernel predates #1762 — its buckets could be one per person. The withheld count then
 * covers every event that was not erased, not only those classed as personal data.
 */
export function predatesRule(result: EventFacetAnswer): boolean {
  return result.withheldReason === 'vertical-predates-rule';
}

/**
 * What the Events mode says when a grouping produced no bucket. Empty buckets over a
 * non-empty match is a different answer from no match at all, and each way of getting
 * there is named: every event erased, or every event withheld as personal data.
 */
export function emptyGroupingText(result: EventFacetAnswer): string {
  if (result.total === 0) return 'No events matched this filter.';
  if (predatesRule(result)) {
    return 'This app was pushed before personal-data events were withheld, so payload groupings are unavailable until it is pushed again.';
  }
  if (result.erased === result.total) return 'Every matching event had its payload erased, so there is nothing left to group by.';
  const withheld = withheldOf(result) ?? 0;
  if (withheld > 0 && result.erased + withheld === result.total) {
    return 'Every matching event is classed as personal data, so none is grouped by a payload field.';
  }
  return 'The matching events produced no groupable value.';
}
