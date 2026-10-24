import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExplanationView } from '../src/lib/api.generated';
import { AiText } from '../src/components/AiText';
import { aiState, provenanceLine } from '../src/lib/explanations';

/**
 * AI-written text on the page (#1749): what the block draws for each answer, that it writes
 * nothing until asked, and that a written paragraph always carries the AI marker and the
 * provenance line the server counted.
 */

const NOW = new Date('2026-10-23T16:00:00.000Z');

const view = (over: Partial<ExplanationView> = {}): ExplanationView => ({
  available: true,
  reason: null,
  disclosure: { vendor: 'Cloudflare Workers AI', location: 'Cloudflare network', sent: 'Counts and redacted messages' },
  explanation: null,
  budget: { person: { used: 0, limit: 20 }, team: { used: 0, limit: 100 } },
  ...over,
});

const written = (current = true): ExplanationView['explanation'] => ({
  text: 'Uploads have failed three times. The refusals come from a supplier.',
  writtenAt: '2026-10-23T15:58:00.000Z',
  current,
  provenance: {
    writtenAt: '2026-10-23T15:58:00.000Z',
    model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    since: '2026-10-20T00:00:00.000Z',
    until: '2026-10-23T15:58:00.000Z',
    sources: [
      { kind: 'finding', count: null, href: '/observability?view=findings' },
      { kind: 'ops-failures', count: 212, href: '/observability?app=S1&view=failures' },
      { kind: 'deploy', count: null, href: null },
    ],
    summary: '212 failure records, 2 versions, 1 deploy',
  },
});

describe('aiState', () => {
  it('hides the block where nothing can be written, rather than drawing it disabled', () => {
    expect(aiState(view({ available: false, reason: 'off', disclosure: null, budget: null }))).toEqual({ kind: 'hidden' });
  });
  it('offers before anything is written, and says when the budget is spent', () => {
    expect(aiState(view())).toEqual({ kind: 'offer', spent: false });
    expect(aiState(view({ budget: { person: { used: 20, limit: 20 }, team: { used: 20, limit: 100 } } }))).toEqual({ kind: 'offer', spent: true });
  });
  it('shows written text, and whether it still describes the data', () => {
    expect(aiState(view({ explanation: written(false) }))).toMatchObject({ kind: 'text', current: false });
  });
});

describe('provenanceLine', () => {
  it('reads like the design: when, from what, and how many sources', () => {
    const line = provenanceLine(written()!.provenance, NOW);
    expect(line).toMatch(/^Written \d{2}:\d{2} from 212 failure records, 2 versions, 1 deploy · 3 sources$/);
  });
});

describe('<AiText>', () => {
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

  const render = async (load: () => Promise<ExplanationView>, write: () => Promise<ExplanationView>) => {
    await act(async () => root.render(<AiText load={load} write={write} writeLabel="Explain this finding" />));
  };
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

  it('reads on open and writes only when asked, then shows the marker, the text and the provenance', async () => {
    const write = vi.fn(async () => view({ explanation: written(), budget: { person: { used: 1, limit: 20 }, team: { used: 1, limit: 100 } } }));
    await render(async () => view(), write);
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Runs on Cloudflare Workers AI');
    await act(async () => button('Explain this finding')!.click());
    expect(write).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('AI');
    expect(container.textContent).toContain('Uploads have failed three times.');
    expect(container.textContent).toContain('from 212 failure records, 2 versions, 1 deploy · 3 sources');
    // Each source with a page is a link to it; one without is named, not linked.
    expect([...container.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['the finding', 'failure records']);
  });

  it('renders a paragraph as text, so markup a model wrote is never markup', async () => {
    const hostile = { ...written()!, text: '<img src=x onerror=alert(1)> click <a href="https://evil.example">here</a>' };
    await render(async () => view({ explanation: hostile }), async () => view());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href="https://evil.example"]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('offers a rewrite when the evidence has moved, and none when it has not', async () => {
    await render(async () => view({ explanation: written(false) }), async () => view({ explanation: written(true) }));
    expect(container.textContent).toContain('Written against older data');
    await act(async () => button('Rewrite')!.click());
    expect(button('Rewrite')).toBeUndefined();
  });

  it('a spent budget disables the button and says which ceiling it hit', async () => {
    await render(async () => view({ budget: { person: { used: 20, limit: 20 }, team: { used: 20, limit: 100 } } }), async () => view());
    expect(button('Explain this finding')!.disabled).toBe(true);
    expect(container.textContent).toContain('You have used today’s 20 AI explanations');
  });
});
