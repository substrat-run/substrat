/**
 * `<sub-entity-table>` — the rows of one paged read: its views, its sort, its filters and
 * search, a selection, and the actions a row allows.
 *
 * A renderer over `EntityTableModel`: it draws the state and forwards clicks, and decides
 * nothing the model does not. Styled only through Web Awesome's `--wa-*` tokens, so it
 * follows whatever theme the page sets — Web Awesome's own, or a Substrat one — with no
 * theme code in here. Uses Web Awesome's free controls inside.
 *
 * Properties (not attributes — they are objects and functions):
 *   `source`  — `{ read, follow, search? }`: `read(query)` is the generated client's read
 *               given the query's `sort`, `order`, filters and view
 *   `columns` — `Column[]`; `sort` makes a header a sort button, `kind` draws the value
 *               (`badge`, `money`, `relative`, …), and `render` / `mount` replace it
 *   `actions` — `RowAction[]`, run through the model (403 / 409 / 404 handled there);
 *               `views` scopes one to some views, `bulk` offers it for a selection
 *   `views`   — `{ id, label }[]`, drawn as a switch above the rows; the first is the default
 *   `filters` — `{ key, label, options }[]`, equality filters on declared filterable columns
 *   `query`   — the first read's query, for a screen restoring one from its URL
 *   `layout`  — `{ order, hidden }` by column key: which columns show, in what order
 *   `detail`  — `(cell, row)`, drawing the open row's detail, as `mount` draws a cell
 *   `expanded` — the key of the row whose `detail` is open, or null: the screen owns it
 * Attributes: `label` (the table's accessible name), `empty`, `forbidden-text`,
 *   `search-label`, `selectable`, `density="compact"`, `paging` (`pages`, the default —
 *   Previous / Next with "21–40 of 132" — or `more`, one "Load more" that appends), and
 *   `page-size` (25). `pageSizes` is the property behind the rows-per-page picker.
 *   `column-picker` adds a "Columns" button: show, hide and reorder the columns. Opt-in;
 *   without it the columns are exactly the ones given. `layout-key` keeps the chosen layout
 *   in this browser under that key; a screen that would rather keep it on the account
 *   listens for `sub-layout-change` and hands it back through `layout`. `row-click` makes a
 *   row answer a click anywhere that is not a control of its own, with `sub-row-click`.
 * Slot: `empty` — what an empty view says, in place of `empty` (a "Create" button, say).
 * Events: `sub-action-done` `{ action, rows }` after an action succeeded on some rows;
 *   `sub-query-change` `{ query }` whenever the person changes the view, sort, filters or search;
 *   `sub-layout-change` `{ layout }` whenever they show, hide or move a column;
 *   `sub-row-click` `{ row }` when a row is clicked, under `row-click`. A pointer's shortcut
 *   only: what it opens should also be reachable by a link or a button in the row.
 *
 * ## Lists people work in (all opt-in)
 *
 * The table reports the gesture and draws the state. What a gesture means is the screen's.
 *
 * Selection the screen can read and set:
 *   `selection` — the selected row keys, set or read at any time; `sub-selection-change`
 *     `{ keys, rows, parents }` fires whenever the person or a re-read changes them. `rows` is the
 *     loaded rows among `keys`, and `parents` each nested key's parent, for a screen dropping
 *     children of selected parents (or `topmost` on a bulk action, which does it for you).
 *   `row-select` makes the row itself select: a click selects that row alone, cmd/ctrl-click
 *     toggles it, shift-click extends from the last anchor, cmd/ctrl+A selects the rows loaded
 *     now (rows loaded later are not added), Escape clears.
 *   Setting either option keeps a selection across a page turn, and a shift-click ranges over
 *   the pages walked so far. A row a re-read no longer returns leaves it. A changed sort,
 *   filter, search or page size keeps only the selected rows its first read still has, and a
 *   changed view clears it. Without either option, a selection is the rows on screen, as ever.
 *
 * Opening a row and moving by keyboard:
 *   `row-open` fires `sub-row-open` `{ row }` on a double-click or Enter. With `row-click` too,
 *     `sub-row-click` waits `doubleClickMs` (300) and does not fire for a double-click, so a
 *     single click can preview and a double-click open. `row-select` never waits.
 *   Any of `row-select`, `row-open`, `row-draggable` or `childrenOf` makes it an ARIA grid (a
 *     treegrid with `childrenOf`) with one focusable row: Up/Down move, Home/End jump, Shift+Up/Down
 *     extend, Space toggles. Controls inside a row stay in the Tab order.
 *   `paging="scroll"` loads the next page as the end of the list comes into view, keeps a real
 *     "Load more" for a keyboard or screen reader, and Down on the last row loads too. A re-read
 *     keeps every page already loaded, where `more` falls back to the first.
 *   A `RowAction` takes `icon` (a Web Awesome name or `{ src }`, drawn with `label` as its
 *     accessible name) and `menu` (always in the "More" menu at the end of the row).
 *
 * Right-click and drag, as hooks:
 *   `sub-row-contextmenu` `{ row, x, y, originalEvent }` always fires; `preventDefault()` on it
 *     keeps the browser's own menu away so the screen can draw one. Under `row-select` a
 *     right-click on an unselected row selects it first.
 *   `row-draggable`, narrowed by `canDrag(row)`, makes rows draggable. `sub-row-dragstart`
 *     `{ row, rows, dataTransfer, originalEvent }` carries the whole selection if the row is part
 *     of it; set `dataTransfer` on it, or `preventDefault()` to refuse. The preview says how
 *     many are moving (`dragLabel(rows)` words it).
 *   `canDrop(row, dragged)` says which rows take a drop; absent, none do, and a dragged row
 *     never takes itself. It runs on every move of the pointer, so keep it cheap. While hovered
 *     the row has the `drop-target` part. `sub-row-drop` `{ target, dragged, dataTransfer,
 *     originalEvent }` reports the drop.
 *   On touch, a long press (`longPressMs`, 500) starts the drag, with `dataTransfer` null. Moving
 *     the finger first scrolls as usual.
 *
 * Nested rows, separate from `expanded` / `detail`:
 *   `childrenOf(row)` returns a read shaped like `source`, made when a row first opens with the
 *     table's query, so each level sorts on its own. `canExpand(row)` says which rows can open;
 *     `rowRank(row)` keeps some first within a level (lower first: folders before files). Row
 *     keys are unique across every level.
 *   `open` — the open row keys; `sub-row-toggle` `{ row, key, open, keys }` fires when one is
 *     opened or closed. Right opens or moves to the first child, Left closes or moves to the parent.
 *   Use `paging="scroll"` for the top level: page numbers mean little once rows open in the
 *     middle. Each open row gets its own "Load more" row, because loading on scroll mid-list would
 *     keep pushing the rows below it down. A search is a flat list of matches, with no levels.
 *   `reload()` reads every open level again and `reload(key)` just that row's children. A failed
 *     or refused child read shows in that row's level. Selecting a parent does not select its
 *     children; a selection is exactly the rows picked.
 *
 * ## Cells a vertical draws itself
 *
 * `render(row)` returns a Lit template or a string, drawn in the table's shadow root. A
 * framework that is not Lit uses `mount(cell, row)` instead: `cell` is an element in the
 * LIGHT DOM, slotted into its place, so React or Vue can render into it and the page's own
 * stylesheet applies to whatever it draws. `mount` may return `{ update(row), unmount() }`;
 * without `update`, a changed row is unmounted and mounted again.
 *
 * ## Styling, outside in
 *
 * The theme's `--wa-*` tokens; then `--sub-table-*` (row height, header and selected
 * backgrounds, cell padding, `--sub-table-max-height` — set it and the header sticks);
 * then `::part()` — `frame`, `toolbar`, `bulk-bar`, `table`, `header-cell`, `row`
 * (plus `selected`, `drop-target`), `cell`, `detail`, `footer`, `empty`. `--sub-table-indent`
 * is the width of one level of nesting.
 */
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/popover/popover.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/skeleton/skeleton.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import SubstratElement from './internal/substrat-element.js';
import {
  BULK,
  EntityTableModel,
  actionsIn,
  arrange,
  cellText,
  defaultLayout,
  emptyReason,
  layoutEntries,
  moveColumn,
  toggleColumn,
  type ColumnSpec,
  type RowAction,
  type TableEntry,
  type TableLayout,
  type TableQuery,
  type TableSource,
  type TableState,
} from './entity-table-model.js';

/** What `mount` may hand back, so the table can keep a framework's cell up to date. */
export interface CellHandle<T> {
  update?(row: T): void;
  unmount?(): void;
}

export interface Column<T, S extends string = string> extends ColumnSpec<T, S> {
  /** Draw the cell yourself, in the table's shadow root. */
  render?(row: T): TemplateResult | string;
  /** Draw the cell yourself, into a light-DOM element — for React, Vue, or plain DOM. */
  mount?(cell: HTMLElement, row: T): CellHandle<T> | void;
  /** A CSS width for the column, for one whose content is narrower than its share (a checkbox). */
  width?: string;
}

export interface TableView {
  id: string;
  label: string;
}

export interface TableFilter {
  /** A declared filterable column — the read's own input field. */
  key: string;
  label: string;
  options: readonly { value: string; label: string }[];
}

/** How long a typed term waits before it is searched, so a word is one read, not five. */
const SEARCH_DEBOUNCE_MS = 250;

/** What a click on a row leaves alone: it belongs to the control, not to the row. */
const OWN_CLICK = 'a,button,input,select,textarea,label,summary,[role="button"],wa-button,wa-checkbox,wa-dropdown,wa-input,wa-select';

/** A column's own width. `min-width` too: the first column otherwise keeps its claim on the slack. */
const widthOf = <T, S extends string>(c: Column<T, S>) => (c.width ? `width:${c.width};min-width:${c.width}` : nothing);

