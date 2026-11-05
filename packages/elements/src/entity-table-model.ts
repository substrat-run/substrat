/**
 * What an entity table knows, with no DOM in it.
 *
 * The element renders this and forwards clicks; everything that decides what the screen
 * says lives here, so a second renderer (React Native, later) gets the same answers from
 * the same code. The contract is the one a vertical's generated client already speaks:
 * a read returns a `Page` (`entries`, `next`, `total`), `next` is followed rather than
 * reassembled, and a refusal is a 403 on the error's `status`.
 *
 * The table owns a QUERY — the view, the sort, the equality filters, the search term —
 * and hands it to `source.read`. What the query may say is what the read declares: `sort`
 * is one of its `sortable` columns, a filter one of its `filterable` ones, and the
 * generated client types both, so a sort with no index behind it does not compile. Paging
 * is the keyset walk the platform has: forward through `next`, never a jump to "page 7 of
 * 40". Previous works anyway — the table keeps the `next` link that led to each page it has
 * shown, so going back re-reads exactly the page it came from.
 * Search is a different read — ranked and capped, not sorted and paged — so a term
 * switches the table into search mode rather than into a filtered page.
 *
 * Answers a hand-written list screen keeps getting wrong, held here once:
 *
 *   - a 403 on the read is a WALL ("you may not see this"), never an empty list;
 *   - a 403 on a row action is about that row: the rows stay, the refusal is shown;
 *   - a 409 or 404 on a row action means the view went stale (another tab moved it),
 *     so the view is read again before the problem is shown;
 *   - an empty answer to a search or a filter is "no matches", not "nothing here";
 *   - a capped search says so, rather than passing its first N off as all of them;
 *   - a re-sort keeps the rows it is replacing on screen until the new ones land.
 */

/** One page of a paged read — the generated client's `Paged<T>`, structurally. */
export interface Page<T> {
  entries: T[];
  /** A URL to follow, or null when the walk is over. */
  next: string | null;
  total: number | null;
}

/** A capped search read's answer — `{ results, capped }`, as a vertical's search ops return it. */
export interface SearchResult<T> {
  results: T[];
  capped: boolean;
}

/** What the table asks its source for. `S` is the read's sortable columns. */
export interface TableQuery<S extends string = string> {
  /** The id of the chosen view, or null when the table declares none. */
  view: string | null;
  /** A declared sortable column, or null for the read's own default order. */
  sort: S | null;
  order: 'asc' | 'desc';
  /** Equality filters by declared filterable column. An absent key is "any". */
  filters: Readonly<Record<string, string>>;
  /** The search term as typed. Shorter than the source's minimum, it searches nothing. */
  q: string;
  /** Rows per page, or null for the read's own default. Pass it on as the read's `limit`. */
  limit: number | null;
}

/** Where the rows come from. `read` is the generated client's read; `follow` its `follow`. */
export interface TableSource<T, S extends string = string> {
  read(query: TableQuery<S>): Promise<Page<T>>;
  follow(next: string): Promise<Page<T>>;
  /** The entity's search read, when it has one. Its answer replaces the page. */
  search?(q: string, query: TableQuery<S>): Promise<SearchResult<T>>;
  /**
   * The views search covers, when it does not cover them all — an index that leaves archived
   * rows out cannot search the archive, and a search box over it would answer "no matches".
   */
  searchViews?: readonly string[];
}

/** How a cell's value is drawn. Every kind is a fact about the field, not about a screen. */
export type CellKind = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'relative' | 'badge' | 'boolean' | 'code';

export type Tone = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

/** The renderer-independent half of a column. */
export interface ColumnSpec<T, S extends string = string> {
  key: string;
  label: string;
  /** Defaults to `row[key]`. */
  value?(row: T): unknown;
  /** Defaults to `text`. */
  kind?: CellKind;
  /** For `badge`: a tone per value. An unlisted value is `neutral`. */
  tones?: Readonly<Record<string, Tone>>;
  /** For `money`: an ISO 4217 code. Money is a decimal string, and is formatted as one. */
  currency?: string;
  /** Makes the cell a link. Given the query, so a view (the trash, say) can link nowhere. */
  href?(row: T, query: TableQuery<S>): string | null;
  /** The declared sortable column this column sorts by. Absent, the header is not a button. */
  sort?: S;
  /**
   * 1 always shows; 2 hides on a narrow table; 3 hides first. Intent rather than a pixel
   * width, so a renderer that is not a browser can honour it too.
   */
  priority?: 1 | 2 | 3;
  align?: 'start' | 'end';
}

