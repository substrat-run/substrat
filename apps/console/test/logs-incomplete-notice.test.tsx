import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { LOGS_INCOMPLETE_HEADER } from '@substrat-run/control-plane-api';
import { createApi } from '../src/lib/api';
import type { RecentLogEvent } from '../src/lib/api';
import {
  LOGS_EMPTY_COMPLETE,
  LOGS_EMPTY_INCOMPLETE,
  LOGS_IDLE,
  LOGS_INCOMPLETE_NOTICE,
  logsFailed,
  logsLoaded,
  logsLoading,
  logsPanelOf,
  type LogsView,
} from '../src/lib/logs-view';
import { LogsIncompleteNotice } from '../src/views/Observability';

/**
 * #2520: `GET /observability/logs` says beside its list when the read stopped short of vouching
 * for the window. The console shows a notice exactly then, and an empty page that may be
 * incomplete does not claim the window held nothing.
 *
 * The view's decisions live in `lib/logs-view` as pure functions (the console has no DOM tooling,
 * and `renderToString` does not run the effects that fill the card), and the view holds nothing
 * of its own: every state it renders is one of `logsLoading`/`logsLoaded`/`logsFailed`, and
 * what it shows is `logsPanelOf` of it. So the table below is the whole rendering contract.
 */
describe('what the recent-logs card shows', () => {
  const line = { timestamp: 1, level: 'info', message: 'a line', service: 's', outcome: null, raw: null } as RecentLogEvent;
  const view = (state: LogsView['state'], events: RecentLogEvent[], incomplete: boolean): LogsView => ({ state, events, incomplete, error: '' });

  // state × incomplete × empty → [notice, empty row]
  const cases: Array<[LogsView['state'], boolean, boolean, boolean, string | null]> = [
    // Answered: the notice is exactly `incomplete`; the empty row is exactly "no events", worded by `incomplete`.
    ['ready', false, false, false, null],
    ['ready', false, true, false, LOGS_EMPTY_COMPLETE],
    ['ready', true, false, true, null],
    ['ready', true, true, true, LOGS_EMPTY_INCOMPLETE],
    // Anything but an answer shows neither, whatever the stale fields hold.
    ...(['idle', 'loading', 'error'] as const).flatMap((state) =>
      [false, true].flatMap((incomplete) =>
        [false, true].map((empty) => [state, incomplete, empty, false, null] as [LogsView['state'], boolean, boolean, boolean, string | null]),
      ),
    ),
  ];

  it.each(cases)('%s, incomplete=%s, empty=%s → notice=%s, empty row=%s', (state, incomplete, empty, notice, emptyRow) => {
    expect(logsPanelOf(view(state, empty ? [] : [line], incomplete))).toEqual({ notice, emptyRow });
  });

  it('an empty page that may be incomplete does not say the window held nothing', () => {
    expect(LOGS_EMPTY_INCOMPLETE).not.toBe(LOGS_EMPTY_COMPLETE);
    expect(LOGS_EMPTY_INCOMPLETE).not.toContain('in this window');
  });

  it('an answer carries the plane’s incomplete flag into the view, and only that', () => {
    expect(logsLoaded({ events: [line], incomplete: true })).toEqual({ state: 'ready', events: [line], incomplete: true, error: '' });
    expect(logsLoaded({ events: [line], incomplete: false })).toEqual({ state: 'ready', events: [line], incomplete: false, error: '' });
  });

  it('a new read clears the flag, and a failed one never keeps it', () => {
    const answered = logsLoaded({ events: [line], incomplete: true });
    expect(logsPanelOf(logsLoading(answered))).toEqual({ notice: false, emptyRow: null });
    expect(logsPanelOf(logsFailed(answered, 'boom'))).toEqual({ notice: false, emptyRow: null });
    expect(logsFailed(answered, 'boom').error).toBe('boom');
    // The lines on screen stay while the next read is in flight.
    expect(logsLoading(answered).events).toEqual([line]);
    expect(logsLoading(LOGS_IDLE).state).toBe('loading');
  });

  it('the notice says what the issue asks, neutrally', () => {
    expect(renderToString(createElement(LogsIncompleteNotice)).replace(/<!-- -->/g, '')).toContain(LOGS_INCOMPLETE_NOTICE);
    expect(LOGS_INCOMPLETE_NOTICE).toBe('This page may be incomplete or missing newer lines.');
  });
});

describe('the console client feeds the card exactly what the plane said', () => {
  const lines = [{ timestamp: 1, level: 'info', message: 'a line', service: 's', outcome: null, raw: null }];

  const panelFor = async (headers: Record<string, string>) => {
    const api = createApi('actor', 'http://cp.local');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(lines, { headers })) as typeof fetch;
    try {
      return logsPanelOf(logsLoaded(await api.recentLogsRead({ service: 's' })));
    } finally {
      globalThis.fetch = original;
    }
  };

  it('a page the plane marked incomplete shows the notice', async () => {
    expect((await panelFor({ [LOGS_INCOMPLETE_HEADER]: '1' })).notice).toBe(true);
  });

  it('twin: a complete page shows no notice at all', async () => {
    expect(await panelFor({})).toEqual({ notice: false, emptyRow: null });
  });
});
