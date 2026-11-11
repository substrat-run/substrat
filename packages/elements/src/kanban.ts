/**
 * `<sub-kanban>` — cards in columns, moved from one column (a state) to another by drag or
 * by keyboard.
 *
 * A renderer over `kanban-model.ts`: the model decides where a card lands and which columns
 * take it, and this draws it and reads the pointer. Styled only through Web Awesome's
 * `--wa-*` tokens, so it follows whatever theme the page sets.
 *
 * Properties (objects and functions, so not attributes):
 *   `columns`  — `KanbanColumn[]`, left to right: `{ key, label, limit?, strict? }`. `limit` is
 *                a WIP limit, shown as "3 / 4" and warned at and over; `strict` refuses a card
 *                that would take the column over it
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
 * Attributes: `label` (the board's accessible name), `addable` (an "Add a card" button under
 *   each column: it opens a field for the title, Enter adds and keeps the field open for the
 *   next, Escape or leaving it empty closes it).
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
 * `prefers-reduced-motion` turns the tilt, the sliding and the settle off; the gap still opens.
 *
 * ## Styling, outside in
 *
 * The theme's `--wa-*` tokens; then `--sub-kanban-column-width` (18rem), `--sub-kanban-tilt`
 * (3deg, the lifted card's resting angle), `--sub-kanban-gap`, `--sub-kanban-card-padding`. A card
 * is drawn with `<wa-card>`'s surface tokens, so it matches the panels around it; then `::part()` — `board`,
 * `column` (plus `refused`, `over`), `header`, `count`, `list`, `card` (plus `pending`,
 * `lifted`), `gap`, `ghost`, `add`, `composer`. The board fills its host's height when the host has
 * one, and each column then scrolls on its own.
 */
