import type { EventFacetResult } from './api';
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
 * grouping, which the read takes as its own parameter. Any top-level field can be named
 * today; restricting it to fields not classed as personal data is #1762.
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

export function bucketRows(result: EventFacetResult, group: EventGroup): BucketRow[] {
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
