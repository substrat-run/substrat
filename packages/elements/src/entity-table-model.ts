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
 *
 * A selection, as a table that opts in keeps it (`configure({ retainSelection })`; nested rows
 * always do): turning a page keeps it, and so does loading more. A row a re-read no longer
 * returns leaves it. A changed sort, filter, search or page size keeps only the selected rows
 * its first read still has, and a changed view clears it. Without the option a selection is
 * only ever the rows on screen, so it does not survive a page turn.
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
  /**
   * Draws the button as an icon, with `label` as its accessible name and tooltip. A Web
   * Awesome icon name, or `{ src }` for an SVG of your own.
   */
  icon?: string | { src: string };
  /** Always in the row's "More" menu. Once any action says so, the others all stay on the row. */
  menu?: boolean;
  /** For `bulk` over nested rows: skip a row whose parent is selected too. */
  topmost?: boolean;
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
  /** The keys of the rows open to show their children. */
  open: ReadonlySet<string>;
  /** Each opened row's children, by the parent's key. */
  levels: ReadonlyMap<string, LevelState<T>>;
}

/** The children of one open row: its own read, which fails or is refused on its own. */
export interface LevelState<T> {
  phase: Phase;
  rows: T[];
  next: string | null;
  loadingMore: boolean;
  refreshing: boolean;
  /** What went wrong. With rows still showing, it is a re-read or a "Load more" that failed. */
  message: string | null;
}

/** One line of the list, in reading order: a row, or what stands in for an open row's children. */
export type TableEntry<T> =
  | {
      kind: 'row';
      id: string;
      key: string;
      row: T;
      /** From 1. */
      level: number;
      parent: string | null;
      expandable: boolean;
      open: boolean;
      /** This row's place among its siblings, from 1, and how many there are. */
      position: number;
      siblings: number;
    }
  | { kind: 'status'; id: string; parent: string; level: number; phase: 'loading' | 'empty' | 'forbidden' | 'error'; message: string | null }
  | { kind: 'more'; id: string; parent: string; level: number; loading: boolean; message: string | null };

/** How a row's children are read. */
export interface TableTree<T, S extends string = string> {
  childrenOf(row: T): TableSource<T, S>;
  /** Absent, every row can open. */
  canExpand?(row: T): boolean;
}

/** What a table has opted in to. Set again freely: a screen's closures change every render. */
export interface TableBehaviour<T, S extends string = string> {
  retainSelection?: boolean;
  /** A re-read walks as many pages as have been appended, so the list stays as long as it was. */
  keepAppended?: boolean;
  tree?: TableTree<T, S> | undefined;
  /** Within one level, lower ranks come first and ties keep the read's order: folders before files. */
  rank?: ((row: T) => number) | undefined;
}

/** `busy` while an action runs over a selection rather than one row. */
export const BULK = '\u0000bulk';

export interface TableOptions<T, S extends string = string> {
  keyOf?: (row: T) => string;
  /** The query the first read is made with. */
  query?: Partial<TableQuery<S>>;
  /** The shortest term that searches. Two is the platform's prefix-index floor. */
  minSearch?: number;
  /** The keys already selected, for a screen restoring a selection. */
  selected?: Iterable<string>;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NONE: ReadonlySet<string> = new Set();

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));

