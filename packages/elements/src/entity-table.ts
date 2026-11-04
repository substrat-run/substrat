/**
 * `<sub-entity-table>` — the rows of one paged read, with the actions a row allows.
 *
 * A renderer over `EntityTableModel`: it draws the state and forwards clicks, and decides
 * nothing the model does not. Styled only through Web Awesome's `--wa-*` tokens, so it
 * follows whatever theme the page sets — Web Awesome's own, or a Substrat one — with no
 * theme code in here. Uses Web Awesome's free controls inside.
 *
 * Properties (not attributes — they are objects and functions):
 *   `source`  — `{ first, follow }`, usually `{ first: () => api.myLists({}), follow: api.follow }`
 *   `columns` — `Column[]`; `priority` 3, then 2, drop out while the table overflows
 *   `actions` — `RowAction[]`, run through the model (403 / 409 / 404 handled there)
 * Attributes: `label` (the table's accessible name), `empty`, `forbidden-text`.
 * Event: `sub-action-done` with `{ action, row }` after an action succeeded.
 */
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { css, html, nothing, type PropertyValues } from 'lit';
import SubstratElement from './internal/substrat-element.js';
import { EntityTableModel, type Column, type RowAction, type TableSource, type TableState } from './entity-table-model.js';

export class SubEntityTable<T = unknown> extends SubstratElement {
  static properties = {
    source: { attribute: false },
    columns: { attribute: false },
    actions: { attribute: false },
    label: {},
    empty: {},
    forbiddenText: { attribute: 'forbidden-text' },
    view: { state: true },
  };

  declare source: TableSource<T> | undefined;
  declare columns: Column<T>[];
  declare actions: RowAction<T>[];
  declare label: string;
  declare empty: string;
  declare forbiddenText: string;
  declare view: TableState<T> | undefined;

  #model: EntityTableModel<T> | undefined;
  #resize = new ResizeObserver(() => this.#fit());

  connectedCallback(): void {
    super.connectedCallback();
    this.#resize.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#resize.disconnect();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#fit();
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
    this.removeAttribute('drop');
    if (!scroll) return;
    for (const level of ['3', '2']) {
      if (scroll.scrollWidth <= scroll.clientWidth) return;
      this.setAttribute('drop', level);
    }
  }

  constructor() {
    super();
    this.columns = [];
    this.actions = [];
    this.label = '';
    this.empty = 'Nothing here.';
    this.forbiddenText = 'You do not have access to this.';
  }

  /** Read again from the first page — after the host created a row, say. */
  reload(): Promise<void> {
    return this.#model?.load() ?? Promise.resolve();
  }

