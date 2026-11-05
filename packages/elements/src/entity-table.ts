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
 * Attributes: `label` (the table's accessible name), `empty`, `forbidden-text`,
 *   `search-label`, `selectable`, `density="compact"`, `paging` (`pages`, the default —
 *   Previous / Next with "21–40 of 132" — or `more`, one "Load more" that appends), and
 *   `page-size` (25). `pageSizes` is the property behind the rows-per-page picker.
 *   `column-picker` adds a "Columns" button: show, hide and reorder the columns. Opt-in;
 *   without it the columns are exactly the ones given. `layout-key` keeps the chosen layout
 *   in this browser under that key; a screen that would rather keep it on the account
 *   listens for `sub-layout-change` and hands it back through `layout`.
 * Slot: `empty` — what an empty view says, in place of `empty` (a "Create" button, say).
 * Events: `sub-action-done` `{ action, rows }` after an action succeeded on some rows;
 *   `sub-query-change` `{ query }` whenever the person changes the view, sort, filters or search;
 *   `sub-layout-change` `{ layout }` whenever they show, hide or move a column.
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
 * (plus `selected`), `cell`, `footer`, `empty`.
 */
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
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

/** At most this many actions show on a row; past that, the first stays and the rest go in "More". */
const INLINE_ACTIONS = 2;

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

const arrow = (order: 'asc' | 'desc' | null) =>
  svg`<svg class="arrow" viewBox="0 0 12 12" aria-hidden="true" data-order=${order ?? 'none'}>
    <path d="M6 2.5 9 6H3z" class="up"/><path d="M6 9.5 3 6h6z" class="down"/>
  </svg>`;

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
  declare columnPicker: boolean;
  declare layoutKey: string | undefined;
  declare label: string;
  declare empty: string;
  declare forbiddenText: string;
  declare searchLabel: string;
  declare selectable: boolean;
  declare density: 'comfortable' | 'compact';
  declare paging: 'pages' | 'more';
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

  constructor() {
    super();
    this.columns = [];
    this.actions = [];
    this.views = [];
    this.filters = [];
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

  /** Read again with the current query — after the host created a row, say. */
  reload(): Promise<void> {
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
    if (changed.has('source') && this.source) {
      const view = this.query?.view ?? this.views[0]?.id ?? null;
      this.#model = new EntityTableModel<T, S>(this.source, (state) => (this.view = state), {
        query: { limit: this.pageSize, ...this.query, view },
      });
      this.view = this.#model.state;
      void this.#model.load();
    }
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#fit();
    this.#syncMounts();
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
    const rows = this.view?.phase === 'ready' ? this.view.rows : [];
    const wanted = new Set<string>();
    if (model) {
      for (const row of rows) {
        for (const column of mounting) {
          const slot = slotOf(column.key, model.keyOf(row));
          wanted.add(slot);
          const known = this.#mounted.get(slot);
          if (known && known.row === row) continue;
          if (known?.handle?.update) {
            known.handle.update(row);
            known.row = row;
            continue;
          }
          if (known) this.#unmount(slot);
          const el = document.createElement('div');
          el.slot = slot;
          el.dataset['subCell'] = column.key;
          this.append(el);
          this.#mounted.set(slot, { el, row, handle: column.mount!(el, row) });
        }
      }
    }
    for (const slot of [...this.#mounted.keys()]) if (!wanted.has(slot)) this.#unmount(slot);
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
    tbody tr:hover td {
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
    if (this.selectable && state.selected.size > 0) {
      const bulk = actionsIn(this.actions, state.query.view, true);
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
    return html`<th scope="col" part="header-cell" class=${this.#cellClass(c, index)} aria-sort=${ariaSort}>
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
    const keys = state.rows.map(model.keyOf);
    const picked = keys.filter((k) => state.selected.has(k)).length;
    const now = new Date();
    const columns = this.#shown;
    return html`<div class="scroll">
        <table part="table" class=${state.refreshing ? 'refreshing' : ''}>
          ${this.label ? html`<caption class="vh">${this.label}</caption>` : nothing}
          <thead>
            <tr>
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
          <tbody>
            ${state.rows.map((row, r) => {
              const key = keys[r]!;
              const selected = state.selected.has(key);
              const name = this.columns[0] ? cellText(this.columns[0], row, now).text : key;
              return html`<tr part=${selected ? 'row selected' : 'row'} class=${selected ? 'selected' : ''}>
                ${this.selectable
                  ? html`<td class="pick">
                      <wa-checkbox size="s" .checked=${selected} @change=${() => model.toggle(key)}
                        ><span class="vh">Select ${name}</span></wa-checkbox
                      >
                    </td>`
                  : nothing}
                ${columns.map(
                  (c, i) => html`<td part="cell" class=${this.#cellClass(c, i)}>${this.#cell(c, row, key, state, now)}</td>`,
                )}
                ${rowActions.length ? html`<td class="actions">${this.#rowActions(rowActions, row, key, name, state)}</td>` : nothing}
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      ${this.#footer(state)}`;
  }

  #rowActions(actions: RowAction<T>[], row: T, key: string, name: string, state: TableState<T, S>) {
    const inline = actions.length <= INLINE_ACTIONS ? actions : actions.slice(0, 1);
    const more = actions.slice(inline.length);
    const busy = state.busy === key;
    const blocked = state.busy !== null && !busy;
    return html`${inline.map(
      (a) => html`<wa-button
        size="s"
        appearance="plain"
        variant=${a.tone === 'danger' ? 'danger' : 'neutral'}
        ?loading=${busy}
        ?disabled=${blocked}
        @click=${() => this.#run(a, row)}
        >${a.label}<span class="vh"> ${name}</span></wa-button
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
                >${a.label}</wa-dropdown-item
              >`,
          )}
        </wa-dropdown>`
      : nothing}`;
  }

  #footer(state: TableState<T, S>) {
    if (state.mode === 'search') {
      const n = state.rows.length;
      const said = state.capped
        ? `The first ${n} matches. Add a word to narrow the search.`
        : `${n} ${n === 1 ? 'match' : 'matches'}`;
      return html`<footer part="footer"><span>${said}</span></footer>`;
    }
    return this.paging === 'more' ? this.#more(state) : this.#pager(state);
  }

  #more(state: TableState<T, S>) {
    if (!state.next && state.total === null) return nothing;
    const shown = state.total === null ? `${state.rows.length} shown` : `${state.rows.length} of ${state.total}`;
    return html`<footer part="footer">
      <span>${shown}</span>
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
