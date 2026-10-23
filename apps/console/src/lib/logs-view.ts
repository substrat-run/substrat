import type { RecentLogEvent, RecentLogsRead } from './api';

/**
 * What the Observability view's recent-logs card holds, and what it says about it (#2520).
 *
 * Pure, so the decisions the view makes — when the notice shows, which empty-state sentence a
 * page gets — are tested rather than read: the console has no DOM tooling, and `renderToString`
 * does not run the effects that fill the card.
 */
export interface LogsView {
  state: 'idle' | 'loading' | 'ready' | 'error';
  events: RecentLogEvent[];
  /** The plane said the page may be incomplete or missing newer lines. Only meaningful when `ready`. */
  incomplete: boolean;
  error: string;
}

export const LOGS_IDLE: LogsView = { state: 'idle', events: [], incomplete: false, error: '' };

/** A read began. The lines on screen stay until it answers, as they always have. */
export const logsLoading = (prev: LogsView): LogsView => ({ ...prev, state: 'loading', incomplete: false });

/** A read answered: its lines, and whether the plane said they may be incomplete. */
export const logsLoaded = (read: RecentLogsRead): LogsView => ({
  state: 'ready',
  events: read.events,
  incomplete: read.incomplete,
  error: '',
});

/** A read failed. */
export const logsFailed = (prev: LogsView, error: string): LogsView => ({ ...prev, state: 'error', incomplete: false, error });

export const LOGS_INCOMPLETE_NOTICE = 'This page may be incomplete or missing newer lines.';
export const LOGS_EMPTY_COMPLETE = 'No log events in this window.';
/** An empty page that may be incomplete does not claim the window held nothing. */
export const LOGS_EMPTY_INCOMPLETE = 'No log events were found in the part of the window that could be read.';

export interface LogsPanel {
  /** Show the incomplete-page notice above the table. */
  notice: boolean;
  /** The sentence of the empty row, or `null` when the page has no empty row. */
  emptyRow: string | null;
}

/** What the card shows for a view: the notice only on an answered, incomplete page; an empty row only on an answered, empty one. */
export function logsPanelOf(view: LogsView): LogsPanel {
  const ready = view.state === 'ready';
  return {
    notice: ready && view.incomplete,
    emptyRow: ready && view.events.length === 0 ? (view.incomplete ? LOGS_EMPTY_INCOMPLETE : LOGS_EMPTY_COMPLETE) : null,
  };
}
