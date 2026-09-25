import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventExplorer } from '../src/views/ObservabilityPanels';
import { api, type EventFacetResult } from '../src/lib/api';
import { bucketNarrow, bucketRows, dimensionLabel } from '../src/lib/log-stream';

const cursor = { from: '2026-09-01T10:00:00.000Z', to: '2026-09-01T11:00:00.000Z' };
const result = (over: Partial<EventFacetResult> = {}): EventFacetResult => ({
  buckets: [
    { value: 'invoice.sent', count: 40, lastSeen: '2026-09-01T10:40:00.000Z' },
    { value: 'ticket.created', count: 10, lastSeen: '2026-09-01T10:20:00.000Z' },
    { value: null, count: 5, lastSeen: null },
  ],
  total: 58,
  erased: 3,
  truncated: false,
  ...over,
});

describe('log-stream derivations', () => {
  it('only an event type narrows, and narrowing regroups by operation', () => {
    expect(bucketNarrow('type', 'invoice.sent')).toEqual({ type: 'invoice.sent', groupBy: 'operation', field: undefined });
    expect(bucketNarrow('type', null)).toBeNull();
    for (const g of ['operation', 'actor', 'version', 'entityType', 'piiClass', 'field'] as const) {
      expect(bucketNarrow(g, 'x')).toBeNull();
    }
  });

  it('draws bars against the largest bucket and names the null bucket for what it is', () => {
    const rows = bucketRows(result(), 'type');
    expect(rows.map((r) => r.width)).toEqual(['100.0%', '25.0%', '12.5%']);
    expect(rows[2]).toMatchObject({ label: 'no value', isNull: true, narrow: null });
  });

  it('labels the dimension column, including a grouping only a URL can ask for', () => {
    expect(dimensionLabel('field', 'currency')).toBe('payload.currency');
    expect(dimensionLabel('piiClass', '')).toBe('PII class');
    expect(dimensionLabel('invocation' as never, '')).toBe('invocation');
  });
});

describe('Events mode', () => {
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
  const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const byText = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text || b.textContent?.startsWith(text))!;

  it('a type bucket narrows the read to that type, grouped by operation, and says so in the URL', async () => {
    const facets = vi.spyOn(api, 'appFacets').mockResolvedValue(result());
    const onQuery = vi.fn();
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} onQuery={onQuery} />));
    expect(container.querySelector('[data-event-totals]')!.textContent).toBe('58 events · 3 erased');
    await click(byText('invoice.sent'));
    expect(onQuery).toHaveBeenLastCalledWith({ groupBy: 'operation', field: undefined, type: 'invoice.sent' });
    expect(facets).toHaveBeenLastCalledWith(
      'app-a',
      expect.objectContaining({ groupBy: 'operation', type: 'invoice.sent', since: cursor.from, until: cursor.to }),
    );
    expect(container.querySelector('[aria-label="Group by"] [aria-pressed="true"]')!.textContent).toBe('Operation');
  });

  it('a bucket nothing can narrow to is not a button', async () => {
    vi.spyOn(api, 'appFacets').mockResolvedValue(result({ buckets: [{ value: 'acme/assign', count: 4, lastSeen: null }] }));
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} query={{ groupBy: 'operation' }} />));
    expect(container.textContent).toContain('acme/assign');
    expect(byText('acme/assign')).toBeUndefined();
  });

  it('narrowing from a half-chosen Payload field leaves field mode, so the control matches the rows', async () => {
    const facets = vi.spyOn(api, 'appFacets').mockResolvedValue(result());
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} />));
    await click(byText('Payload field'));
    expect(container.querySelector('[aria-label="Group by payload field"]')).not.toBeNull();
    await click(byText('invoice.sent'));
    expect(facets).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ groupBy: 'operation', type: 'invoice.sent' }));
    expect(container.querySelector('[aria-label="Group by"] [aria-pressed="true"]')!.textContent).toBe('Operation');
    expect(container.querySelector('[aria-label="Group by payload field"]')).toBeNull();
  });

  it('picking Payload field asks nothing until a field is named', async () => {
    const facets = vi.spyOn(api, 'appFacets').mockResolvedValue(result());
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} />));
    expect(facets).toHaveBeenCalledTimes(1);
    await click(byText('Payload field'));
    expect(facets).toHaveBeenCalledTimes(1);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Group by payload field"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'currency');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText('Group'));
    expect(facets).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ field: 'currency', groupBy: undefined }));
  });
});