/** At most this many actions show on a row; past that, the first stays and the rest go in "More". */
const INLINE_ACTIONS = 2;

/** How far a finger may wander during a long press before it is a scroll, in CSS pixels. */
const LONG_PRESS_SLOP = 8;

/** The type a dragged row's keys are carried under: Firefox starts no drag with no data on it. */
const DRAG_TYPE = 'application/x-sub-entity-table';

/** What a row drag carries while it is under way. */
interface RowDrag<T> {
  rows: T[];
  keys: Set<string>;
}

/** A finger held on a row: a press until the timer fires, a drag once `rows` is set. */
interface TouchPress<T> {
  pointer: number;
  x: number;
  y: number;
  key: string;
  row: T;
  timer: ReturnType<typeof setTimeout>;
  dragging: boolean;
}

type RowEntry<T> = Extract<TableEntry<T>, { kind: 'row' }>;

/** Where `layout-key` keeps a layout in this browser. */
const LAYOUT_STORE = 'sub-entity-table:layout:';

/** A stored layout as read back, or null for anything that is not one. */
function parseLayout(raw: string | null): TableLayout | null {
  try {
    const v: unknown = raw === null ? null : JSON.parse(raw);
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((k) => typeof k === 'string');
    if (v && typeof v === 'object' && strings((v as TableLayout).order) && strings((v as TableLayout).hidden)) {
      return { order: (v as TableLayout).order, hidden: (v as TableLayout).hidden };
    }
  } catch {
    // Not JSON: a layout nobody can read is no layout.
  }
  return null;
}

/** A slot name is an attribute value; a row key could be anything. */
const slotOf = (column: string, key: string) => `cell-${column}-${key}`.replace(/[^\w-]/g, '_');
const detailSlotOf = (key: string) => `detail-${key}`.replace(/[^\w-]/g, '_');

const arrow = (order: 'asc' | 'desc' | null) =>
  svg`<svg class="arrow" viewBox="0 0 12 12" aria-hidden="true" data-order=${order ?? 'none'}>
    <path d="M6 2.5 9 6H3z" class="up"/><path d="M6 9.5 3 6h6z" class="down"/>
  </svg>`;

const twisty = svg`<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 8.5 6 4 9.5z"/></svg>`;

/** What every line of one render shares. */
interface RowLine<T, S extends string> {
  state: TableState<T, S>;
  columns: Column<T, S>[];
  rowActions: RowAction<T>[];
  now: Date;
  navigable: boolean;
  nested: boolean;
  picks: boolean;
  tabStop: string | null;
  span: number;
}

interface Mounted<T> {
  el: HTMLElement;
  row: T;
  handle: CellHandle<T> | void;
}

export class SubEntityTable<T = unknown, S extends string = string> extends SubstratElement {
  static properties = {
    source: { attribute: false },
    columns: { attribute: false },
    actions: { attribute: false },
    views: { attribute: false },
    filters: { attribute: false },
    query: { attribute: false },
    layout: { attribute: false },
    detail: { attribute: false },
    expanded: { attribute: false },
    selection: { attribute: false },
    open: { attribute: false },
    childrenOf: { attribute: false },
    canExpand: { attribute: false },
    rowRank: { attribute: false },
    canDrag: { attribute: false },
    canDrop: { attribute: false },
    dragLabel: { attribute: false },
    doubleClickMs: { attribute: false },
    longPressMs: { attribute: false },
    rowSelect: { type: Boolean, attribute: 'row-select', reflect: true },
    rowOpen: { type: Boolean, attribute: 'row-open', reflect: true },
    rowDraggable: { type: Boolean, attribute: 'row-draggable', reflect: true },
    rowClick: { type: Boolean, attribute: 'row-click', reflect: true },
    columnPicker: { type: Boolean, attribute: 'column-picker', reflect: true },
    layoutKey: { attribute: 'layout-key' },
    label: {},
    empty: {},
    forbiddenText: { attribute: 'forbidden-text' },
    searchLabel: { attribute: 'search-label' },
    selectable: { type: Boolean, reflect: true },
    density: { reflect: true },
    paging: { reflect: true },
    pageSize: { type: Number, attribute: 'page-size' },
    pageSizes: { attribute: false },
    view: { state: true },
  };

  declare source: TableSource<T, S> | undefined;
  declare columns: Column<T, S>[];
  declare actions: RowAction<T>[];
  declare views: TableView[];
  declare filters: TableFilter[];
  declare query: Partial<TableQuery<S>> | undefined;
  declare layout: TableLayout | undefined;
  declare detail: ((cell: HTMLElement, row: T) => CellHandle<T> | void) | undefined;
  declare expanded: string | null;
  declare selection: Iterable<string> | undefined;
  declare open: Iterable<string> | undefined;
  /** A read for this row's children. Not `children`: every element already has one. */
  declare childrenOf: ((row: T) => TableSource<T, S>) | undefined;
  declare canExpand: ((row: T) => boolean) | undefined;
  declare rowRank: ((row: T) => number) | undefined;
  declare canDrag: ((row: T) => boolean) | undefined;
  declare canDrop: ((row: T, dragged: T[]) => boolean) | undefined;
  declare dragLabel: ((rows: T[]) => string) | undefined;
  declare doubleClickMs: number;
  declare longPressMs: number;
  declare rowSelect: boolean;
  declare rowOpen: boolean;
  /** Not `draggable`: every element already has one, and it means the element itself. */
  declare rowDraggable: boolean;
  declare rowClick: boolean;
  declare columnPicker: boolean;
  declare layoutKey: string | undefined;
  declare label: string;
  declare empty: string;
  declare forbiddenText: string;
  declare searchLabel: string;
  declare selectable: boolean;
  declare density: 'comfortable' | 'compact';
  declare paging: 'pages' | 'more' | 'scroll';
  declare pageSize: number;
  declare pageSizes: number[];
  declare view: TableState<T, S> | undefined;

