import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from '../src/wa';

/**
 * `wa-button` colours the button in its shadow root, so a `color` left on the host draws
 * grey with no error, and a browser is the only other place that would show it.
 */
describe('an icon button', () => {
  it('is named by its label, not by a glyph drawn inside it', () => {
    const html = renderToStaticMarkup(<IconButton label="Close">✕</IconButton>);
    expect(html).toContain('title="Close"');
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>✕<\/span>/);
  });
});

describe('a colour given to a button', () => {
  it.each([
    ['Button', <Button style={{ color: 'red', marginLeft: 4 }}>Delete</Button>],
    ['IconButton', <IconButton label="Delete" style={{ color: 'red', marginLeft: 4 }} />],
  ])('%s hands it to the inner button, and keeps the rest of the style on the host', (_, node) => {
    const html = renderToStaticMarkup(node);
    expect(html).toContain('ui-tinted');
    expect(html).toMatch(/style="[^"]*--ui-button-color:\s*red/);
    expect(html).toMatch(/style="[^"]*margin-left:\s*4px/);
    expect(html).not.toMatch(/style="[^"]*[;"]color:/);
  });

  it('is read by the stylesheet', () => {
    const css = readFileSync(new URL('../src/wa/wa.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ui-tinted::part\(base\)\s*\{\s*color:\s*var\(--ui-button-color\)/);
  });
});
