import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SweepRunEntry } from '@substrat-run/contracts';
import { SweepRunDetail } from '../src/views/SweepRuns';

describe('sweep receipt detail', () => {
  it('shows a mixed successful sweep limitation neutrally', () => {
    const entry = { outcome: 'ok', error: 'scope invoice: supplier-invoice polling is unavailable' } as SweepRunEntry;
    const html = renderToStaticMarkup(<SweepRunDetail entry={entry} />);
    expect(html).toContain('supplier-invoice polling is unavailable');
    expect(html).toContain('var(--text-tertiary)');
    expect(html).not.toContain('var(--status-danger-fg)');
  });

  it('separates an unsupported invoice from a failed ledger in one receipt', () => {
    const entry = { outcome: 'failed', error: 'Unsupported bindings: scope invoice: supplier-invoice polling is unavailable\n1 binding did not land (reference abc)' } as SweepRunEntry;
    const html = renderToStaticMarkup(<SweepRunDetail entry={entry} />);
    expect(html).toContain('color:var(--text-tertiary)">Unsupported bindings: scope invoice');
    expect(html).toContain('color:var(--status-danger-fg)">1 binding did not land');
  });
});