  protected willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('source') && this.source) {
      this.#model = new EntityTableModel(this.source, (state) => (this.view = state));
      this.view = this.#model.state;
      void this.#model.load();
    }
  }

  static css = css`
    :host {
      display: block;
      font-family: var(--wa-font-family-body);
      color: var(--wa-color-text-normal);
    }
    .frame {
      background: var(--wa-color-surface-default);
      border: var(--wa-panel-border-width) var(--wa-panel-border-style) var(--wa-color-surface-border);
      border-radius: var(--wa-panel-border-radius);
      overflow: hidden;
    }
    wa-callout {
      margin: var(--wa-space-s);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--wa-font-size-s);
      font-variant-numeric: tabular-nums;
    }
    th {
      text-align: start;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      letter-spacing: 0.02em;
      padding: var(--wa-space-xs) var(--wa-space-m);
      background: var(--wa-color-surface-lowered);
      border-bottom: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    }
    td {
      padding: var(--wa-space-xs) var(--wa-space-m);
      height: calc(var(--wa-form-control-height) + var(--wa-space-2xs));
      border-top: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    }
    /* Values stay on one line; the first column takes the slack and is the one that wraps. */
    th,
    td {
      white-space: nowrap;
    }
    th:first-child,
    td:first-child {
      white-space: normal;
      width: 100%;
      min-width: 9rem;
    }
    /* The last resort when the columns still left are wider than the frame: scroll the
       table, never clip the actions off its edge. */
    .scroll {
      overflow-x: auto;
    }
    tbody tr:first-child td {
      border-top: 0;
    }
    tbody tr:hover td {
      background: var(--wa-color-neutral-fill-quiet);
    }
    .end {
      text-align: end;
    }
    .actions {
      text-align: end;
      white-space: nowrap;
      width: 1%;
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
    .note {
      padding: var(--wa-space-xl) var(--wa-space-m);
      text-align: center;
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
    footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wa-space-s);
      padding: var(--wa-space-xs) var(--wa-space-m);
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
    return html`<div class="frame" aria-busy=${state.phase === 'loading' ? 'true' : 'false'}>
      ${this.#problem(state)} ${this.#body(state)}
    </div>`;
  }

  #problem(state: TableState<T>) {
    const p = state.problem;
    if (!p || state.phase === 'error') return nothing;
    const variant = p.kind === 'refused' ? 'warning' : p.kind === 'stale' ? 'neutral' : 'danger';
    const lead = p.kind === 'refused' ? 'Not allowed.' : p.kind === 'stale' ? '' : 'Something went wrong.';
    return html`<wa-callout variant=${variant} size="s" role="status">
      ${lead ? html`<strong>${lead}</strong> ` : nothing}${p.message}
    </wa-callout>`;
  }

  #body(state: TableState<T>) {
    switch (state.phase) {
      case 'loading':
        return html`<div class="note"><wa-spinner label="Loading"></wa-spinner></div>`;
      case 'forbidden':
        return html`<wa-callout variant="warning" size="s">${this.forbiddenText}</wa-callout>`;
      case 'error':
        return html`<wa-callout variant="danger" size="s">
          <strong>Could not load.</strong> ${state.problem?.message ?? ''}
          <wa-button size="s" appearance="outlined" @click=${() => this.reload()}>Try again</wa-button>
        </wa-callout>`;
      case 'ready':
        return state.rows.length === 0 ? html`<p class="note">${this.empty}</p>` : this.#table(state);
    }
  }

  #table(state: TableState<T>) {
    const model = this.#model!;
    const cellClass = (c: Column<T>) => [`p${c.priority ?? 1}`, c.align === 'end' ? 'end' : ''].join(' ');
    return html`<div class="scroll">
        <table>
        ${this.label ? html`<caption class="vh">${this.label}</caption>` : nothing}
        <thead>
          <tr>
            ${this.columns.map((c) => html`<th scope="col" class=${cellClass(c)}>${c.label}</th>`)}
            ${this.actions.length ? html`<th scope="col" class="actions"><span class="vh">Actions</span></th>` : nothing}
          </tr>
        </thead>
        <tbody>
          ${state.rows.map((row) => {
            const key = model.keyOf(row);
            return html`<tr>
              ${this.columns.map((c) => {
                const href = c.href?.(row);
                const value = c.value(row);
                return html`<td class=${cellClass(c)}>${href ? html`<a href=${href}>${value}</a>` : value}</td>`;
              })}
              ${this.actions.length
                ? html`<td class="actions">
                    ${this.actions.map(
                      (a) => html`<wa-button
                        size="s"
                        appearance="plain"
                        variant=${a.tone === 'danger' ? 'danger' : 'neutral'}
                        ?loading=${state.busy === key}
                        ?disabled=${state.busy !== null && state.busy !== key}
                        @click=${() => this.#run(a, row)}
                        >${a.label}</wa-button
                      >`,
                    )}
                  </td>`
                : nothing}
            </tr>`;
          })}
        </tbody>
        </table>
      </div>
      ${this.#footer(state)}`;
  }

  #footer(state: TableState<T>) {
    if (!state.next && state.total === null) return nothing;
    const shown = state.total === null ? `${state.rows.length} shown` : `${state.rows.length} of ${state.total}`;
    return html`<footer>
      <span>${shown}</span>
      ${state.next
        ? html`<wa-button size="s" appearance="outlined" ?loading=${state.loadingMore} @click=${() => this.#model!.more()}
            >Load more</wa-button
          >`
        : nothing}
    </footer>`;
  }

  async #run(action: RowAction<T>, row: T) {
    const model = this.#model!;
    await model.run(action, row);
    if (!model.state.problem) {
      this.dispatchEvent(new CustomEvent('sub-action-done', { detail: { action: action.id, row }, bubbles: true, composed: true }));
    }
  }
}

if (!customElements.get('sub-entity-table')) customElements.define('sub-entity-table', SubEntityTable);

declare global {
  interface HTMLElementTagNameMap {
    'sub-entity-table': SubEntityTable;
  }
}
