import { describe, expect, it } from 'vitest';
import { boardOf, indexAt, loadOf, moveCard, moveOf, refusalOf, stepFrom, type KanbanColumn } from '../src/kanban-model.js';

type Card = { id: string; status: string };

const COLUMNS: KanbanColumn[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing', limit: 2, strict: true },
  { key: 'done', label: 'Done' },
];
const CARDS: Card[] = [
  { id: 'a', status: 'todo' },
  { id: 'b', status: 'todo' },
  { id: 'c', status: 'doing' },
  { id: 'x', status: 'nowhere' },
];
const board = boardOf(CARDS, COLUMNS, (c) => c.id, (c) => c.status);
const lists = (b: typeof board) => Object.fromEntries([...b].map(([k, v]) => [k, [...v]]));

describe('kanban model', () => {
  it('lays cards out by column in their given order, every column present, unknown columns dropped', () => {
    expect(lists(board)).toEqual({ todo: ['a', 'b'], doing: ['c'], done: [] });
  });

  it('moves a card to an index counted without it, and reports its new neighbours', () => {
    expect(lists(moveCard(board, 'a', { column: 'doing', index: 1 }))).toEqual({ todo: ['b'], doing: ['c', 'a'], done: [] });
    expect(lists(moveCard(board, 'a', { column: 'todo', index: 1 }))).toEqual({ todo: ['b', 'a'], doing: ['c'], done: [] });
    expect(moveOf(board, CARDS[0], 'a', { column: 'doing', index: 0 })).toMatchObject({ from: 'todo', to: 'doing', fromIndex: 0, index: 0, after: null, before: 'c' });
  });

  it('treats a drop where the card started as no move', () => {
    expect(moveCard(board, 'b', { column: 'todo', index: 1 })).toBe(board);
    expect(moveOf(board, CARDS[1], 'b', { column: 'todo', index: 1 })).toBeNull();
  });

  it('never refuses a reorder; refuses by the screen rule, then by a strict limit', () => {
    expect(refusalOf(board, COLUMNS[0]!, 'a', 'todo', false)).toBeNull();
    expect(refusalOf(board, COLUMNS[2]!, 'a', 'todo', false)).toBe('refused');
    const full = moveCard(board, 'b', { column: 'doing', index: 0 });
    expect(refusalOf(full, COLUMNS[1]!, 'a', 'todo', true)).toBe('full');
    expect(refusalOf(board, COLUMNS[1]!, 'a', 'todo', true)).toBeNull();
  });

  it('reads a count against its limit', () => {
    expect([loadOf(1, 2), loadOf(2, 2), loadOf(3, 2), loadOf(9, undefined)]).toEqual(['under', 'at', 'over', 'under']);
  });

  it('drops before the first card whose middle is below the pointer', () => {
    expect([indexAt([10, 30, 50], 5), indexAt([10, 30, 50], 31), indexAt([10, 30, 50], 99), indexAt([], 0)]).toEqual([0, 2, 3, 0]);
  });

  it('steps a held card within a column and across, skipping columns that do not take it', () => {
    const takes = (c: string) => c !== 'doing';
    expect(stepFrom(board, COLUMNS, 'b', { column: 'todo', index: 1 }, 'up', takes)).toEqual({ column: 'todo', index: 0 });
    expect(stepFrom(board, COLUMNS, 'b', { column: 'todo', index: 1 }, 'down', takes)).toBeNull();
    expect(stepFrom(board, COLUMNS, 'b', { column: 'todo', index: 1 }, 'right', takes)).toEqual({ column: 'done', index: 0 });
    expect(stepFrom(board, COLUMNS, 'b', { column: 'todo', index: 1 }, 'left', takes)).toBeNull();
  });
});
