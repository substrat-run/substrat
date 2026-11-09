import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantModel, answerOf, type AssistantTurn } from '@substrat-run/elements/assistant-model';
import { CommandPalette, type AskFn } from '../src/components/CommandPalette';
import { ASK_LABELS, askSource, historyFor, lookLabel, mockAsk } from '../src/lib/ask';
import type { PaletteContext } from '../src/lib/palette';
import { type as typeInto } from './wa';

/**
 * ⌘K Ask (#2283): what a turn shows, read from the assistant's stream protocol into the
 * element's model, and the overlay's third mode that sends a question with the conversation so far.
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

/** One question through the source, as the model has it once it comes to rest. */
async function asked(events: Array<Record<string, unknown>>): Promise<AssistantTurn> {
  const model = new AssistantModel({ source: askSource(async () => ({ events })) });
  model.send('q');
  await new Promise((resolve) => setTimeout(resolve));
  return model.snapshot.turns[0]!;
}

const lines = (turn: AssistantTurn) => turn.parts.flatMap((p) => (p.kind === 'note' ? [p.text] : []));

describe('askSource', () => {
  it('reads a turn into the reads it made, the answer and its provenance', async () => {
    const turn = await asked(turnEvents());
    expect(lines(turn)).toEqual(['Read findings (3)', 'Read finding evidence', 'Read team audit (2+)']);
    expect(answerOf(turn)).toBe('A supplier refuses them.');
    expect(turn).toMatchObject({ provenance: { producedAt: at, sources: 2 }, budgetExhausted: false, status: 'done', failure: null });
    expect(ASK_LABELS.provenance!(turn.provenance!, undefined)).toMatch(/from 2 reads · model llama-3\.3-70b-instruct-fp8-fast$/);
  });

  it('says a refused read as a refusal, and skips an event this page does not know', async () => {
    const turn = await asked([
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: { refused: 'no' }, id: 1 },
      { t: 'a-newer-event', id: 2 },
      { t: 'tool-output', callId: 'c2', tool: 'app_requests', output: { error: 'app not found' }, id: 3 },
      { t: 'turn-finish', reason: 'done', id: 4 },
    ]);
    expect(lines(turn)).toEqual(['Could not read findings: not part of your role', 'Could not read app requests: app not found']);
  });

  it('reads a spent budget and a failed model', async () => {
    expect(await asked([{ t: 'budget-notice', exhausted: true, id: 1 }, { t: 'turn-finish', reason: 'budget', id: 2 }])).toMatchObject({ status: 'budget', budgetExhausted: true });
    expect(ASK_LABELS.budgetOut).toMatch(/today’s AI answers/);
    expect(await asked([{ t: 'turn-error', code: 'model_unavailable', message: 'Try later.', id: 1 }])).toMatchObject({ status: 'failed', failure: { code: 'model_unavailable', message: 'Try later.' } });
  });
});

describe('historyFor', () => {
  it('keeps the newest turns within the route’s bound, still opening on a question', () => {
    const history = Array.from({ length: 10 }, (_, i) => [
      { role: 'user' as const, text: `q${i}` },
      { role: 'assistant' as const, text: `a${i}` },
    ]).flat();
    const h = historyFor(history, 'now?');
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
  const type = (text: string) => act(async () => typeInto(container.querySelector('wa-input')!, text));
  const tabs = () => [...container.querySelectorAll('wa-radio-group[label="Mode"] wa-radio')].map((t) => t.textContent);
  /** The conversation the element was handed: no element is registered here, so the model is what a suite reads. */
  const turns = () => (container.querySelector('sub-assistant') as unknown as { model: AssistantModel }).model.snapshot.turns;
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve)));

  it('offers no Ask mode where the deployment writes no AI text', async () => {
    await render(null);
    expect(tabs()).toEqual(['Jump', 'Support']);
  });

  it('asks with the conversation so far, and hands each answer to the element', async () => {
    const ask = vi.fn<AskFn>(async () => ({ events: turnEvents() }));
    await render(ask);
    expect(tabs()).toEqual(['Jump', 'Ask', 'Support']);
    await key('Tab');
    expect(container.querySelector('wa-input')!.getAttribute('label')).toBe('Ask');

    await type('Why do uploads fail?');
    await key('Enter');
    await settle();
    expect(ask).toHaveBeenCalledWith({ messages: [{ role: 'user', text: 'Why do uploads fail?' }] });
    expect(turns().map(answerOf)).toEqual(['A supplier refuses them.']);
    expect((container.querySelector('wa-input') as unknown as { value: string }).value).toBe('');

    await type('And since when?');
    await key('Enter');
    await settle();
    expect(ask.mock.calls[1]![0]).toEqual({
      messages: [
        { role: 'user', text: 'Why do uploads fail?' },
        { role: 'assistant', text: 'A supplier refuses them.' },
        { role: 'user', text: 'And since when?' },
      ],
    });
  });

  it('a request that fails is on its turn, and the conversation goes on', async () => {
    const ask = vi.fn<AskFn>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await render(ask);
    await key('Tab');
    await type('Anything?');
    await key('Enter');
    await settle();
    expect(turns()).toMatchObject([{ status: 'failed', failure: { code: 'transport' } }]);
  });

  it('leaves Tab to the browser once there is a conversation, and an Enter the element took alone', async () => {
    const ask = vi.fn<AskFn>(async () => ({ events: turnEvents() }));
    await render(ask);
    await key('Tab');
    await type('Why?');
    await key('Enter');
    await settle();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    await act(async () => window.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);

    await type('Taken by a button');
    const taken = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    taken.preventDefault();
    await act(async () => window.dispatchEvent(taken));
    await settle();
    expect(ask).toHaveBeenCalledOnce();
  });

  it('the preview’s stand-in answers in the protocol, so the page is a protocol client either way', async () => {
    vi.useFakeTimers();
    const pending = mockAsk()({ messages: [{ role: 'user', text: 'q' }] });
    await vi.advanceTimersByTimeAsync(1000);
    const { events } = await pending;
    vi.useRealTimers();
    const turn = await asked(events);
    expect(answerOf(turn)).toContain('likely cause');
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
