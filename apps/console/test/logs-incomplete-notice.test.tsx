import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { LOGS_INCOMPLETE_HEADER } from '@substrat-run/control-plane-api';
import { createApi } from '../src/lib/api';
import { LogsIncompleteNotice } from '../src/views/Observability';

/**
 * #2520: `GET /observability/logs` says beside its list when the read stopped short of vouching
 * for the window. The console reads that through its own client (`createApi`) and shows the
 * notice exactly then: the client is driven with a plane answering as the route does, and what
 * it reports is what the view renders.
 */
describe('the console says when a logs page may be incomplete', () => {
  const lines = [{ timestamp: 1, level: 'info', message: 'a line', service: 's', outcome: null, raw: null }];
  const NOTICE = 'This page may be incomplete or missing newer lines.';

  const readAs = async (headers: Record<string, string>) => {
    const api = createApi('actor', 'http://cp.local');
    const fetchMock: typeof fetch = async () => Response.json(lines, { headers });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      return await api.recentLogsRead({ service: 's' });
    } finally {
      globalThis.fetch = original;
    }
  };
  const render = (incomplete: boolean) =>
    renderToString(createElement(LogsIncompleteNotice, { incomplete })).replace(/<!-- -->/g, '');

  it('a page the plane marked incomplete shows the notice', async () => {
    const { events, incomplete } = await readAs({ [LOGS_INCOMPLETE_HEADER]: '1' });
    expect(events).toEqual(lines);
    expect(render(incomplete)).toContain(NOTICE);
  });

  it('twin: a complete page shows no notice at all', async () => {
    const { events, incomplete } = await readAs({});
    expect(events).toEqual(lines);
    expect(render(incomplete)).toBe('');
  });
});
