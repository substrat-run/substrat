/**
 * `<sub-kanban>` — cards in columns, moved from one column (a state) to another by drag or
 * by keyboard.
 *
 * A renderer over `kanban-model.ts`: the model decides where a card lands and which columns
 * take it, and this draws it and reads the pointer. Styled only through Web Awesome's
 * `--wa-*` tokens, so it follows whatever theme the page sets.
 *
 * Properties (objects and functions, so not attributes):
 *   `columns`  — `KanbanColumn[]`, left to right: `{ key, label, limit?, strict?, colour? }`.
 *                `limit` is a WIP limit, shown as "3 / 4" and warned at and over; `strict`
 *                refuses a card that would take the column over it; `colour` (any CSS colour)
 *                is drawn as a dot before the label and set as `--sub-kanban-column-accent`
 *   `cards`    — the cards, in the order each column shows them
 *   `keyOf`    — a card's unique key (default `card.id`)
 *   `columnOf` — the column a card is in (default `card.status`)
 *   `labelOf`  — a card's name, drawn by default and spoken when it moves (default `card.title`,
 *                then `card.name`, then the key)
 *   `renderCard(card)` — draw a card's content yourself, in the shadow root (Lit or a string)
 *   `mount(el, card)`  — or into a light-DOM element, for React or Vue; may return
 *                `{ update(card), unmount() }`, as a table cell does
 *   `canDrag(card)`    — which cards may move at all (default every one)
 *   `canDrop(card, from, to)` — which columns take a card: the lifecycle's transitions. A
 *                column that does not is dimmed while the card is held, and says so when the
 *                card is over it. A reorder within a column is never refused.
 *   `move(move)` — persist a move. The board shows it at once; while the promise is pending
 *                the card is marked `pending`, and if it rejects the card goes back and
 *                `sub-move-failed` fires. Absent, a move is only reported.
 *   `labels`   — `Partial<KanbanLabels>`: any of the words the board shows or says, in place of
 *                the registered language's or English (`KANBAN_LABELS`). See "Words" below.
 * Attributes: `label` (the board's accessible name; default the `board` word), `addable` (an
 *   "Add a card" button under each column: it opens a field for the title, Enter adds and keeps
 *   the field open for the next, Escape or leaving it empty closes it), `sortable` (on by
 *   default; `sortable="false"`, or the property `false`, for a board that keeps no order
 *   within a column — see below).
 * Function: `registerKanbanLabels(code, labels)` — the board's words for a language.
 * Events:
 *   `sub-card-move`  `KanbanMove` — as a card is dropped somewhere new; `preventDefault()`
 *     sends it back. `after` / `before` are its new neighbours, for a rank between them.
 *   `sub-move-failed` `{ move, error }` — `move` rejected; the card is back where it was.
 *   `sub-card-open`  `{ card }` — a click on a card that did not drag, or Enter on it.
 *   `sub-card-add`   `{ column, title }` — a title entered under `addable`. The screen makes
 *     the card and hands it back in `cards`; the board does not invent one.
 * Method: `moveTo(key, column, index?)` — the same move without a drag, for a "Move to…" menu
 *   or a command palette; resolves whether it moved.
 *
 * The board shows the cards it was given and the moves made on it since. Setting `cards`
 * again (a re-read) starts from that; the screen does not have to echo a move back.
 *
 * ## Moving a card
 *
 * Pointer: press and drag. The card lifts out of the column — tilted, raised, swaying a
 * little with the pointer's speed — and a gap the size of the card opens where it would
 * land, the cards around it sliding aside. A mouse starts after a few pixels, so a click is
 * still a click; a finger holds for a moment first (`longPressMs`, 250), so a swipe still
 * scrolls. Near an edge the board and the column scroll. Escape, or a drop where it started,
 * puts it back; it settles into its gap before the move is made.
 *
 * Keyboard: Tab to a card, Space to pick it up; arrows move it (left and right skip columns
 * that do not take it), Home / End to the top or bottom, Space or Enter drops it, Escape puts
 * it back. Unheld, arrows move focus between cards. Every step is announced.
 *
 * With `sortable` off, the board keeps no order within a column (a screen whose columns are a
 * derived value, or which stores order elsewhere). No gap opens in the card's own column, so a
 * drop there is "dropped where it was"; in another, the gap shows where the card will land —
 * among that column's cards by their place in `cards` — rather than following the pointer. Up,
 * Down, Home and End on a held card only say so. `moveTo` ignores its `index`. A move's `index`,
 * `after` and `before` still describe where the card landed.
 *
 * ## Words
 *
 * Every word the board shows or announces resolves as: its own `labels`, then the words
 * registered for its language in Web Awesome's translation registry, then English. Its
 * language is the nearest `lang` up from it, then the page's, then the browser's; it sets that
 * on the Web Awesome components it draws, which would otherwise read only their own or the
 * page's. A page in Swedish imports Web Awesome's `translations/sv.js` for those components and
 * calls `registerKanbanLabels('sv', {…})` for the board's own words.
 *
 * `prefers-reduced-motion` turns the tilt, the sliding and the settle off; the gap still opens.
 *
 * ## Styling, outside in
 *
 * The theme's `--wa-*` tokens; then `--sub-kanban-column-width` (18rem, where each column
 * starts), `--sub-kanban-column-grow` (0; 1 shares the room left over, so a few columns fill a
 * wide board), `--sub-kanban-tilt` (3deg, the lifted card's resting angle), `--sub-kanban-gap`,
 * `--sub-kanban-card-padding`, and `--sub-kanban-column-accent` (set per column from `colour`;
 * read it in `::part(header)` to draw the colour another way). A card is drawn with
 * `<wa-card>`'s surface tokens, so it matches the panels around it; then `::part()` — `board`,
 * `column` (plus `refused`, `over`), `header`, `accent`, `count`, `list`, `card` (plus `pending`,
 * `lifted`), `gap`, `ghost`, `add`, `composer`. The board fills its host's height when the host has
 * one, and each column then scrolls on its own.
 */
