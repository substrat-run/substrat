/**
 * `pageVisible` never hands out a position of a row the caller may not see (#2073).
 *
 * The fetch here mints a READABLE cursor — the row's sort value and id, as `ctx.page`'s envelope
 * carries them (K-44) — so every cursor a walk returns can be decoded and judged against the rows
 * the check refused. That is the oracle: not the page shape, but whose position the cursor is.
 */
import { describe, expect, it } from 'vitest';
import {
  mapPage,
  pageOf,
  pageVisible,
  serializeWithoutRowCursors,
  VISIBLE_BATCH,
  VISIBLE_SCAN_BUDGET,
  type Page,
  type VisibleTest,
  withoutRowCursors,
} from '../src/pagination.js';

interface Row {
  id: string;
  /** The sort value; rows may share one, and the id breaks the tie. */
  s: string;
}
const encode = (row: Row) => btoa(JSON.stringify({ s: row.s, id: row.id }));
const decode = (cursor: string) => (JSON.parse(atob(cursor)) as Row).id;
const after = (row: Row, cursor: string) => {
  const at = JSON.parse(atob(cursor)) as Row;
  return row.s > at.s || (row.s === at.s && row.id > at.id);
};

/**
 * A keyset table of `n` rows, read the way `ctx.page` reads one: `pageOf`, so a full page carries
 * its last row's cursor and the page can mint any of its rows'. `tie` rows share each sort value.
 * `bare` drops `rowCursors`, for a fetch whose producer does not pass the ask on.
 */
function table(n: number, opts: { tie?: number; bare?: boolean } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `r${String(i).padStart(4, '0')}`,
    s: String(Math.floor(i / (opts.tie ?? 1))).padStart(4, '0'),
  }));
  const fetches: { limit: number; cursor?: string }[] = [];
  const fetch = (p: { limit: number; cursor?: string; rowCursors?: boolean }): Page<Row> => {
    fetches.push({ limit: p.limit, cursor: p.cursor });
    const page = pageOf(
      rows.filter((r) => p.cursor === undefined || after(r, p.cursor)).slice(0, p.limit),
      p.limit,
      encode,
      p.rowCursors,
    );
    return opts.bare ? { entries: page.entries, nextCursor: page.nextCursor } : page;
  };
  return { rows, fetch, fetches };
}