const BLANK_LEVEL = { rows: [], next: null, loadingMore: false, refreshing: false, message: null };

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

  #behaviour: TableBehaviour<T, S> = {};
  /** The row a shift-click extends from. */
  #anchor: string | null = null;
  /** The keys of each page shown so far, by page: reading order across pages. */
  #pageKeys: string[][] = [];
  /** Every row seen while a selection may outlive the page it was made on. */
  #known = new Map<string, T>();
  /** Which open row each nested row is under. */
  #parents = new Map<string, string>();
  /** How many pages were appended to the first, for a re-read to walk again. */
  #appended = 0;
  /** Per open row, its latest read: an answer to any older one is dropped. */
  #levelReads = new Map<string, { appended: number }>();
  #entries: { state: TableState<T, S>; list: TableEntry<T>[] } | undefined;

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
      selected: options.selected ? new Set(options.selected) : NONE,
      problem: null,
      open: NONE,
      levels: new Map(),
    };
  }

  /** Say what this table has opted in to. Takes effect from the next thing it draws or reads. */
  configure(behaviour: TableBehaviour<T, S>): void {
    this.#behaviour = behaviour;
    this.#entries = undefined;
  }

  get #retains(): boolean {
    return Boolean(this.#behaviour.retainSelection || this.#behaviour.tree);
  }

  /** The list as it reads on screen: every row, nested ones under their parents. */
  get entries(): TableEntry<T>[] {
    if (this.#entries?.state !== this.state) this.#entries = { state: this.state, list: this.#flatten() };
    return this.#entries.list;
  }

  #flatten(): TableEntry<T>[] {
    const { rows, open, levels, mode } = this.state;
    // A search answers with a ranked list of matches: no levels, and its own order.
    const tree = mode === 'page' ? this.#behaviour.tree : undefined;
    const rank = mode === 'page' ? this.#behaviour.rank : undefined;
    const list: TableEntry<T>[] = [];
    const seen = new Set<string>();
    const walk = (level: T[], depth: number, parent: string | null) => {
      const ordered = rank ? level.map((row) => ({ row, by: rank(row) })).sort((a, b) => a.by - b.by).map((r) => r.row) : level;
      ordered.forEach((row, i) => {
        const key = this.keyOf(row);
        // A row listed under itself would otherwise never end.
        if (tree && seen.has(key)) return;
        seen.add(key);
        const expandable = tree !== undefined && (tree.canExpand?.(row) ?? true);
        const isOpen = expandable && open.has(key);
        list.push({ kind: 'row', id: `row:${key}`, key, row, level: depth, parent, expandable, open: isOpen, position: i + 1, siblings: ordered.length });
        if (!isOpen) return;
        const child = levels.get(key);
        const status = (phase: 'loading' | 'empty' | 'forbidden' | 'error', message: string | null = null) =>
          list.push({ kind: 'status', id: `status:${key}`, parent: key, level: depth + 1, phase, message });
        if (!child || child.phase === 'loading') status('loading');
        else if (child.phase === 'forbidden' || child.phase === 'error') status(child.phase, child.message);
        else if (child.rows.length === 0) status('empty');
        else {
          walk(child.rows, depth + 1, key);
          if (child.next) list.push({ kind: 'more', id: `more:${key}`, parent: key, level: depth + 1, loading: child.loadingMore, message: child.message });
        }
      });
    };
    walk(rows, 1, null);
    return list;
  }

  get #rowKeys(): string[] {
    return this.entries.flatMap((e) => (e.kind === 'row' ? [e.key] : []));
  }

  /** Every selectable key in reading order, across the pages walked so far. */
  get #order(): string[] {
    if (!this.#retains || this.state.mode === 'search') return this.#rowKeys;
    const { page } = this.state;
    return [...this.#pageKeys.slice(0, page).flat(), ...this.#rowKeys, ...this.#pageKeys.slice(page + 1).flat()];
  }

  #remember(rows: readonly T[], parent: string | null = null) {
    if (!this.#retains) return;
    for (const row of rows) {
      const key = this.keyOf(row);
      this.#known.set(key, row);
      if (parent !== null) this.#parents.set(key, parent);
    }
  }

  /** The selection without `keys`, or the same object when none of them is in it. */
  #without(selected: ReadonlySet<string>, keys: Iterable<string>): ReadonlySet<string> {
    const next = new Set(selected);
    let changed = false;
    for (const key of keys) changed = next.delete(key) || changed;
    return changed ? next : selected;
  }

  /** A changed query starts one walk: everything seen so far must reappear in its first read. */
  #collapsePages() {
    this.#pageKeys = [this.#pageKeys.flat()];
  }

  /** A read walked again: the first page, then as many more as were appended. */
  async #walk(source: TableSource<T, S>, link: string | null, query: TableQuery<S>, appended: number): Promise<Page<T> & { walked: number }> {
    let page = await (link === null ? source.read(query) : source.follow(link));
    const entries = [...page.entries];
    let walked = 0;
    while (walked < appended && page.next) {
      page = await source.follow(page.next);
      entries.push(...page.entries);
      walked++;
    }
    return { entries, next: page.next, total: page.total, walked };
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
   * Read what is on screen again, with the current query: the page and, with `keepAppended`,
   * every batch appended to it, so an action does not collapse a long list. Keeps a `problem`
   * it is told to, so a reload can carry one.
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
        : await this.#walk(this.source, link, query, this.#behaviour.keepAppended ? this.#appended : 0).then((p) => {
            if (this.#behaviour.keepAppended && generation === this.#generation) this.#appended = p.walked;
            return { mode: 'page' as const, rows: p.entries, next: p.next, total: p.total, capped: false };
          });
      if (generation !== this.#generation) return;
      // The last row of a later page went (deleted here, or elsewhere): show the page before.
      if (patch.rows.length === 0 && page > 0 && link !== null) return this.#goTo(page - 1, keep);
      // A selection names rows; one the new read no longer has is not selected any more.
      const keys = new Set(patch.rows.map(this.keyOf));
      const selected = this.#retains
        ? this.#without(this.state.selected, (this.#pageKeys[page] ?? []).filter((k) => !keys.has(k)))
        : new Set([...this.state.selected].filter((k) => keys.has(k)));
      this.#pageKeys[page] = [...keys];
      this.#remember(patch.rows);
      this.#set({ ...patch, phase: 'ready', loadingMore: false, refreshing: false, selected, problem: keep });
      await this.#refreshLevels();
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
        this.#set({ refreshing: false, loadingMore: false, problem: { kind: 'failed', message: messageOf(error) } });
      } else {
        this.#set({ phase: 'error', problem: { kind: 'failed', message: messageOf(error) } });
      }
    }
  }

  /** Change the query and read again, from the first page. A new view starts with nothing selected. */
  setQuery(patch: Partial<TableQuery<S>>): Promise<void> {
    const query = { ...this.state.query, ...patch };
    const selected = patch.view !== undefined && patch.view !== this.state.query.view ? NONE : this.state.selected;
    this.#collapsePages();
    this.#trail = [null];
    this.#offsets = [0];
    this.#appended = 0;
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
    this.#collapsePages();
    this.#trail = [null];
    this.#offsets = [0];
    this.#appended = 0;
    this.#set({ page: 0, offset: 0 });
    return this.load();
  }

  /** Drop the search term and every filter — what "No matches" offers. */
  clear(): Promise<void> {
    return this.setQuery({ q: '', filters: {} });
  }

  /** Append the next batch. Waits out a re-read: `next` still belongs to the rows it is replacing. */
  async more(): Promise<void> {
    const { next, loadingMore, refreshing } = this.state;
    if (!next || loadingMore || refreshing) return;
    const generation = this.#generation;
    this.#set({ loadingMore: true });
    try {
      const page = await this.source.follow(next);
      if (generation !== this.#generation) return;
      const rows = [...this.state.rows, ...page.entries];
      this.#appended++;
      this.#pageKeys[this.state.page] = rows.map(this.keyOf);
      this.#remember(page.entries);
      this.#set({ rows, next: page.next, loadingMore: false });
      await this.#readMissingLevels();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#set({ loadingMore: false, problem: { kind: 'failed', message: messageOf(error) } });
    }
  }

  toggle(key: string): void {
    const selected = new Set(this.state.selected);
    if (!selected.delete(key)) selected.add(key);
    this.#anchor = key;
    this.#set({ selected });
  }

  /** The screen's own selection. Keys for rows not loaded yet are kept: they may be on their way. */
  setSelection(keys: Iterable<string>): void {
    const selected = new Set(keys);
    if (!sameKeys(selected, this.state.selected)) this.#set({ selected });
  }

  /** Select this row and no other: a plain click. */
  selectOnly(key: string): void {
    this.#anchor = key;
    this.#set({ selected: new Set([key]) });
  }

  /**
   * Select from the anchor to this row, in reading order: a shift-click. Replaces the selection
   * unless `additive`, and leaves the anchor where it is, so a second shift-click re-draws the
   * range. With no anchor it starts at `from`, or, without one either, selects just this row.
   */
  extendTo(key: string, { additive = false, from }: { additive?: boolean; from?: string } = {}): void {
    const order = this.#order;
    const anchor = this.#anchor !== null && order.includes(this.#anchor) ? this.#anchor : (from ?? null);
    const start = anchor === null ? -1 : order.indexOf(anchor);
    const end = order.indexOf(key);
    if (end < 0) return;
    if (start < 0) return this.selectOnly(key);
    this.#anchor = anchor;
    const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    this.#set({ selected: new Set(additive ? [...this.state.selected, ...range] : range) });
  }

  /** Where the next shift-extend starts: the row a plain arrow key moved to. */
  setAnchor(key: string): void {
    this.#anchor = key;
  }

  /** Select the rows loaded now. Rows that load later are not added: Cmd+A means what is there. */
  selectLoaded(): void {
    this.#set({ selected: new Set(this.#rowKeys) });
  }

  /** Select every row on screen, or none if they all are. Rows not yet loaded are not "all". */
  toggleAll(): void {
    const keys = this.#rowKeys;
    const all = keys.length > 0 && keys.every((k) => this.state.selected.has(k));
    if (this.#retains) {
      // Rows selected on another page are not this checkbox's to change.
      const selected = new Set(this.state.selected);
      for (const key of keys) {
        if (all) selected.delete(key);
        else selected.add(key);
      }
      this.#set({ selected });
    } else {
      this.#set({ selected: all ? NONE : new Set(keys) });
    }
  }

  clearSelection(): void {
    this.#set({ selected: NONE });
  }

  get selectedRows(): T[] {
    const { selected, rows } = this.state;
    if (!this.#retains) return rows.filter((row) => selected.has(this.keyOf(row)));
    const inOrder = this.#order.filter((k) => selected.has(k));
    const listed = new Set(inOrder);
    return [...inOrder, ...[...selected].filter((k) => !listed.has(k))].flatMap((k) => {
      const row = this.#known.get(k);
      return row === undefined ? [] : [row];
    });
  }

  /** The open row this nested row is under, or null for a top-level row. */
  parentOf(key: string): string | null {
    return this.#parents.get(key) ?? null;
  }

  /** The selected rows with no selected row above them. */
  get topmostSelectedRows(): T[] {
    const { selected } = this.state;
    return this.selectedRows.filter((row) => {
      const walked = new Set<string>();
      for (let up = this.parentOf(this.keyOf(row)); up !== null && !walked.has(up); up = this.parentOf(up)) {
        if (selected.has(up)) return false;
        walked.add(up);
      }
      return true;
    });
  }

  /** Which rows are open. A row that has not loaded yet opens when it does. */
  setOpen(keys: Iterable<string>): Promise<void> {
    const open = new Set(keys);
    if (!sameKeys(open, this.state.open)) this.#set({ open });
    return this.#readMissingLevels();
  }

  /** Read one open row's children again, for a change the screen was told about. */
  async reloadLevel(key: string): Promise<void> {
    const row = this.#known.get(key);
    if (row !== undefined && this.state.open.has(key)) await this.#readLevel(key, row);
  }

  /** The next page of one open row's children. */
  async moreIn(key: string): Promise<void> {
    const tree = this.#behaviour.tree;
    const level = this.state.levels.get(key);
    const row = this.#known.get(key);
    const read = this.#levelReads.get(key);
    if (!tree || !level?.next || level.loadingMore || row === undefined || !read) return;
    this.#setLevel(key, { loadingMore: true, message: null });
    try {
      const page = await tree.childrenOf(row).follow(level.next);
      if (this.#levelReads.get(key) !== read) return;
      read.appended++;
      this.#remember(page.entries, key);
      this.#setLevel(key, { rows: [...(this.state.levels.get(key)?.rows ?? []), ...page.entries], next: page.next, loadingMore: false });
      await this.#readMissingLevels();
    } catch (error) {
      if (this.#levelReads.get(key) !== read) return;
      this.#setLevel(key, { loadingMore: false, message: messageOf(error) });
    }
  }

  #setLevel(key: string, patch: Partial<LevelState<T>>) {
    const levels = new Map(this.state.levels);
    levels.set(key, { phase: 'loading', ...BLANK_LEVEL, ...levels.get(key), ...patch });
    this.#set({ levels });
  }

  #openRows(): Extract<TableEntry<T>, { kind: 'row' }>[] {
    return this.entries.flatMap((e) => (e.kind === 'row' && e.open ? [e] : []));
  }

  /** First reads, for every open row on the list that has none. Each may reveal more. */
  async #readMissingLevels(): Promise<void> {
    if (!this.#behaviour.tree) return;
    await Promise.all(this.#openRows().filter((e) => !this.state.levels.has(e.key)).map((e) => this.#readLevel(e.key, e.row)));
  }

  /**
   * After the top level was read: read every open level again, and forget the rest. A closed
   * row reopens with a fresh read, and a row that left the list takes its children with it.
   */
  async #refreshLevels(): Promise<void> {
    if (!this.#behaviour.tree || this.state.mode !== 'page') return;
    const open = this.#openRows();
    const live = new Set(open.map((e) => e.key));
    const levels = new Map(this.state.levels);
    let selected = this.state.selected;
    for (const [key, level] of this.state.levels) {
      if (live.has(key)) continue;
      levels.delete(key);
      this.#levelReads.delete(key);
      selected = this.#without(selected, level.rows.map(this.keyOf));
    }
    if (levels.size !== this.state.levels.size) this.#set({ levels, selected });
    await Promise.all(open.map((e) => this.#readLevel(e.key, e.row)));
  }

  async #readLevel(key: string, row: T): Promise<void> {
    const tree = this.#behaviour.tree;
    if (!tree) return;
    const before = this.state.levels.get(key);
    const shown = before?.phase === 'ready';
    const read = { appended: shown ? (this.#levelReads.get(key)?.appended ?? 0) : 0 };
    this.#levelReads.set(key, read);
    this.#setLevel(key, shown ? { refreshing: true } : { ...BLANK_LEVEL, phase: 'loading' });
    const had = before?.rows.map(this.keyOf) ?? [];
    try {
      const page = await this.#walk(tree.childrenOf(row), null, this.state.query, read.appended);
      if (this.#levelReads.get(key) !== read) return;
      read.appended = page.walked;
      const keys = new Set(page.entries.map(this.keyOf));
      const selected = this.#without(this.state.selected, had.filter((k) => !keys.has(k)));
      if (selected !== this.state.selected) this.#set({ selected });
      this.#remember(page.entries, key);
      this.#setLevel(key, { phase: 'ready', rows: page.entries, next: page.next, loadingMore: false, refreshing: false, message: null });
      await this.#readMissingLevels();
    } catch (error) {
      if (this.#levelReads.get(key) !== read) return;
      if (statusOf(error) === 403) {
        const selected = this.#without(this.state.selected, had);
        if (selected !== this.state.selected) this.#set({ selected });
        this.#setLevel(key, { ...BLANK_LEVEL, phase: 'forbidden' });
      } else if (shown) {
        this.#setLevel(key, { refreshing: false, message: messageOf(error) });
      } else {
        this.#setLevel(key, { ...BLANK_LEVEL, phase: 'error', message: messageOf(error) });
      }
    }
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
    const rows = action.topmost ? this.topmostSelectedRows : this.selectedRows;
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

/**
 * Which columns a person has chosen to see, and in what order, by column key. Kept apart from
 * the query: it changes nothing the server is asked, so it is not in the URL either. The
 * first declared column names the row — the link, the selection's label — so it stays first
 * and shown whatever a layout says.
 */
export interface TableLayout {
  order: readonly string[];
  hidden: readonly string[];
}

/** The declared order with nothing hidden: what "Reset" goes back to. */
export const defaultLayout = (columns: readonly { key: string }[]): TableLayout => ({
  order: columns.map((c) => c.key),
  hidden: [],
});

/**
 * The columns a layout shows, in its order. A key the layout does not know — a column added
 * since it was saved — keeps its declared place among the rest, at the end; a key it names
 * that no longer exists is ignored.
 */
export function arrange<C extends { key: string }>(columns: readonly C[], layout: TableLayout | null | undefined): C[] {
  if (!layout || columns.length === 0) return [...columns];
  const [first, ...rest] = columns;
  const rank = (key: string) => {
    const i = layout.order.indexOf(key);
    return i < 0 ? layout.order.length : i;
  };
  const ordered = rest
    .map((c, declared) => ({ c, declared }))
    .sort((a, b) => rank(a.c.key) - rank(b.c.key) || a.declared - b.declared)
    .map(({ c }) => c);
  return [first!, ...ordered.filter((c) => !layout.hidden.includes(c.key))];
}

/** Every column after the first, in the layout's order, with whether it is shown. */
export function layoutEntries<C extends { key: string }>(
  columns: readonly C[],
  layout: TableLayout | null | undefined,
): { column: C; shown: boolean }[] {
  const all = arrange(columns, layout && { order: layout.order, hidden: [] }).slice(1);
  return all.map((column) => ({ column, shown: !layout?.hidden.includes(column.key) }));
}

/** Show or hide one column. The first column cannot be hidden, and asking does nothing. */
export function toggleColumn(columns: readonly { key: string }[], layout: TableLayout | null | undefined, key: string): TableLayout {
  const base = normalised(columns, layout);
  if (key === columns[0]?.key) return base;
  const hidden = base.hidden.includes(key) ? base.hidden.filter((k) => k !== key) : [...base.hidden, key];
  return { order: base.order, hidden };
}

/** Move a column `by` places among the others (−1 is up), or to the place of `to`. */
export function moveColumn(
  columns: readonly { key: string }[],
  layout: TableLayout | null | undefined,
  key: string,
  by: { by: number } | { to: string },
): TableLayout {
  const base = normalised(columns, layout);
  const [first, ...rest] = base.order;
  const from = rest.indexOf(key);
  if (from < 0) return base;
  const target = 'by' in by ? from + by.by : rest.indexOf(by.to);
  if (target < 0 || target >= rest.length || target === from) return base;
  const moved = rest.filter((k) => k !== key);
  moved.splice(target, 0, key);
  return { order: [first!, ...moved], hidden: base.hidden };
}

/** A layout naming every current column exactly once, in the order `arrange` shows them. */
function normalised(columns: readonly { key: string }[], layout: TableLayout | null | undefined): TableLayout {
  const known = new Set(columns.map((c) => c.key));
  const order = arrange(columns, layout && { order: layout.order, hidden: [] }).map((c) => c.key);
  return { order, hidden: (layout?.hidden ?? []).filter((k) => known.has(k) && k !== columns[0]?.key) };
}

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