import '@awesome.me/webawesome/dist/components/button/button.js';
import { css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { LabelsController, registerLabels } from './internal/labels.js';
import { langOf } from './internal/lang.js';
import SubstratElement from './internal/substrat-element.js';
import {
  boardOf,
  indexAt,
  loadOf,
  moveCard,
  moveOf,
  placeOf,
  refusalOf,
  spotOf,
  stepFrom,
  without,
  type Board,
  type KanbanColumn,
  type KanbanMove,
  type Refusal,
  type Spot,
  type Step,
} from './kanban-model.js';

/**
 * Every word the board shows or says. A word that carries a value is a function, so plurals
 * and word order work in any language. `card` and `column` arguments are already names (a
 * card's `labelOf`, a column's `label`); `position` counts from 1.
 */
export interface KanbanLabels {
  /** The board's accessible name, when `label` is not set. */
  board: string;
  /** How to move a card by keyboard, read with every movable card. */
  instructions: string;
  /** `aria-roledescription` of a card that moves, and of one that does not. */
  movableCard: string;
  card: string;
  /** The count's accessible name, e.g. "3 cards, limit 4". */
  count(count: number, limit: number | undefined): string;
  /** Shown over a column, while a card is held above it, that is full or does not take it. */
  full(column: string): string;
  cantMove(column: string): string;
  addCard: string;
  newCardTitle(column: string): string;
  titlePlaceholder: string;
  submitCard: string;
  cancel: string;
  /** Announced: where a held card would land, e.g. "Done, position 2 of 3." */
  position(column: string, position: number, total: number): string;
  /** Announced on pick-up. `where` is `position(…)`; `keyboard` asks for the keys too. */
  pickedUp(card: string, where: string, keyboard: boolean): string;
  doesNotTake(column: string): string;
  noColumnThatWay: string;
  endOfColumn: string;
  /** Up or Down on a held card when `sortable` is off. */
  noOrder: string;
  cannotMove(card: string): string;
  droppedWhereItWas(card: string): string;
  cancelled(card: string, column: string): string;
  refused(card: string, column: string): string;
  moved(card: string, column: string, position: number, total: number): string;
  moveFailed(card: string, column: string): string;
  added(title: string, column: string): string;
}

const KEYS_HELP = 'Arrow keys move it, Space drops it, Escape cancels.';

/** The board's English words: the last fallback, and a start for a translation. */
export const KANBAN_LABELS: Readonly<KanbanLabels> = {
  board: 'Board',
  instructions: `Press Space to pick up the card. ${KEYS_HELP}`,
  movableCard: 'movable card',
  card: 'card',
  count: (count, limit) => `${count} ${count === 1 ? 'card' : 'cards'}${limit === undefined ? '' : `, limit ${limit}`}`,
  full: (column) => `${column} is full`,
  cantMove: (column) => `Can't move to ${column}`,
  addCard: 'Add a card',
  newCardTitle: (column) => `Title of a new card in ${column}`,
  titlePlaceholder: 'Enter a title…',
  submitCard: 'Add card',
  cancel: 'Cancel',
  position: (column, position, total) => `${column}, position ${position} of ${total}.`,
  pickedUp: (card, where, keyboard) => `Picked up ${card}. ${where}${keyboard ? ` ${KEYS_HELP}` : ''}`,
  doesNotTake: (column) => `${column} does not take this card.`,
  noColumnThatWay: 'No column that takes this card that way.',
  endOfColumn: 'Already at the end of the column.',
  noOrder: 'This board keeps no order within a column.',
  cannotMove: (card) => `${card} cannot be moved.`,
  droppedWhereItWas: (card) => `${card} dropped where it was.`,
  cancelled: (card, column) => `Move cancelled. ${card} is back in ${column}.`,
  refused: (card, column) => `${card} could not move there; it is back in ${column}.`,
  moved: (card, column, position, total) => `Moved ${card} to ${column}, position ${position} of ${total}.`,
  moveFailed: (card, column) => `${card} could not be moved; it is back in ${column}.`,
  added: (title, column) => `Added ${title} to ${column}.`,
};

const PREFIX = 'sub-kanban';

/**
 * Register the board's words for a language (`'sv'`, or a region such as `'sv-FI'`) in Web
 * Awesome's translation registry, beside its own components' words. Every board whose language
 * is that one uses them, unless the board's own `labels` says otherwise. Call it again to add
 * or replace words; the ones not given keep falling back to English.
 */
export function registerKanbanLabels(code: string, labels: Partial<KanbanLabels>): void {
  registerLabels(PREFIX, code, labels);
}

registerKanbanLabels('en', KANBAN_LABELS);

/** What `mount` may hand back, so the board can keep a framework's card up to date. */
export interface CardHandle<T> {
  update?(card: T): void;
  unmount?(): void;
}

/** Controls inside a card keep their own pointer and keys: a press on one never drags. */
const OWN_CONTROL = 'a,button,input,select,textarea,label,summary,[role="button"],wa-button,wa-checkbox,wa-dropdown,wa-input,wa-select';

/** How far a mouse moves before a press is a drag rather than a click, in pixels. */
const DRAG_DISTANCE = 5;
/** How far a finger may wander during the long press before it is a scroll instead. */
const TOUCH_SLOP = 8;
/** How close to an edge the pointer scrolls, and the fastest it scrolls, per frame. */
const EDGE = 64;
const SCROLL_SPEED = 18;

const KEY_STEPS: Record<string, Step> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'top', End: 'bottom' };

/** Drawn here rather than by `<wa-icon>`, whose default library fetches from Font Awesome's CDN. */
const PLUS = svg`<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />`;

const slotOf = (key: string) => `card-${key}`.replace(/[^\w-]/g, '_');

/** A card in the air. `at` is where it would land; `over` the column under it, taking it or not. */
interface Drag<T> {
  key: string;
  card: T;
  from: Spot;
  at: Spot;
  over: string | null;
  mode: 'pointer' | 'keyboard';
  width: number;
  height: number;
}

/** The pointer's side of a drag: where it is, where the card was gripped, and how it sways. */
interface Motion {
  id: number;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  velocity: number;
  tilt: number;
  scale: number;
  frame: number;
  /** `--sub-kanban-tilt`, read once when the card lifts. */
  rest: number;
}

