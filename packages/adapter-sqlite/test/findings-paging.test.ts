import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { FINDINGS_LIMIT_DEFAULT, FINDINGS_LIMIT_MAX, findingCursorOf, parseFindingCursor, type FindingEntry, type FindingFilter } from '@substrat-run/contracts';
import { FINDINGS_DDL, listFindings } from '@substrat-run/kernel';

/**
 * `listFindings`' keyset walk (#2198), against the real table rather than a fake executor:
 * the property is "the SQL seeks to the right row", and only SQLite can say so. Rows are
 * inserted directly because a tie on `last_seen` — the case a page boundary can split wrongly —
 * cannot be produced through the record calls, whose clock moves.
 */
describe('listFindings paging (#2198)', () => {
  const T = '01JZ000000000000000000TNTA';
  const U = '01JZ000000000000000000TNTB';
  let db: Database.Database;
  const sql = (q: string, params: readonly (string | number | null)[]) => db.prepare(q).all(...params);
  const instantAt = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const at = (lastSeen: string, id: string) => findingCursorOf({ lastSeen: lastSeen as FindingEntry['lastSeen'], id });

  const insert = (id: string, lastSeen: string, o: { tenant?: string; status?: string; kind?: string } = {}) =>
    db
      .prepare(
        `INSERT INTO _substrat_findings (id, tenant_id, kind, subject, status, severity, title, codes, seen_count,
           first_seen, last_seen, evidence)
         VALUES (?, ?, ?, ?, ?, 'warning', ?, '[]', 1, ?, ?, ?)`,
      )
      .run(
        id,
        o.tenant ?? T,
        o.kind ?? 'recurring',
        `subject-${id}`,
        o.status ?? 'open',
        `title ${id}`,
        lastSeen,
        lastSeen,
        JSON.stringify({ source: 'ops-failures', fingerprint: id }),
      );

  const ids = (filter?: FindingFilter) => listFindings(sql, filter).map((f) => f.id);
  /** Walk to the end the way a client does, returning each page's ids. */
  const walk = (filter: FindingFilter = {}): string[][] => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = listFindings(sql, { ...filter, ...(cursor === undefined ? {} : { cursor }) });
      pages.push(page.map((f) => f.id));
      // pageOf's rule: a full page may have more behind it, a short one is the end.
      if (page.length < (filter.limit ?? FINDINGS_LIMIT_DEFAULT)) return pages;
      cursor = findingCursorOf(page[page.length - 1]!);
    }
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(FINDINGS_DDL);
  });

  it('walks every row exactly once, in last_seen DESC / id order, across page boundaries', () => {
    for (let i = 1; i <= 7; i++) insert(`F${i}`, instantAt(i));
    expect(walk({ limit: 3 })).toEqual([['F7', 'F6', 'F5'], ['F4', 'F3', 'F2'], ['F1']]);
    // The positive twin: one page that holds everything is the unpaged read.
    expect(ids({ limit: 50 })).toEqual(['F7', 'F6', 'F5', 'F4', 'F3', 'F2', 'F1']);
  });

  it('ends on a short page, and an exact multiple costs one empty page rather than a missed row', () => {
    for (let i = 1; i <= 6; i++) insert(`F${i}`, instantAt(i));
    expect(walk({ limit: 3 })).toEqual([['F6', 'F5', 'F4'], ['F3', 'F2', 'F1'], []]);
  });

  it('does not split a tie on last_seen: the id tiebreak is part of the cursor', () => {
    const same = instantAt(5);
    for (const id of ['A', 'B', 'C', 'D', 'E']) insert(id, same);
    insert('OLD', instantAt(1));
    // The boundary falls inside the tie (B | C), so a cursor on last_seen alone would drop C-E or repeat A-B.
    expect(walk({ limit: 2 })).toEqual([['A', 'B'], ['C', 'D'], ['E', 'OLD'], []]);
    expect(ids({ limit: 2, cursor: at(same, 'B') })).toEqual(['C', 'D']);
  });

  it('is empty past the last row, and on an empty table', () => {
    expect(ids()).toEqual([]);
    insert('F1', instantAt(1));
    expect(ids({ cursor: at(instantAt(1), 'F1') })).toEqual([]);
    // Twin: a cursor before every row still returns it.
    expect(ids({ cursor: at(instantAt(2), 'Z') })).toEqual(['F1']);
  });

  it('keeps a walk inside its filter: status, kind and tenant narrow every page', () => {
    for (let i = 1; i <= 6; i++) insert(`O${i}`, instantAt(i * 2), { status: i % 2 ? 'open' : 'acked' });
    insert('OTHER', instantAt(100), { tenant: U });
    insert('DRIFT', instantAt(50), { kind: 'drift' });
    expect(walk({ tenantId: T as never, status: 'acked', limit: 2 })).toEqual([['O6', 'O4'], ['O2']]);
    expect(walk({ tenantId: T as never, kind: 'drift', limit: 2 })).toEqual([['DRIFT']]);
    expect(ids({ tenantId: U as never })).toEqual(['OTHER']);
  });

  it('defaults to 100 when no limit is sent, as it did before it could page', () => {
    for (let i = 0; i < 120; i++) insert(`F${String(i).padStart(3, '0')}`, instantAt(i));
    expect(ids()).toHaveLength(FINDINGS_LIMIT_DEFAULT);
    expect(FINDINGS_LIMIT_DEFAULT).toBe(100);
  });

  it('refuses a limit that is not 1..max, and takes both bounds', () => {
    insert('F1', instantAt(1));
    for (const limit of [0, -1, 1.5, Number.NaN, FINDINGS_LIMIT_MAX + 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => listFindings(sql, { limit }), String(limit)).toThrow(/limit must be/);
    }
    expect(ids({ limit: 1 })).toEqual(['F1']);
    expect(ids({ limit: FINDINGS_LIMIT_MAX })).toEqual(['F1']);
  });

  it('refuses a cursor it did not mint, instead of reading it as "from the start"', () => {
    insert('F1', instantAt(1));
    const sep = String.fromCharCode(0);
    for (const cursor of ['', 'F1', `${instantAt(1)}`, `not-an-instant${sep}F1`, `${instantAt(1)}${sep}`, `${instantAt(1)}${sep}F1${sep}x`, "'; DROP TABLE _substrat_findings;--"]) {
      expect(() => listFindings(sql, { cursor }), JSON.stringify(cursor)).toThrow(/cursor is not a findings cursor/);
    }
    // The table survived the injection-shaped one, and a minted cursor is accepted.
    expect(ids()).toEqual(['F1']);
    expect(parseFindingCursor(`${instantAt(1)}${sep}F1`)).toEqual({ lastSeen: instantAt(1), id: 'F1' });
  });

  describe('a finding seen again while the walk is in progress', () => {
    const bump = (id: string, to: string) => db.prepare('UPDATE _substrat_findings SET last_seen = ? WHERE id = ?').run(to, id);

    it('is never returned twice: one already read moves to the front, ahead of the cursor', () => {
      for (let i = 1; i <= 6; i++) insert(`F${i}`, instantAt(i));
      const first = listFindings(sql, { limit: 3 }); // F6 F5 F4
      bump('F5', instantAt(60)); // already read, now newest
      const rest = listFindings(sql, { limit: 3, cursor: findingCursorOf(first[2]!) }).map((f) => f.id);
      expect(rest).toEqual(['F3', 'F2', 'F1']);
      expect(rest).not.toContain('F5');
    });

    it('is met at the front of the next fresh read when it had not been reached yet', () => {
      for (let i = 1; i <= 6; i++) insert(`F${i}`, instantAt(i));
      const first = listFindings(sql, { limit: 3 });
      bump('F1', instantAt(60)); // not reached by this walk: the walk skips it, the next read leads with it
      const rest = listFindings(sql, { limit: 3, cursor: findingCursorOf(first[2]!) }).map((f) => f.id);
      expect(rest).toEqual(['F3', 'F2']);
      expect(ids({ limit: 3 })).toEqual(['F1', 'F6', 'F5']);
    });

    it('does not shift the cursor when a row at the boundary changes status', () => {
      for (let i = 1; i <= 4; i++) insert(`F${i}`, instantAt(i));
      const first = listFindings(sql, { limit: 2 }); // F4 F3
      db.prepare("UPDATE _substrat_findings SET status = 'resolved' WHERE id = 'F3'").run();
      expect(listFindings(sql, { limit: 2, cursor: findingCursorOf(first[1]!) }).map((f) => f.id)).toEqual(['F2', 'F1']);
    });
  });
});
