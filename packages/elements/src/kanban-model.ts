/**
 * What `<sub-kanban>` decides, with no DOM in it: which card sits where, where a moved card
 * lands, which columns take it, and where an arrow key moves it. The element draws this and
 * forwards pointers and keys; a second renderer gets the same answers from the same code.
 *
 * A board is each column's card keys in order. A card being moved stays in its column of the
 * board until the move is made, and a drop position is an index into the target column with
 * that card left out — so "the same place" is the index it started at, in either column.
 */

export interface KanbanColumn {
  key: string;
  label: string;
  /**
   * The most cards the column should hold (a WIP limit). Its header shows the count against
   * it, warning at the limit and over it.
   */
  limit?: number;
  /** Refuse a card that would take the column over `limit`, rather than only warn. */
  strict?: boolean;
}

/** Each column's card keys, in order. Every column has an entry, empty or not. */
export type Board = ReadonlyMap<string, readonly string[]>;

/** Where a card is, or would land: a column, and an index into it without the card. */
export interface Spot {
  column: string;
  index: number;
}

/** A move, as the screen hears of it. `before` / `after` are the neighbours it lands between. */
export interface KanbanMove<T> {
  card: T;
  key: string;
  from: string;
  to: string;
  fromIndex: number;
  index: number;
  /** The card it lands after (above it), or null at the top: for a rank between two neighbours. */
  after: string | null;
  /** The card it lands before (below it), or null at the end. */
  before: string | null;
}

/** Why a column does not take a card: the screen's own rule, or a strict limit. */
export type Refusal = 'refused' | 'full';

/**
 * The board the cards describe, in their given order. A card whose column is not one of
 * `columns` is left off: it has nowhere to be drawn.
 */
export function boardOf<T>(
  cards: readonly T[],
  columns: readonly KanbanColumn[],
  keyOf: (card: T) => string,
  columnOf: (card: T) => string,
): Board {
  const board = new Map<string, string[]>(columns.map((c) => [c.key, []]));
  for (const card of cards) board.get(columnOf(card))?.push(keyOf(card));
  return board;
}

/** Where a card is now, or null if the board does not hold it. */
export function spotOf(board: Board, key: string): Spot | null {
  for (const [column, keys] of board) {
    const index = keys.indexOf(key);
    if (index >= 0) return { column, index };
  }
  return null;
}

/** A column's keys with `key` left out: the list a drop index points into. */
export function without(board: Board, column: string, key: string): readonly string[] {
  return (board.get(column) ?? []).filter((k) => k !== key);
}

/** The board after `key` is moved to `to`. Unchanged (the same object) when it would not move. */
export function moveCard(board: Board, key: string, to: Spot): Board {
  const from = spotOf(board, key);
  if (!from || !board.has(to.column)) return board;
  if (from.column === to.column && from.index === to.index) return board;
  const next = new Map(board);
  next.set(from.column, without(board, from.column, key));
  const target = [...next.get(to.column)!];
  target.splice(Math.max(0, Math.min(to.index, target.length)), 0, key);
  next.set(to.column, target);
  return next;
}

/** The move a drop at `to` makes, or null when the card would land where it started. */
export function moveOf<T>(board: Board, card: T, key: string, to: Spot): KanbanMove<T> | null {
  const from = spotOf(board, key);
  if (!from || (from.column === to.column && from.index === to.index)) return null;
  const rest = without(board, to.column, key);
  const index = Math.max(0, Math.min(to.index, rest.length));
  return { card, key, from: from.column, to: to.column, fromIndex: from.index, index, after: rest[index - 1] ?? null, before: rest[index] ?? null };
}

/**
 * Whether `to` takes the card: its own column always does (a reorder is never refused),
 * then the screen's rule (`allowed`), then a strict limit.
 */
export function refusalOf(board: Board, column: KanbanColumn, key: string, from: string, allowed: boolean): Refusal | null {
  if (column.key === from) return null;
  if (!allowed) return 'refused';
  if (column.strict && column.limit !== undefined && without(board, column.key, key).length >= column.limit) return 'full';
  return null;
}

/** How a column's count reads against its limit: quiet below it, a warning at it, danger over it. */
export function loadOf(count: number, limit: number | undefined): 'under' | 'at' | 'over' {
  if (limit === undefined || count < limit) return 'under';
  return count === limit ? 'at' : 'over';
}

/**
 * Where a pointer at `y` drops among cards whose vertical middles are `middles`, top to
 * bottom: before the first card whose middle is below it. Measured against the list as it
 * is drawn (with the gap open), which is what keeps the gap from flickering between two
 * places — the pointer over the gap answers the gap's own index.
 */
export function indexAt(middles: readonly number[], y: number): number {
  const i = middles.findIndex((m) => y < m);
  return i < 0 ? middles.length : i;
}

export type Step = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Where a lifted card goes on an arrow key. Up and down move within the column, left and
 * right to the nearest column that takes it (skipping the ones that do not), keeping the
 * row where it can. Null when there is nowhere to go, so the key can say so.
 */
export function stepFrom(board: Board, columns: readonly KanbanColumn[], key: string, at: Spot, step: Step, takes: (column: string) => boolean): Spot | null {
  const length = without(board, at.column, key).length;
  if (step === 'up') return at.index > 0 ? { ...at, index: at.index - 1 } : null;
  if (step === 'down') return at.index < length ? { ...at, index: at.index + 1 } : null;
  if (step === 'top') return at.index > 0 ? { ...at, index: 0 } : null;
  if (step === 'bottom') return at.index < length ? { ...at, index: length } : null;
  const order = columns.map((c) => c.key);
  const by = step === 'left' ? -1 : 1;
  for (let i = order.indexOf(at.column) + by; i >= 0 && i < order.length; i += by) {
    const column = order[i]!;
    if (!takes(column)) continue;
    return { column, index: Math.min(at.index, without(board, column, key).length) };
  }
  return null;
}
