/**
 * What an entity table knows, with no DOM in it.
 *
 * The element renders this and forwards clicks; everything that decides what the screen
 * says lives here, so a second renderer (React Native, later) gets the same answers from
 * the same code. The contract is the one a vertical's generated client already speaks:
 * a read returns a `Page` (`entries`, `next`, `total`), `next` is followed rather than
 * reassembled, and a refusal is a 403 on the error's `status`.
 *
 * Three answers a hand-written list screen keeps getting wrong, held here once:
 *
 *   - a 403 on the read is a WALL ("you may not see this"), never an empty list;
 *   - a 403 on a row action is about that row: the rows stay, the refusal is shown;
 *   - a 409 or 404 on a row action means the view went stale (another tab moved it),
 *     so the view is read again before the problem is shown.
 */

/** One page of a paged read — the generated client's `Paged<T>`, structurally. */
export interface Page<T> {
  entries: T[];
  /** A URL to follow, or null when the walk is over. */
  next: string | null;
  total: number | null;
}

/** Where the rows come from. `first` is the read; `follow` is the client's `follow`. */
export interface TableSource<T> {
  first(): Promise<Page<T>>;
  follow(next: string): Promise<Page<T>>;
}

export interface Column<T> {
  key: string;
  label: string;
  value(row: T): string;
  /** Makes the cell a link. */
  href?(row: T): string | null;
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
  run(row: T): Promise<unknown>;
}

export type Phase = 'loading' | 'ready' | 'forbidden' | 'error';

/** Something to say above the rows that does not replace them. */
export interface Problem {
  kind: 'refused' | 'stale' | 'failed';
  message: string;
}

export interface TableState<T> {
  phase: Phase;
  rows: T[];
  next: string | null;
  total: number | null;
  loadingMore: boolean;
  /** Key of the row whose action is in flight. */
  busy: string | null;
  problem: Problem | null;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class EntityTableModel<T> {
  state: TableState<T> = {
    phase: 'loading',
    rows: [],
    next: null,
    total: null,
    loadingMore: false,
    busy: null,
    problem: null,
  };

  /** Bumped by every reload, so a page that lands after one is dropped, not appended. */
  #generation = 0;

  constructor(
    private readonly source: TableSource<T>,
    private readonly onChange: (state: TableState<T>) => void,
    readonly keyOf: (row: T) => string = (row) => String((row as { id?: unknown }).id),
  ) {}

  #set(patch: Partial<TableState<T>>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Read from the first page. Keeps a `problem` it is told to, so a reload can carry one. */
  async load(keep: Problem | null = null): Promise<void> {
    const generation = ++this.#generation;
    if (this.state.phase !== 'ready') this.#set({ phase: 'loading' });
    try {
      const page = await this.source.first();
      if (generation !== this.#generation) return;
      this.#set({ phase: 'ready', rows: page.entries, next: page.next, total: page.total, loadingMore: false, problem: keep });
    } catch (error) {
      if (generation !== this.#generation) return;
      if (statusOf(error) === 403) {
        this.#set({ phase: 'forbidden', rows: [], next: null, total: null, loadingMore: false, problem: null });
      } else if (this.state.phase === 'ready') {
        // A failed re-read is a blip over rows we still have, not a reason to drop them.
        this.#set({ problem: { kind: 'failed', message: messageOf(error) } });
      } else {
        this.#set({ phase: 'error', problem: { kind: 'failed', message: messageOf(error) } });
      }
    }
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
}
