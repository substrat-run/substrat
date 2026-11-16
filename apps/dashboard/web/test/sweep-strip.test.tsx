import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SweepStrip } from '../src/components/ui';

describe('connection sweep status', () => {
  it('renders an unsupported plane outcome neutrally with its guidance', () => {
    const html = renderToStaticMarkup(<SweepStrip
      runs={[{ id: 'run', outcome: 'unsupported', at: '2026-10-29T00:00:00Z', error: 'upgrade the invoice sweep' }]}
      skippedNote="nothing polls this connection"
    />);
    expect(html).toContain('unsupported: upgrade the invoice sweep');
    expect(html).toContain('— unsupported: upgrade the invoice sweep</span>');
    expect(html).toContain('var(--text-tertiary)');
    expect(html).not.toContain('var(--status-success-fg)');
  });

  it('keeps a mixed successful sweep green and shows its invoice limitation as neutral detail', () => {
    const html = renderToStaticMarkup(<SweepStrip
      runs={[{ id: 'run', outcome: 'ok', at: '2026-10-29T00:00:00Z', error: 'scope invoice: supplier-invoice polling is unavailable' }]}
      skippedNote="nothing polls this connection"
    />);
    expect(html).toContain('var(--status-success-fg)');
    expect(html).toContain('supplier-invoice polling is unavailable');
    expect(html).toContain('— scope invoice: supplier-invoice polling is unavailable</span>');
    expect(html).toContain('var(--text-tertiary)');
  });

  // #3235: the cause of a failing sweep is on the page, not only in the tick's tooltip.
  it("writes the newest failed run's sentence out, in the danger colour", () => {
    const said = "1 of 1 binding did not land: the app's 'shop/record-commerce' refused it (conflict): UNIQUE constraint failed: products.sku (reference 01ABC)";
    const html = renderToStaticMarkup(<SweepStrip
      runs={[
        { id: 'new', outcome: 'failed', at: '2026-10-29T01:00:00Z', error: said },
        { id: 'old', outcome: 'ok', at: '2026-10-29T00:00:00Z', error: null },
      ]}
      skippedNote="nothing polls this connection"
    />);
    const sentence = html.slice(html.indexOf('data-sweep-sentence'));
    expect(sentence).toContain(`— failed: ${said.replace(/'/g, '&#x27;')}</span>`);
    expect(sentence).toContain('color:var(--status-danger-fg)');
  });

  it('says only "failed" for a failed run with no sentence', () => {
    const html = renderToStaticMarkup(<SweepStrip runs={[{ id: 'r', outcome: 'failed', at: '2026-10-29T00:00:00Z', error: null }]} skippedNote="x" />);
    expect(html).toContain('— failed</span>');
  });
});