/** A press that may become a drag. */
interface Press {
  id: number;
  key: string;
  card: HTMLElement;
  x: number;
  y: number;
  touch: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class SubKanban<T = any> extends SubstratElement {
  static properties = {
    columns: { attribute: false },
    cards: { attribute: false },
    keyOf: { attribute: false },
    columnOf: { attribute: false },
    labelOf: { attribute: false },
    renderCard: { attribute: false },
    mount: { attribute: false },
    canDrag: { attribute: false },
    canDrop: { attribute: false },
    move: { attribute: false },
    longPressMs: { attribute: false },
    labels: { attribute: false },
    label: {},
    addable: { type: Boolean, reflect: true },
    // On unless the attribute says `sortable="false"`: a plain boolean attribute cannot default to true.
    sortable: { converter: { fromAttribute: (value: string | null) => value !== 'false' } },
  };

  declare columns: KanbanColumn[];
  declare cards: T[];
  declare keyOf: (card: T) => string;
  declare columnOf: (card: T) => string;
  declare labelOf: (card: T) => string;
  declare renderCard?: (card: T) => TemplateResult | string;
  declare mount?: (el: HTMLElement, card: T) => CardHandle<T> | void;
  declare canDrag?: (card: T) => boolean;
  declare canDrop?: (card: T, from: string, to: string) => boolean;
  declare move?: (move: KanbanMove<T>) => unknown;
  declare longPressMs: number;
  declare labels: Partial<KanbanLabels> | undefined;
  declare label: string;
  declare addable: boolean;
  declare sortable: boolean;

  #board: Board = new Map();
  #byKey = new Map<string, T>();
  /** Each card's index in `cards`: where it lands in a column when `sortable` is off. */
  #rank = new Map<string, number>();
  #translations = new LabelsController<KanbanLabels>(this, PREFIX, KANBAN_LABELS);
  #drag: Drag<T> | null = null;
  #motion: Motion | null = null;
  #press: Press | null = null;
  /** Between a release and the move: the card is flying into its gap, and takes no input. */
  #settling = false;
  /** Moves still saving, by card key — laid over a new `cards` until they settle. */
  #pending = new Map<string, KanbanMove<T>>();
  #said = '';
  /** The card to give focus back to once it is drawn again in another column. */
  #focusKey: string | null = null;
  /** Every card's place before this render, for sliding it from there to its new one. */
  #before = new Map<string, DOMRect>();
  #mounted = new Map<string, { el: HTMLElement; card: T; handle: CardHandle<T> | void }>();
  #ghostClone: HTMLElement | null = null;
  #flashKey: string | null = null;
  /** The column whose "Add a card" field is open. */
  #adding: string | null = null;
  /** What the cards' places were last drawn from; a render that changes neither slides nothing. */
  #drawnBoard: Board | null = null;
  #drawnAt = '';

  constructor() {
    super();
    this.columns = [];
    this.cards = [];
    this.keyOf = (card) => String((card as { id?: unknown }).id);
    this.columnOf = (card) => String((card as { status?: unknown }).status);
    this.labelOf = (card) => {
      const c = card as { title?: unknown; name?: unknown };
      return String(c.title ?? c.name ?? this.keyOf(card));
    };
    this.longPressMs = 250;
    this.labels = undefined;
    this.label = '';
    this.addable = false;
    this.sortable = true;
  }

  /**
   * The board's language: the nearest `lang` up from it, then the page's, then the browser's
   * (as Web Awesome's own components fall back). Set on the Web Awesome components it draws,
   * which read only their own `lang` or the page's, so the two never disagree.
   */
  get #lang(): string {
    return langOf(this) ?? (typeof navigator === 'undefined' ? 'en' : navigator.language);
  }

