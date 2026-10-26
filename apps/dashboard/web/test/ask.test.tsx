import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type AskFn } from '../src/components/CommandPalette';
import { foldTurn, historyFor, lookLabel, mockAsk, type AskTurn } from '../src/lib/ask';
import type { PaletteContext } from '../src/lib/palette';

/**
 * ⌘K Ask (#2283): what a turn shows, folded from the assistant's stream protocol, and the
 * overlay's third mode that sends a question with the conversation so far.
 */

const at = '2026-10-24T09:30:00.000Z';
const turnEvents = (over: Array<Record<string, unknown>> = []) =>
  [
    { t: 'user-message', text: 'Why do uploads fail?' },
    { t: 'turn-start', v: 1 },
    { t: 'step-start', step: 'look-1' },
    { t: 'tool-input', callId: 'c1', tool: 'list_findings', input: {} },
    { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: { available: true, entries: [{}, {}, {}], nextCursor: null, cut: false } },
    { t: 'tool-input', callId: 'c2', tool: 'finding_evidence', input: { id: 'F1' } },
    { t: 'tool-output', callId: 'c2', tool: 'finding_evidence', output: { finding: {} } },
    { t: 'tool-input', callId: 'c3', tool: 'list_team_audit', input: {} },
    { t: 'tool-output', callId: 'c3', tool: 'list_team_audit', output: { entries: [{}, {}], nextCursor: 'x', truncated: true } },
    { t: 'step-end', step: 'look-1' },
    { t: 'text-start', pid: 'answer' },
    { t: 'text-delta', pid: 'answer', delta: 'A supplier refuses ' },
    { t: 'text-delta', pid: 'answer', delta: 'them.' },
    { t: 'text-end', pid: 'answer' },
    { t: 'data-provenance', producedAt: at, model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', sources: 2 },
    ...over,
    { t: 'turn-finish', reason: 'done' },
  ].map((e, i) => ({ ...e, id: i + 1 }));

describe('foldTurn', () => {
  it('folds a turn into its question, the reads it made, the answer and its provenance', () => {
    expect(foldTurn(turnEvents())).toEqual({
      question: 'Why do uploads fail?',
      looks: [
        { tool: 'list_findings', label: 'Read findings (3)' },
        { tool: 'finding_evidence', label: 'Read finding evidence' },
        { tool: 'list_team_audit', label: 'Read team audit (2+)' },
      ],
      answer: 'A supplier refuses them.',
      provenance: { producedAt: at, model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', sources: 2 },
      budgetExhausted: false,
      error: null,
    });
  });

  it('says a refused read as a refusal, and skips an event this page does not know', () => {
    const turn = foldTurn([
      { t: 'user-message', text: 'q', id: 1 },
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: { refused: 'no' }, id: 2 },
      { t: 'a-newer-event', id: 3 },
      { t: 'turn-finish', reason: 'done', id: 4 },
    ]);
    expect(turn.looks).toEqual([{ tool: 'list_findings', label: 'Could not read findings: not part of your role' }]);
    expect(foldTurn([{ t: 'tool-output', callId: 'c', tool: 'app_requests', output: { error: 'app not found' }, id: 1 }]).looks).toEqual([
      { tool: 'app_requests', label: 'Could not read app requests: app not found' },
    ]);
  });

  it('reads a spent budget and a failed model as words for the person', () => {
    expect(foldTurn([{ t: 'user-message', text: 'q', id: 1 }, { t: 'budget-notice', exhausted: true, id: 2 }, { t: 'turn-finish', reason: 'budget', id: 3 }]).error).toMatch(/today’s AI answers/);
    expect(foldTurn([{ t: 'user-message', text: 'q', id: 1 }, { t: 'turn-error', code: 'model_unavailable', message: 'Try later.', id: 2 }]).error).toBe('Try later.');
  });
});

describe('historyFor', () => {
  const answered = (question: string, answer: string): AskTurn => ({ question, looks: [], answer, provenance: null, budgetExhausted: false, error: null });

  it('sends each answered turn as question and answer, and leaves out a turn with no answer', () => {
    const failed: AskTurn = { ...answered('lost', ''), error: 'boom' };
    expect(historyFor([answered('a?', 'A.'), failed], 'b?')).toEqual([
      { role: 'user', text: 'a?' },
      { role: 'assistant', text: 'A.' },
      { role: 'user', text: 'b?' },
    ]);
  });

  it('keeps the newest turns within the route’s bound, still opening on a question', () => {
    const turns = Array.from({ length: 10 }, (_, i) => answered(`q${i}`, `a${i}`));
    const h = historyFor(turns, 'now?');
    expect(h.length).toBeLessThanOrEqual(12);
    expect(h[0]!.role).toBe('user');
    expect(h.at(-1)).toEqual({ role: 'user', text: 'now?' });
  });
});

const CTX: PaletteContext = { apps: [{ scopeId: 'A1', name: 'Helpdesk', host: null, status: 'active' }], currentApp: 'A1', models: {} };

describe('⌘K Ask', () => {
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

  const render = (ask: AskFn | null) => act(async () => root.render(<CommandPalette ctx={CTX} ask={ask} onGo={vi.fn()} onClose={vi.fn()} />));
  const key = (k: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: k })));
  const type = async (text: string) => {
    const input = container.querySelector('input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const tabs = () => [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);

  it('offers no Ask mode where the deployment writes no AI text', async () => {
    await render(null);
    expect(tabs()).toEqual(['Jump', 'Support']);
  });

  it('asks with the conversation so far, and shows each answer under the AI marker with its reads', async () => {
    const ask = vi.fn<AskFn>(async () => ({ events: turnEvents() }));
    await render(ask);
    expect(tabs()).toEqual(['Jump', 'Ask', 'Support']);
    await key('Tab');
    expect(container.querySelector('input')!.getAttribute('aria-label')).toBe('Ask');

    await type('Why do uploads fail?');
    await key('Enter');
    expect(ask).toHaveBeenCalledWith({ messages: [{ role: 'user', text: 'Why do uploads fail?' }] });
    expect(container.textContent).toContain('Read findings (3) · Read finding evidence · Read team audit (2+)');
    expect(container.textContent).toContain('AI');
    expect(container.textContent).toContain('A supplier refuses them.');
    expect(container.textContent).toContain('from 2 reads');

    await type('And since when?');
    await key('Enter');
    expect(ask.mock.calls[1]![0]).toEqual({
      messages: [
        { role: 'user', text: 'Why do uploads fail?' },
        { role: 'assistant', text: 'A supplier refuses them.' },
        { role: 'user', text: 'And since when?' },
      ],
    });
  });

  it('a request that fails is said on its turn, and the conversation goes on', async () => {
    const ask = vi.fn<AskFn>(async () => {
      throw new Error('the dashboard could not be reached');
    });
    await render(ask);
    await key('Tab');
    await type('Anything?');
    await key('Enter');
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('the dashboard could not be reached');
  });

  it('the preview’s stand-in answers in the protocol, so the page is a protocol client either way', async () => {
    vi.useFakeTimers();
    const pending = mockAsk()({ messages: [{ role: 'user', text: 'q' }] });
    await vi.advanceTimersByTimeAsync(1000);
    const turn = foldTurn((await pending).events);
    vi.useRealTimers();
    expect(turn.answer).toContain('likely cause');
    expect(turn.provenance?.sources).toBe(1);
  });
});

describe('lookLabel', () => {
  it('counts a bare list, and reads a record that carries an error field as a read', () => {
    expect(lookLabel('list_deployments', [{ slug: 'a' }, { slug: 'b' }])).toBe('Read deployments (2)');
    expect(lookLabel('list_deployments', { items: [{ slug: 'a' }], truncated: true })).toBe('Read deployments (1+)');
    expect(lookLabel('get_install', { status: 'failed', error: 'push rejected' })).toBe('Read install');
    expect(lookLabel('get_install', { error: 'not found' })).toBe('Could not read install: not found');
    expect(lookLabel('list_findings', { refused: 'no' })).toBe('Could not read findings: not part of your role');
  });
});
