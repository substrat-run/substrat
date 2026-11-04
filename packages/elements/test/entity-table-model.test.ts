import { describe, expect, it, vi } from 'vitest';
import { EntityTableModel, type Page, type TableSource } from '../src/entity-table-model.js';

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
  new EntityTableModel<Row>(
    { first: async () => page([]), follow: async () => page([]), ...source },
    () => {},
  );

describe('EntityTableModel', () => {
  it('reads a 403 as a wall and an empty page as empty — never the one for the other', async () => {
    const walled = modelOver({ first: () => Promise.reject(new Refusal(403)) });
    const empty = modelOver({});
    await Promise.all([walled.load(), empty.load()]);
    expect(walled.state).toMatchObject({ phase: 'forbidden', rows: [] });
    expect(empty.state).toMatchObject({ phase: 'ready', rows: [], problem: null });
  });

  it('follows next until it is null, appending', async () => {
    const follow = vi.fn(async (next: string) => (next === 'p2' ? page(['b'], 'p3') : page(['c'])));
    const model = modelOver({ first: async () => page(['a'], 'p2'), follow });
    await model.load();
    await model.more();
    await model.more();
    await model.more();
    expect(model.state.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(model.state.next).toBeNull();
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows when an action is refused, and re-reads when it went stale', async () => {
    const first = vi.fn(async () => page(['a', 'b']));
    const model = modelOver({ first });
    await model.load();

    await model.run({ id: 'trash', label: 'Trash', run: () => Promise.reject(new Refusal(403)) }, { id: 'a' });
    expect(model.state).toMatchObject({ phase: 'ready', busy: null, problem: { kind: 'refused' } });
    expect(model.state.rows).toHaveLength(2);
    expect(first).toHaveBeenCalledTimes(1);

    await model.run({ id: 'trash', label: 'Trash', run: () => Promise.reject(new Refusal(409)) }, { id: 'a' });
    expect(first).toHaveBeenCalledTimes(2);
    expect(model.state.problem).toMatchObject({ kind: 'stale' });
  });

  it('drops a page that lands after a reload instead of appending it to the new read', async () => {
    let release!: (p: Page<Row>) => void;
    const model = modelOver({
      first: async () => page(['a'], 'p2'),
      follow: () => new Promise<Page<Row>>((resolve) => (release = resolve)),
    });
    await model.load();
    const more = model.more();
    await model.load();
    release(page(['old']));
    await more;
    expect(model.state).toMatchObject({ rows: [{ id: 'a' }], loadingMore: false });
  });
});
