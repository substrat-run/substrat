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
  loadLogs,
  logsFailed,
  logsLoaded,
  logsLoading,
  logsPanelOf,
  type LogsView,
} from '../src/lib/logs-view';
import { LogsCard, LogsIncompleteNotice } from '../src/views/Observability';

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

  // state × incomplete × empty → [notice, empty row]; loading and failure follow the state alone
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
    expect(logsPanelOf(view(state, empty ? [] : [line], incomplete))).toEqual({
      notice,
      emptyRow,
      loading: state === 'loading',
      failure: state === 'error' ? 'Log query failed: ' : null,
    });
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
    expect(logsPanelOf(logsLoading(answered))).toMatchObject({ notice: false, emptyRow: null });
    expect(logsPanelOf(logsFailed(answered, 'boom'))).toMatchObject({ notice: false, emptyRow: null, failure: 'Log query failed: boom' });
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

/**
 * The card itself, rendered: `LogsCard` is props-only, so `renderToString` runs all of it. Each
 * branch is asserted on the text a reader sees, so the JSX gates (`panel.notice &&`, the loading
 * row, the failure branch) are held here and not by reading the view.
 */
describe('the recent-logs card, rendered', () => {
  const line = { timestamp: Date.UTC(2026, 9, 1, 12, 0, 0), level: 'error', message: 'boom at noon', service: 's', outcome: 'exception', raw: null } as RecentLogEvent;
  const render = (view: LogsView) => renderToString(createElement(LogsCard, { view })).replace(/<!-- -->/g, '');
  const v = (state: LogsView['state'], events: RecentLogEvent[], incomplete: boolean, error = ''): LogsView => ({ state, events, incomplete, error });

  it('an answered, incomplete page shows the notice and its lines', () => {
    const html = render(v('ready', [line], true));
    expect(html).toContain(LOGS_INCOMPLETE_NOTICE);
    expect(html).toContain('boom at noon');
    expect(html).toContain('2026-10-01 12:00:00');
    expect(html).not.toContain(LOGS_EMPTY_COMPLETE);
    expect(html).not.toContain(LOGS_EMPTY_INCOMPLETE);
    expect(html).not.toContain('Loading…');
  });

  it('twin: an answered, complete page shows its lines and no notice', () => {
    const html = render(v('ready', [line], false));
    expect(html).not.toContain(LOGS_INCOMPLETE_NOTICE);
    expect(html).toContain('boom at noon');
  });

  it('an empty page says the window held nothing only when it is complete', () => {
    const complete = render(v('ready', [], false));
    expect(complete).toContain(LOGS_EMPTY_COMPLETE);
    expect(complete).not.toContain(LOGS_INCOMPLETE_NOTICE);
    const incomplete = render(v('ready', [], true));
    expect(incomplete).toContain(LOGS_EMPTY_INCOMPLETE);
    expect(incomplete).toContain(LOGS_INCOMPLETE_NOTICE);
    expect(incomplete).not.toContain(LOGS_EMPTY_COMPLETE);
  });

  it('while a read is in flight it shows the loading row, the lines already there, and no notice or empty row', () => {
    const html = render(v('loading', [line], true));
    expect(html).toContain('Loading…');
    expect(html).toContain('boom at noon');
    expect(html).not.toContain(LOGS_INCOMPLETE_NOTICE);
    expect(html).not.toContain(LOGS_EMPTY_COMPLETE);
    expect(render(v('loading', [], false))).not.toContain(LOGS_EMPTY_COMPLETE);
  });

  it('a failed read shows the failure sentence in place of the table, and nothing else', () => {
    const html = render(v('error', [line], true, 'upstream said no'));
    expect(html).toContain('Log query failed: upstream said no');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('boom at noon');
    expect(html).not.toContain(LOGS_INCOMPLETE_NOTICE);
    expect(html).not.toContain('Loading…');
  });

  it('every other state shows a table with no loading, failure, notice or empty row', () => {
    for (const state of ['idle', 'ready'] as const) {
      const html = render(v(state, [line], false));
      expect(html).toContain('<table');
      expect(html).not.toContain('Loading…');
      expect(html).not.toContain('Log query failed');
    }
    expect(render(LOGS_IDLE)).not.toContain(LOGS_EMPTY_COMPLETE);
  });
});

/**
 * What a read turns into, driven with a stub client: the effect in the view only calls this and
 * stores what it returns, so the flag the plane reported cannot be lost between the two.
 */
describe('a read ends in the answered view or the failed one', () => {
  const line = { timestamp: 1, level: 'info', message: 'a line', service: 's', outcome: null, raw: null } as RecentLogEvent;
  const asked: unknown[] = [];
  const clientAnswering = (read: () => Promise<{ events: RecentLogEvent[]; incomplete: boolean }>) => ({
    recentLogsRead: async (q?: unknown) => {
      asked.push(q);
      return read();
    },
  });

  it('carries the plane’s incomplete flag through, and the query it was given', async () => {
    const query = { service: 's', hours: 24, limit: 100 };
    const incomplete = await loadLogs(clientAnswering(async () => ({ events: [line], incomplete: true })), query);
    expect(incomplete(LOGS_IDLE)).toEqual({ state: 'ready', events: [line], incomplete: true, error: '' });
    expect(asked.at(-1)).toEqual(query);
    const complete = await loadLogs(clientAnswering(async () => ({ events: [line], incomplete: false })), query);
    expect(complete(LOGS_IDLE)).toEqual({ state: 'ready', events: [line], incomplete: false, error: '' });
  });

  it('a refusal is the failed view, keeping the lines already on screen and never the flag', async () => {
    const prev = logsLoaded({ events: [line], incomplete: true });
    const failed = await loadLogs(clientAnswering(async () => Promise.reject(new Error('501 not configured'))), { service: 's' });
    expect(failed(prev)).toEqual({ state: 'error', events: [line], incomplete: false, error: '501 not configured' });
    const odd = await loadLogs(clientAnswering(async () => Promise.reject('plain string')), { service: 's' });
    expect(odd(prev).error).toBe('plain string');
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
    expect(await panelFor({})).toMatchObject({ notice: false, emptyRow: null });
  });
});
