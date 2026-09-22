import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { connectorCallsSeries } from '../src/lib/connector-calls';
import { ProviderChart } from '../src/views/ConnectorCallsChart';

/** One provider's stacked bars (#1691), drawn green → yellow → red like the traffic chart (#1693). */
describe('ProviderChart (#1691)', () => {
  const now = Date.parse('2026-09-22T12:34:00Z');
  const render = (over: Partial<{ ok: number; class4xx: number; class5xx: number }>) => {
    const [series] = connectorCallsSeries(
      [
        {
          provider: 'scrive',
          start: '2026-09-22T12:00:00Z',
          bucketMinutes: 60,
          calls: (over.ok ?? 0) + (over.class4xx ?? 0) + (over.class5xx ?? 0),
          errors: 0,
          ok: over.ok ?? 0,
          class4xx: over.class4xx ?? 0,
          class5xx: over.class5xx ?? 0,
          timeouts: 0,
          failed: 0,
          durationP50: 90,
          durationP95: 400,
        },
      ],
      24,
      now,
    );
    return renderToString(createElement(ProviderChart, { series: series! }));
  };
  const fills = (html: string) => ({
    green: (html.match(/<rect[^>]*fill="var\(--status-success-fg/g) ?? []).length,
    yellow: (html.match(/<rect[^>]*fill="var\(--status-warning-fg/g) ?? []).length,
    red: (html.match(/<rect[^>]*fill="var\(--status-danger-fg/g) ?? []).length,
  });

  it('stacks one segment per outcome class present in the bucket', () => {
    const html = render({ ok: 6, class4xx: 2, class5xx: 2 });
    expect(fills(html)).toEqual({ green: 1, yellow: 1, red: 1 });
    expect(html).toContain('10 calls');
    expect(html).toContain('20% red');
    expect(html).toContain('worst p95 400 ms');
  });

  it('draws no segment for a class with nothing in it', () => {
    expect(fills(render({ ok: 5 }))).toEqual({ green: 1, yellow: 0, red: 0 });
  });
});
