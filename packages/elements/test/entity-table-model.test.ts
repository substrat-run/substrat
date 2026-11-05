import { describe, expect, it, vi } from 'vitest';
import {
  EntityTableModel,
  actionsIn,
  arrange,
  defaultLayout,
  layoutEntries,
  moveColumn,
  toggleColumn,
  cellText,
  emptyReason,
  queryFromParams,
  queryToParams,
  type ColumnSpec,
  type QueryParams,
  type Page,
  type RowAction,
  type TableQuery,
  type TableSource,
} from '../src/entity-table-model.js';

type Row = { id: string };

class Refusal extends Error {
  constructor(readonly status: number) {
    super(`status ${status}`);
  }
}

const page = (ids: string[], next: string | null = null): Page<Row> => ({
  entries: ids.map((id) => ({ id })),
  next,
  total: null,
});

const modelOver = (source: Partial<TableSource<Row>>) =>
  new EntityTableModel<Row>({ read: async () => page([]), follow: async () => page([]), ...source }, () => {});

describe('EntityTableModel', () => {
  it('reads a 403 as a wall and an empty page as empty — never the one for the other', async () => {
    const walled = modelOver({ read: () => Promise.reject(new Refusal(403)) });
    const empty = modelOver({});
    await Promise.all([walled.load(), empty.load()]);
    expect(walled.state).toMatchObject({ phase: 'forbidden', rows: [] });
    expect(empty.state).toMatchObject({ phase: 'ready', rows: [], problem: null });
    expect(emptyReason(empty.state)).toBe('empty');
  });

  it('follows next until it is null, appending', async () => {
    const follow = vi.fn(async (next: string) => (next === 'p2' ? page(['b'], 'p3') : page(['c'])));
    const model = modelOver({ read: async () => page(['a'], 'p2'), follow });
    await model.load();
    await model.more();
    await model.more();
    await model.more();
    expect(model.state.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(model.state.next).toBeNull();
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows when an action is refused, and re-reads when it went stale', async () => {
    const read = vi.fn(async () => page(['a', 'b']));
    const model = modelOver({ read });
    await model.load();

    await model.run({ id: 'trash', label: 'Trash', run: () => Promise.reject(new Refusal(403)) }, { id: 'a' });
    expect(model.state).toMatchObject({ phase: 'ready', busy: null, problem: { kind: 'refused' } });
    expect(model.state.rows).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);

    await model.run({ id: 'trash', label: 'Trash', run: () => Promise.reject(new Refusal(409)) }, { id: 'a' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(model.state.problem).toMatchObject({ kind: 'stale' });
  });

  it('drops a page that lands after a reload instead of appending it to the new read', async () => {
    let release!: (p: Page<Row>) => void;
    const model = modelOver({
      read: async () => page(['a'], 'p2'),
      follow: () => new Promise<Page<Row>>((resolve) => (release = resolve)),
    });
    await model.load();
    const more = model.more();
    await model.load();
    release(page(['old']));
    await more;
    expect(model.state).toMatchObject({ rows: [{ id: 'a' }], loadingMore: false });
  });

  it('cycles a header asc → desc → default, keeps the old rows on screen while each re-read is out, and shows only the latest answer', async () => {
    const asked: Pick<TableQuery, 'sort' | 'order'>[] = [];
    const answers: ((p: Page<Row>) => void)[] = [];
    const model = modelOver({
      read: (q) => {
        asked.push({ sort: q.sort, order: q.order });
        return new Promise((resolve) => answers.push(resolve));
      },
    });
    const first = model.load();
    answers[0]!(page(['a', 'b']));
    await first;

    const asc = model.sortBy('name');
    expect(model.state).toMatchObject({ phase: 'ready', refreshing: true, rows: [{ id: 'a' }, { id: 'b' }] });
    const desc = model.sortBy('name');
    // The ascending answer arrives after the descending one was asked for: it is not shown.
    answers[2]!(page(['b', 'a']));
    answers[1]!(page(['a', 'b']));
    await Promise.all([asc, desc]);
    expect(model.state).toMatchObject({ refreshing: false, rows: [{ id: 'b' }, { id: 'a' }] });

    const back = model.sortBy('name');
    answers[3]!(page(['a', 'b']));
    await back;
    expect(asked).toEqual([
      { sort: null, order: 'asc' },
      { sort: 'name', order: 'asc' },
      { sort: 'name', order: 'desc' },
      { sort: null, order: 'asc' },
    ]);
  });

  it('searches only past the minimum, says when the search was capped, and an empty answer is "no matches"', async () => {
    const read = vi.fn(async () => page(['a', 'b'], 'p2'));
    const search = vi.fn(async (q: string) =>
      q === 'zz' ? { results: [], capped: false } : { results: [{ id: 'b' }], capped: true },
    );
    const model = modelOver({ read, search });
    await model.load();

    await model.search('m');
    expect(read).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();

    await model.search('mi');
    expect(model.state).toMatchObject({ mode: 'search', rows: [{ id: 'b' }], next: null, capped: true });

    await model.search('zz');
    expect(emptyReason(model.state)).toBe('no-matches');

    await model.clear();
    expect(model.state).toMatchObject({ mode: 'page', rows: [{ id: 'a' }, { id: 'b' }], next: 'p2', capped: false });
  });

  it('runs a bulk action per row, reads once, and counts what did not happen', async () => {
    const read = vi.fn(async () => page(['a', 'b', 'c', 'd']));
    const model = modelOver({ read });
    await model.load();
    for (const k of ['a', 'b', 'c']) model.toggle(k);

    const outcome: Record<string, () => Promise<unknown>> = {
      a: async () => undefined,
      b: () => Promise.reject(new Refusal(403)),
      c: () => Promise.reject(new Refusal(409)),
    };
    const archive: RowAction<Row> = { id: 'archive', label: 'Archive', bulk: true, run: (row) => outcome[row.id]!() };
    const done = await model.runBulk(archive);

    expect(done).toEqual([{ id: 'a' }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(model.state.selected.size).toBe(0);
    expect(model.state.problem).toEqual({
      kind: 'refused',
      message: 'Archive: 1 of 3 done; 1 not allowed, 1 changed somewhere else.',
    });
  });

  it('keeps a selection across a re-read only for rows still there, and drops it on a new view', async () => {
    let ids = ['a', 'b'];
    const model = modelOver({ read: async () => page(ids) });
    await model.load();
    model.toggleAll();
    ids = ['b', 'c'];
    await model.load();
    expect([...model.state.selected]).toEqual(['b']);

    await model.setQuery({ view: 'archived' });
    expect(model.state.selected.size).toBe(0);
  });

  it('pages forward through next and back through the link that led to each page, and a reload stays put', async () => {
    const pages: Record<string, Page<Row>> = { p2: page(['c', 'd'], 'p3'), p3: page(['e']) };
    const read = vi.fn(async () => page(['a', 'b'], 'p2'));
    const follow = vi.fn(async (next: string) => pages[next]!);
    const model = modelOver({ read, follow });
    await model.load();

    await model.nextPage();
    await model.nextPage();
    expect(model.state).toMatchObject({ page: 2, offset: 4, rows: [{ id: 'e' }], next: null });
    await model.nextPage(); // the end: nothing to follow
    expect(model.state.page).toBe(2);

    await model.prevPage();
    expect(model.state).toMatchObject({ page: 1, offset: 2, rows: [{ id: 'c' }, { id: 'd' }] });
    await model.load();
    expect(follow).toHaveBeenLastCalledWith('p2');
    expect(model.state.page).toBe(1);

    await model.prevPage();
    expect(model.state).toMatchObject({ page: 0, offset: 0, rows: [{ id: 'a' }, { id: 'b' }] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('steps back a page when a reload finds this one emptied, and a new query starts at the first', async () => {
    let second = page(['c']);
    const model = modelOver({ read: async () => page(['a', 'b'], 'p2'), follow: async () => second });
    await model.load();
    await model.nextPage();
    second = page([]);
    await model.load();
    expect(model.state).toMatchObject({ page: 0, rows: [{ id: 'a' }, { id: 'b' }] });

    await model.nextPage();
    await model.setPageSize(50);
    expect(model.state).toMatchObject({ page: 0, offset: 0, query: { limit: 50 } });
  });

  it('does not search a view its source says search cannot cover', async () => {
    const search = vi.fn(async () => ({ results: [], capped: false }));
    const model = modelOver({ search, searchViews: ['active'] });
    await model.setQuery({ view: 'archived' });
    expect(model.searchable).toBe(false);
    await model.search('milk');
    expect(search).not.toHaveBeenCalled();
    expect(model.state.mode).toBe('page');
  });
});

describe('actionsIn', () => {
  it('offers an action in its views only, and for a selection only when it is bulk', () => {
    const archive: RowAction<Row> = { id: 'archive', label: 'Archive', views: ['active'], bulk: true, run: async () => {} };
    const rename: RowAction<Row> = { id: 'rename', label: 'Rename', run: async () => {} };
    expect(actionsIn([archive, rename], 'active').map((a) => a.id)).toEqual(['archive', 'rename']);
    expect(actionsIn([archive, rename], 'archived').map((a) => a.id)).toEqual(['rename']);
    expect(actionsIn([archive, rename], 'active', true).map((a) => a.id)).toEqual(['archive']);
  });
});

describe('cellText', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const tones = { open: 'success' } as const;
  const cases: [string, ColumnSpec<Record<string, unknown>>, Record<string, unknown>, object][] = [
    ['an absent value is a quiet dash', { key: 'x', label: 'X' }, {}, { text: '—', blank: true }],
    ['a badge takes its tone', { key: 's', label: 'S', kind: 'badge', tones }, { s: 'open' }, { text: 'open', tone: 'success' }],
    ['an unlisted badge value is neutral', { key: 's', label: 'S', kind: 'badge', tones }, { s: 'held' }, { tone: 'neutral' }],
    [
      'money keeps a decimal string exact',
      { key: 'm', label: 'M', kind: 'money', currency: 'SEK' },
      { m: '9007199254740993.10' },
      { text: expect.stringContaining('9,007,199,254,740,993.10') },
    ],
    [
      'relative time says when, with the exact time on hover',
      { key: 't', label: 'T', kind: 'relative' },
      { t: '2026-11-02T12:00:00Z' },
      { text: '3 days ago', title: expect.any(String) },
    ],
    ['a SQLite 0 is No', { key: 'd', label: 'D', kind: 'boolean' }, { d: 0 }, { text: 'No', blank: true }],
  ];
  it.each(cases)('%s', (_, column, row, expected) => {
    expect(cellText(column, row, now, 'en-US')).toMatchObject(expected);
  });
});

describe('queryToParams / queryFromParams', () => {
  const spec: QueryParams<'name' | 'created_at'> = {
    views: ['active', 'archived'],
    sorts: ['name', 'created_at'],
    filters: { done: ['0', '1'] },
    limits: [10, 25],
    defaults: { view: 'active', limit: 10 },
  };
  const base: TableQuery<'name' | 'created_at'> = { view: 'active', sort: null, order: 'asc', filters: {}, q: '', limit: 10 };

  it('writes only what differs from the defaults, and reads the same query back', () => {
    expect(queryToParams(base, spec).toString()).toBe('');
    const query = { ...base, view: 'archived', sort: 'name' as const, order: 'desc' as const, filters: { done: '1' }, q: 'oat milk', limit: 25 };
    const params = queryToParams(query, spec);
    expect(params.toString()).toBe('view=archived&sort=name&order=desc&done=1&q=oat+milk&limit=25');
    expect(queryFromParams(params, spec)).toEqual({ view: 'archived', sort: 'name', order: 'desc', filters: { done: '1' }, q: 'oat milk', limit: 25 });
  });

  it('drops what the spec does not list, so a stale link falls back to the defaults', () => {
    expect(queryFromParams('view=gone&sort=secret&done=7&limit=100000&other=x', spec)).toEqual({});
  });

  it('keeps two tables apart by prefix', () => {
    const items = { ...spec, prefix: 'items.' };
    const params = queryToParams({ ...base, sort: 'name' }, items);
    expect(params.toString()).toBe('items.sort=name');
    expect(queryFromParams(params, spec)).toEqual({});
    expect(queryFromParams(params, items)).toEqual({ sort: 'name' });
  });

  it('refuses a filter named like one of the query\'s own parameters', () => {
    expect(() => queryToParams(base, { filters: { order: ['asc'] } })).toThrow(/cannot be called "order"/);
  });
});

describe('column layout', () => {
  const columns = ['name', 'created', 'id', 'owner'].map((key) => ({ key }));
  const keys = (cs: { key: string }[]) => cs.map((c) => c.key);

  it('shows the layout\'s order without its hidden columns, the first column always first and shown', () => {
    const layout = { order: ['owner', 'name', 'id', 'created'], hidden: ['id', 'name'] };
    expect(keys(arrange(columns, layout))).toEqual(['name', 'owner', 'created']);
    expect(layoutEntries(columns, layout).map((e) => [e.column.key, e.shown])).toEqual([
      ['owner', true],
      ['id', false],
      ['created', true],
    ]);
  });

  it('puts a column added since the layout was saved at the end, and ignores one that is gone', () => {
    expect(keys(arrange(columns, { order: ['name', 'id', 'gone', 'created'], hidden: ['gone'] }))).toEqual([
      'name',
      'id',
      'created',
      'owner',
    ]);
  });

  it('toggles a column, and refuses to hide the first', () => {
    const hidden = toggleColumn(columns, null, 'id');
    expect(hidden).toEqual({ order: ['name', 'created', 'id', 'owner'], hidden: ['id'] });
    expect(toggleColumn(columns, hidden, 'id').hidden).toEqual([]);
    expect(toggleColumn(columns, hidden, 'name')).toEqual(hidden);
  });

  it('moves a column among the others, never past an edge or above the first', () => {
    const up = moveColumn(columns, null, 'id', { by: -1 });
    expect(up.order).toEqual(['name', 'id', 'created', 'owner']);
    expect(moveColumn(columns, up, 'id', { by: -1 })).toEqual(up);
    expect(moveColumn(columns, null, 'owner', { by: 1 }).order).toEqual(defaultLayout(columns).order);
    expect(moveColumn(columns, null, 'owner', { to: 'created' }).order).toEqual(['name', 'owner', 'created', 'id']);
    expect(moveColumn(columns, null, 'name', { by: 1 }).order).toEqual(defaultLayout(columns).order);
  });
});