export interface RowAction<T> {
  id: string;
  label: string;
  tone?: 'neutral' | 'danger';
  /** The views it is offered in. Absent, every view. */
  views?: readonly string[];
  /** Also offered for a selection, run once per selected row. */
  bulk?: boolean;
  run(row: T): Promise<unknown>;
}

export type Phase = 'loading' | 'ready' | 'forbidden' | 'error';

/** Something to say above the rows that does not replace them. */
export interface Problem {
  kind: 'refused' | 'stale' | 'failed';
  message: string;
}

export interface TableState<T, S extends string = string> {
  phase: Phase;
  query: TableQuery<S>;
  /** `search` when the rows are a search's results: ranked, unpaged, maybe capped. */
  mode: 'page' | 'search';
  rows: T[];
  next: string | null;
  total: number | null;
  /** Which page is on screen, from 0, when the table pages rather than appends. */
  page: number;
  /** How many rows came before this page — so the footer can say "21–40". */
  offset: number;
  /** The search stopped at its limit; there are more matches than rows. */
  capped: boolean;
  loadingMore: boolean;
  /** A re-read is in flight over rows still on screen (a re-sort, a new view). */
  refreshing: boolean;
  /** Key of the row whose action is in flight, or `BULK` while a selection's runs. */
  busy: string | null;
  selected: ReadonlySet<string>;
  problem: Problem | null;
}

/** `busy` while an action runs over a selection rather than one row. */
export const BULK = '\u0000bulk';

export interface TableOptions<T, S extends string = string> {
  keyOf?: (row: T) => string;
  /** The query the first read is made with. */
  query?: Partial<TableQuery<S>>;
  /** The shortest term that searches. Two is the platform's prefix-index floor. */
  minSearch?: number;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NONE: ReadonlySet<string> = new Set();

export class EntityTableModel<T, S extends string = string> {
  state: TableState<T, S>;
  readonly keyOf: (row: T) => string;
  readonly minSearch: number;

  /** Bumped by every read, so an answer that lands after a newer one is dropped, not shown. */
  #generation = 0;

  /**
   * How to read each page shown so far: the first is the query itself (null), every later one
   * the `next` link the page before it handed out. A cursor is a position, so re-following one
   * re-reads that page as it is now — which is what a reload after an action wants.
   */
  #trail: (string | null)[] = [null];
  /** Where each page shown so far starts, beside `#trail`. */
  #offsets: number[] = [0];

  constructor(
    private readonly source: TableSource<T, S>,
    private readonly onChange: (state: TableState<T, S>) => void,
    options: TableOptions<T, S> = {},
  ) {
    this.keyOf = options.keyOf ?? ((row) => String((row as { id?: unknown }).id));
    this.minSearch = options.minSearch ?? 2;
    this.state = {
      phase: 'loading',
      query: { view: null, sort: null, order: 'asc', filters: {}, q: '', limit: null, ...options.query },
      mode: 'page',
      rows: [],
      next: null,
      total: null,
      page: 0,
      offset: 0,
      capped: false,
      loadingMore: false,
      refreshing: false,
      busy: null,
      selected: NONE,
      problem: null,
    };
  }

  #set(patch: Partial<TableState<T, S>>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** The current view is one the source can search. */
  get searchable(): boolean {
    const { search, searchViews } = this.source;
    const { view } = this.state.query;
    return Boolean(search) && (!searchViews || view === null || searchViews.includes(view));
  }

  /** The term is long enough to search, and there is a search to ask in this view. */
  get searching(): boolean {
    return this.searchable && this.state.query.q.trim().length >= this.minSearch;
  }

