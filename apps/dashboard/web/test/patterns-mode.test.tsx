import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternsMode } from '../src/views/PatternsMode';
import { api, ApiError, type LogPatterns } from '../src/lib/api';
import { shareLabel, templateParts } from '../src/lib/patterns';
import { logChips, parseBarText } from '../src/lib/logs-chips';
import { tenantLogsQuery } from '../src/lib/logs-query';
import { mockPatternLines } from '../src/lib/mock-patterns';
import { sectionOf } from '../src/lib/obs-sections';

/** #1747: the Patterns mode — its template rendering, the chip a pattern becomes, and the read. */

describe('patterns, pure', () => {
  it('splits a template into its text and its placeholders', () => {
    expect(templateParts('reply to {ticketId} bounced: {reason}')).toEqual([
      { text: 'reply to ', slot: false },
      { text: 'ticketId', slot: true },
      { text: ' bounced: ', slot: false },
      { text: 'reason', slot: true },
    ]);
    // Not a placeholder the logger fills — left as text.
    expect(templateParts('{a.b} and {}')).toEqual([{ text: '{a.b} and {}', slot: false }]);
  });

  it('places the preview’s lines inside the window they are said to be from', () => {
    const window = { from: Date.parse('2026-09-20T10:00:00Z'), to: Date.parse('2026-09-20T11:00:00Z') };
    const lines = mockPatternLines('reply to {ticketId} sent by {agent}', window);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.timestamp!).toBeGreaterThanOrEqual(window.from);
      expect(l.timestamp!).toBeLessThan(window.to);
    }
  });

  it('says a share the way the row does', () => {
    expect(shareLabel(0.5)).toBe('50%');
    expect(shareLabel(0.034)).toBe('3.4%');
    expect(shareLabel(0.0004)).toBe('<0.1%');
    expect(shareLabel(0)).toBe('0.0%');
  });

  it('becomes a `pattern` chip on Lines, and sends the template to the log read', () => {
    expect(logChips({ tpl: 'reply to {id} sent' }, 'logs')).toContainEqual({ key: 'pattern', value: 'reply to {id} sent', clears: ['tpl'] });
    expect(logChips({ tpl: 'x' }, 'patterns')).toEqual([]);
    expect(tenantLogsQuery({ template: 'reply to {id} sent' }).get('template')).toBe('reply to {id} sent');
    // An empty template is kept, so the plane refuses it rather than reading the whole log.
    expect(tenantLogsQuery({ template: '' }).has('template')).toBe(true);
    expect(tenantLogsQuery({}).has('template')).toBe(false);
    expect(parseBarText('anything', 'patterns')).toMatchObject({ error: expect.stringContaining('Click a pattern') });
    expect(sectionOf('patterns')).toBe('logs');
  });
});

describe('PatternsMode', () => {
  const window = { from: '2026-09-27T10:00:00.000Z', to: '2026-09-27T13:00:00.000Z' };
  const answer: LogPatterns = {
    total: 200,
    bucketMs: 360_000,
    truncated: true,
    estimated: false,
    patterns: [
      {
        template: 'reply to {ticketId} bounced',
        count: 38,
        share: 0.19,
        levels: { debug: 0, info: 0, warn: 30, error: 8 },
        dominant: 'warn',
        buckets: [{ start: '2026-09-27T12:00:00.000Z', count: 38 }],
      },
    ],
  };
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const render = async () => {
    const onOpenPattern = vi.fn();
    await act(async () => root.render(<PatternsMode scopeId="app-a" window={window} nonce={0} onOpenPattern={onOpenPattern} />));
    return onOpenPattern;
  };

  it('asks for the page window verbatim and draws each template with its slots marked', async () => {
    const read = vi.spyOn(api, 'appLogPatterns').mockResolvedValue(answer);
    const onOpenPattern = await render();
    const q = read.mock.calls[0]![1] as URLSearchParams;
    expect(read.mock.calls[0]![0]).toBe('app-a');
    expect(q.get('since')).toBe(window.from);
    expect(q.get('until')).toBe(window.to);
    expect(q.get('hours')).toBeNull();
    const row = container.querySelector('[data-pattern]')!;
    expect([...row.querySelectorAll('[data-slot]')].map((s) => s.textContent)).toEqual(['ticketId']);
    expect(row.textContent).toContain('WRN');
    expect(row.textContent).toContain('19%');
    expect(container.textContent).toContain('more exist');
    await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenPattern).toHaveBeenCalledWith('reply to {ticketId} bounced');
  });

  it('says why it is empty: console.log lines carry no template', async () => {
    vi.spyOn(api, 'appLogPatterns').mockResolvedValue({ ...answer, total: 0, patterns: [], truncated: false });
    await render();
    expect(container.textContent).toContain('console.log');
    expect(container.textContent).toContain('Lines tab');
  });

  it('says a 501 is "not on this platform"', async () => {
    vi.spyOn(api, 'appLogPatterns').mockRejectedValue(new ApiError(501, 'not configured'));
    await render();
    expect(container.textContent).toContain('not available on this platform');
  });
});