  get #words(): KanbanLabels {
    return this.#translations.resolve(this.#lang, this.labels);
  }

  /** The board as drawn: each column's card keys, with the moves made since `cards` was set. */
  get board(): Board {
    return this.#board;
  }

  /**
   * Move a card without a drag — behind a "Move to…" menu or a command palette. The same
   * path a drop takes: the column must take the card, `sub-card-move` may refuse it, and
   * `move` persists it. `index` defaults to the end of the column; with `sortable` off it is
   * ignored, and the card lands where the column's order puts it. Resolves whether it moved.
   */
  async moveTo(key: string, column: string, index?: number): Promise<boolean> {
    const card = this.#byKey.get(key);
    const from = spotOf(this.#board, key);
    const target = this.columns.find((c) => c.key === column);
    if (card === undefined || !from || !target || this.#drag || this.#settling) return false;
    const allowed = !this.canDrop || this.canDrop(card, from.column, column);
    if (refusalOf(this.#board, target, key, from.column, allowed)) return false;
    const to = this.sortable ? { column, index: index ?? without(this.#board, column, key).length } : placeOf(this.#board, key, column, this.#rank);
    const move = moveOf(this.#board, card, key, to);
    if (!move || !this.#emit('sub-card-move', move, true)) return false;
    return this.#commit(move);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#endPress();
    this.#stopPointer();
    this.#drag = null;
    this.#settling = false;
    for (const key of [...this.#mounted.keys()]) this.#unmount(key);
  }

  protected willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    if (changed.has('cards') || changed.has('columns') || changed.has('keyOf') || changed.has('columnOf')) {
      this.#board = boardOf(this.cards, this.columns, this.keyOf, this.columnOf);
      this.#rank = new Map(this.cards.map((c, i) => [this.keyOf(c), i]));
      // With no order in a column, a move still saving lands where the new cards' order puts it.
      for (const m of this.#pending.values()) {
        this.#board = moveCard(this.#board, m.key, this.sortable ? { column: m.to, index: m.index } : placeOf(this.#board, m.key, m.to, this.#rank));
      }
      this.#byKey = new Map(this.cards.map((c) => [this.keyOf(c), c]));
      const drag = this.#drag;
      if (drag && !this.#byKey.has(drag.key)) this.#abandon();
      else if (drag && !this.sortable) {
        // A held card's place follows the order, and the order just changed: place it again.
        const from = spotOf(this.#board, drag.key);
        if (from) this.#drag = { ...drag, from, at: drag.at.column === from.column ? from : placeOf(this.#board, drag.key, drag.at.column, this.#rank) };
      }
    } else if (changed.has('sortable') && !this.sortable) {
      // Turned off: an order made while it was on is not the given one, and a card landing by
      // `placeOf` would be placed among it. Each column takes the given order; every card stays
      // in its column, moves already saved included, which a rebuild from `cards` would drop.
      const rank = (key: string) => this.#rank.get(key) ?? Number.MAX_SAFE_INTEGER;
      this.#board = new Map([...this.#board].map(([column, keys]) => [column, [...keys].sort((x, y) => rank(x) - rank(y))]));
    }
    this.#measure();
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    this.#slide();
    this.#flash();
    if (this.mount) this.#syncMounts();
    if (this.#focusKey) {
      const card = this.#cardEl(this.#focusKey);
      if (card && this.shadowRoot!.activeElement !== card) card.focus({ preventScroll: false });
      if (!this.#drag) this.#focusKey = null;
    }
  }

  static css = css`
    :host {
      --sub-kanban-column-width: 18rem;
      --sub-kanban-column-grow: 0;
      --sub-kanban-tilt: 3deg;
      --sub-kanban-gap: var(--wa-space-m);
      display: block;
      font-family: var(--wa-font-family-body);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-normal);
      min-width: 0;
    }
    .board {
      display: flex;
      align-items: flex-start;
      gap: var(--sub-kanban-gap);
      height: 100%;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      padding-block-end: var(--wa-space-xs);
    }
    :host([dragging]) .board {
      cursor: grabbing;
    }
    .column {
      position: relative;
      /* A width each column starts at; a grow above 0 shares out the room left over, so a few
         columns fill a wide board. */
      flex: var(--sub-kanban-column-grow) 0 var(--sub-kanban-column-width);
      display: flex;
      flex-direction: column;
      max-height: 100%;
      min-width: 0;
      background: var(--wa-color-surface-lowered);
      border-radius: var(--wa-border-radius-l);
      transition:
        opacity var(--wa-transition-fast) var(--wa-transition-easing),
        box-shadow var(--wa-transition-fast) var(--wa-transition-easing);
    }
    .column.over {
      box-shadow: inset 0 0 0 var(--wa-border-width-m, 2px) var(--wa-color-brand-border-normal);
    }
    .column.refused:not(.over) {
      opacity: 0.5;
    }
    .column.refused.over {
      box-shadow: none;
    }
    .column.refused.over > :not(.refusal) {
      opacity: 0.35;
    }
    .refusal {
      position: absolute;
      inset: 3rem var(--wa-space-s) var(--wa-space-s);
      display: grid;
      place-items: center;
      padding: var(--wa-space-m);
      border: var(--wa-border-width-m, 2px) dashed var(--wa-color-danger-border-normal);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-danger-fill-quiet);
      color: var(--wa-color-danger-on-quiet);
      font-weight: var(--wa-font-weight-semibold);
      text-align: center;
      pointer-events: none;
      z-index: 1;
    }
    header {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
      padding: var(--wa-space-s) var(--wa-space-m);
      font-weight: var(--wa-font-weight-semibold);
    }
    .accent {
      flex: none;
      width: 0.625rem;
      height: 0.625rem;
      border-radius: 50%;
      background: var(--sub-kanban-column-accent);
    }
    header h3 {
      margin: 0;
      font: inherit;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .count {
      margin-inline-start: auto;
      padding: 0 var(--wa-space-xs);
      border-radius: var(--wa-border-radius-pill);
      color: var(--wa-color-text-quiet);
      font-weight: var(--wa-font-weight-normal);
      font-variant-numeric: tabular-nums;
    }
    .count[data-load='at'] {
      background: var(--wa-color-warning-fill-quiet);
      color: var(--wa-color-warning-on-quiet);
    }
    .count[data-load='over'] {
      background: var(--wa-color-danger-fill-quiet);
      color: var(--wa-color-danger-on-quiet);
      font-weight: var(--wa-font-weight-semibold);
    }
    .list {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
      min-height: 2.75rem;
      margin: 0;
      padding: 0 var(--wa-space-s) var(--wa-space-s);
      list-style: none;
      overflow-y: auto;
      overscroll-behavior-y: contain;
    }
    /* The surface is <wa-card>'s, token for token, so a theme that restyles panels restyles
       these too — without a <wa-card> (a shadow root and slot watchers) per card. */
    .card {
      position: relative;
      padding: var(--sub-kanban-card-padding, var(--wa-space-s) var(--wa-space-m));
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      border: var(--wa-panel-border-width) var(--wa-panel-border-style) var(--wa-color-surface-border);
      border-radius: var(--wa-panel-border-radius);
      box-shadow: var(--wa-shadow-s);
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      touch-action: manipulation;
      overflow-wrap: anywhere;
      transition:
        box-shadow var(--wa-transition-fast) var(--wa-transition-easing),
        border-color var(--wa-transition-fast) var(--wa-transition-easing),
        transform var(--wa-transition-fast) var(--wa-transition-easing);
    }
    .card:hover {
      border-color: var(--wa-color-neutral-border-normal);
    }
    .card:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    .card.fixed {
      cursor: default;
    }
    .card.pending {
      opacity: 0.65;
    }
    .card.lifted {
      transform: rotate(var(--sub-kanban-tilt)) scale(1.02);
      box-shadow: var(--wa-shadow-l);
      z-index: 2;
    }
    .gap {
      flex: none;
      border-radius: var(--wa-panel-border-radius);
      background: var(--wa-color-neutral-fill-quiet);
    }
    .ghost {
      position: fixed;
      inset: auto;
      top: 0;
      left: 0;
      margin: 0;
      overflow: visible;
      color: inherit;
      font: inherit;
      box-shadow: var(--wa-shadow-l);
      cursor: grabbing;
      pointer-events: none;
      will-change: transform;
      z-index: 1000;
      /* It moves every frame by hand; a transition (the card's own, on transform) would lag
         it behind the pointer, and animate it in from wherever it was first drawn. */
      transition: none;
    }
    .add {
      margin: 0 var(--wa-space-s) var(--wa-space-s);
    }
    .composer {
      display: grid;
      gap: var(--wa-space-xs);
      padding: 0 var(--wa-space-s) var(--wa-space-s);
    }
    .compose {
      display: block;
      width: 100%;
      resize: none;
      cursor: text;
      font: inherit;
      user-select: text;
      -webkit-user-select: text;
    }
    .compose:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    .compose::placeholder {
      color: var(--wa-color-text-quiet);
    }
    .composer-actions {
      display: flex;
      gap: var(--wa-space-xs);
    }
    .plus {
      width: 1em;
      height: 1em;
    }
    .add::part(base) {
      justify-content: flex-start;
    }
    .vh {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .card,
      .column {
        transition: none;
      }
      .card.lifted {
        transform: none;
      }
    }
  `;

  render() {
    const drag = this.#drag;
    const words = this.#words;
    const lang = this.#lang;
    return html`<div class="board" part="board" role="group" aria-label=${this.label || words.board}>
        ${repeat(this.columns, (c) => c.key, (c) => this.#column(c, drag, words, lang))}
      </div>
      ${drag?.mode === 'pointer' ? this.#ghost(drag) : nothing}
      <p class="vh" id="how">${words.instructions}</p>
      <div class="vh" role="status" aria-live="assertive" aria-atomic="true">${this.#said}</div>`;
  }

  #column(column: KanbanColumn, drag: Drag<T> | null, words: KanbanLabels, lang: string) {
    const keys = this.#board.get(column.key) ?? [];
    // While a card is held, it counts where it would land, so a limit warns before the drop.
    const leaving = drag && drag.from.column === column.key && drag.at.column !== column.key ? 1 : 0;
    const arriving = drag && drag.from.column !== column.key && drag.at.column === column.key ? 1 : 0;
    const count = keys.length - leaving + arriving;
    const refusal = drag ? this.#refusal(drag, column) : null;
    const over = drag?.over === column.key;
    const load = loadOf(count, column.limit);
    const shown = drag ? this.#keysWhileDragging(column.key, drag) : keys.map((key) => ({ key, gap: false }));
    const headId = `col-${column.key}`.replace(/[^\w-]/g, '_');
    return html`<section
      class="column ${refusal ? 'refused' : ''} ${over ? 'over' : ''}"
      part="column${refusal ? ' refused' : ''}${over && !refusal ? ' over' : ''}"
      data-column=${column.key}
      aria-labelledby=${headId}
      style=${styleMap({ '--sub-kanban-column-accent': column.colour })}
    >
      <header part="header">
        ${column.colour ? html`<span class="accent" part="accent" aria-hidden="true"></span>` : nothing}
        <h3 id=${headId}>${column.label}</h3>
        <span class="count" part="count" data-load=${load} aria-label=${words.count(count, column.limit)}
          >${column.limit === undefined ? count : `${count} / ${column.limit}`}</span
        >
      </header>
      <ul class="list" part="list" aria-labelledby=${headId}>
        ${repeat(
          shown,
          (s) => (s.gap ? '\u0000gap' : s.key),
          (s) => (s.gap ? this.#gapOrLifted(drag!, words) : this.#card(s.key, words)),
        )}
      </ul>
      ${over && refusal ? html`<div class="refusal" aria-hidden="true">${refusal === 'full' ? words.full(column.label) : words.cantMove(column.label)}</div>` : nothing}
      ${this.addable ? this.#adder(column, words, lang) : nothing}
    </section>`;
  }

  /** "Add a card", or the field it opens: type a title, Enter adds it and keeps the field open. */
  #adder(column: KanbanColumn, words: KanbanLabels, lang: string) {
    if (this.#adding !== column.key) {
      return html`<wa-button class="add" part="add" appearance="plain" size="s" lang=${lang} @click=${() => this.#openAdder(column.key)}>
        <svg slot="start" class="plus" viewBox="0 0 16 16" aria-hidden="true">${PLUS}</svg>${words.addCard}
      </wa-button>`;
    }
    return html`<div class="composer" part="composer" @focusout=${this.#onComposerBlur}>
      <textarea
        class="card compose"
        rows="2"
        lang=${lang}
        aria-label=${words.newCardTitle(column.label)}
        placeholder=${words.titlePlaceholder}
        @keydown=${(e: KeyboardEvent) => this.#onComposerKey(e, column.key)}
      ></textarea>
      <div class="composer-actions">
        <wa-button variant="brand" size="s" lang=${lang} @click=${() => this.#submitCard(column.key)}>${words.submitCard}</wa-button>
        <wa-button appearance="plain" size="s" lang=${lang} @click=${() => this.#closeAdder()}>${words.cancel}</wa-button>
      </div>
    </div>`;
  }

  #openAdder(column: string) {
    this.#adding = column;
    this.requestUpdate();
    void this.updateComplete.then(() => this.#composer()?.focus());
  }

  #closeAdder() {
    const column = this.#adding;
    this.#adding = null;
    this.requestUpdate();
    if (column) {
      void this.updateComplete.then(() =>
        this.shadowRoot!.querySelector<HTMLElement>(`.column[data-column="${CSS.escape(column)}"] .add`)?.focus(),
      );
    }
  }

  #onComposerKey(e: KeyboardEvent, column: string) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.#submitCard(column);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.#closeAdder();
    }
  }

  /** Leaving an empty field closes it, as clicking anywhere else on Trello does; a typed title stays. */
  #onComposerBlur = (e: FocusEvent) => {
    const composer = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && composer.contains(e.relatedTarget)) return;
    if (!this.#composer()?.value.trim()) {
      this.#adding = null;
      this.requestUpdate();
    }
  };

  /** The screen makes the card: `sub-card-add` carries the title, and the new card arrives in `cards`. */
  #submitCard(column: string) {
    const field = this.#composer();
    const title = field?.value.trim() ?? '';
    if (!field || !title) return field?.focus();
    this.#emit('sub-card-add', { column, title });
    this.#say(this.#words.added(title, this.#columnLabel(column)));
    field.value = '';
    field.focus();
    // The new card lands at the end of the list, above the field: keep both in view.
    void this.updateComplete.then(() => {
      const list = this.shadowRoot!.querySelector<HTMLElement>(`.column[data-column="${CSS.escape(column)}"] .list`);
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  #composer() {
    return this.shadowRoot?.querySelector<HTMLTextAreaElement>('.compose') ?? null;
  }

  /** A column's entries while a card is held: the others, with the gap (or the held card) at `at`. */
  #keysWhileDragging(column: string, drag: Drag<T>) {
    const rest = without(this.#board, column, drag.key).map((key) => ({ key, gap: false }));
    if (drag.at.column === column) rest.splice(Math.min(drag.at.index, rest.length), 0, { key: drag.key, gap: true });
    return rest;
  }

  #gapOrLifted(drag: Drag<T>, words: KanbanLabels) {
    if (drag.mode === 'keyboard') return this.#card(drag.key, words, true);
    return html`<li class="gap" part="gap" data-key=${drag.key} aria-hidden="true" style="height: ${drag.height}px"></li>`;
  }

  #card(key: string, words: KanbanLabels, lifted = false) {
    const card = this.#byKey.get(key);
    if (card === undefined) return nothing;
    const movable = !this.canDrag || this.canDrag(card);
    const pending = this.#pending.has(key);
    return html`<li
      class="card ${movable ? '' : 'fixed'} ${pending ? 'pending' : ''} ${lifted ? 'lifted' : ''}"
      part="card${pending ? ' pending' : ''}${lifted ? ' lifted' : ''}"
      data-key=${key}
      tabindex="0"
      aria-roledescription=${movable ? words.movableCard : words.card}
      aria-describedby=${movable ? 'how' : nothing}
      aria-busy=${pending ? 'true' : nothing}
      @pointerdown=${(e: PointerEvent) => this.#onPointerDown(e, key)}
      @click=${(e: MouseEvent) => this.#onClick(e, key)}
      @keydown=${(e: KeyboardEvent) => this.#onKey(e, key)}
      @contextmenu=${(e: Event) => this.#press?.touch && e.preventDefault()}
    >
      ${this.#content(card, key)}
    </li>`;
  }

  #content(card: T, key: string) {
    if (this.mount) return html`<slot name=${slotOf(key)}></slot>`;
    if (this.renderCard) return this.renderCard(card);
    return this.labelOf(card);
  }

  #ghost(drag: Drag<T>) {
    const content = this.mount ? html`<slot name="ghost"></slot>` : this.renderCard ? this.renderCard(drag.card) : this.labelOf(drag.card);
    // Placed where the card was from its first frame: drawn at 0,0 and moved a frame later,
    // it would be seen jumping in from the corner.
    const m = this.#motion;
    const at = m ? `transform: translate3d(${m.x - m.grabX}px, ${m.y - m.grabY}px, 0); transform-origin: ${m.grabX}px ${m.grabY}px;` : '';
    return html`<div class="card ghost" part="card ghost" popover="manual" aria-hidden="true" style="width: ${drag.width}px; height: ${drag.height}px; ${at}">${content}</div>`;
  }

  #refusal(drag: Drag<T>, column: KanbanColumn): Refusal | null {
    const allowed = !this.canDrop || this.canDrop(drag.card, drag.from.column, column.key);
    return refusalOf(this.#board, column, drag.key, drag.from.column, allowed);
  }

  #takes(drag: Drag<T>, column: string) {
    const c = this.columns.find((col) => col.key === column);
    return c !== undefined && this.#refusal(drag, c) === null;
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────────────

  #onPointerDown(e: PointerEvent, key: string) {
    if (this.#drag?.mode === 'keyboard') this.#cancel();
    if (e.button !== 0 || this.#drag || this.#settling || this.#onOwnControl(e)) return;
    const card = this.#byKey.get(key);
    if (card === undefined || (this.canDrag && !this.canDrag(card))) return;
    this.#endPress();
    const touch = e.pointerType === 'touch';
    this.#press = { id: e.pointerId, key, card: e.currentTarget as HTMLElement, x: e.clientX, y: e.clientY, touch, timer: null };
    if (touch) this.#press.timer = setTimeout(() => this.#press && this.#lift(this.#press, this.#press.x, this.#press.y), this.longPressMs);
    addEventListener('pointermove', this.#onPointerMove, { passive: true });
    addEventListener('pointerup', this.#onPointerUp);
    addEventListener('pointercancel', this.#onPointerCancel);
    addEventListener('touchmove', this.#onTouchMove, { passive: false });
    addEventListener('keydown', this.#onPointerKey, true);
  }

  #onPointerMove = (e: PointerEvent) => {
    const press = this.#press;
    const motion = this.#motion;
    if (motion && e.pointerId === motion.id) {
      motion.velocity = motion.velocity * 0.7 + (e.clientX - motion.x) * 0.3;
      motion.x = e.clientX;
      motion.y = e.clientY;
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const distance = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (press.touch) {
      // Moved before the hold finished: a scroll, not a drag.
      if (distance > TOUCH_SLOP) this.#endPress();
      return;
    }
    if (distance > DRAG_DISTANCE) this.#lift(press, e.clientX, e.clientY);
  };

  #onPointerUp = (e: PointerEvent) => {
    if (this.#motion && e.pointerId === this.#motion.id) {
      this.#swallowClick();
      void this.#release(false);
      return;
    }
    if (this.#press && e.pointerId === this.#press.id) this.#endPress();
  };

  #onPointerCancel = (e: PointerEvent) => {
    if (this.#motion && e.pointerId === this.#motion.id) void this.#release(true);
    else if (this.#press && e.pointerId === this.#press.id) this.#endPress();
  };

  /** Once a finger is dragging, the page must not scroll under it. */
  #onTouchMove = (e: TouchEvent) => {
    if (this.#motion) e.preventDefault();
  };

  #onPointerKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.#motion) {
      e.preventDefault();
      e.stopPropagation();
      void this.#release(true);
    }
  };

  /** The press became a drag: the card lifts out and the gap opens where it was. */
  #lift(press: Press, x: number, y: number) {
    const card = this.#byKey.get(press.key);
    const from = spotOf(this.#board, press.key);
    if (card === undefined || !from) return this.#endPress();
    const rect = press.card.getBoundingClientRect();
    if (press.timer) clearTimeout(press.timer);
    this.#press = null;
    this.#drag = { key: press.key, card, from, at: from, over: from.column, mode: 'pointer', width: rect.width, height: rect.height };
    this.#motion = { id: press.id, x, y, grabX: press.x - rect.left, grabY: press.y - rect.top, velocity: 0, tilt: 0, scale: 1, frame: 0, rest: reducedMotion() ? 0 : this.#restingTilt() };
    if (this.mount) this.#cloneGhost(press.key);
    this.toggleAttribute('dragging', true);
    this.#say(this.#words.pickedUp(this.labelOf(card), this.#where(from, press.key), false));
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const ghost = this.#ghostEl();
      if (!ghost || !this.#motion) return;
      try {
        ghost.showPopover?.();
      } catch {
        // Not in the document any more, or no top layer: the fixed position still draws it.
      }
      this.#place(ghost, this.#motion);
      this.#motion.frame = requestAnimationFrame(this.#tick);
    });
  }

  /** One frame of a pointer drag: scroll near an edge, find the gap, and move and sway the card. */
  #tick = () => {
    const motion = this.#motion;
    const drag = this.#drag;
    if (!motion || !drag) return;
    this.#autoScroll(motion);
    this.#hitTest(drag, motion);
    const ghost = this.#ghostEl();
    if (ghost) {
      const still = motion.rest === 0;
      const sway = still ? 0 : Math.max(-4, Math.min(4, motion.velocity * 0.35));
      motion.velocity *= 0.85;
      motion.tilt += (motion.rest + sway - motion.tilt) * 0.2;
      motion.scale += ((still ? 1 : 1.03) - motion.scale) * 0.25;
      this.#place(ghost, motion);
    }
    motion.frame = requestAnimationFrame(this.#tick);
  };

  #place(ghost: HTMLElement, m: Motion) {
    ghost.style.transform = `translate3d(${m.x - m.grabX}px, ${m.y - m.grabY}px, 0) rotate(${m.tilt}deg) scale(${m.scale})`;
  }

  #restingTilt() {
    const value = parseFloat(getComputedStyle(this).getPropertyValue('--sub-kanban-tilt'));
    return Number.isFinite(value) ? value : 3;
  }

  /** Which column is under the pointer, and where in it the card would land. */
  #hitTest(drag: Drag<T>, m: Motion) {
    const columns = [...this.shadowRoot!.querySelectorAll<HTMLElement>('.column')];
    const under = columns.find((el) => {
      const r = el.getBoundingClientRect();
      return m.x >= r.left && m.x <= r.right;
    });
    if (!under) return;
    const column = under.dataset['column']!;
    let at: Spot;
    if (!this.#takes(drag, column)) {
      at = drag.from;
    } else if (!this.sortable) {
      // No order to choose: the gap shows where the card will land, wherever the pointer is.
      at = placeOf(this.#board, drag.key, column, this.#rank);
    } else {
      const list = under.querySelector<HTMLElement>('.list')!;
      const top = list.getBoundingClientRect().top - list.scrollTop;
      // Layout positions (offsetTop), not drawn ones: a card mid-slide must not move the target.
      const middles = [...list.querySelectorAll<HTMLElement>(':scope > .card')].map((el) => top + el.offsetTop + el.offsetHeight / 2);
      at = { column, index: indexAt(middles, m.y) };
    }
    if (drag.over === column && drag.at.column === at.column && drag.at.index === at.index) return;
    const moved = drag.at.column !== at.column || drag.at.index !== at.index;
    this.#drag = { ...drag, at, over: column };
    if (moved) this.#say(this.#where(at, drag.key));
    else if (drag.over !== column && !this.#takes(drag, column)) this.#say(this.#words.doesNotTake(this.#columnLabel(column)));
    this.requestUpdate();
  }

  #autoScroll(m: Motion) {
    const board = this.shadowRoot!.querySelector<HTMLElement>('.board');
    if (board) board.scrollLeft += edgeSpeed(m.x, board.getBoundingClientRect().left, board.getBoundingClientRect().right);
    const under = [...this.shadowRoot!.querySelectorAll<HTMLElement>('.list')].find((el) => {
      const r = el.getBoundingClientRect();
      return m.x >= r.left && m.x <= r.right && m.y >= r.top - EDGE && m.y <= r.bottom + EDGE;
    });
    if (under && under.scrollHeight > under.clientHeight) {
      const r = under.getBoundingClientRect();
      under.scrollTop += edgeSpeed(m.y, r.top, r.bottom);
    }
    const page = edgeSpeed(m.y, 0, innerHeight);
    if (page) scrollBy(0, page);
  }

  /** The card flies into its gap — or home, when cancelled — and then the move is made. */
  async #release(cancel: boolean) {
    const drag = this.#drag;
    const motion = this.#motion;
    if (!drag || !motion) return;
    this.#settling = true;
    this.#stopPointer();
    let to = cancel || drag.over === null || !this.#takes(drag, drag.at.column) ? drag.from : drag.at;
    const move = moveOf(this.#board, drag.card, drag.key, to);
    // Carried away and back again: `to` equals `from` by value but is another object.
    if (!move || !this.#emit('sub-card-move', move, true)) to = drag.from;
    if (to !== drag.at) {
      this.#drag = { ...drag, at: to, over: null };
      this.requestUpdate();
      await this.updateComplete;
    }
    const ghost = this.#ghostEl();
    const gap = this.shadowRoot!.querySelector<HTMLElement>('.gap');
    if (ghost && gap && !reducedMotion()) {
      const r = gap.getBoundingClientRect();
      const animation = ghost.animate(
        [{ transform: ghost.style.transform }, { transform: `translate3d(${r.left}px, ${r.top}px, 0) rotate(0deg) scale(1)`, boxShadow: 'var(--wa-shadow-s)' }],
        { duration: 200, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: 'forwards' },
      );
      await animation.finished.catch(() => undefined);
    }
    this.#settling = false;
    this.toggleAttribute('dragging', false);
    this.#dropGhostClone();
    this.#drag = null;
    if (to === drag.from) {
      const words = this.#words;
      const name = this.labelOf(drag.card);
      this.#say(cancel ? words.cancelled(name, this.#columnLabel(drag.from.column)) : words.droppedWhereItWas(name));
      this.requestUpdate();
      return;
    }
    if (move) void this.#commit(move);
  }

  /** A drop that never finishes: the card it carried is gone from `cards`. */
  #abandon() {
    this.#stopPointer();
    this.#dropGhostClone();
    this.toggleAttribute('dragging', false);
    this.#drag = null;
    this.#settling = false;
  }

  #stopPointer() {
    if (this.#motion) cancelAnimationFrame(this.#motion.frame);
    this.#motion = null;
    removeEventListener('pointermove', this.#onPointerMove);
    removeEventListener('pointerup', this.#onPointerUp);
    removeEventListener('pointercancel', this.#onPointerCancel);
    removeEventListener('touchmove', this.#onTouchMove);
    removeEventListener('keydown', this.#onPointerKey, true);
  }

  #endPress() {
    if (this.#press?.timer) clearTimeout(this.#press.timer);
    this.#press = null;
    if (!this.#motion) this.#stopPointer();
  }

  /** The click a browser fires after a drag's pointerup is not a click on the card. */
  #swallowClick() {
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
  }

  #onClick(e: MouseEvent, key: string) {
    if (this.#onOwnControl(e) || this.#drag) return;
    const card = this.#byKey.get(key);
    if (card !== undefined) this.#emit('sub-card-open', { card });
  }

  #onOwnControl(e: Event) {
    for (const node of e.composedPath()) {
      if (node === e.currentTarget) break;
      if (node instanceof Element && node.matches(OWN_CONTROL)) return true;
    }
    return false;
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────────────

  #onKey(e: KeyboardEvent, key: string) {
    if (e.target !== e.currentTarget || this.#settling || this.#motion) return;
    const drag = this.#drag;
    if (drag?.mode === 'keyboard') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        void this.#dropKeyboard(drag);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.#cancel();
      } else if (KEY_STEPS[e.key]) {
        e.preventDefault();
        const step = KEY_STEPS[e.key]!;
        const next = stepFrom(this.#board, this.columns, drag.key, drag.at, step, (c) => this.#takes(drag, c), this.sortable ? undefined : this.#rank);
        if (!next) {
          const words = this.#words;
          return this.#say(step === 'left' || step === 'right' ? words.noColumnThatWay : this.sortable ? words.endOfColumn : words.noOrder);
        }
        this.#drag = { ...drag, at: next, over: next.column };
        this.#focusKey = drag.key;
        this.#say(this.#where(next, drag.key));
        this.requestUpdate();
      }
      return;
    }
    const card = this.#byKey.get(key);
    if (card === undefined) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (this.canDrag && !this.canDrag(card)) return this.#say(this.#words.cannotMove(this.labelOf(card)));
      const from = spotOf(this.#board, key)!;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.#drag = { key, card, from, at: from, over: from.column, mode: 'keyboard', width: rect.width, height: rect.height };
      this.#focusKey = key;
      this.#say(this.#words.pickedUp(this.labelOf(card), this.#where(from, key), true));
      this.requestUpdate();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#emit('sub-card-open', { card });
    } else if (KEY_STEPS[e.key]) {
      e.preventDefault();
      this.#focusNeighbour(key, KEY_STEPS[e.key]!);
    }
  }

  async #dropKeyboard(drag: Drag<T>) {
    const move = moveOf(this.#board, drag.card, drag.key, drag.at);
    this.#drag = null;
    this.#focusKey = drag.key;
    if (!move) {
      this.#say(this.#words.droppedWhereItWas(this.labelOf(drag.card)));
      this.requestUpdate();
      return;
    }
    if (!this.#emit('sub-card-move', move, true)) {
      this.#say(this.#words.refused(this.labelOf(drag.card), this.#columnLabel(drag.from.column)));
      this.requestUpdate();
      return;
    }
    await this.#commit(move);
  }

  #cancel() {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    this.#focusKey = drag.key;
    this.#say(this.#words.cancelled(this.labelOf(drag.card), this.#columnLabel(drag.from.column)));
    this.requestUpdate();
  }

  /** Unheld arrows walk the cards: up and down in a column, left and right to the same row beside it. */
  #focusNeighbour(key: string, step: Step) {
    const at = spotOf(this.#board, key);
    if (!at) return;
    const order = this.columns.map((c) => c.key);
    let target: string | undefined;
    const keys = this.#board.get(at.column) ?? [];
    if (step === 'up') target = keys[at.index - 1];
    else if (step === 'down') target = keys[at.index + 1];
    else if (step === 'top') target = keys[0];
    else if (step === 'bottom') target = keys[keys.length - 1];
    else {
      const by = step === 'left' ? -1 : 1;
      for (let i = order.indexOf(at.column) + by; i >= 0 && i < order.length && target === undefined; i += by) {
        const beside = this.#board.get(order[i]!) ?? [];
        target = beside[Math.min(at.index, beside.length - 1)];
      }
    }
    if (target !== undefined) this.#cardEl(target)?.focus();
  }

  // ── The move ────────────────────────────────────────────────────────────────────────

  /** Show the move, then persist it; if that fails, the card goes back. */
  async #commit(move: KanbanMove<T>): Promise<boolean> {
    this.#board = moveCard(this.#board, move.key, { column: move.to, index: move.index });
    this.#say(this.#words.moved(this.labelOf(move.card), this.#columnLabel(move.to), move.index + 1, (this.#board.get(move.to) ?? []).length));
    this.#flashKey = move.key;
    if (!this.move) {
      this.requestUpdate();
      return true;
    }
    this.#pending.set(move.key, move);
    this.requestUpdate();
    try {
      await this.move(move);
      return true;
    } catch (error) {
      // Back where it was, or with no order in a column, where the order (which may have changed since) puts it.
      const back = this.sortable ? { column: move.from, index: move.fromIndex } : placeOf(this.#board, move.key, move.from, this.#rank);
      this.#board = moveCard(this.#board, move.key, back);
      this.#say(this.#words.moveFailed(this.labelOf(move.card), this.#columnLabel(move.from)));
      this.#emit('sub-move-failed', { move, error });
      return false;
    } finally {
      this.#pending.delete(move.key);
      this.requestUpdate();
    }
  }

  /** The card that just landed glows once, so the eye finds it (Jira does the same). */
  #flash() {
    const key = this.#flashKey;
    this.#flashKey = null;
    if (!key || reducedMotion() || typeof Element.prototype.animate !== 'function') return;
    this.#cardEl(key)?.animate(
      [{ boxShadow: '0 0 0 2px var(--wa-color-brand-border-normal), var(--wa-shadow-s)' }, { boxShadow: 'var(--wa-shadow-s)' }],
      { duration: 700, easing: 'ease-out' },
    );
  }

  // ── Drawing helpers ─────────────────────────────────────────────────────────────────

  /** Before a render: where every card is drawn now, so `#slide` can move it from there. */
  #measure() {
    this.#before.clear();
    const at = this.#drag ? `${this.#drag.key}@${this.#drag.at.column}:${this.#drag.at.index}` : '';
    const moved = this.#board !== this.#drawnBoard || at !== this.#drawnAt;
    this.#drawnBoard = this.#board;
    this.#drawnAt = at;
    if (!moved || !this.hasUpdated || reducedMotion() || typeof Element.prototype.animate !== 'function') return;
    for (const el of this.shadowRoot!.querySelectorAll<HTMLElement>('.list > [data-key]')) {
      this.#before.set(el.dataset['key']!, el.getBoundingClientRect());
    }
  }

  /** After a render: each card that moved slides from where it was (FLIP). */
  #slide() {
    if (this.#before.size === 0) return;
    for (const el of this.shadowRoot!.querySelectorAll<HTMLElement>('.list > [data-key]')) {
      const was = this.#before.get(el.dataset['key']!);
      if (!was) continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      for (const a of el.getAnimations()) if (a.id === 'slide') a.cancel();
      const lifted = el.classList.contains('lifted') ? ' rotate(var(--sub-kanban-tilt)) scale(1.02)' : '';
      const animation = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)${lifted}` }, { transform: `translate(0, 0)${lifted}` }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
      );
      animation.id = 'slide';
    }
    this.#before.clear();
  }

  #where(at: Spot, key: string) {
    const length = without(this.#board, at.column, key).length + 1;
    return this.#words.position(this.#columnLabel(at.column), at.index + 1, length);
  }

  #columnLabel(key: string) {
    return this.columns.find((c) => c.key === key)?.label ?? key;
  }

  #say(text: string) {
    // The same words twice would not be read again; a trailing space makes them new.
    this.#said = this.#said === text ? `${text} ` : text;
    this.requestUpdate();
  }

  #cardEl(key: string) {
    return this.shadowRoot?.querySelector<HTMLElement>(`.list > .card[data-key="${CSS.escape(key)}"]`) ?? null;
  }

  #ghostEl() {
    return this.shadowRoot?.querySelector<HTMLElement>('.ghost') ?? null;
  }

  #emit(type: string, detail: unknown, cancelable = false) {
    return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
  }

  // ── Light-DOM cards (`mount`) ──────────────────────────────────────────────────────

  #syncMounts() {
    const wanted = new Set<string>();
    for (const keys of this.#board.values()) {
      for (const key of keys) {
        const card = this.#byKey.get(key);
        if (card === undefined) continue;
        wanted.add(key);
        const known = this.#mounted.get(key);
        if (known && known.card === card) continue;
        if (known?.handle?.update) {
          known.handle.update(card);
          known.card = card;
          continue;
        }
        if (known) this.#unmount(key);
        const el = document.createElement('div');
        el.slot = slotOf(key);
        this.append(el);
        this.#mounted.set(key, { el, card, handle: this.mount!(el, card) });
      }
    }
    for (const key of [...this.#mounted.keys()]) if (!wanted.has(key)) this.#unmount(key);
  }

  #unmount(key: string) {
    const known = this.#mounted.get(key);
    if (!known) return;
    known.handle?.unmount?.();
    known.el.remove();
    this.#mounted.delete(key);
  }

  /** A mounted card's content, copied for the lifted card: what it drew, frozen for the drag. */
  #cloneGhost(key: string) {
    const source = this.#mounted.get(key)?.el;
    if (!source) return;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.slot = 'ghost';
    this.append(clone);
    this.#ghostClone = clone;
  }

  #dropGhostClone() {
    this.#ghostClone?.remove();
    this.#ghostClone = null;
  }
}

/** How fast to scroll for a pointer at `p` between edges `low` and `high`: faster nearer the edge. */
function edgeSpeed(p: number, low: number, high: number) {
  if (p < low + EDGE) return -Math.ceil(SCROLL_SPEED * Math.min(1, (low + EDGE - p) / EDGE));
  if (p > high - EDGE) return Math.ceil(SCROLL_SPEED * Math.min(1, (p - (high - EDGE)) / EDGE));
  return 0;
}

if (!customElements.get('sub-kanban')) customElements.define('sub-kanban', SubKanban);

declare global {
  interface HTMLElementTagNameMap {
    'sub-kanban': SubKanban;
  }
}
