// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/assistant.js';
import type { SubAssistant } from '../src/assistant.js';
import { AssistantModel, scriptedSource, type AssistantEvent } from '../src/assistant-model.js';

const tick = () => new Promise((resolve) => setTimeout(resolve));
const finish: AssistantEvent = { t: 'turn-finish', reason: 'done' };
const answer = (text: string): AssistantEvent => ({ t: 'text-delta', pid: 'a', delta: text });
const modelOf = (...script: AssistantEvent[]) => new AssistantModel({ source: scriptedSource(script) });

async function mount(model: AssistantModel | undefined, set?: (el: SubAssistant) => void): Promise<SubAssistant> {
  const el = document.createElement('sub-assistant');
  el.model = model;
  set?.(el);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

const find = <T extends Element = HTMLElement>(el: SubAssistant, selector: string) => el.shadowRoot!.querySelector<T>(selector);
const text = (el: SubAssistant, part: string) => find(el, `[part~="${part}"]`)?.textContent?.trim();
const status = (el: SubAssistant) => find(el, '[role="status"]')!.textContent;

async function ask(el: SubAssistant, model: AssistantModel, question = 'why?') {
  model.send(question);
  await tick();
  await el.updateComplete;
}

const enter = (init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true, ...init });

async function typed(el: SubAssistant, value: string) {
  const field = find<HTMLTextAreaElement>(el, 'textarea')!;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await el.updateComplete;
  return field;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('<sub-assistant>', () => {
  it('draws the question and the answer as text, under the AI marker', async () => {
    const model = modelOf(answer('<img src=x onerror=alert(1)>'), finish);
    const el = await mount(model);
    await ask(el, model, '<b>why?</b>');
    expect(text(el, 'question')).toBe('<b>why?</b>');
    expect(text(el, 'answer')).toBe('<img src=x onerror=alert(1)>');
    expect(text(el, 'ai-marker')).toBe('AI');
    expect(find(el, 'img')).toBeNull();
  });

  it('grows an answer by appending, so a selection inside it survives the next token', async () => {
    let more: () => void = () => undefined;
    const model = new AssistantModel({
      source: {
        async *send() {
          yield answer('The first part');
          await new Promise<void>((resolve) => (more = resolve));
          yield answer(' and the rest');
          yield finish;
        },
      },
    });
    const el = await mount(model);
    await ask(el, model);
    const node = find(el, '[part~="answer"]')!.lastChild as Text;
    const range = document.createRange();
    range.setStart(node, 4);
    range.setEnd(node, 9);
    more();
    await tick();
    await el.updateComplete;
    expect(text(el, 'answer')).toBe('The first part and the rest');
    expect(range.toString()).toBe('first');
  });

  it('folds tool calls and host notes into one line, in the host’s words where it gives them', async () => {
    const model = modelOf(
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: [] },
      { t: 'host-event', kind: 'read', text: 'Read members (3)' },
      answer('Fine.'),
      finish,
    );
    const el = await mount(model, (e) => (e.labels = { tool: (name) => `Looked at ${name}` }));
    await ask(el, model);
    expect(text(el, 'trace')).toBe('Looked at list_findings · Read members (3)');
  });

  it('marks Enter on its own button as handled and presses it, so a host at window can leave it alone', async () => {
    const seen: boolean[] = [];
    const host = (event: Event) => seen.push(event.defaultPrevented);
    window.addEventListener('keydown', host);
    try {
      const model = new AssistantModel({ source: scriptedSource([{ t: 'turn-error', code: 'model', message: 'Busy.' }]) });
      const el = await mount(model);
      await ask(el, model);
      const retry = vi.spyOn(model, 'retry');
      find(el, '[part~="retry"]')!.dispatchEvent(enter());
      expect(seen).toEqual([true]);
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', host);
    }
  });

  it('listens to nothing above itself', async () => {
    const onWindow = vi.spyOn(window, 'addEventListener');
    const onDocument = vi.spyOn(document, 'addEventListener');
    await mount(modelOf(finish));
    expect([...onWindow.mock.calls, ...onDocument.mock.calls].map(([type]) => type)).not.toContain('keydown');
  });

  it('sends on Enter, keeps Shift+Enter and an input method’s Enter in the field, and clears only what was sent', async () => {
    const seen: string[] = [];
    const host = () => seen.push('host');
    window.addEventListener('keydown', host);
    try {
      const model = modelOf(answer('ok'), finish);
      const send = vi.spyOn(model, 'send');
      const el = await mount(model);
      const field = await typed(el, 'why?');
      field.dispatchEvent(enter({ shiftKey: true }));
      field.dispatchEvent(enter({ isComposing: true }));
      expect(send).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      field.dispatchEvent(enter());
      expect(send).toHaveBeenCalledExactlyOnceWith('why?');
      expect(field.value).toBe('');
    } finally {
      window.removeEventListener('keydown', host);
    }
  });

  it('keeps the draft when a run is in flight', async () => {
    const model = new AssistantModel({
      source: {
        async *send() {
          await new Promise(() => undefined);
        },
      },
    });
    const el = await mount(model);
    await ask(el, model);
    const field = await typed(el, 'and?');
    field.dispatchEvent(enter());
    expect(field.value).toBe('and?');
  });

  it('under hide-composer draws no input, and draws what the host sends', async () => {
    const model = modelOf(answer('ok'), finish);
    const el = await mount(model, (e) => (e.hideComposer = true));
    expect(find(el, 'textarea')).toBeNull();
    await ask(el, model, 'from the palette');
    expect(text(el, 'question')).toBe('from the palette');
  });

  it('offers Stop only on a source that can stop', async () => {
    const running = (cancel?: () => Promise<void>) =>
      new AssistantModel({
        source: {
          async *send() {
            await new Promise(() => undefined);
          },
          ...(cancel ? { cancel } : {}),
        },
      });
    const without = running();
    const plain = await mount(without);
    await ask(plain, without);
    expect(find(plain, '[part~="stop"]')).toBeNull();

    const cancel = vi.fn(() => Promise.resolve());
    const model = running(cancel);
    const el = await mount(model, (e) => (e.hideComposer = true));
    await ask(el, model);
    find(el, '[part~="stop"]')!.click();
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('raises the source event on a click, and a cancelled one keeps a link from opening', async () => {
    const model = modelOf({ t: 'source', sid: 'f', title: 'lease.pdf', ref: 'file/1' }, { t: 'source', sid: 'u', title: 'Docs', url: 'https://example.com/d' }, finish);
    const el = await mount(model);
    await ask(el, model);
    const opened: unknown[] = [];
    el.addEventListener('sub-assistant-source', (event) => {
      opened.push((event as CustomEvent).detail.citation.ref);
      event.preventDefault();
    });
    find(el, 'button[part~="source"]')!.click();
    const link = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
    find(el, 'a[part~="source"]')!.dispatchEvent(link);
    expect(opened).toEqual(['file/1', null]);
    expect(link.defaultPrevented).toBe(true);
    expect(find<HTMLAnchorElement>(el, 'a[part~="source"]')!.rel).toBe('noopener noreferrer');
  });

  it('keeps one status node, empty until it has something to say, and no live region on the transcript', async () => {
    const model = modelOf(answer('ok'), finish);
    const el = await mount(model);
    expect(status(el)).toBe('');
    expect(el.shadowRoot!.querySelectorAll('[role="status"],[role="log"],[role="alert"],[aria-live]')).toHaveLength(1);
    await ask(el, model);
    expect(status(el)).toBe('Answer ready.');
  });

  it('says a failure in the server’s words, or its own when the server wrote none', async () => {
    const said = new AssistantModel({ source: scriptedSource([{ t: 'turn-error', code: 'model', message: 'Too busy.' }]) });
    const el = await mount(said);
    await ask(el, said);
    expect(status(el)).toBe('Too busy.');
    expect(text(el, 'failure')).toContain('Too busy.');

    const thrown = new AssistantModel({
      source: {
        // eslint-disable-next-line require-yield
        async *send() {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    const other = await mount(thrown, (e) => (e.labels = { failure: (f) => `Fel: ${f.code}` }));
    await ask(other, thrown);
    expect(status(other)).toBe('Fel: transport');
  });

  it('never offers an approval, and says the turn cannot be finished here', async () => {
    const model = modelOf({ t: 'turn-finish', reason: 'awaiting-approval' });
    const el = await mount(model);
    await ask(el, model);
    expect(text(el, 'note')).toBe('This needs an approval that this version cannot show.');
    expect(el.shadowRoot!.querySelectorAll('button:not([part~="send"])')).toHaveLength(0);
  });

  it('says it is still working after a silence, and stops once the turn has ended', async () => {
    vi.useFakeTimers();
    let end: () => void = () => undefined;
    const model = new AssistantModel({
      source: {
        async *send() {
          await new Promise<void>((resolve) => (end = resolve));
          yield finish;
        },
      },
    });
    const el = await mount(model);
    model.send('why?');
    await el.updateComplete;
    expect(status(el)).toBe('Working on it…');
    await vi.advanceTimersByTimeAsync(10_000);
    await el.updateComplete;
    expect(status(el)).toBe('Still working.');
    end();
    await vi.advanceTimersByTimeAsync(0);
    await el.updateComplete;
    expect(status(el)).toBe('Answer ready.');
    await vi.advanceTimersByTimeAsync(30_000);
    await el.updateComplete;
    expect(status(el)).toBe('Answer ready.');
  });

  it('keeps the conversation when taken out of the page, and starts over on a new model', async () => {
    const model = modelOf(answer('ok'), finish);
    const el = await mount(model);
    await ask(el, model, 'first');
    el.remove();
    document.body.append(el);
    await el.updateComplete;
    expect(text(el, 'question')).toBe('first');

    el.model = modelOf(finish);
    await el.updateComplete;
    expect(find(el, '[part~="question"]')).toBeNull();
    await el.updateComplete;
  });

  it('shows the empty slot before the first question only', async () => {
    const model = modelOf(answer('ok'), finish);
    const el = await mount(model);
    expect(find(el, 'slot[name="empty"]')).not.toBeNull();
    await ask(el, model);
    expect(find(el, 'slot[name="empty"]')).toBeNull();
  });

  it('names its messages at the level the host gives', async () => {
    const model = modelOf(answer('ok'), finish);
    const el = await mount(model, (e) => (e.headingLevel = 4));
    await ask(el, model);
    expect([...el.shadowRoot!.querySelectorAll('[role="heading"]')].map((h) => h.getAttribute('aria-level'))).toEqual(['4', '4']);
  });
});