import '@awesome.me/webawesome/dist/components/button/button.js';
import { css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import SubstratElement from './internal/substrat-element.js';
import {
  boardOf,
  indexAt,
  loadOf,
  moveCard,
  moveOf,
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
    label: {},
    addable: { type: Boolean, reflect: true },
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
  declare label: string;
  declare addable: boolean;

  #board: Board = new Map();
  #byKey = new Map<string, T>();
  #drag: Drag<T> | null = null;
  #motion: Motion | null = null;
  #press: Press | null = null;
  /** Between a release and the move: the card is flying into its gap, and takes no input. */
  #settling = false;
  #pending = new Set<string>();
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
    this.label = 'Board';
    this.addable = false;
  }

  /** The board as drawn: each column's card keys, with the moves made since `cards` was set. */
  get board(): Board {
    return this.#board;
  }

  /**
   * Move a card without a drag — behind a "Move to…" menu or a command palette. The same
   * path a drop takes: the column must take the card, `sub-card-move` may refuse it, and
   * `move` persists it. `index` defaults to the end of the column. Resolves whether it moved.
   */
  async moveTo(key: string, column: string, index?: number): Promise<boolean> {
    const card = this.#byKey.get(key);
    const from = spotOf(this.#board, key);
    const target = this.columns.find((c) => c.key === column);
    if (card === undefined || !from || !target || this.#drag || this.#settling) return false;
    const allowed = !this.canDrop || this.canDrop(card, from.column, column);
    if (refusalOf(this.#board, target, key, from.column, allowed)) return false;
    const move = moveOf(this.#board, card, key, { column, index: index ?? without(this.#board, column, key).length });
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
      this.#byKey = new Map(this.cards.map((c) => [this.keyOf(c), c]));
      const drag = this.#drag;
      if (drag && !this.#byKey.has(drag.key)) this.#abandon();
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
      flex: 0 0 var(--sub-kanban-column-width);
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
    return html`<div class="board" part="board" role="group" aria-label=${this.label}>
        ${repeat(this.columns, (c) => c.key, (c) => this.#column(c, drag))}
      </div>
      ${drag?.mode === 'pointer' ? this.#ghost(drag) : nothing}
      <p class="vh" id="how">Press Space to pick up the card. Arrow keys move it, Space drops it, Escape cancels.</p>
      <div class="vh" role="status" aria-live="assertive" aria-atomic="true">${this.#said}</div>`;
  }

  #column(column: KanbanColumn, drag: Drag<T> | null) {
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
    >
      <header part="header">
        <h3 id=${headId}>${column.label}</h3>
        <span class="count" part="count" data-load=${load} aria-label=${this.#countLabel(count, column)}
          >${column.limit === undefined ? count : `${count} / ${column.limit}`}</span
        >
      </header>
      <ul class="list" part="list" aria-labelledby=${headId}>
        ${repeat(
          shown,
          (s) => (s.gap ? '\u0000gap' : s.key),
          (s) => (s.gap ? this.#gapOrLifted(drag!) : this.#card(s.key)),
        )}
      </ul>
      ${over && refusal ? html`<div class="refusal" aria-hidden="true">${refusal === 'full' ? `${column.label} is full` : `Can't move to ${column.label}`}</div>` : nothing}
      ${this.addable ? this.#adder(column) : nothing}
    </section>`;
  }

  /** "Add a card", or the field it opens: type a title, Enter adds it and keeps the field open. */
  #adder(column: KanbanColumn) {
    if (this.#adding !== column.key) {
      return html`<wa-button class="add" part="add" appearance="plain" size="s" @click=${() => this.#openAdder(column.key)}>
        <svg slot="start" class="plus" viewBox="0 0 16 16" aria-hidden="true">${PLUS}</svg>Add a card
      </wa-button>`;
    }
    return html`<div class="composer" part="composer" @focusout=${this.#onComposerBlur}>
      <textarea
        class="card compose"
        rows="2"
        aria-label=${`Title of a new card in ${column.label}`}
        placeholder="Enter a title…"
        @keydown=${(e: KeyboardEvent) => this.#onComposerKey(e, column.key)}
      ></textarea>
      <div class="composer-actions">
        <wa-button variant="brand" size="s" @click=${() => this.#submitCard(column.key)}>Add card</wa-button>
        <wa-button appearance="plain" size="s" @click=${() => this.#closeAdder()}>Cancel</wa-button>
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
    this.#say(`Added ${title} to ${this.#columnLabel(column)}.`);
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

  #countLabel(count: number, column: KanbanColumn) {
    const cards = `${count} ${count === 1 ? 'card' : 'cards'}`;
    return column.limit === undefined ? cards : `${cards}, limit ${column.limit}`;
  }

  /** A column's entries while a card is held: the others, with the gap (or the held card) at `at`. */
  #keysWhileDragging(column: string, drag: Drag<T>) {
    const rest = without(this.#board, column, drag.key).map((key) => ({ key, gap: false }));
    if (drag.at.column === column) rest.splice(Math.min(drag.at.index, rest.length), 0, { key: drag.key, gap: true });
    return rest;
  }

  #gapOrLifted(drag: Drag<T>) {
    if (drag.mode === 'keyboard') return this.#card(drag.key, true);
    return html`<li class="gap" part="gap" data-key=${drag.key} aria-hidden="true" style="height: ${drag.height}px"></li>`;
  }

  #card(key: string, lifted = false) {
    const card = this.#byKey.get(key);
    if (card === undefined) return nothing;
    const movable = !this.canDrag || this.canDrag(card);
    const pending = this.#pending.has(key);
    return html`<li
      class="card ${movable ? '' : 'fixed'} ${pending ? 'pending' : ''} ${lifted ? 'lifted' : ''}"
      part="card${pending ? ' pending' : ''}${lifted ? ' lifted' : ''}"
      data-key=${key}
      tabindex="0"
      aria-roledescription=${movable ? 'movable card' : 'card'}
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
    this.#say(`Picked up ${this.labelOf(card)}. ${this.#where(from, press.key)}`);
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
    else if (drag.over !== column && !this.#takes(drag, column)) this.#say(`${this.#columnLabel(column)} does not take this card.`);
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
    if (move && !this.#emit('sub-card-move', move, true)) to = drag.from;
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
      this.#say(cancel ? `Move cancelled. ${this.labelOf(drag.card)} is back in ${this.#columnLabel(drag.from.column)}.` : `${this.labelOf(drag.card)} dropped where it was.`);
      this.requestUpdate();
      return;
    }
    void this.#commit(move!);
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
        const next = stepFrom(this.#board, this.columns, drag.key, drag.at, KEY_STEPS[e.key]!, (c) => this.#takes(drag, c));
        if (!next) return this.#say(e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? 'No column that takes this card that way.' : 'Already at the end of the column.');
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
      if (this.canDrag && !this.canDrag(card)) return this.#say(`${this.labelOf(card)} cannot be moved.`);
      const from = spotOf(this.#board, key)!;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.#drag = { key, card, from, at: from, over: from.column, mode: 'keyboard', width: rect.width, height: rect.height };
      this.#focusKey = key;
      this.#say(`Picked up ${this.labelOf(card)}. ${this.#where(from, key)} Arrow keys move it, Space drops it, Escape cancels.`);
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
      this.#say(`${this.labelOf(drag.card)} dropped where it was.`);
      this.requestUpdate();
      return;
    }
    if (!this.#emit('sub-card-move', move, true)) {
      this.#say(`${this.labelOf(drag.card)} could not move there; it is back in ${this.#columnLabel(drag.from.column)}.`);
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
    this.#say(`Move cancelled. ${this.labelOf(drag.card)} is back in ${this.#columnLabel(drag.from.column)}.`);
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
    this.#say(`Moved ${this.labelOf(move.card)} to ${this.#columnLabel(move.to)}, position ${move.index + 1} of ${(this.#board.get(move.to) ?? []).length}.`);
    this.#flashKey = move.key;
    if (!this.move) {
      this.requestUpdate();
      return true;
    }
    this.#pending.add(move.key);
    this.requestUpdate();
    try {
      await this.move(move);
      return true;
    } catch (error) {
      this.#board = moveCard(this.#board, move.key, { column: move.from, index: move.fromIndex });
      this.#say(`${this.labelOf(move.card)} could not be moved; it is back in ${this.#columnLabel(move.from)}.`);
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
    return `${this.#columnLabel(at.column)}, position ${at.index + 1} of ${length}.`;
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
