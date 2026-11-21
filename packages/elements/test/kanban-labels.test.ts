// @vitest-environment jsdom
/**
 * The board's words: every one of them replaceable, and layered on Web Awesome's translation
 * registry (the board's own `labels`, then the registered language, then English). Its own file
 * because a registered translation is page-wide and would leak into the other suites.
 */
import { LocalizeController } from '@awesome.me/webawesome/dist/utilities/localize.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KanbanLabels, SubKanban } from '../src/kanban.js';

type Card = { id: string; title: string; status: string };
type Board = SubKanban<Card>;

let kanban: typeof import('../src/kanban.js');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  kanban = await import('../src/kanban.js');
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
});

const TITLES = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const COLUMN_LABELS = ['To do', 'Doing', 'Done'];

async function boardIn(parent: HTMLElement, props: Partial<Board> = {}) {
  const board = document.createElement('sub-kanban') as Board;
  Object.assign(board, {
    columns: [
      { key: 'todo', label: 'To do', limit: 3 },
      { key: 'doing', label: 'Doing' },
      { key: 'done', label: 'Done' },
    ],
    cards: [
      { id: 'a', title: 'Alpha', status: 'todo' },
      { id: 'b', title: 'Beta', status: 'todo' },
      { id: 'c', title: 'Gamma', status: 'doing' },
    ],
    addable: true,
    ...props,
  });
  parent.append(board);
  await board.updateComplete;
  return board;
}

const root = (board: Board) => board.shadowRoot!;
const focus = (board: Board, key: string) => root(board).querySelector<HTMLElement>(`[data-key="${key}"]`)!.focus();

async function press(board: Board, key: string) {
  const target = root(board).activeElement as HTMLElement;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
  await board.updateComplete;
  await flush();
}

/** Everything a person sees or hears in the board: its text (no CSS), and the attributes a screen reader reads. */
function spoken(board: Board): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root(board), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('style')) continue;
    out.push(node.textContent ?? '');
  }
  for (const el of root(board).querySelectorAll('*')) {
    for (const name of ['aria-label', 'aria-roledescription', 'placeholder', 'title']) {
      const value = el.getAttribute(name);
      if (value) out.push(value);
    }
  }
  return out;
}

/** What is left of the spoken text once placeholders, card titles, column names and counts are taken out: words the labels did not cover. */
function uncovered(board: Board): string {
  let text = spoken(board).join(' ').replace(/«[^»]*»/g, ' ');
  for (const name of [...TITLES, ...COLUMN_LABELS]) text = text.split(name).join(' ');
  return text.replace(/[\d\s/.,]+/g, ' ').trim();
}

describe('<sub-kanban> labels', () => {
  it('says nothing in English once every label is replaced, across every state a keyboard or `moveTo` reaches', async () => {
    // A plain word is read on every render, so only the words that take a value can say they were used.
    const used = new Set<string>();
    const labels = Object.fromEntries(
      Object.entries(kanban.KANBAN_LABELS).map(([key, value]) => [key, typeof value === 'function' ? () => (used.add(key), `«${key}»`) : `«${key}»`]),
    ) as unknown as KanbanLabels;
    let fail = false;
    const board = await boardIn(document.body, {
      labels,
      canDrag: (card) => card.id !== 'c',
      move: () => (fail ? Promise.reject(new Error('conflict')) : Promise.resolve()),
    });
    const leaks: string[] = [];
    const check = (step: string) => {
      const left = uncovered(board);
      if (left) leaks.push(`${step}: ${left}`);
    };
    check('first render');

    root(board).querySelector<HTMLElement>('.column[data-column="doing"] .add')!.click();
    await board.updateComplete;
    check('composer open');
    const field = root(board).querySelector<HTMLTextAreaElement>('.compose')!;
    field.value = 'Delta';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await board.updateComplete;
    check('card added');

    focus(board, 'c');
    await press(board, ' ');
    check('a card that cannot move');

    focus(board, 'a');
    await press(board, ' ');
    check('picked up');
    await press(board, 'ArrowUp');
    check('at the top');
    await press(board, 'ArrowLeft');
    check('no column to the left');
    await press(board, 'ArrowRight');
    check('carried right');
    await press(board, 'Escape');
    check('cancelled');

    await press(board, ' ');
    await press(board, ' ');
    check('dropped where it was');

    board.addEventListener('sub-card-move', (e) => e.preventDefault(), { once: true });
    await press(board, ' ');
    await press(board, 'ArrowRight');
    await press(board, ' ');
    check('refused by the screen');

    expect(await board.moveTo('a', 'done')).toBe(true);
    check('moved');
    fail = true;
    expect(await board.moveTo('b', 'done')).toBe(false);
    await board.updateComplete;
    check('move failed');

    board.sortable = false;
    await board.updateComplete;
    focus(board, 'a');
    await press(board, ' ');
    await press(board, 'ArrowDown');
    check('no order');

    expect(leaks).toEqual([]);
    // Only a pointer reaches these: a column that refuses the card, shown while it hangs over it.
    const pointerOnly = ['full', 'cantMove', 'doesNotTake'];
    const functions = Object.entries(kanban.KANBAN_LABELS).filter(([, value]) => typeof value === 'function').map(([key]) => key);
    expect(functions.filter((key) => !used.has(key) && !pointerOnly.includes(key))).toEqual([]);
  });

  it("registers its English in Web Awesome's registry, and takes a registered language from the nearest lang", async () => {
    kanban.registerKanbanLabels('sv', { addCard: 'Lägg till kort', count: (n) => `${n} kort` });
    const section = document.createElement('section');
    section.lang = 'sv-FI';
    document.body.append(section);
    const board = await boardIn(section);

    const registry = new LocalizeController(board);
    expect(registry.exists('sub-kanban.addCard' as never, { lang: 'en', includeFallback: false })).toBe(true);

    const add = root(board).querySelector<HTMLElement>('.add')!;
    expect(add.textContent!.trim()).toBe('Lägg till kort');
    // Web Awesome's own components read only their own lang or the page's: the board hands them its own.
    expect(add.getAttribute('lang')).toBe('sv-FI');
    expect(root(board).querySelector('.count')!.getAttribute('aria-label')).toBe('2 kort');
    // A word Swedish does not register is English.
    expect(root(board).querySelector('[role=group]')!.getAttribute('aria-label')).toBe('Board');
  });

  it("prefers the board's own labels to a registered language, and passes over a registered word of the wrong kind", async () => {
    kanban.registerKanbanLabels('sv', { titlePlaceholder: 'Skriv en titel…', newCardTitle: 'not a function' as never });
    document.documentElement.lang = 'sv';
    const board = await boardIn(document.body, { labels: { addCard: 'Nytt kort' } });
    expect(root(board).querySelector('.add')!.textContent!.trim()).toBe('Nytt kort');
    root(board).querySelector<HTMLElement>('.add')!.click();
    await board.updateComplete;
    const field = root(board).querySelector<HTMLTextAreaElement>('.compose')!;
    expect(field.placeholder).toBe('Skriv en titel…');
    expect(field.getAttribute('aria-label')).toBe('Title of a new card in To do');
  });
});
