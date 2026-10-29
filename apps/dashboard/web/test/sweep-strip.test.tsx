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
    expect(html).toContain('— unsupported');
    expect(html).toContain('var(--text-tertiary)');
    expect(html).not.toContain('var(--status-success-fg)');
  });
});