/** Walk to the end, collecting every entry and every cursor handed out. */
async function walk(
  fetch: (p: { limit: number; cursor?: string; rowCursors?: boolean }) => Page<Row>,
  limit: number,
  visible: ReadonlySet<string> | VisibleTest<Row>,
  scanBudget?: number,
) {
  const allow = visible instanceof Set ? (r: Row) => visible.has(r.id) : (visible as VisibleTest<Row>);
  const entries: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await pageVisible(fetch, { limit, cursor }, allow, { scanBudget });
    expect('rowCursors' in page).toBe(false); // never handed on: only the rows returned are named
    entries.push(...page.entries.map((r) => r.id));
    if (page.nextCursor === null) return { entries, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

describe('pageVisible (#2073)', () => {
  const { rows, fetch } = table(300);
  // Visible: every 7th row, plus a run at the end — refused rows on both sides of each, and
  // visible rows on both sides of every batch boundary.
  const visible = new Set(ids(rows.filter((_, i) => i % 7 === 3 || i >= 290)));
  const expected = ids(rows.filter((r) => visible.has(r.id)));

  for (const limit of [1, 2, 3, 20, 63, 64, 65, 200]) {
    it(`limit ${limit}: every cursor decodes to a row the caller may see, and the walk reaches them all`, async () => {
      const { entries, cursors } = await walk(fetch, limit, visible);
      expect(entries).toEqual(expected);
      for (const c of cursors) expect(visible.has(decode(c)), `cursor at ${decode(c)}`).toBe(true);
    });
  }

  it('limit 1 hands out exactly the visible rows, one cursor each', async () => {
    const { entries, cursors } = await walk(fetch, 1, visible);
    expect(cursors.map(decode)).toEqual(entries);
  });

  it('a caller refused every row gets no rows and no cursor — below, at and past the budget', async () => {
    const answer = (n: number) => pageVisible(table(n).fetch, { limit: 5 }, () => false, { scanBudget: 4 });
    for (const n of [3, 4, 5, 30]) expect(await answer(n), `table of ${n}`).toEqual({ entries: [], nextCursor: null });
  });

  it('answers a visible prefix the same either side of the budget', async () => {
    // [r0000] visible, the rest refused; tables of 3 end inside a budget of 4, 4 and 5 spend it.
    const page = (n: number) => pageVisible(table(n).fetch, { limit: 5 }, (r) => r.id === 'r0000', { scanBudget: 4 });
    for (const n of [3, 4, 5, 30]) {
      expect(await page(n), `table of ${n}`).toEqual({ entries: [expect.objectContaining({ id: 'r0000' })], nextCursor: null });
    }
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

  // Codex r1 on #2078: fetching only what the page lacks costs a read per refused row.
  for (const limit of [1, 20]) {
    it(`limit ${limit} over ${VISIBLE_SCAN_BUDGET} refused rows: reads stay at budget / batch`, async () => {
      const t = table(VISIBLE_SCAN_BUDGET + 10);
      const lastId = t.rows.at(-1)!.id;
      const page = await pageVisible(t.fetch, { limit }, (r) => r.id === lastId);
      expect(page).toEqual({ entries: [], nextCursor: null }); // past the budget: the documented limit
      expect(t.fetches.length).toBeLessThanOrEqual(Math.ceil(VISIBLE_SCAN_BUDGET / Math.max(limit, VISIBLE_BATCH)));
    });
  }

  it('fetches in batches of max(limit, VISIBLE_BATCH)', async () => {
    const small = table(300);
    await pageVisible(small.fetch, { limit: 2 }, (r) => r.id === 'r0100' || r.id === 'r0200');
    expect(small.fetches.map((f) => f.limit)).toEqual([VISIBLE_BATCH, VISIBLE_BATCH, VISIBLE_BATCH, VISIBLE_BATCH]);
    const large = table(300);
    await pageVisible(large.fetch, { limit: 100 }, () => true);
    expect(large.fetches.map((f) => f.limit)).toEqual([100]);
  });

  it('a full page carries the cursor of its last row even when the table ends there', async () => {
    const t = table(4);
    const first = await pageVisible(t.fetch, { limit: 2 }, (r) => r.id === 'r0001' || r.id === 'r0003');
    expect(ids(first.entries)).toEqual(['r0001', 'r0003']);
    expect(decode(first.nextCursor!)).toBe('r0003');
    expect(await pageVisible(t.fetch, { limit: 2, cursor: first.nextCursor! }, () => true)).toEqual({
      entries: [],
      nextCursor: null,
    });
  });

  it("stops checking at the page's last visible row", async () => {
    const asked: string[] = [];
    await pageVisible(fetch, { limit: 2 }, (r) => {
      asked.push(r.id);
      return visible.has(r.id);
    });
    expect(asked).toEqual(['r0000', 'r0001', 'r0002', 'r0003', 'r0004', 'r0005', 'r0006', 'r0007', 'r0008', 'r0009', 'r0010']);
  });

  it('resumes exactly at a batch boundary: the last row of one batch, then the first of the next', async () => {
    const last = `r${String(VISIBLE_BATCH - 1).padStart(4, '0')}`;
    const first = `r${String(VISIBLE_BATCH).padStart(4, '0')}`;
    const { entries, cursors } = await walk(table(200).fetch, 1, new Set([last, first]));
    expect(entries).toEqual([last, first]);
    expect(cursors.map(decode)).toEqual([last, first]);
  });

  it('walks ties in the sort value across batch boundaries without skipping or repeating', async () => {
    // Five rows to a sort value, so every batch boundary falls inside a run of ties.
    const t = table(400, { tie: 5 });
    const shown = new Set(ids(t.rows.filter((_, i) => i % 3 === 0)));
    for (const limit of [1, 7, 64]) {
      const { entries, cursors } = await walk(t.fetch, limit, shown);
      expect(entries, `limit ${limit}`).toEqual(ids(t.rows.filter((r) => shown.has(r.id))));
      for (const c of cursors) expect(shown.has(decode(c))).toBe(true);
    }
  });

  it("takes the cursor from the visible row's own entry in the same response — one fetch", async () => {
    // Visible r0000 and r0002 at limit 2: the page fills on r0002, mid-batch.
    const t = table(10);
    const page = await pageVisible(t.fetch, { limit: 2 }, (r) => r.id === 'r0000' || r.id === 'r0002');
    expect(decode(page.nextCursor!)).toBe('r0002');
    expect(t.fetches).toHaveLength(1);
  });

  it('fails closed on a fetch that returns no rowCursors: the page ends there, and nothing is read again', async () => {
    // Mid-batch: no position of r0002 is in the response, so the walk ends, as a short page does.
    const bare = table(10, { bare: true });
    const visibleAt = (r: Row) => r.id === 'r0000' || r.id === 'r0002';
    expect(await pageVisible(bare.fetch, { limit: 2 }, visibleAt)).toEqual({
      entries: [{ id: 'r0000', s: '0000' }, { id: 'r0002', s: '0002' }],
      nextCursor: null,
    });
    expect(bare.fetches).toHaveLength(1);
    // A FULL bare batch, stopped at r0002: its nextCursor is r0063's, a refused row, and is not it.
    const full = table(200, { bare: true });
    expect(await pageVisible(full.fetch, { limit: 1 }, (r) => r.id === 'r0002')).toEqual({
      entries: [{ id: 'r0002', s: '0002' }],
      nextCursor: null,
    });
    // The last row of a full batch is still its own: that is the response's `nextCursor`.
    const edge = table(200, { bare: true });
    const last = `r${String(VISIBLE_BATCH - 1).padStart(4, '0')}`;
    const atEdge = await pageVisible(edge.fetch, { limit: 1 }, (r) => r.id === last);
    expect(decode(atEdge.nextCursor!)).toBe(last);
  });

  it('takes a batch test, one verdict per row in order, asked once per batch', async () => {
    const batches: string[][] = [];
    const test: VisibleTest<Row> = {
      batch: (rs) => {
        batches.push(ids(rs));
        return rs.map((r) => visible.has(r.id));
      },
    };
    const { entries, cursors } = await walk(fetch, 20, test);
    expect(entries).toEqual(expected);
    for (const c of cursors) expect(visible.has(decode(c))).toBe(true);
    expect(batches[0]).toHaveLength(VISIBLE_BATCH);
  });
});

describe("a page's own row cursors (#2073)", () => {
  const rows: Row[] = [{ id: 'a', s: '1' }, { id: 'b', s: '2' }, { id: 'c', s: '3' }];

  it('are there only when asked for, aligned with the entries', () => {
    expect('rowCursors' in pageOf(rows, 3, encode)).toBe(false);
    expect(pageOf(rows, 3, encode, true).rowCursors!.map(decode)).toEqual(['a', 'b', 'c']);
  });

  for (const [what, project] of [
    ['an equal primitive', () => 'same'],
    ['one reused object', (() => {
      const shared = { name: 'same' };
      return () => shared;
    })()],
  ] as [string, (r: Row) => unknown][]) {
    it(`mapPage keeps each row's cursor by position when rows project to ${what}`, async () => {
      const mapped = mapPage(pageOf(rows, 3, encode, true), project);
      expect(mapped.rowCursors!.map(decode)).toEqual(['a', 'b', 'c']);
      // The walk that stops at the second of three equal projections hands on b, not a.
      const fetch = (p: { limit: number; cursor?: string; rowCursors?: boolean }) =>
        mapPage(pageOf(rows.filter((r) => !p.cursor || after(r, p.cursor)).slice(0, p.limit), p.limit, encode, p.rowCursors), project);
      const first = await pageVisible(fetch, { limit: 2 }, () => true);
      expect(decode(first.nextCursor!)).toBe('b');
      const second = await pageVisible(fetch, { limit: 2, cursor: first.nextCursor! }, () => true);
      expect(second.entries).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });
  }
});

describe('rowCursors never leave the process (#2073)', () => {
  const leaky = () => ({ entries: [{ id: 'a' }], nextCursor: 'a', rowCursors: ['a', 'HIDDEN'] });
  class PageInstance {
    entries = [{ id: 'a' }];
    nextCursor = 'a';
    rowCursors = ['HIDDEN'];
  }
  const page = leaky();
  for (const [shape, value] of Object.entries({
    'a page': leaky(),
    'one page referenced twice': { first: page, again: page },
    'an array of the same page': [page, page],
    'a class instance': new PageInstance(),
    'a toJSON that returns a page': { toJSON: () => ({ nested: leaky() }) },
  })) {
    it(`serialised: ${shape}`, () => {
      const json = serializeWithoutRowCursors(value)!;
      expect(json).not.toContain('rowCursors');
      expect(json).not.toContain('HIDDEN');
      expect(JSON.stringify(withoutRowCursors(value))).toBe(json);
    });
  }

  it("leaves a rowCursors that is not a page's untouched — a domain field, opaque data", () => {
    const value = {
      entry: { id: 'a', rowCursors: ['kept'] },
      opaque: { rowCursors: { any: 'thing' } },
      // Has entries but no nextCursor: not a page, so not scrubbed.
      almost: { entries: [], rowCursors: ['kept'] },
      page: { entries: [{ id: 'a', rowCursors: 'kept-in-entry' }], nextCursor: null, rowCursors: ['HIDDEN'] },
    };
    const back = JSON.parse(serializeWithoutRowCursors(value)!);
    expect(back.entry.rowCursors).toEqual(['kept']);
    expect(back.opaque.rowCursors).toEqual({ any: 'thing' });
    expect(back.almost.rowCursors).toEqual(['kept']);
    expect(back.page.entries[0].rowCursors).toBe('kept-in-entry');
    expect(back.page).not.toHaveProperty('rowCursors');
  });

  it('leaves undefined as JSON leaves it', () => {
    expect(serializeWithoutRowCursors(undefined)).toBeUndefined();
    expect(withoutRowCursors(undefined)).toBeUndefined();
  });
});
