// @vitest-environment jsdom
/**
 * The board's keyboard path and `moveTo`, on the real element. jsdom lays nothing out, so the
 * pointer drag (hit-testing, the tilt, the settle) is checked in a browser, not here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SubKanban } from '../src/kanban.js';
import type { KanbanMove } from '../src/kanban-model.js';

type Card = { id: string; title: string; status: string };
type Board = SubKanban<Card>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  await import('../src/kanban.js');
});

afterEach(() => document.body.replaceChildren());

async function boardWith(props: Partial<Board> = {}) {
  const board = document.createElement('sub-kanban') as Board;
  Object.assign(board, {
    columns: [
      { key: 'todo', label: 'To do' },
      { key: 'doing', label: 'Doing' },
      { key: 'done', label: 'Done' },
    ],
    cards: [
      { id: 'a', title: 'Alpha', status: 'todo' },
      { id: 'b', title: 'Beta', status: 'todo' },
      { id: 'c', title: 'Gamma', status: 'doing' },
    ],
    ...props,
  });
  const moves: KanbanMove<Card>[] = [];
  board.addEventListener('sub-card-move', (e) => moves.push((e as CustomEvent).detail));
  document.body.append(board);
  await board.updateComplete;
  return { board, moves };
}

const columns = (board: Board) => Object.fromEntries([...board.board].map(([k, v]) => [k, [...v]]));
const said = (board: Board) => board.shadowRoot!.querySelector('[role=status]')!.textContent!.trim();

async function press(board: Board, key: string) {
  const target = board.shadowRoot!.activeElement as HTMLElement;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
  await board.updateComplete;
  await flush();
}

describe('<sub-kanban>', () => {
  it('picks a card up with Space, carries it with arrows, drops it with Space, and says each step', async () => {
    const { board, moves } = await boardWith({ canDrop: (_c, _from, to) => to !== 'doing' });
    board.shadowRoot!.querySelector<HTMLElement>('[data-key="b"]')!.focus();
    await press(board, ' ');
    expect(said(board)).toMatch(/^Picked up Beta\. To do, position 2 of 2\./);
    await press(board, 'ArrowRight');
    expect(said(board)).toBe('Done, position 1 of 1.');
    expect((board.shadowRoot!.activeElement as HTMLElement).dataset['key']).toBe('b');
    await press(board, ' ');
    expect(columns(board)).toEqual({ todo: ['a'], doing: ['c'], done: ['b'] });
    expect(moves).toMatchObject([{ key: 'b', from: 'todo', to: 'done', index: 0 }]);
  });

  it('puts a held card back on Escape, with no move', async () => {
    const { board, moves } = await boardWith();
    board.shadowRoot!.querySelector<HTMLElement>('[data-key="a"]')!.focus();
    await press(board, ' ');
    await press(board, 'ArrowRight');
    await press(board, 'Escape');
    expect(columns(board).todo).toEqual(['a', 'b']);
    expect(moves).toEqual([]);
    expect(said(board)).toBe('Move cancelled. Alpha is back in To do.');
  });

  it('moves without a drag, refusing what the screen refuses, and a cancelled event', async () => {
    const { board } = await boardWith({ canDrop: (_c, _from, to) => to !== 'done' });
    expect(await board.moveTo('a', 'done')).toBe(false);
    board.addEventListener('sub-card-move', (e) => (e as CustomEvent<KanbanMove<Card>>).detail.key === 'b' && e.preventDefault(), { once: true });
    expect(await board.moveTo('b', 'doing')).toBe(false);
    expect(await board.moveTo('a', 'doing', 0)).toBe(true);
    expect(columns(board)).toEqual({ todo: ['b'], doing: ['a', 'c'], done: [] });
  });

  it('shows a move at once and takes it back when saving it fails', async () => {
    let fail!: (e: Error) => void;
    const { board } = await boardWith({ move: () => new Promise((_, reject) => (fail = reject)) });
    const failed: unknown[] = [];
    board.addEventListener('sub-move-failed', (e) => failed.push((e as CustomEvent).detail.error));
    const done = board.moveTo('a', 'done');
    await board.updateComplete;
    expect(columns(board).done).toEqual(['a']);
    expect(board.shadowRoot!.querySelector('[data-key="a"]')!.getAttribute('aria-busy')).toBe('true');
    fail(new Error('conflict'));
    expect(await done).toBe(false);
    expect(columns(board)).toEqual({ todo: ['a', 'b'], doing: ['c'], done: [] });
    expect(failed).toHaveLength(1);
  });

  it('keeps a move still saving over new cards, and takes it back from them when it fails', async () => {
    let fail!: (e: Error) => void;
    const { board } = await boardWith({ move: () => new Promise((_, reject) => (fail = reject)) });
    const done = board.moveTo('a', 'done');
    board.cards = [...board.cards, { id: 'd', title: 'Delta', status: 'doing' }];
    await board.updateComplete;
    expect(columns(board)).toEqual({ todo: ['b'], doing: ['c', 'd'], done: ['a'] });
    fail(new Error('conflict'));
    expect(await done).toBe(false);
    expect(columns(board)).toEqual({ todo: ['a', 'b'], doing: ['c', 'd'], done: [] });
  });

  it('counts a column against its limit', async () => {
    const { board } = await boardWith({ columns: [{ key: 'todo', label: 'To do', limit: 2 }, { key: 'doing', label: 'Doing', limit: 2 }] });
    const counts = [...board.shadowRoot!.querySelectorAll<HTMLElement>('.count')].map((c) => `${c.textContent} ${c.dataset['load']}`);
    expect(counts).toEqual(['2 / 2 at', '1 / 2 under']);
  });

  it('opens a field from "Add a card", reports each title with Enter, and stays open for the next', async () => {
    const { board } = await boardWith({ addable: true });
    const added: unknown[] = [];
    board.addEventListener('sub-card-add', (e) => added.push((e as CustomEvent).detail));
    board.shadowRoot!.querySelector<HTMLElement>('.column[data-column="doing"] .add')!.click();
    await board.updateComplete;
    const field = board.shadowRoot!.querySelector<HTMLTextAreaElement>('.compose')!;
    const enter = () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    enter();
    field.value = '  Delta  ';
    enter();
    await board.updateComplete;
    expect(added).toEqual([{ column: 'doing', title: 'Delta' }]);
    expect(board.shadowRoot!.querySelector<HTMLTextAreaElement>('.compose')?.value).toBe('');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await board.updateComplete;
    expect(board.shadowRoot!.querySelector('.compose')).toBeNull();
  });

  it("sets a column's colour as its accent and draws a dot for it, and draws none for a column without one", async () => {
    const { board } = await boardWith({ columns: [{ key: 'todo', label: 'To do', colour: '#e2445c' }, { key: 'doing', label: 'Doing' }] });
    const [todo, doing] = [...board.shadowRoot!.querySelectorAll<HTMLElement>('.column')];
    expect(todo!.style.getPropertyValue('--sub-kanban-column-accent')).toBe('#e2445c');
    expect(todo!.querySelector('header [part="accent"]')).not.toBeNull();
    expect(doing!.style.getPropertyValue('--sub-kanban-column-accent')).toBe('');
    expect(doing!.querySelector('[part="accent"]')).toBeNull();
  });

  it('with sortable off, keeps a held card out of its own column\'s order and lands it where the given order puts it', async () => {
    // Given order a, c, b: so b lands after c in Doing, whatever the keys or `moveTo` ask.
    const cards = [
      { id: 'a', title: 'Alpha', status: 'todo' },
      { id: 'c', title: 'Gamma', status: 'doing' },
      { id: 'b', title: 'Beta', status: 'todo' },
    ];
    const { board, moves } = await boardWith({ cards, sortable: false });
    board.shadowRoot!.querySelector<HTMLElement>('[data-key="b"]')!.focus();
    await press(board, ' ');
    await press(board, 'ArrowUp');
    expect(said(board)).toBe('This board keeps no order within a column.');
    await press(board, 'ArrowRight');
    expect(said(board)).toBe('Doing, position 2 of 2.');
    await press(board, 'ArrowLeft');
    await press(board, ' ');
    expect(said(board)).toBe('Beta dropped where it was.');
    expect(moves).toEqual([]);
    expect(await board.moveTo('b', 'doing', 0)).toBe(true);
    expect(columns(board)).toEqual({ todo: ['a'], doing: ['c', 'b'], done: [] });
    expect(moves).toMatchObject([{ key: 'b', to: 'doing', index: 1, after: 'c', before: null }]);
  });

  it('with sortable off, places a held card again when the order changes under it', async () => {
    const cards = [
      { id: 'b', title: 'Beta', status: 'todo' },
      { id: 'c', title: 'Gamma', status: 'doing' },
      { id: 'd', title: 'Delta', status: 'doing' },
    ];
    const { board, moves } = await boardWith({ cards, sortable: false });
    board.shadowRoot!.querySelector<HTMLElement>('[data-key="b"]')!.focus();
    await press(board, ' ');
    await press(board, 'ArrowRight');
    expect(said(board)).toBe('Doing, position 1 of 3.');
    board.cards = [cards[1]!, cards[2]!, cards[0]!];
    await board.updateComplete;
    await flush();
    await press(board, ' ');
    expect(moves).toMatchObject([{ key: 'b', to: 'doing', index: 2, after: 'd', before: null }]);
  });

  it('with sortable off, sends a card whose save failed back where the current order puts it', async () => {
    let fail!: (e: Error) => void;
    const cards = [
      { id: 'b', title: 'Beta', status: 'todo' },
      { id: 'a', title: 'Alpha', status: 'todo' },
      { id: 'c', title: 'Gamma', status: 'todo' },
    ];
    const { board } = await boardWith({ cards, sortable: false, move: () => new Promise((_, reject) => (fail = reject)) });
    const done = board.moveTo('b', 'done');
    board.cards = [cards[2]!, cards[0]!, cards[1]!];
    await board.updateComplete;
    fail(new Error('conflict'));
    expect(await done).toBe(false);
    expect(columns(board).todo).toEqual(['c', 'b', 'a']);
  });

  it('turning sortable off puts each column back in the given order, keeping every card in its column', async () => {
    const { board } = await boardWith();
    expect(await board.moveTo('b', 'todo', 0)).toBe(true);
    expect(await board.moveTo('c', 'done')).toBe(true);
    expect(columns(board)).toEqual({ todo: ['b', 'a'], doing: [], done: ['c'] });
    board.sortable = false;
    await board.updateComplete;
    expect(columns(board)).toEqual({ todo: ['a', 'b'], doing: [], done: ['c'] });
    expect(await board.moveTo('c', 'todo')).toBe(true);
    expect(columns(board).todo).toEqual(['a', 'b', 'c']);
  });

  it('reads sortable="false" from the attribute, and any other value as on', async () => {
    const { board } = await boardWith();
    board.setAttribute('sortable', 'false');
    expect(board.sortable).toBe(false);
    board.setAttribute('sortable', '');
    expect(board.sortable).toBe(true);
  });
});