  /**
   * Read the page on screen again, with the current query. Keeps a `problem` it is told to,
   * so a reload can carry one.
   */
  async load(keep: Problem | null = null): Promise<void> {
    const generation = ++this.#generation;
    const { query, page } = this.state;
    const link = this.#trail[page] ?? null;
    const shown = this.state.phase === 'ready';
    this.#set(shown ? { refreshing: true } : { phase: 'loading' });
    try {
      const patch: Partial<TableState<T, S>> & { rows: T[] } = this.searching
        ? await this.source.search!(query.q.trim(), query).then((r) => ({
            mode: 'search' as const,
            rows: r.results,
            next: null,
            total: null,
            capped: r.capped,
          }))
        : await (link === null ? this.source.read(query) : this.source.follow(link)).then((p) => ({
            mode: 'page' as const,
            rows: p.entries,
            next: p.next,
            total: p.total,
            capped: false,
          }));
      if (generation !== this.#generation) return;
      // The last row of a later page went (deleted here, or elsewhere): show the page before.
      if (patch.rows.length === 0 && page > 0 && link !== null) return this.#goTo(page - 1, keep);
      // A selection names rows; one the new read no longer has is not selected any more.
      const keys = new Set(patch.rows.map(this.keyOf));
      const selected = new Set([...this.state.selected].filter((k) => keys.has(k)));
      this.#set({ ...patch, phase: 'ready', loadingMore: false, refreshing: false, selected, problem: keep });
    } catch (error) {
      if (generation !== this.#generation) return;
      if (statusOf(error) === 403) {
        this.#set({
          phase: 'forbidden',
          rows: [],
          next: null,
          total: null,
          loadingMore: false,
          refreshing: false,
          selected: NONE,
          problem: null,
        });
      } else if (shown) {
        // A failed re-read is a blip over rows we still have, not a reason to drop them.
        this.#set({ refreshing: false, problem: { kind: 'failed', message: messageOf(error) } });
      } else {
        this.#set({ phase: 'error', problem: { kind: 'failed', message: messageOf(error) } });
      }
    }
  }

  /** Change the query and read again, from the first page. A new view starts with nothing selected. */
  setQuery(patch: Partial<TableQuery<S>>): Promise<void> {
    const query = { ...this.state.query, ...patch };
    const selected = patch.view !== undefined && patch.view !== this.state.query.view ? NONE : this.state.selected;
    this.#trail = [null];
    this.#offsets = [0];
    this.#set({ query, selected, page: 0, offset: 0 });
    return this.load();
  }

  /** The page after this one, through the `next` link it handed out. */
  nextPage(): Promise<void> {
    const { next, page, offset, rows, mode } = this.state;
    if (!next || mode === 'search' || this.state.loadingMore) return Promise.resolve();
    this.#trail = [...this.#trail.slice(0, page + 1), next];
    this.#offsets = [...this.#offsets.slice(0, page + 1), offset + rows.length];
    return this.#goTo(page + 1);
  }

  /** The page before this one, re-read through the link that led to it. */
  prevPage(): Promise<void> {
    return this.state.page > 0 ? this.#goTo(this.state.page - 1) : Promise.resolve();
  }

  /** Rows per page. A new size starts again from the first page. */
  setPageSize(limit: number): Promise<void> {
    return this.setQuery({ limit });
  }

  #goTo(page: number, keep: Problem | null = null): Promise<void> {
    this.#set({ page, offset: this.#offsets[page] ?? 0 });
    return this.load(keep);
  }

  /** A header press: ascending, then descending, then back to the read's own order. */
  sortBy(column: S): Promise<void> {
    const { sort, order } = this.state.query;
    if (sort !== column) return this.setQuery({ sort: column, order: 'asc' });
    if (order === 'asc') return this.setQuery({ order: 'desc' });
    return this.setQuery({ sort: null, order: 'asc' });
  }

  filter(key: string, value: string | null): Promise<void> {
    const rest = { ...this.state.query.filters };
    delete rest[key];
    return this.setQuery({ filters: value === null || value === '' ? rest : { ...rest, [key]: value } });
  }

  /**
   * A new search term. Typing the first letter, or deleting down to one, changes nothing
   * the server is asked, so it reads nothing: only crossing the minimum, or a new term
   * past it, does.
   */
  search(q: string): Promise<void> {
    const before = this.searching;
    this.#set({ query: { ...this.state.query, q } });
    if (!before && !this.searching) return Promise.resolve();
    // Into a search, or back out of one: either way the answer starts at its first page.
    this.#trail = [null];
    this.#offsets = [0];
    this.#set({ page: 0, offset: 0 });
    return this.load();
  }

  /** Drop the search term and every filter — what "No matches" offers. */
  clear(): Promise<void> {
    return this.setQuery({ q: '', filters: {} });
  }

