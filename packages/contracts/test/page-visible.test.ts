/**
 * `pageVisible` never hands out a position of a row the caller may not see (#2073).
 *
 * The fetch here mints a READABLE cursor — the row's id, as `ctx.page`'s envelope carries it
 * (K-44) — so every cursor a walk returns can be decoded and judged against the rows the check
 * refused. That is the oracle: not the page shape, but whose position the cursor is.
 */
import { describe, expect, it } from 'vitest';
import { pageOf, pageVisible, VISIBLE_SCAN_BUDGET, type Page, type VisibleTest } from '../src/pagination.js';

interface Row {
  id: string;
}
const encode = (row: Row) => btoa(JSON.stringify({ id: row.id }));
const decode = (cursor: string) => (JSON.parse(atob(cursor)) as Row).id;

/** A keyset table of `n` rows, read the way `ctx.page` reads one: full page ⇒ the last row's cursor. */
function table(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}` }));
  const fetches: { limit: number; cursor?: string }[] = [];
  const fetch = (p: { limit: number; cursor?: string }): Page<Row> => {
    fetches.push(p);
    const after = p.cursor === undefined ? '' : decode(p.cursor);
    return pageOf(rows.filter((r) => r.id > after).slice(0, p.limit), p.limit, encode);
  };
  return { rows, fetch, fetches };
}

/** Walk to the end, collecting every entry and every cursor handed out. */
async function walk(
  fetch: (p: { limit: number; cursor?: string }) => Page<Row>,
  limit: number,
  visible: ReadonlySet<string> | VisibleTest<Row>,
  scanBudget?: number,
) {
  const allow = visible instanceof Set ? (r: Row) => visible.has(r.id) : (visible as VisibleTest<Row>);
  const entries: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await pageVisible(fetch, { limit, cursor }, allow, {
      ...(scanBudget === undefined ? {} : { scanBudget }),
    });
    entries.push(...page.entries.map((r) => r.id));
    if (page.nextCursor === null) return { entries, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

describe('pageVisible (#2073)', () => {
  const { rows, fetch } = table(30);
  // Visible: every third row, plus a run at the end — refused rows on both sides of each.
  const visible = new Set(rows.filter((_, i) => i % 3 === 1 || i >= 27).map((r) => r.id));

  for (const limit of [1, 2, 3, 5, 50]) {
    it(`limit ${limit}: every cursor decodes to a row the caller may see, and the walk reaches them all`, async () => {
      const { entries, cursors } = await walk(fetch, limit, visible);
      expect(entries).toEqual(rows.filter((r) => visible.has(r.id)).map((r) => r.id));
      for (const c of cursors) expect(visible.has(decode(c)), `cursor at ${decode(c)}`).toBe(true);
    });
  }

  it('limit 1 hands out exactly the visible rows, one cursor each', async () => {
    const { entries, cursors } = await walk(fetch, 1, visible);
    expect(cursors.map(decode)).toEqual(entries);
  });

  it('a caller refused every row gets no rows and no cursor — below, at and past the budget', async () => {
    const none = new Set<string>();
    const answer = (n: number) => pageVisible(table(n).fetch, { limit: 5 }, (r) => none.has(r.id), { scanBudget: 4 });
    for (const n of [3, 4, 5, 30]) expect(await answer(n), `table of ${n}`).toEqual({ entries: [], nextCursor: null });
  });

  it('answers a visible prefix the same either side of the budget', async () => {
    // [r0000] visible, the rest refused; tables of 3 end inside a budget of 4, 4 and 5 spend it.
    const page = (n: number) => pageVisible(table(n).fetch, { limit: 5 }, (r) => r.id === 'r0000', { scanBudget: 4 });
    const expected = { entries: [{ id: 'r0000' }], nextCursor: null };
    for (const n of [3, 4, 5, 30]) expect(await page(n), `table of ${n}`).toEqual(expected);
  });

  it('reads at most the budget', async () => {
    const t = table(100);
    await pageVisible(t.fetch, { limit: 3 }, () => false, { scanBudget: 10 });
    expect(t.fetches.reduce((n, f) => n + f.limit, 0)).toBe(10);
  });

  it('defaults to VISIBLE_SCAN_BUDGET', async () => {
    const t = table(VISIBLE_SCAN_BUDGET + 50);
    expect(await pageVisible(t.fetch, { limit: 200 }, () => false)).toEqual({ entries: [], nextCursor: null });
    expect(t.fetches.reduce((n, f) => n + f.limit, 0)).toBe(VISIBLE_SCAN_BUDGET);
  });

  it('a full page carries the cursor of its last row even when the table ends there', async () => {
    const t = table(4);
    const first = await pageVisible(t.fetch, { limit: 2 }, (r) => r.id === 'r0001' || r.id === 'r0003');
    expect(first.entries.map((r) => r.id)).toEqual(['r0001', 'r0003']);
    expect(decode(first.nextCursor!)).toBe('r0003');
    expect(await pageVisible(t.fetch, { limit: 2, cursor: first.nextCursor! }, () => true)).toEqual({
      entries: [],
      nextCursor: null,
    });
  });

  it('stops checking at the page\'s last visible row', async () => {
    const asked: string[] = [];
    await pageVisible(fetch, { limit: 1 }, (r) => {
      asked.push(r.id);
      return visible.has(r.id);
    });
    expect(asked).toEqual(['r0000', 'r0001']);
  });

  it('reads a mid-batch cursor back with one more fetch, or mints it with cursorOf', async () => {
    // Visible r0000 and r0002 at limit 2: the page fills on r0002, mid-batch (r0003 was read too).
    const visibleAt = (r: Row) => r.id === 'r0000' || r.id === 'r0002';
    const readBack = table(10);
    const viaFetch = await pageVisible(readBack.fetch, { limit: 2 }, visibleAt);
    expect(decode(viaFetch.nextCursor!)).toBe('r0002');
    expect(readBack.fetches.at(-1)).toEqual({ limit: 1, cursor: readBack.fetches.at(-2)!.cursor });

    const minted = table(10);
    expect(await pageVisible(minted.fetch, { limit: 2 }, visibleAt, { cursorOf: encode })).toEqual(viaFetch);
    expect(minted.fetches).toHaveLength(readBack.fetches.length - 1);
  });

  it('takes a batch test, one verdict per row in order', async () => {
    const batches: string[][] = [];
    const test: VisibleTest<Row> = {
      batch: (rs) => {
        batches.push(rs.map((r) => r.id));
        return rs.map((r) => visible.has(r.id));
      },
    };
    const { entries, cursors } = await walk(fetch, 2, test);
    expect(entries).toEqual(rows.filter((r) => visible.has(r.id)).map((r) => r.id));
    for (const c of cursors) expect(visible.has(decode(c))).toBe(true);
    expect(batches[0]).toEqual(['r0000', 'r0001']); // asked of the whole batch at once
  });
});