  #model: EntityTableModel<T, S> | undefined;
  #resize = new ResizeObserver(() => this.#fit());
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #mounted = new Map<string, Mounted<T>>();
  /** The priority level `#fit` is dropping, so the picker can say why a column is not there. */
  #drop: '2' | '3' | null = null;
  #dragging: string | null = null;
  #announce = '';
  /** A single click waiting to see whether it becomes a double-click. */
  #pendingClick: { key: string; timer: ReturnType<typeof setTimeout>; fire: () => void } | null = null;
  /** The entry holding the one tabindex="0". */
  #current: string | null = null;
  /** Where the row holding focus stood as this render began, in case the render takes it away. */
  #hadFocusAt: number | null = null;
  /** The entries as last drawn, since `willUpdate` already sees the model's next ones. */
  #drawnIds: string[] = [];
  /** The array this element last wrote to `selection`, to tell it from one a screen set. */
  #written: Iterable<string> | undefined;
  /** A screen has set `selection`, so it has opted in to a selection that outlives a page. */
  #screenSelects = false;
  /** A checkbox's change event does not say whether shift was held; the click before it does. */
  #shiftOnCheckbox = false;
  #notePickClick = {
    handleEvent: (e: MouseEvent) => {
      this.#shiftOnCheckbox = e.shiftKey;
    },
    capture: true,
  };
  #lastSelected: ReadonlySet<string> = new Set();
  #lastOpen: ReadonlySet<string> = new Set();
  #drag: RowDrag<T> | null = null;
  #dropKey: string | null = null;
  #dragPreview: HTMLElement | null = null;
  #touch: TouchPress<T> | null = null;
  #swallowClick = false;
  #end: IntersectionObserver | null = null;
  #sentinel: Element | null = null;
  #watchedRows = -1;
  /** Scrolling is what a held finger must not start. Passive listeners cannot refuse it. */
  #holdScroll = {
    handleEvent: (e: TouchEvent) => {
      if (this.#touch?.dragging && e.cancelable) e.preventDefault();
    },
    passive: false,
  };

  constructor() {
    super();
    this.columns = [];
    this.actions = [];
    this.views = [];
    this.filters = [];
    this.expanded = null;
    this.doubleClickMs = 300;
    this.longPressMs = 500;
    this.rowSelect = false;
    this.rowOpen = false;
    this.rowDraggable = false;
    this.rowClick = false;
    this.label = '';
    this.empty = 'Nothing here.';
    this.forbiddenText = 'You do not have access to this.';
    this.searchLabel = 'Search';
    this.selectable = false;
    this.columnPicker = false;
    this.density = 'comfortable';
    this.paging = 'pages';
    this.pageSize = 25;
    this.pageSizes = [10, 25, 50, 100];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#resize.observe(this);
    // A table moved in the DOM was disconnected, which unmounted its framework cells.
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#resize.disconnect();
    clearTimeout(this.#searchTimer);
    if (this.#pendingClick) clearTimeout(this.#pendingClick.timer);
    this.#pendingClick = null;
    this.#endTouch();
    this.#end?.disconnect();
    this.#sentinel = null;
    this.#watchedRows = -1;
    for (const slot of [...this.#mounted.keys()]) this.#unmount(slot);
  }

  /** The columns on screen: the given ones, arranged by the layout. */
  get #shown(): Column<T, S>[] {
    return arrange(this.columns, this.layout);
  }

  #stored(): TableLayout | null {
    try {
      return parseLayout(localStorage.getItem(LAYOUT_STORE + this.layoutKey));
    } catch {
      return null; // Storage refused (a private window, blocked site data): the declared layout.
    }
  }

  #setLayout(next: TableLayout, said: string) {
    this.layout = next;
    this.#announce = said;
    if (this.layoutKey) {
      try {
        localStorage.setItem(LAYOUT_STORE + this.layoutKey, JSON.stringify(next));
      } catch {
        // Not kept past this page, which is all a refused store can mean.
      }
    }
    this.dispatchEvent(new CustomEvent('sub-layout-change', { detail: { layout: next }, bubbles: true, composed: true }));
  }

  /**
   * Read again with the current query — after the host created a row, say. With nested rows
   * this re-reads every open level too; given a row's key, only that row's children.
   */
  reload(key?: string): Promise<void> {
    if (key !== undefined) return this.#model?.reloadLevel(key) ?? Promise.resolve();
    return this.#model?.load() ?? Promise.resolve();
  }

  /** The query the rows on screen answer, for a screen that keeps it in its URL. */
  get currentQuery(): TableQuery<S> | undefined {
    return this.#model?.state.query;
  }

  protected willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('layoutKey') && this.layoutKey && this.layout === undefined) {
      this.layout = this.#stored() ?? undefined;
    }
    const root = this.renderRoot as ShadowRoot | undefined;
    const focused = root?.activeElement;
    this.#hadFocusAt = focused instanceof HTMLTableRowElement && focused.dataset['entry'] ? this.#drawnIds.indexOf(focused.dataset['entry']) : null;
    if (changed.has('selection') && this.selection && this.selection !== this.#written) this.#screenSelects = true;
    const fresh = changed.has('source') && this.source;
    if (fresh) {
      const view = this.query?.view ?? this.views[0]?.id ?? null;
      this.#model = new EntityTableModel<T, S>(this.source!, (state) => this.#stateChanged(state), {
        query: { limit: this.pageSize, ...this.query, view },
        ...(this.selection ? { selected: this.selection } : {}),
      });
      this.view = this.#model.state;
      this.#lastSelected = this.#model.state.selected;
      this.#lastOpen = new Set();
    }
    this.#model?.configure({
      retainSelection: this.rowSelect || this.#screenSelects,
      keepAppended: this.paging === 'scroll',
      tree: this.childrenOf ? { childrenOf: this.childrenOf, ...(this.canExpand ? { canExpand: this.canExpand } : {}) } : undefined,
      rank: this.rowRank,
    });
    if (changed.has('selection') && this.selection) {
      const keys = new Set(this.selection);
      this.#lastSelected = keys;
      this.#model?.setSelection(keys);
    }
    if ((changed.has('open') || fresh) && this.open) {
      this.#lastOpen = new Set(this.open);
      void this.#model?.setOpen(this.#lastOpen);
    }
    if (fresh) void this.#model!.load();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#fit();
    this.#syncMounts();
    this.#watchEnd();
    this.#restoreFocus();
    this.#drawnIds = this.#focusable.map((e) => e.id);
  }

  /** Report a selection the screen did not set itself. */
  #stateChanged(state: TableState<T, S>) {
    this.view = state;
    const before = this.#lastSelected;
    if (state.selected === before) return;
    if (state.selected.size === before.size && [...state.selected].every((k) => before.has(k))) return;
    this.#lastSelected = state.selected;
    const keys = [...state.selected];
    this.selection = this.#written = keys;
    const model = this.#model!;
    const parents = Object.fromEntries(keys.map((k) => [k, model.parentOf(k)]));
    this.dispatchEvent(
      new CustomEvent('sub-selection-change', { detail: { keys, rows: model.selectedRows, parents }, bubbles: true, composed: true }),
    );
  }

  /** The rows on the list and their "Load more" lines: what the arrow keys walk. */
  get #focusable(): Exclude<TableEntry<T>, { kind: 'status' }>[] {
    return (this.#model?.entries ?? []).filter((e): e is Exclude<TableEntry<T>, { kind: 'status' }> => e.kind !== 'status');
  }

  /** The table takes the keyboard, and draws itself as a grid, only if a gesture asked for it. */
  get #navigable(): boolean {
    return this.rowSelect || this.rowOpen || this.rowDraggable || Boolean(this.childrenOf);
  }

  /** A render can take away the row holding focus (its action removed it); keep focus nearby. */
  #restoreFocus() {
    const at = this.#hadFocusAt;
    this.#hadFocusAt = null;
    if (at === null || at < 0 || (this.renderRoot as ShadowRoot).activeElement) return;
    const list = this.#focusable;
    const next = list[Math.min(at, list.length - 1)];
    if (next) this.#focus(next.id);
  }

  #focus(id: string, options?: FocusOptions) {
    this.#current = id;
    this.requestUpdate();
    this.renderRoot.querySelector<HTMLElement>(`tr[data-entry="${CSS.escape(id)}"]`)?.focus(options);
  }

  /**
   * Under `paging="scroll"`, read on when the end of the list comes into view. Observed afresh
   * each time the list grows: the end still in view after a short page is no change, so an
   * observer left alone would stay silent. A failed read does not grow it, so nothing loops.
   */
  #watchEnd() {
    if (typeof IntersectionObserver === 'undefined') return;
    const sentinel = this.renderRoot.querySelector('.sentinel');
    const rows = this.view?.rows.length ?? 0;
    if (sentinel === this.#sentinel && rows === this.#watchedRows) return;
    this.#sentinel = sentinel;
    this.#watchedRows = rows;
    this.#end ??= new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) void this.#model?.more();
    });
    this.#end.disconnect();
    if (sentinel) this.#end.observe(sentinel);
  }

  /**
   * Drop priority-3 columns, then priority-2, only while the table is wider than its
   * frame. Measured rather than a fixed breakpoint: how wide the columns are is the
   * theme's business (Atelier needs more room than Ledger), so no width in here can be
   * right for every theme. Reading `scrollWidth` forces layout, so this settles before
   * the frame paints.
   */
  #fit() {
    const scroll = this.renderRoot.querySelector<HTMLElement>('.scroll');
    const before = this.#drop;
    this.removeAttribute('drop');
    this.#drop = null;
    if (scroll) {
      for (const level of ['3', '2'] as const) {
        if (scroll.scrollWidth <= scroll.clientWidth) break;
        this.setAttribute('drop', level);
        this.#drop = level;
      }
    }
    // The picker says which columns are out for lack of room; it settles in one more pass.
    if (this.#drop !== before && this.columnPicker) this.requestUpdate();
  }

  /** Keep one light-DOM cell per (mounted column, row on screen), and no others. */
  #syncMounts() {
    const model = this.#model;
    const mounting = this.#shown.filter((c) => c.mount);
    const entries = this.view?.phase === 'ready' && model ? model.entries : [];
    const rows = entries.flatMap((e) => (e.kind === 'row' ? [e.row] : []));
    const wanted = new Set<string>();
    if (model) {
      for (const row of rows) {
        for (const column of mounting) {
          const slot = slotOf(column.key, model.keyOf(row));
          wanted.add(slot);
          this.#syncMount(slot, row, column.mount!, (el) => (el.dataset['subCell'] = column.key));
        }
      }
      const open = this.detail && rows.find((row) => model.keyOf(row) === this.expanded);
      if (open !== undefined && open !== false) {
        const slot = detailSlotOf(this.expanded!);
        wanted.add(slot);
        this.#syncMount(slot, open, this.detail!, (el) => (el.dataset['subDetail'] = ''));
      }
    }
    for (const slot of [...this.#mounted.keys()]) if (!wanted.has(slot)) this.#unmount(slot);
  }

  #syncMount(slot: string, row: T, mount: (cell: HTMLElement, row: T) => CellHandle<T> | void, mark: (el: HTMLElement) => void) {
    const known = this.#mounted.get(slot);
    if (known && known.row === row) return;
    if (known?.handle?.update) {
      known.handle.update(row);
      known.row = row;
      return;
    }
    if (known) this.#unmount(slot);
    const el = document.createElement('div');
    el.slot = slot;
    mark(el);
    this.append(el);
    this.#mounted.set(slot, { el, row, handle: mount(el, row) });
  }

  /** The event landed on a control of the row's own, which it belongs to instead. */
  #onOwnControl(e: Event) {
    for (const node of e.composedPath()) {
      if (node === e.currentTarget) break;
      if (node instanceof Element && node.matches(OWN_CLICK)) return true;
    }
    return false;
  }

  #emit(name: string, detail: unknown, cancelable = false) {
    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable }));
  }

  #onRowClick(e: MouseEvent, entry: RowEntry<T>) {
    if (this.#swallowClick) {
      this.#swallowClick = false;
      return;
    }
    if (this.#onOwnControl(e)) return;
    if (this.#navigable) this.#focus(entry.id, { preventScroll: true });
    const model = this.#model!;
    const modified = e.shiftKey || e.metaKey || e.ctrlKey;
    if (this.rowSelect) {
      if (e.shiftKey) model.extendTo(entry.key, { additive: e.metaKey || e.ctrlKey });
      else if (modified) model.toggle(entry.key);
      else model.selectOnly(entry.key);
      if (modified) return; // Picking rows out, which is not a click on one.
    }
    if (this.rowClick) this.#clickOrWait(entry);
  }

  /** With `row-open` too, a click waits to see whether a second one turns it into an open. */
  #clickOrWait({ key, row }: RowEntry<T>) {
    const fire = () => this.#emit('sub-row-click', { row });
    if (!this.rowOpen) return void fire();
    const pending = this.#pendingClick;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pendingClick = null;
      if (pending.key === key) return; // The second click of a double.
      pending.fire();
    }
    this.#pendingClick = {
      key,
      fire,
      timer: setTimeout(() => {
        this.#pendingClick = null;
        fire();
      }, this.doubleClickMs),
    };
  }

  /** A second click, or a shift-click, would otherwise select the text under it. */
  #onRowMouseDown(e: MouseEvent) {
    if (this.#onOwnControl(e)) return;
    if ((this.rowSelect && e.shiftKey) || (this.rowOpen && e.detail > 1)) e.preventDefault();
  }

  #onRowDoubleClick(e: MouseEvent, row: T) {
    if (this.rowOpen && !this.#onOwnControl(e)) this.#emit('sub-row-open', { row });
  }

  #onContextMenu(e: MouseEvent, entry: RowEntry<T>) {
    if (this.#touch?.dragging) return e.preventDefault(); // The long press that started this drag.
    const model = this.#model!;
    if (this.rowSelect && !model.state.selected.has(entry.key)) model.selectOnly(entry.key);
    const allowed = this.#emit('sub-row-contextmenu', { row: entry.row, x: e.clientX, y: e.clientY, originalEvent: e }, true);
    if (!allowed) e.preventDefault();
  }

  /** The row under the focus, for keys pressed on the row itself and not on a control in it. */
  #onRowKey(e: KeyboardEvent) {
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLTableRowElement) || !target.dataset['entry']) return;
    const list = this.#focusable;
    const at = list.findIndex((x) => x.id === target.dataset['entry']);
    const entry = list[at];
    if (entry && this.#keyOnEntry(e, list, at, entry)) e.preventDefault();
  }

  #keyOnEntry(e: KeyboardEvent, list: Exclude<TableEntry<T>, { kind: 'status' }>[], at: number, entry: (typeof list)[number]): boolean {
    const model = this.#model!;
    const picks = this.rowSelect || this.selectable;
    const mod = e.metaKey || e.ctrlKey;
    const go = (to: number) => {
      const next = list[to];
      if (!next) return;
      if (next.kind === 'row') {
        if (e.shiftKey && picks) model.extendTo(next.key, entry.kind === 'row' ? { from: entry.key } : {});
        else model.setAnchor(next.key);
      }
      this.#focus(next.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        if (at < list.length - 1) go(at + 1);
        else void this.#loadOnThenFocus(list.length);
        return true;
      case 'ArrowUp':
        go(at - 1);
        return true;
      case 'Home':
        go(0);
        return true;
      case 'End':
        go(list.length - 1);
        return true;
      case 'ArrowRight':
        if (entry.kind !== 'row' || !entry.expandable) return false;
        if (!entry.open) this.#toggleRow(entry);
        else if (list[at + 1]?.level === entry.level + 1) go(at + 1);
        return true;
      case 'ArrowLeft': {
        if (entry.kind === 'row' && entry.open) {
          this.#toggleRow(entry);
          return true;
        }
        const parent = entry.parent;
        if (parent === null) return false;
        const up = list.findIndex((x) => x.kind === 'row' && x.key === parent);
        if (up >= 0) go(up);
        return true;
      }
      case 'Enter':
        if (entry.kind === 'more') void this.#moreThenFocus(entry, at);
        else if (this.rowOpen) this.#emit('sub-row-open', { row: entry.row });
        else return false;
        return true;
      case ' ':
        if (entry.kind === 'more') void this.#moreThenFocus(entry, at);
        else if (picks) model.toggle(entry.key);
        else return false;
        return true;
      case 'Escape':
        if (!this.rowSelect || model.state.selected.size === 0) return false;
        model.clearSelection();
        return true;
      case 'a':
      case 'A':
        if (!this.rowSelect || !mod) return false;
        model.selectLoaded();
        return true;
      default:
        return false;
    }
  }

  /** Down on the last row reads the next page, then steps onto the first row it brought. */
  async #loadOnThenFocus(index: number) {
    const model = this.#model!;
    if (this.paging === 'pages' || !model.state.next || model.state.mode === 'search') return;
    await model.more();
    await this.updateComplete;
    const next = this.#focusable[index];
    if (next) this.#focus(next.id);
  }

  /** The "Load more" line goes when its level is walked, so focus lands where it stood. */
  async #moreThenFocus(entry: Extract<TableEntry<T>, { kind: 'more' }>, index: number) {
    await this.#model!.moreIn(entry.parent);
    await this.updateComplete;
    const next = this.#focusable[index];
    if (next) this.#focus(next.id);
  }

  #toggleRow(entry: RowEntry<T>) {
    const model = this.#model!;
    const keys = new Set(model.state.open);
    const open = !keys.delete(entry.key);
    if (open) keys.add(entry.key);
    this.#lastOpen = keys;
    this.open = [...keys];
    void model.setOpen(keys);
    this.#emit('sub-row-toggle', { row: entry.row, key: entry.key, open, keys: [...keys] });
  }

  #canDragRow(row: T) {
    return this.rowDraggable && (this.canDrag?.(row) ?? true);
  }

  #draggedRows(key: string, row: T): T[] {
    const model = this.#model!;
    return model.state.selected.has(key) ? model.selectedRows : [row];
  }

  /** What a drag's preview says: the row, or how many. */
  #dragText(rows: T[]) {
    if (this.dragLabel) return this.dragLabel(rows);
    if (rows.length !== 1 || !this.columns[0]) return `${rows.length} items`;
    return cellText(this.columns[0], rows[0]!, new Date()).text;
  }

  #makePreview(rows: T[]) {
    const preview = document.createElement('div');
    preview.className = 'drag-preview';
    preview.textContent = this.#dragText(rows);
    this.renderRoot.append(preview);
    return preview;
  }

  #onDragStart(e: DragEvent, key: string, row: T) {
    if (this.#touch) return e.preventDefault(); // A long press drags its own way, on every browser.
    const rows = this.#draggedRows(key, row);
    const model = this.#model!;
    const transfer = e.dataTransfer;
    transfer?.setData(DRAG_TYPE, JSON.stringify(rows.map(model.keyOf)));
    const preview = this.#makePreview(rows);
    transfer?.setDragImage?.(preview, 12, 12);
    // The browser has its picture once this event is over.
    setTimeout(() => preview.remove(), 0);
    if (!this.#emit('sub-row-dragstart', { row, rows, dataTransfer: transfer, originalEvent: e }, true)) return e.preventDefault();
    this.#drag = { rows, keys: new Set(rows.map(model.keyOf)) };
  }

  #acceptsDrop(key: string, row: T) {
    const drag = this.#drag;
    return drag !== null && !drag.keys.has(key) && (this.canDrop?.(row, drag.rows) ?? false);
  }

  #setDropKey(key: string | null) {
    if (key === this.#dropKey) return;
    this.#dropKey = key;
    this.requestUpdate();
  }

  #onDragOver(e: DragEvent, key: string, row: T) {
    if (!this.#drag) return;
    if (this.#acceptsDrop(key, row)) {
      e.preventDefault();
      this.#setDropKey(key);
    } else {
      this.#setDropKey(null);
    }
  }

  #onDragLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || (!this.renderRoot.contains(to) && !this.contains(to))) this.#setDropKey(null);
  }

  #reportDrop(row: T, dataTransfer: DataTransfer | null, originalEvent: Event) {
    this.#emit('sub-row-drop', { target: row, dragged: this.#drag!.rows, dataTransfer, originalEvent });
  }

  #onDrop(e: DragEvent, key: string, row: T) {
    if (!this.#acceptsDrop(key, row)) return;
    e.preventDefault();
    this.#reportDrop(row, e.dataTransfer, e);
    this.#endDrag();
  }

  #endDrag() {
    this.#drag = null;
    this.#setDropKey(null);
  }

  #onPointerDown(e: PointerEvent, key: string, row: T) {
    if (e.pointerType !== 'touch' || this.#touch || !this.#canDragRow(row) || this.#onOwnControl(e)) return;
    this.#touch = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      key,
      row,
      dragging: false,
      timer: setTimeout(() => this.#beginTouchDrag(e), this.longPressMs),
    };
    window.addEventListener('pointermove', this.#onTouchMove);
    window.addEventListener('pointerup', this.#onTouchEnd);
    window.addEventListener('pointercancel', this.#onTouchCancel);
  }

  #beginTouchDrag(e: PointerEvent) {
    const touch = this.#touch;
    if (!touch) return;
    const rows = this.#draggedRows(touch.key, touch.row);
    if (!this.#emit('sub-row-dragstart', { row: touch.row, rows, dataTransfer: null, originalEvent: e }, true)) {
      this.#endTouch();
      return;
    }
    touch.dragging = true;
    this.#drag = { rows, keys: new Set(rows.map(this.#model!.keyOf)) };
    this.#dragPreview = this.#makePreview(rows);
    this.#movePreview(touch.x, touch.y);
  }

  #movePreview(x: number, y: number) {
    if (this.#dragPreview) this.#dragPreview.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  }

  /** The row under a point. A mounted cell's content is in the light DOM, so it goes by its slot. */
  #rowAt(x: number, y: number) {
    const hit = (this.renderRoot as ShadowRoot).elementFromPoint?.(x, y);
    const cell = hit?.closest('[data-sub-cell]');
    const key = (cell?.assignedSlot ?? hit)?.closest<HTMLElement>('tr[data-entry]')?.dataset['entry'];
    const entry = this.#model?.entries.find((x) => x.id === key);
    return entry?.kind === 'row' ? entry : undefined;
  }

  #onTouchMove = (e: PointerEvent) => {
    const touch = this.#touch;
    if (!touch || e.pointerId !== touch.pointer) return;
    if (!touch.dragging) {
      // Moved before the press came due: this finger is scrolling the list, so leave it alone.
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > LONG_PRESS_SLOP) this.#endTouch();
      return;
    }
    this.#movePreview(e.clientX, e.clientY);
    const over = this.#rowAt(e.clientX, e.clientY);
    this.#setDropKey(over && this.#acceptsDrop(over.key, over.row) ? over.key : null);
  };

  #onTouchEnd = (e: PointerEvent) => {
    const touch = this.#touch;
    if (!touch || e.pointerId !== touch.pointer) return;
    if (touch.dragging) {
      const over = this.#rowAt(e.clientX, e.clientY);
      if (over && this.#acceptsDrop(over.key, over.row)) this.#reportDrop(over.row, null, e);
      // The lift can still arrive as a click on the row it started from.
      this.#swallowClick = true;
      setTimeout(() => (this.#swallowClick = false), 0);
    }
    this.#endTouch();
  };

  #onTouchCancel = (e: PointerEvent) => {
    if (e.pointerId === this.#touch?.pointer) this.#endTouch();
  };

  #endTouch() {
    if (this.#touch) clearTimeout(this.#touch.timer);
    const dragging = this.#touch?.dragging;
    this.#touch = null;
    window.removeEventListener('pointermove', this.#onTouchMove);
    window.removeEventListener('pointerup', this.#onTouchEnd);
    window.removeEventListener('pointercancel', this.#onTouchCancel);
    this.#dragPreview?.remove();
    this.#dragPreview = null;
    if (dragging) this.#endDrag();
  }

  #unmount(slot: string) {
    const known = this.#mounted.get(slot);
    if (!known) return;
    known.handle?.unmount?.();
    known.el.remove();
    this.#mounted.delete(slot);
  }

  #changed(work: Promise<void>) {
    this.dispatchEvent(
      new CustomEvent('sub-query-change', { detail: { query: this.#model!.state.query }, bubbles: true, composed: true }),
    );
    return work;
  }

  #onSearch(e: Event) {
    const q = (e.target as HTMLInputElement).value ?? '';
    clearTimeout(this.#searchTimer);
    this.#searchTimer = setTimeout(() => void this.#changed(this.#model!.search(q)), SEARCH_DEBOUNCE_MS);
  }

  static css = css`
    :host {
      --sub-table-row-height: calc(var(--wa-form-control-height) + var(--wa-space-2xs));
      --sub-table-cell-padding-inline: var(--wa-space-m);
      --sub-table-cell-padding-block: var(--wa-space-xs);
      --sub-table-header-background: var(--wa-color-surface-lowered);
      --sub-table-row-hover: var(--wa-color-neutral-fill-quiet);
      --sub-table-row-selected: var(--wa-color-brand-fill-quiet);
      --sub-table-max-height: none;
      --sub-table-indent: var(--wa-space-l);
      display: block;
      font-family: var(--wa-font-family-body);
      color: var(--wa-color-text-normal);
    }
    :host([density='compact']) {
      --sub-table-row-height: var(--wa-form-control-height);
      --sub-table-cell-padding-block: var(--wa-space-3xs);
      --sub-table-cell-padding-inline: var(--wa-space-s);
    }
    .frame {
      background: var(--wa-color-surface-default);
      border: var(--wa-panel-border-width) var(--wa-panel-border-style) var(--wa-color-surface-border);
      border-radius: var(--wa-panel-border-radius);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--wa-space-s);
      padding: var(--wa-space-s) var(--sub-table-cell-padding-inline);
      border-bottom: var(--wa-border-width-s) solid var(--wa-color-surface-border);
      min-height: calc(var(--wa-form-control-height) + 2 * var(--wa-space-s));
    }
    .toolbar .grow {
      flex: 1 1 12rem;
      max-width: 22rem;
    }
    /* The Columns button keeps to the end of the toolbar, whatever is before it. */
    .columns-button {
      margin-inline-start: auto;
    }
    .picker::part(body) {
      padding: var(--wa-space-xs);
      min-width: 16rem;
    }
    .picker-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .picker-row {
      display: grid;
      grid-template-columns: 1rem 1fr auto auto;
      align-items: center;
      gap: var(--wa-space-2xs);
      padding: var(--wa-space-3xs) var(--wa-space-2xs);
      border-radius: var(--wa-border-radius-s);
      font-size: var(--wa-font-size-s);
    }
    .picker-row.fixed {
      grid-template-columns: 1rem 1fr auto;
      border-bottom: var(--wa-border-width-s) solid var(--wa-color-surface-border);
      border-radius: 0;
      margin-bottom: var(--wa-space-3xs);
      padding-bottom: var(--wa-space-2xs);
    }
    li.picker-row:hover {
      background: var(--sub-table-row-hover);
    }
    .picker-row.dragging {
      opacity: 0.45;
    }
    .grip {
      color: var(--wa-color-text-quiet);
      cursor: grab;
      text-align: center;
      user-select: none;
    }
    .hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
    }
    .moves {
      display: inline-flex;
    }
    .picker-foot {
      display: flex;
      justify-content: flex-end;
      border-top: var(--wa-border-width-s) solid var(--wa-color-surface-border);
      margin-top: var(--wa-space-3xs);
      padding-top: var(--wa-space-3xs);
    }
    .toolbar wa-select {
      width: 12rem;
    }
    /* "Status  Open": a filter keeps its name once it has a value, the way a chip does. */
    .filter-name {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      margin-inline-end: var(--wa-space-2xs);
    }
    .bulk {
      background: var(--sub-table-row-selected);
    }
    .bulk strong {
      font-size: var(--wa-font-size-s);
      margin-inline-end: auto;
    }
    wa-callout {
      margin: var(--wa-space-s);
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--wa-font-size-s);
      font-variant-numeric: tabular-nums;
      transition: opacity var(--wa-transition-fast) var(--wa-transition-easing);
    }
    table.refreshing {
      opacity: 0.55;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      text-align: start;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      letter-spacing: 0.02em;
      padding: var(--sub-table-cell-padding-block) var(--sub-table-cell-padding-inline);
      background: var(--sub-table-header-background);
      border-bottom: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    }
    td {
      padding: var(--sub-table-cell-padding-block) var(--sub-table-cell-padding-inline);
      border-top: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    }
    /* The header takes the rows' height too: on its own it shrinks to its text, and its labels
       then sit closer to its edges than a row's values do to theirs. */
    th,
    td {
      height: var(--sub-table-row-height);
    }
    /* Values stay on one line; the first data column takes the slack and is the one that wraps. */
    th,
    td {
      white-space: nowrap;
    }
    .primary {
      white-space: normal;
      width: 100%;
      min-width: 9rem;
    }
    .pick {
      width: 1%;
      padding-inline-end: 0;
    }
    /* A block, not inline: on the text's baseline the checkbox keeps a descender's room under
       it and sits above the middle of the row. */
    .pick wa-checkbox {
      display: flex;
    }
    /* The last resort when the columns still left are wider than the frame: scroll the
       table, never clip the actions off its edge. A max height makes the header stick. */
    .scroll {
      overflow: auto;
      max-height: var(--sub-table-max-height);
    }
    tbody tr:first-child td {
      border-top: 0;
    }
    tbody tr:hover td,
    tbody tr.expanded td {
      background: var(--sub-table-row-hover);
    }
    :host([row-click]) tbody tr:not(.detail) {
      cursor: pointer;
    }
    :host([row-open]) tbody tr[data-entry],
    :host([row-select]) tbody tr[data-entry] {
      cursor: default;
    }
    tbody tr[data-entry] {
      scroll-margin-block-start: var(--sub-table-row-height);
    }
    tbody tr[data-entry]:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: calc(-1 * var(--wa-focus-ring-width, 2px));
    }
    /* A long press is the drag; the phone's own callout and text selection would be in its way. */
    tbody tr[draggable='true'] {
      -webkit-touch-callout: none;
    }
    @media (pointer: coarse) {
      tbody tr[draggable='true'] {
        user-select: none;
      }
    }
    tbody tr.drop-target td {
      background: var(--sub-table-row-selected);
      box-shadow:
        inset 0 var(--wa-border-width-m) 0 var(--wa-color-brand-border-loud),
        inset 0 calc(-1 * var(--wa-border-width-m)) 0 var(--wa-color-brand-border-loud);
    }
    /* Parked off screen until the browser photographs it; a finger's drag moves it into view. */
    .drag-preview {
      position: fixed;
      top: 0;
      left: 0;
      transform: translateX(-200vw);
      z-index: var(--wa-z-index-tooltip, 1000);
      pointer-events: none;
      padding: var(--wa-space-2xs) var(--wa-space-s);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-brand-fill-loud);
      color: var(--wa-color-brand-on-loud);
      font-size: var(--wa-font-size-s);
      white-space: nowrap;
    }
    .nested {
      display: flex;
      align-items: center;
      gap: var(--wa-space-2xs);
      padding-inline-start: calc(var(--sub-level, 0) * var(--sub-table-indent));
    }
    .nested-body {
      min-width: 0;
      flex: 1;
    }
    .twisty-gap {
      flex: none;
      width: 1.25em;
      height: 1.25em;
    }
    .twisty {
      all: unset;
      flex: none;
      width: 1.25em;
      height: 1.25em;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--wa-color-text-quiet);
      border-radius: var(--wa-border-radius-s);
    }
    .twisty svg {
      width: 0.75em;
      height: 0.75em;
      fill: currentColor;
      transition: rotate var(--wa-transition-fast) var(--wa-transition-easing);
    }
    .twisty[data-open='true'] svg {
      rotate: 90deg;
    }
    tr.level-line td {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
    }
    .level-note {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }
    /* Where the list ends, for the observer behind paging="scroll". It needs a box to intersect. */
    .sentinel {
      height: 1px;
    }
    tr.detail td {
      white-space: normal;
      height: auto;
      padding-block: var(--wa-space-s);
      background: var(--sub-table-row-hover);
    }
    tbody tr.selected td {
      background: var(--sub-table-row-selected);
    }
    .end {
      text-align: end;
    }
    /* A mounted cell is a flex row, so a component in it is centred on the row's middle
       rather than sat on a text baseline with a descender's room under it. */
    slot::slotted([data-sub-cell]) {
      display: flex;
      align-items: center;
    }
    .end slot::slotted([data-sub-cell]) {
      justify-content: flex-end;
    }
    .sort {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-3xs);
      border-radius: var(--wa-border-radius-s);
    }
    .sort:hover,
    th[aria-sort='ascending'] .sort,
    th[aria-sort='descending'] .sort {
      color: var(--wa-color-text-normal);
    }
    .sort:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    .arrow {
      width: 0.75em;
      height: 0.75em;
      fill: currentColor;
    }
    .arrow .up,
    .arrow .down {
      opacity: 0.3;
    }
    .arrow[data-order='asc'] .up,
    .arrow[data-order='desc'] .down {
      opacity: 1;
    }
    .arrow[data-order='asc'] .down,
    .arrow[data-order='desc'] .up {
      opacity: 0;
    }
    /* No block padding: the buttons are already a control's height, and padded they would make
       every row taller than the row height the header and the other cells keep. */
    .actions {
      text-align: end;
      white-space: nowrap;
      width: 1%;
      padding-block: 0;
    }
    /* With a pointer that hovers, a row's actions wait to be wanted; on touch, or held by
       the keyboard, or while one runs, they show. */
    @media (hover: hover) {
      tbody tr:not(:hover):not(:focus-within):not(.selected) .actions > :not([loading]) {
        opacity: 0;
      }
    }
    a {
      color: inherit;
      font-weight: var(--wa-font-weight-semibold);
      text-decoration: none;
    }
    a:hover {
      color: var(--wa-color-text-link);
      text-decoration: underline;
    }
    a:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    .blank {
      color: var(--wa-color-text-quiet);
    }
    code {
      font-family: var(--wa-font-family-code);
      font-size: 0.92em;
      color: var(--wa-color-text-quiet);
    }
    wa-skeleton {
      height: 0.8em;
      width: 70%;
    }
    .note {
      padding: var(--wa-space-xl) var(--wa-space-m);
      text-align: center;
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
    .note wa-button {
      margin-top: var(--wa-space-s);
    }
    footer .pages {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }
    footer wa-select.size {
      width: 8.5rem;
    }
    /* Every labelled control in here labels itself for a screen reader only (.vh), and its
       label part keeps a margin regardless, which makes it taller than a button of the same
       size and sits it lower beside one — the toolbar's Columns button, the pager's buttons. */
    wa-input::part(form-control-label),
    wa-select::part(form-control-label),
    wa-radio-group::part(form-control-label) {
      margin: 0;
    }
    footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wa-space-s);
      padding: var(--wa-space-xs) var(--sub-table-cell-padding-inline);
      border-top: var(--wa-border-width-s) solid var(--wa-color-surface-border);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
    }
    .vh {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    :host([drop='3']) .p3,
    :host([drop='2']) .p3,
    :host([drop='2']) .p2 {
      display: none;
    }
  `;

  render() {
    const state = this.view;
    if (!state) return nothing;
    return html`<div part="frame" class="frame" aria-busy=${state.phase === 'loading' || state.refreshing ? 'true' : 'false'}>
      ${this.#toolbar(state)} ${this.#problem(state)} ${this.#body(state)}
    </div>`;
  }

  #toolbar(state: TableState<T, S>) {
    const model = this.#model!;
    const bulk = actionsIn(this.actions, state.query.view, true);
    // A click on a row selects it, so without a bulk action to offer the bar would only be in the way.
    if ((this.selectable || (this.rowSelect && bulk.length > 0)) && state.selected.size > 0) {
      return html`<div part="toolbar bulk-bar" class="toolbar bulk" role="toolbar" aria-label="Selection">
        <strong>${state.selected.size} selected</strong>
        ${bulk.map(
          (a) => html`<wa-button
            size="s"
            appearance="outlined"
            variant=${a.tone === 'danger' ? 'danger' : 'neutral'}
            ?loading=${state.busy === BULK}
            ?disabled=${state.busy !== null}
            @click=${() => this.#runBulk(a)}
            >${a.label}</wa-button
          >`,
        )}
        <wa-button size="s" appearance="plain" ?disabled=${state.busy !== null} @click=${() => model.clearSelection()}
          >Clear</wa-button
        >
      </div>`;
    }
    const views = this.views.length > 1;
    const search = model.searchable;
    if (!views && !search && this.filters.length === 0 && !this.columnPicker) return nothing;
    return html`<div part="toolbar" class="toolbar">
      ${views
        ? html`<wa-radio-group
            size="s"
            orientation="horizontal"
            .value=${state.query.view}
            @change=${(e: Event) => this.#changed(model.setQuery({ view: (e.target as HTMLInputElement).value }))}
          >
            <span slot="label" class="vh">View</span>
            ${this.views.map((v) => html`<wa-radio appearance="button" value=${v.id}>${v.label}</wa-radio>`)}
          </wa-radio-group>`
        : nothing}
      ${search
        ? html`<wa-input
            class="grow"
            size="s"
            type="search"
            with-clear
            placeholder=${this.searchLabel}
            .value=${state.query.q}
            @input=${(e: Event) => this.#onSearch(e)}
          >
            <span slot="label" class="vh">${this.searchLabel}</span>
          </wa-input>`
        : nothing}
      ${this.filters.map(
        (f) => html`<wa-select
          size="s"
          with-clear
          placeholder="Any"
          .value=${state.query.filters[f.key] ?? ''}
          ?disabled=${state.mode === 'search'}
          title=${state.mode === 'search' ? 'A search is ranked, not filtered: clear it to filter' : nothing}
          @change=${(e: Event) => this.#changed(model.filter(f.key, (e.target as HTMLSelectElement).value || null))}
        >
          <span slot="label" class="vh">${f.label}</span>
          <span slot="start" class="filter-name" aria-hidden="true">${f.label}</span>
          ${f.options.map((o) => html`<wa-option value=${o.value}>${o.label}</wa-option>`)}
        </wa-select>`,
      )}
      ${this.columnPicker ? this.#picker() : nothing}
    </div>`;
  }

  /**
   * Show, hide and reorder the columns. Dragging is for a pointer; every row also has Move up
   * and Move down, so a keyboard or a screen reader can do everything a drag can. The first
   * column names the row and is listed as always shown.
   */
  #picker() {
    const first = this.columns[0];
    if (!first) return nothing;
    const entries = layoutEntries(this.columns, this.layout);
    const plain = JSON.stringify(arrange(this.columns, this.layout).map((c) => c.key)) ===
      JSON.stringify(this.columns.map((c) => c.key));
    const narrow = (c: Column<T, S>) =>
      (this.#drop === '3' && c.priority === 3) || (this.#drop === '2' && (c.priority === 2 || c.priority === 3));
    const move = (key: string, label: string, by: number) => {
      const next = moveColumn(this.columns, this.layout, key, { by });
      const at = layoutEntries(this.columns, next).findIndex((e) => e.column.key === key);
      this.#setLayout(next, `${label} moved ${by < 0 ? 'up' : 'down'}, ${at + 1} of ${entries.length}.`);
      // Focus follows the column. At an edge the button pressed is disabled now, and focus
      // would fall to the page; the other one is where a keyboard wants to be.
      void this.updateComplete.then(() => {
        const moves = this.renderRoot.querySelectorAll<HTMLElement>(`li[data-key="${CSS.escape(key)}"] .moves wa-button`);
        const pressed = moves[by < 0 ? 0 : 1];
        (pressed && !pressed.hasAttribute('disabled') ? pressed : moves[by < 0 ? 1 : 0])?.focus();
      });
    };
    return html`<wa-button id="columns" class="columns-button" size="s" appearance="outlined">Columns</wa-button>
      <wa-popover for="columns" placement="bottom-end" class="picker">
        <div class="picker-body" role="group" aria-label="Columns">
          <div class="picker-row fixed">
            <span class="grip" aria-hidden="true"></span>
            <wa-checkbox size="s" checked disabled>${first.label}</wa-checkbox>
            <span class="hint">Always shown</span>
          </div>
          <ol class="picker-list">
            ${repeat(
              entries,
              (e) => e.column.key,
              ({ column: c, shown }, i) => html`<li
                class=${['picker-row', this.#dragging === c.key ? 'dragging' : ''].join(' ')}
                data-key=${c.key}
                draggable="true"
                @dragstart=${(e: DragEvent) => {
                  this.#dragging = c.key;
                  e.dataTransfer?.setData('text/plain', c.key);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                  this.requestUpdate();
                }}
                @dragover=${(e: DragEvent) => {
                  if (this.#dragging && this.#dragging !== c.key) e.preventDefault();
                }}
                @drop=${(e: DragEvent) => {
                  e.preventDefault();
                  const key = this.#dragging;
                  this.#dragging = null;
                  if (key && key !== c.key) {
                    const label = this.columns.find((x) => x.key === key)?.label ?? key;
                    this.#setLayout(moveColumn(this.columns, this.layout, key, { to: c.key }), `${label} moved.`);
                  } else this.requestUpdate();
                }}
                @dragend=${() => {
                  this.#dragging = null;
                  this.requestUpdate();
                }}
              >
                <span class="grip" aria-hidden="true">⠿</span>
                <wa-checkbox
                  size="s"
                  .checked=${shown}
                  @change=${() =>
                    this.#setLayout(toggleColumn(this.columns, this.layout, c.key), `${c.label} ${shown ? 'hidden' : 'shown'}.`)}
                  >${c.label}</wa-checkbox
                >
                ${shown && narrow(c) ? html`<span class="hint">Hidden while narrow</span>` : html`<span></span>`}
                <span class="moves">
                  <wa-button size="xs" appearance="plain" ?disabled=${i === 0} @click=${() => move(c.key, c.label, -1)}
                    >↑<span class="vh">Move ${c.label} up</span></wa-button
                  >
                  <wa-button
                    size="xs"
                    appearance="plain"
                    ?disabled=${i === entries.length - 1}
                    @click=${() => move(c.key, c.label, 1)}
                    >↓<span class="vh">Move ${c.label} down</span></wa-button
                  >
                </span>
              </li>`,
            )}
          </ol>
          <div class="picker-foot">
            <wa-button
              size="s"
              appearance="plain"
              ?disabled=${plain && !this.layout?.hidden.length}
              @click=${() => this.#setLayout(defaultLayout(this.columns), 'Columns reset.')}
              >Reset to default</wa-button
            >
          </div>
          <span class="vh" aria-live="polite">${this.#announce}</span>
        </div>
      </wa-popover>`;
  }

  #problem(state: TableState<T, S>) {
    const p = state.problem;
    if (!p || state.phase === 'error') return nothing;
    const variant = p.kind === 'refused' ? 'warning' : p.kind === 'stale' ? 'neutral' : 'danger';
    const lead = p.kind === 'refused' ? 'Not allowed.' : p.kind === 'stale' ? '' : 'Something went wrong.';
    return html`<wa-callout variant=${variant} size="s" role="status">
      ${lead ? html`<strong>${lead}</strong> ` : nothing}${p.message}
    </wa-callout>`;
  }

  #body(state: TableState<T, S>) {
    switch (state.phase) {
      case 'loading':
        return this.#skeleton();
      case 'forbidden':
        return html`<wa-callout variant="warning" size="s">${this.forbiddenText}</wa-callout>`;
      case 'error':
        return html`<wa-callout variant="danger" size="s">
          <strong>Could not load.</strong> ${state.problem?.message ?? ''}
          <wa-button size="s" appearance="outlined" @click=${() => this.reload()}>Try again</wa-button>
        </wa-callout>`;
      case 'ready':
        return state.rows.length === 0 ? this.#empty(state) : this.#table(state);
    }
  }

  /** Rows the height of real ones, so the first answer lands without the page jumping. */
  #skeleton() {
    return html`<div class="scroll">
      <table aria-hidden="true">
        <tbody>
          ${[0, 1, 2].map(
            () => html`<tr>
              ${this.#shown.map(
                (c, i) => html`<td class=${this.#cellClass(c, i)}><wa-skeleton effect="sheen"></wa-skeleton></td>`,
              )}
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }

  #empty(state: TableState<T, S>) {
    if (emptyReason(state) === 'no-matches') {
      return html`<div part="empty" class="note">
        <div>${state.mode === 'search' ? `Nothing matches “${state.query.q.trim()}”.` : 'Nothing matches these filters.'}</div>
        <wa-button size="s" appearance="outlined" @click=${() => this.#clear()}>Clear</wa-button>
      </div>`;
    }
    return html`<div part="empty" class="note"><slot name="empty">${this.empty}</slot></div>`;
  }

  #clear() {
    clearTimeout(this.#searchTimer);
    return this.#changed(this.#model!.clear());
  }

  #cellClass(c: Column<T, S>, index: number) {
    const end = c.align === 'end' || (c.align === undefined && (c.kind === 'number' || c.kind === 'money'));
    return [`p${c.priority ?? 1}`, end ? 'end' : '', index === 0 ? 'primary' : ''].filter(Boolean).join(' ');
  }

  #header(c: Column<T, S>, index: number, state: TableState<T, S>) {
    // A search is ranked, not sorted: its headers are labels until the term is cleared.
    const sortable = c.sort !== undefined && state.mode === 'page';
    const order = sortable && state.query.sort === c.sort ? state.query.order : null;
    const ariaSort = !sortable ? nothing : order === 'asc' ? 'ascending' : order === 'desc' ? 'descending' : 'none';
    return html`<th scope="col" part="header-cell" class=${this.#cellClass(c, index)} style=${widthOf(c)} aria-sort=${ariaSort}>
      ${sortable
        ? html`<button class="sort" @click=${() => this.#changed(this.#model!.sortBy(c.sort!))}>
            ${c.label}${arrow(order)}
          </button>`
        : c.label}
    </th>`;
  }

  #cell(c: Column<T, S>, row: T, key: string, state: TableState<T, S>, now: Date) {
    if (c.mount) return html`<slot name=${slotOf(c.key, key)}></slot>`;
    if (c.render) return c.render(row);
    const cell = cellText(c, row, now);
    const href = cell.blank ? null : c.href?.(row, state.query);
    const body =
      c.kind === 'badge' && !cell.blank
        ? html`<wa-badge variant=${cell.tone ?? 'neutral'} appearance="filled">${cell.text}</wa-badge>`
        : c.kind === 'code' && !cell.blank
          ? html`<code>${cell.text}</code>`
          : cell.text;
    if (href) return html`<a href=${href} title=${cell.title ?? nothing}>${body}</a>`;
    return html`<span class=${cell.blank ? 'blank' : nothing} title=${cell.title ?? nothing}>${body}</span>`;
  }

  #table(state: TableState<T, S>) {
    const model = this.#model!;
    const rowActions = actionsIn(this.actions, state.query.view);
    const entries = model.entries;
    const keys = entries.flatMap((e) => (e.kind === 'row' ? [e.key] : []));
    const picked = keys.filter((k) => state.selected.has(k)).length;
    const columns = this.#shown;
    const navigable = this.#navigable;
    const focusable = this.#focusable;
    const nested = Boolean(this.childrenOf) && state.mode === 'page';
    const line: RowLine<T, S> = {
      state,
      columns,
      rowActions,
      now: new Date(),
      navigable,
      nested,
      picks: this.rowSelect || this.selectable,
      tabStop: focusable.some((e) => e.id === this.#current) ? this.#current : (focusable[0]?.id ?? null),
      span: columns.length + (this.selectable ? 1 : 0) + (rowActions.length ? 1 : 0),
    };
    const draw = (entry: TableEntry<T>, index: number) => (entry.kind === 'row' ? this.#row(entry, index, line) : this.#levelLine(entry, index, line));
    return html`<div class="scroll">
        <table
          part="table"
          class=${state.refreshing ? 'refreshing' : ''}
          role=${navigable ? (nested ? 'treegrid' : 'grid') : nothing}
          aria-rowcount=${navigable ? entries.length + 1 : nothing}
          aria-multiselectable=${navigable && line.picks ? 'true' : nothing}
        >
          ${this.label ? html`<caption class="vh">${this.label}</caption>` : nothing}
          <thead>
            <tr aria-rowindex=${navigable ? 1 : nothing}>
              ${this.selectable
                ? html`<th scope="col" class="pick">
                    <wa-checkbox
                      size="s"
                      .checked=${picked > 0 && picked === keys.length}
                      .indeterminate=${picked > 0 && picked < keys.length}
                      @change=${() => model.toggleAll()}
                      ><span class="vh">Select all shown</span></wa-checkbox
                    >
                  </th>`
                : nothing}
              ${columns.map((c, i) => this.#header(c, i, state))}
              ${rowActions.length ? html`<th scope="col" class="actions"><span class="vh">Actions</span></th>` : nothing}
            </tr>
          </thead>
          <tbody
            @keydown=${navigable ? (e: KeyboardEvent) => this.#onRowKey(e) : nothing}
            @focusin=${navigable ? (e: FocusEvent) => this.#onRowFocus(e) : nothing}
            @dragleave=${this.rowDraggable ? (e: DragEvent) => this.#onDragLeave(e) : nothing}
            @touchmove=${this.rowDraggable ? this.#holdScroll : nothing}
          >
            ${navigable ? repeat(entries, (e) => e.id, draw) : entries.map(draw)}
          </tbody>
        </table>
        ${this.paging === 'scroll' && state.mode === 'page' && state.next ? html`<div class="sentinel" aria-hidden="true"></div>` : nothing}
      </div>
      ${this.#footer(state)}`;
  }

  /** Focus moved to a row, or into one: that row now holds the Tab stop. */
  #onRowFocus(e: FocusEvent) {
    const row = e.composedPath().find((n): n is HTMLTableRowElement => n instanceof HTMLTableRowElement && Boolean(n.dataset['entry']));
    if (row && row.dataset['entry'] !== this.#current) {
      this.#current = row.dataset['entry']!;
      this.requestUpdate();
    }
  }

  #row(entry: RowEntry<T>, index: number, line: RowLine<T, S>) {
    const { key, row } = entry;
    const { state, columns, rowActions, now, navigable, nested, picks, tabStop, span } = line;
    const model = this.#model!;
    const selected = state.selected.has(key);
    const name = this.columns[0] ? cellText(this.columns[0], row, now).text : key;
    const open = this.expanded === key;
    const dropping = this.#dropKey === key;
    const part = ['row', selected ? 'selected' : '', dropping ? 'drop-target' : ''].filter(Boolean).join(' ');
    return html`<tr
        part=${part}
        class=${[selected ? 'selected' : '', open ? 'expanded' : '', dropping ? 'drop-target' : ''].filter(Boolean).join(' ')}
        data-entry=${navigable ? entry.id : nothing}
        tabindex=${navigable ? (entry.id === tabStop ? '0' : '-1') : nothing}
        draggable=${this.#canDragRow(row) ? 'true' : nothing}
        aria-selected=${navigable && picks ? String(selected) : nothing}
        aria-rowindex=${navigable ? index + 2 : nothing}
        aria-level=${nested ? entry.level : nothing}
        aria-setsize=${nested ? entry.siblings : nothing}
        aria-posinset=${nested ? entry.position : nothing}
        aria-expanded=${nested && entry.expandable ? String(entry.open) : nothing}
        @click=${(e: MouseEvent) => this.#onRowClick(e, entry)}
        @mousedown=${(e: MouseEvent) => this.#onRowMouseDown(e)}
        @dblclick=${(e: MouseEvent) => this.#onRowDoubleClick(e, row)}
        @contextmenu=${(e: MouseEvent) => this.#onContextMenu(e, entry)}
        @dragstart=${(e: DragEvent) => this.#onDragStart(e, key, row)}
        @dragenter=${(e: DragEvent) => this.#onDragOver(e, key, row)}
        @dragover=${(e: DragEvent) => this.#onDragOver(e, key, row)}
        @drop=${(e: DragEvent) => this.#onDrop(e, key, row)}
        @dragend=${() => this.#endDrag()}
        @pointerdown=${(e: PointerEvent) => this.#onPointerDown(e, key, row)}
      >
        ${this.selectable
          ? html`<td class="pick" @click=${this.#notePickClick}>
              <wa-checkbox size="s" .checked=${selected} @change=${() => this.#onPick(key)}
                ><span class="vh">Select ${name}</span></wa-checkbox
              >
            </td>`
          : nothing}
        ${columns.map((c, i) => {
          const cell = this.#cell(c, row, key, state, now);
          return html`<td part="cell" class=${this.#cellClass(c, i)} style=${widthOf(c)}>${nested && i === 0 ? this.#nested(entry, cell) : cell}</td>`;
        })}
        ${rowActions.length ? html`<td class="actions">${this.#rowActions(rowActions, row, key, name, state)}</td>` : nothing}
      </tr>
      ${open && this.detail
        ? html`<tr class="detail">
            <td part="detail" colspan=${span}>
              <slot name=${detailSlotOf(key)}></slot>
            </td>
          </tr>`
        : nothing}`;
  }

  #onPick(key: string) {
    const model = this.#model!;
    if (this.rowSelect && this.#shiftOnCheckbox) model.extendTo(key);
    else model.toggle(key);
    this.#shiftOnCheckbox = false;
  }

  /** The first cell of a nested list: its indent, and the control that opens the row. */
  #nested(entry: RowEntry<T>, body: unknown) {
    return html`<div class="nested" style="--sub-level:${entry.level - 1}">
      ${entry.expandable
        ? html`<button
            class="twisty"
            tabindex="-1"
            aria-hidden="true"
            data-open=${String(entry.open)}
            @click=${() => {
              this.#toggleRow(entry);
              this.#focus(entry.id);
            }}
          >
            ${twisty}
          </button>`
        : html`<span class="twisty-gap"></span>`}
      <div class="nested-body">${body}</div>
    </div>`;
  }

  /** What stands in an open row's level: a status in place of its rows, or its "Load more". */
  #levelLine(entry: Exclude<TableEntry<T>, { kind: 'row' }>, index: number, line: RowLine<T, S>) {
    const model = this.#model!;
    const aria = (body: TemplateResult) => html`<td colspan=${line.span}>
      <div class="nested" style="--sub-level:${entry.level - 1}"><span class="twisty-gap"></span>${body}</div>
    </td>`;
    if (entry.kind === 'more') {
      return html`<tr
        class="level-line"
        data-entry=${entry.id}
        tabindex=${entry.id === line.tabStop ? '0' : '-1'}
        aria-rowindex=${index + 2}
        aria-level=${entry.level}
      >
        ${aria(html`<span class="level-note">
          <wa-button size="s" appearance="plain" ?loading=${entry.loading} @click=${() => model.moreIn(entry.parent)}>Load more</wa-button>
          ${entry.message ? html`<span role="status">${entry.message}</span>` : nothing}
        </span>`)}
      </tr>`;
    }
    const body =
      entry.phase === 'loading'
        ? html`<span class="level-note"><wa-spinner></wa-spinner> Loading…</span>`
        : entry.phase === 'empty'
          ? html`<span class="level-note">${this.empty}</span>`
          : entry.phase === 'forbidden'
            ? html`<span class="level-note" role="status">${this.forbiddenText}</span>`
            : html`<span class="level-note" role="alert">
                <strong>Could not load.</strong> ${entry.message ?? ''}
                <wa-button size="s" appearance="outlined" @click=${() => model.reloadLevel(entry.parent)}>Try again</wa-button>
              </span>`;
    return html`<tr class="level-line" aria-rowindex=${index + 2} aria-level=${entry.level}>${aria(body)}</tr>`;
  }

  #rowActions(actions: RowAction<T>[], row: T, key: string, name: string, state: TableState<T, S>) {
    const chosen = actions.some((a) => a.menu);
    const inline = chosen ? actions.filter((a) => !a.menu) : actions.length <= INLINE_ACTIONS ? actions : actions.slice(0, 1);
    const more = actions.filter((a) => !inline.includes(a));
    const busy = state.busy === key;
    const blocked = state.busy !== null && !busy;
    return html`${inline.map(
      (a) => html`<wa-button
        size="s"
        appearance="plain"
        variant=${a.tone === 'danger' ? 'danger' : 'neutral'}
        ?loading=${busy}
        ?disabled=${blocked}
        title=${a.icon ? a.label : nothing}
        @click=${() => this.#run(a, row)}
        >${a.icon ? html`${this.#icon(a.icon)}<span class="vh">${a.label} ${name}</span>` : html`${a.label}<span class="vh"> ${name}</span>`}</wa-button
      >`,
    )}${more.length
      ? html`<wa-dropdown
          @wa-select=${(e: CustomEvent<{ item: { value: string } }>) => {
            const action = more.find((a) => a.id === e.detail.item.value);
            if (action) void this.#run(action, row);
          }}
        >
          <wa-button slot="trigger" size="s" appearance="plain" ?disabled=${blocked}
            >⋯<span class="vh">More actions for ${name}</span></wa-button
          >
          ${more.map(
            (a) =>
              html`<wa-dropdown-item value=${a.id} variant=${a.tone === 'danger' ? 'danger' : 'default'}
                >${a.icon ? this.#icon(a.icon, 'icon') : nothing}${a.label}</wa-dropdown-item
              >`,
          )}
        </wa-dropdown>`
      : nothing}`;
  }

  #icon(icon: NonNullable<RowAction<T>['icon']>, slot?: string) {
    return typeof icon === 'string'
      ? html`<wa-icon slot=${slot ?? nothing} name=${icon} aria-hidden="true"></wa-icon>`
      : html`<wa-icon slot=${slot ?? nothing} src=${icon.src} aria-hidden="true"></wa-icon>`;
  }

  #footer(state: TableState<T, S>) {
    if (state.mode === 'search') {
      const n = state.rows.length;
      const said = state.capped
        ? `The first ${n} matches. Add a word to narrow the search.`
        : `${n} ${n === 1 ? 'match' : 'matches'}`;
      return html`<footer part="footer"><span>${said}</span></footer>`;
    }
    return this.paging === 'more' || this.paging === 'scroll' ? this.#more(state) : this.#pager(state);
  }

  #more(state: TableState<T, S>) {
    if (!state.next && state.total === null) return nothing;
    const shown = state.total === null ? `${state.rows.length} shown` : `${state.rows.length} of ${state.total}`;
    return html`<footer part="footer">
      <span aria-live=${this.paging === 'scroll' ? 'polite' : nothing}>${shown}</span>
      ${state.next
        ? html`<wa-button size="s" appearance="outlined" ?loading=${state.loadingMore} @click=${() => this.#model!.more()}
            >Load more</wa-button
          >`
        : nothing}
    </footer>`;
  }

  /**
   * "21–40 of 132", rows per page, Previous and Next. No page numbers: a keyset walk cannot
   * jump to page 7, and pretending it can means an offset, which drops and repeats rows on a
   * table someone is writing to.
   */
  #pager(state: TableState<T, S>) {
    const model = this.#model!;
    const first = state.page === 0;
    // A single short first page needs no pager — unless its size is the reason it is short.
    if (first && !state.next && state.rows.length < Math.min(...this.pageSizes)) {
      return state.total === null ? nothing : html`<footer part="footer"><span>${state.total} in all</span></footer>`;
    }
    const from = state.offset + 1;
    const to = state.offset + state.rows.length;
    const range = `${from}–${to}${state.total === null ? '' : ` of ${state.total}`}`;
    const busy = state.refreshing;
    return html`<footer part="footer" class="pager">
      <span aria-live="polite">${range}</span>
      <span class="pages">
        <wa-select
          size="s"
          class="size"
          .value=${String(state.query.limit ?? this.pageSize)}
          @change=${(e: Event) => this.#changed(model.setPageSize(Number((e.target as HTMLSelectElement).value)))}
        >
          <span slot="label" class="vh">Rows per page</span>
          ${this.pageSizes.map((n) => html`<wa-option value=${String(n)}>${n} per page</wa-option>`)}
        </wa-select>
        <wa-button size="s" appearance="outlined" ?disabled=${first || busy} @click=${() => model.prevPage()}
          >‹ Previous</wa-button
        >
        <wa-button size="s" appearance="outlined" ?disabled=${!state.next || busy} @click=${() => model.nextPage()}
          >Next ›</wa-button
        >
      </span>
    </footer>`;
  }

  async #run(action: RowAction<T>, row: T) {
    const model = this.#model!;
    await model.run(action, row);
    if (!model.state.problem) this.#done(action, [row]);
  }

  async #runBulk(action: RowAction<T>) {
    const done = await this.#model!.runBulk(action);
    if (done.length) this.#done(action, done);
  }

  #done(action: RowAction<T>, rows: T[]) {
    this.dispatchEvent(new CustomEvent('sub-action-done', { detail: { action: action.id, rows }, bubbles: true, composed: true }));
  }
}

if (!customElements.get('sub-entity-table')) customElements.define('sub-entity-table', SubEntityTable);

declare global {
  interface HTMLElementTagNameMap {
    'sub-entity-table': SubEntityTable;
  }
}