  async more(): Promise<void> {
    const { next, loadingMore } = this.state;
    if (!next || loadingMore) return;
    const generation = this.#generation;
    this.#set({ loadingMore: true });
    try {
      const page = await this.source.follow(next);
      if (generation !== this.#generation) return;
      this.#set({ rows: [...this.state.rows, ...page.entries], next: page.next, loadingMore: false });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#set({ loadingMore: false, problem: { kind: 'failed', message: messageOf(error) } });
    }
  }

  toggle(key: string): void {
    const selected = new Set(this.state.selected);
    if (!selected.delete(key)) selected.add(key);
    this.#set({ selected });
  }

  /** Select every row on screen, or none if they all are. Rows not yet loaded are not "all". */
  toggleAll(): void {
    const keys = this.state.rows.map(this.keyOf);
    const all = keys.length > 0 && keys.every((k) => this.state.selected.has(k));
    this.#set({ selected: all ? NONE : new Set(keys) });
  }

  clearSelection(): void {
    this.#set({ selected: NONE });
  }

  get selectedRows(): T[] {
    return this.state.rows.filter((row) => this.state.selected.has(this.keyOf(row)));
  }

  async run(action: RowAction<T>, row: T): Promise<void> {
    if (this.state.busy) return;
    this.#set({ busy: this.keyOf(row), problem: null });
    try {
      await action.run(row);
      this.#set({ busy: null });
      await this.load();
    } catch (error) {
      const status = statusOf(error);
      this.#set({ busy: null });
      if (status === 409 || status === 404) {
        await this.load({ kind: 'stale', message: 'This changed somewhere else. The view was refreshed.' });
      } else {
        this.#set({ problem: { kind: status === 403 ? 'refused' : 'failed', message: messageOf(error) } });
      }
    }
  }

  /**
   * Run an action once per selected row, then read once. One row's refusal does not stop
   * the rest — each is its own operation on the server, so each answers for itself — and
   * the summary counts them, because "3 of 5 done" is what a person needs to know.
   * Returns the rows it succeeded on.
   */
  async runBulk(action: RowAction<T>): Promise<T[]> {
    const rows = this.selectedRows;
    if (this.state.busy || rows.length === 0) return [];
    this.#set({ busy: BULK, problem: null });
    const done: T[] = [];
    let refused = 0;
    let stale = 0;
    let failed = 0;
    let last = '';
    for (const row of rows) {
      try {
        await action.run(row);
        done.push(row);
      } catch (error) {
        const status = statusOf(error);
        if (status === 403) refused++;
        else if (status === 409 || status === 404) stale++;
        else {
          failed++;
          last = messageOf(error);
        }
      }
    }
    this.#set({ busy: null, selected: NONE });
    const parts = [
      refused ? `${refused} not allowed` : '',
      stale ? `${stale} changed somewhere else` : '',
      failed ? `${failed} failed${last ? ` (${last})` : ''}` : '',
    ].filter(Boolean);
    const problem: Problem | null = parts.length
      ? {
          kind: refused ? 'refused' : stale ? 'stale' : 'failed',
          message: `${action.label}: ${done.length} of ${rows.length} done; ${parts.join(', ')}.`,
        }
      : null;
    await this.load(problem);
    return done;
  }
}

/** The actions a view offers on a row, or for a selection. */
export const actionsIn = <T>(actions: readonly RowAction<T>[], view: string | null, bulk = false): RowAction<T>[] =>
  actions.filter((a) => (!a.views || view === null || a.views.includes(view)) && (!bulk || a.bulk));

/** Why a ready table has no rows: nothing exists, or nothing matches what was asked. */
export const emptyReason = (state: Pick<TableState<unknown>, 'mode' | 'query'>): 'empty' | 'no-matches' =>
  state.mode === 'search' || Object.keys(state.query.filters).length > 0 ? 'no-matches' : 'empty';

/**
 * What a table's query may say in a URL. Read back, anything not listed here is dropped, so
 * a stale or hand-edited link gives the table's defaults rather than a read the server
 * refuses. Written, a value equal to `defaults` is left out, so the plain screen has a plain
 * URL. `prefix` keeps two tables on one page apart (`items.sort`).
 */
export interface QueryParams<S extends string = string> {
  views?: readonly string[];
  sorts?: readonly S[];
  /** Each filter's key and the values it may take. Filters are written under their key. */
  filters?: Readonly<Record<string, readonly string[]>>;
  limits?: readonly number[];
  defaults?: Partial<Pick<TableQuery<S>, 'view' | 'limit'>>;
  prefix?: string;
}

/** The parameter names the query itself uses, which a filter key may not take. */
const QUERY_PARAMS = ['view', 'sort', 'order', 'q', 'limit'] as const;

function filterKeys(spec: QueryParams<string>): string[] {
  const keys = Object.keys(spec.filters ?? {});
  const taken = keys.find((k) => (QUERY_PARAMS as readonly string[]).includes(k));
  if (taken) throw new Error(`A filter cannot be called "${taken}": the query's own parameter has that name.`);
  return keys;
}

/**
 * The query as URL parameters — not the page: a page is a cursor that answers one query at one
 * moment, so a link or a reload starts at the first page of the same view, sort and filters.
 */
export function queryToParams<S extends string>(query: TableQuery<S>, spec: QueryParams<S> = {}): URLSearchParams {
  const p = spec.prefix ?? '';
  const params = new URLSearchParams();
  if (query.view !== null && query.view !== spec.defaults?.view) params.set(`${p}view`, query.view);
  if (query.sort !== null) params.set(`${p}sort`, query.sort);
  if (query.order === 'desc') params.set(`${p}order`, 'desc');
  for (const key of filterKeys(spec)) {
    const value = query.filters[key];
    if (value !== undefined) params.set(`${p}${key}`, value);
  }
  if (query.q.trim() !== '') params.set(`${p}q`, query.q);
  if (query.limit !== null && query.limit !== spec.defaults?.limit) params.set(`${p}limit`, String(query.limit));
  return params;
}

/** The query a URL's parameters name, as the table's starting `query`. */
export function queryFromParams<S extends string>(
  params: URLSearchParams | string,
  spec: QueryParams<S> = {},
): Partial<TableQuery<S>> {
  const read = typeof params === 'string' ? new URLSearchParams(params) : params;
  const p = spec.prefix ?? '';
  const get = (name: string) => read.get(`${p}${name}`);
  const query: Partial<TableQuery<S>> = {};
  const view = get('view');
  if (view !== null && spec.views?.includes(view)) query.view = view;
  const sort = spec.sorts?.find((s) => s === get('sort'));
  if (sort !== undefined) query.sort = sort;
  if (get('order') === 'desc') query.order = 'desc';
  const filters: Record<string, string> = {};
  for (const key of filterKeys(spec)) {
    const value = get(key);
    if (value !== null && spec.filters![key]!.includes(value)) filters[key] = value;
  }
  if (Object.keys(filters).length > 0) query.filters = filters;
  const q = get('q');
  if (q !== null && q.trim() !== '') query.q = q;
  const limit = Number(get('limit'));
  if (spec.limits?.includes(limit)) query.limit = limit;
  return query;
}

/** One cell, as text: what it says, what it says on hover, and its tone when it is a badge. */
export interface CellText {
  text: string;
  title?: string;
  tone?: Tone;
  /** No value: drawn quietly, so an empty cell reads as empty rather than as missing. */
  blank?: boolean;
}

const RELATIVE: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** `now` is passed in, not read, so the same row reads the same in a test and on a screen. */
export function cellText<T>(column: ColumnSpec<T, string>, row: T, now: Date, locale?: string): CellText {
  const raw = column.value ? column.value(row) : (row as Record<string, unknown>)[column.key];
  if (raw === null || raw === undefined || raw === '') return { text: '—', blank: true };
  switch (column.kind ?? 'text') {
    case 'number':
      return { text: new Intl.NumberFormat(locale).format(Number(raw)) };
    case 'money': {
      // Decimal strings, never floats: `format` takes the string whole (Intl.NumberFormat v3),
      // so 0.1 + 0.2 never reaches a screen.
      const format = new Intl.NumberFormat(locale, column.currency ? { style: 'currency', currency: column.currency } : {});
      return { text: format.format(String(raw) as unknown as number) };
    }
    case 'date':
    case 'datetime':
    case 'relative': {
      const at = new Date(String(raw));
      if (Number.isNaN(at.getTime())) return { text: String(raw) };
      const exact = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
      if (column.kind === 'datetime') return { text: exact };
      if (column.kind === 'date') return { text: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at), title: exact };
      const seconds = (at.getTime() - now.getTime()) / 1000;
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const unit = RELATIVE.find(([, size]) => Math.abs(seconds) >= size);
      return { text: unit ? rtf.format(Math.round(seconds / unit[1]), unit[0]) : rtf.format(0, 'minute'), title: exact };
    }
    case 'boolean':
      // SQLite has no boolean, so 1/0 arrive as numbers; both spellings read the same.
      return raw === true || raw === 1 || raw === '1' ? { text: 'Yes' } : { text: 'No', blank: true };
    case 'badge':
      return { text: String(raw), tone: column.tones?.[String(raw)] ?? 'neutral' };
    default:
      return { text: String(raw) };
  }
}
