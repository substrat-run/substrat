// @vitest-environment node
/** `Dialog` renders on the server too: the opener capture reads `document`, which a server lacks. */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../src/components/Dialog';

describe('Dialog on the server', () => {
  it('has no document here, so the test means something', () => {
    expect(typeof document).toBe('undefined');
  });

  it('renders an open dialog without throwing', () => {
    const html = renderToString(<Dialog open title="Delete the thing" />);
    expect(html).toContain('role="dialog"');
  });

  it('renders a closed one as nothing', () => {
    expect(renderToString(<Dialog open={false} title="Delete the thing" />)).toBe('');
  });
});
