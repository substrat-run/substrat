import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventExplorer } from '../src/views/ObservabilityPanels';
import { api, type EventFacetAnswer, type EventFacetResult } from '../src/lib/api';
import { bucketNarrow, bucketRows, dimensionLabel, emptyGroupingText, withheldOf } from '../src/lib/log-stream';

const cursor = { from: '2026-09-01T10:00:00.000Z', to: '2026-09-01T11:00:00.000Z' };
const result = (over: Partial<EventFacetResult> = {}): EventFacetResult => ({
  buckets: [
    { value: 'invoice.sent', count: 40, lastSeen: '2026-09-01T10:40:00.000Z' },
    { value: 'ticket.created', count: 10, lastSeen: '2026-09-01T10:20:00.000Z' },
    { value: null, count: 5, lastSeen: null },
  ],
  total: 58,
  erased: 3,
  withheldPersonal: 0,
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

  it('reads a missing withheld count as unknown, never 0 (#1762)', () => {
    const { withheldPersonal: _, ...older } = result();
    expect(withheldOf(older as EventFacetAnswer)).toBeNull();
    expect(withheldOf(result({ withheldPersonal: 0 }))).toBe(0);
  });

  it('says plainly when every event was withheld as personal data (#1762)', () => {
    expect(emptyGroupingText(result({ buckets: [], total: 12, erased: 2, withheldPersonal: 10 }))).toBe(
      'Every matching event is classed as personal data, so none is grouped by a payload field.',
    );
    expect(emptyGroupingText(result({ buckets: [], total: 4, erased: 4, withheldPersonal: 0 }))).toMatch(/erased/);
    expect(emptyGroupingText(result({ buckets: [], total: 0, erased: 0 }))).toBe('No events matched this filter.');
    expect(
      emptyGroupingText(result({ buckets: [], total: 9, erased: 0, withheldPersonal: 9, withheldReason: 'vertical-predates-rule' })),
    ).toMatch(/^This app was pushed with Substrat packages from before personal-data events were withheld/);
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

  it('a payload grouping says how many events it withheld as personal data, and why (#1762)', async () => {
    vi.spyOn(api, 'appFacets').mockResolvedValue(
      result({ buckets: [{ value: 'SEK', count: 50, lastSeen: null }], total: 4263, erased: 3, withheldPersonal: 4210 }),
    );
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} query={{ field: 'currency' }} />));
    expect(container.querySelector('[data-event-totals]')!.textContent).toBe(
      '4,263 events · 3 erased · 4,210 withheld as personal data',
    );
    expect(container.textContent).toContain('Grouping by a payload field counts only events not classed as personal data.');
    expect(container.textContent).toContain('SEK');
  });

  it('a payload grouping whose events were all withheld says so instead of drawing nothing (#1762)', async () => {
    vi.spyOn(api, 'appFacets').mockResolvedValue(result({ buckets: [], total: 40, erased: 0, withheldPersonal: 40 }));
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} query={{ field: 'email' }} />));
    expect(container.querySelector('[data-event-totals]')!.textContent).toBe('40 events · 0 erased · 40 withheld as personal data');
    expect(container.textContent).toContain('Every matching event is classed as personal data, so none is grouped by a payload field.');
  });

  it('an answer with no withheld count says unknown, not 0 (#1762)', async () => {
    const { withheldPersonal: _, ...older } = result();
    vi.spyOn(api, 'appFacets').mockResolvedValue(older as EventFacetAnswer);
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} query={{ field: 'currency' }} />));
    expect(container.querySelector('[data-event-totals]')!.textContent).toBe('58 events · 3 erased · withheld unknown');
    expect(container.textContent).toContain('This answer does not say whether they were withheld, so this grouping may include them.');
  });

  it('a payload grouping refused because the app predates the rule shows no buckets and says why (#1762)', async () => {
    vi.spyOn(api, 'appFacets').mockResolvedValue(
      result({ buckets: [], total: 58, erased: 3, withheldPersonal: 55, withheldReason: 'vertical-predates-rule' }),
    );
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} query={{ field: 'email' }} />));
    // The count covers every event not erased, so it does not claim to be personal data.
    expect(container.querySelector('[data-event-totals]')!.textContent).toBe('58 events · 3 erased · 55 withheld');
    expect(container.textContent).toContain(
      'This app was pushed with Substrat packages from before personal-data events were withheld, so payload groupings are unavailable. Update its Substrat packages and push it again.',
    );
  });

  it('an envelope grouping mentions no withholding at all', async () => {
    const { withheldPersonal: _, ...older } = result();
    vi.spyOn(api, 'appFacets').mockResolvedValue(older as EventFacetAnswer);
    await act(async () => root.render(<EventExplorer embedded scopeId="app-a" hours={24} window={cursor} />));
    expect(container.querySelector('[data-event-withheld]')).toBeNull();
    expect(container.textContent).not.toContain('personal data');
  });
});
