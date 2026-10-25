/**
 * What an app's Logs panel says about a read it has answered (#2521) — pure, so the decisions
 * (when the notice shows, which empty-state sentence a page gets) are tested rather than read.
 *
 * `incomplete` is the plane's own `x-substrat-logs-incomplete` header: the page may be missing
 * lines behind a cut, so a short page is not "the window held no more".
 */
export const LOGS_INCOMPLETE_NOTICE = 'This page may be incomplete or missing newer lines.';

/** An empty page that may be incomplete does not claim the window held nothing. */
export const LOGS_EMPTY_INCOMPLETE = 'No log events were found in the part of the window that could be read.';

export interface AppLogsPanel {
  /** Show the incomplete-page notice above the list. */
  notice: boolean;
  /** An empty page that may be incomplete: say that instead of what an empty, complete one says. */
  emptyIncomplete: boolean;
}

export function appLogsPanelOf(read: { events: readonly unknown[]; incomplete: boolean } | null): AppLogsPanel {
  return {
    notice: read !== null && read.incomplete,
    emptyIncomplete: read !== null && read.incomplete && read.events.length === 0,
  };
}
