import { describe, expect, it } from 'vitest';
import { scopeId, type ScopeDumpPage, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { TRANSFER_ATTEMPTS, transferScope, type VerticalClient } from '../src/vertical-client.js';

/**
 * #2450: `transferScope` moves a scope a page at a time into the destination's stage, and falls
 * back to the whole dump wherever an end predates the paged verbs. The pages are one copy only
 * while the source's revision holds; a copy it moves under is started again, then refused.
 */
const from = scopeId.parse(ulid());
const to = scopeId.parse(ulid());

const fragment = (rows: unknown[][]): ScopeDumpTable => ({
  name: 't_rows',
  ddl: 'CREATE TABLE t_rows (id TEXT)',
  columns: ['id'],
  rows,
});
const meta: ScopeDumpTable = {
  name: '_substrat_meta',
  ddl: 'CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT)',
  columns: ['key', 'value'],
  rows: [['carried_away', 'x']],
};

/** A source answering `pages` in order, the revision of each read from `revisions` (default `r1`). */
function pagedSource(pages: ScopeDumpTable[][], revisions: (n: number, attempt: number) => string = () => 'r1') {
  const calls: { cursor: string | null; stamp?: boolean }[] = [];
  let attempt = 0;
  const source = {
    exportScope: async () => {
      throw new Error('whole export not expected');
    },
    exportScopeStamped: async () => {
      throw new Error('whole export not expected');
    },
    exportScopePage: async (_sid: string, cursor: string | null, opts?: { stamp?: boolean }): Promise<ScopeDumpPage> => {
      calls.push({ cursor, stamp: opts?.stamp });
      if (cursor === null) attempt++;
      const n = cursor === null ? 0 : Number(cursor);
      return {
        tables: pages[n]!,
        next: n + 1 < pages.length ? String(n + 1) : null,
        loadStamp: 'stamp',
        revision: revisions(n, attempt),
      };
    },
  };
  return { source: source as unknown as VerticalClient, calls };
}

function stagingDest(answer: 'staged' | 'predates' = 'staged') {
  const staged: { sid: string; stageId: string; seq: number; rows: number }[] = [];
  const discarded: string[] = [];
  const dest = {
    stageScopePage: async (sid: string, stageId: string, seq: number, tables: ScopeDumpTable[]) => {
      if (answer === 'predates') return 'predates' as const;
      staged.push({ sid, stageId, seq, rows: tables.reduce((n, t) => n + t.rows.length, 0) });
      return { staged: true };
    },
    discardStagedScope: async (_sid: string, stageId: string) => {
      discarded.push(stageId);
    },
  };
  return { dest: dest as unknown as VerticalClient, staged, discarded };
}

describe('transferScope (#2450)', () => {
  it('stages every page into the destination scope and names the stage', async () => {
    const { source, calls } = pagedSource([[fragment([['a']]), meta], [fragment([['b']])], [fragment([['c']])]]);
    const { dest, staged } = stagingDest();
    const out = await transferScope(source, dest, { from, to });
    expect(out.dump).toEqual({ stageId: staged[0]!.stageId });
    expect(staged.map((s) => [s.sid, s.seq, s.rows])).toEqual([[to, 0, 2], [to, 1, 1], [to, 2, 1]]);
    expect(new Set(staged.map((s) => s.stageId)).size).toBe(1);
    expect(out).toMatchObject({ loadStamp: 'stamp', revision: 'r1' });
    // The meta table travels beside the stage, for the carried-away check.
    expect(out.meta).toEqual([meta]);
    // A carry's export is stamped by default.
    expect(calls.every((c) => c.stamp === true)).toBe(true);
  });

  it('a fork reads unstamped', async () => {
    const { source, calls } = pagedSource([[fragment([['a']])], [fragment([['b']])]]);
    await transferScope(source, stagingDest().dest, { from, to }, { stamp: false });
    expect(calls.every((c) => c.stamp === false)).toBe(true);
  });

  it('a scope that fits one page moves whole, and stages nothing', async () => {
    const { source } = pagedSource([[fragment([['a']])]]);
    const { dest, staged } = stagingDest();
    const out = await transferScope(source, dest, { from });
    expect(out.dump).toEqual([fragment([['a']])]);
    expect(staged).toEqual([]);
  });

  it('a destination that cannot stage gets the pages merged into one dump', async () => {
    const { source } = pagedSource([[fragment([['a']])], [fragment([['b']])], [fragment([['c']])]]);
    const out = await transferScope(source, stagingDest('predates').dest, { from });
    expect(out.dump).toEqual([fragment([['a'], ['b'], ['c']])]);
  });

  it('a source that predates the pages exports whole: stamped for a carry, unstamped for a fork', async () => {
    const whole = [fragment([['a'], ['b']])];
    const source = {
      exportScopePage: async () => 'predates' as const,
      exportScopeStamped: async () => ({ tables: whole, loadStamp: 'old-stamp', revision: 'r9' }),
      exportScope: async () => whole,
    } as unknown as VerticalClient;
    expect(await transferScope(source, stagingDest().dest, { from })).toMatchObject({
      dump: whole, loadStamp: 'old-stamp', revision: 'r9',
    });
    expect(await transferScope(source, stagingDest().dest, { from }, { stamp: false })).toMatchObject({
      dump: whole, loadStamp: null, revision: null,
    });
  });

  it('a client assembled without the paged verbs is read as one that predates them', async () => {
    const whole = [fragment([['a']])];
    const source = {
      exportScopeStamped: async () => ({ tables: whole, loadStamp: null, revision: null }),
    } as unknown as VerticalClient;
    expect((await transferScope(source, {} as VerticalClient, { from })).dump).toEqual(whole);
  });

  it('a source written between pages is copied again, and the torn stage is discarded', async () => {
    // The first attempt's second page reads a moved revision; the second attempt holds still.
    const { source } = pagedSource([[fragment([['a']])], [fragment([['b']])]], (n, attempt) =>
      attempt === 1 && n === 1 ? 'r2' : `r${attempt}`,
    );
    const { dest, staged, discarded } = stagingDest();
    const out = await transferScope(source, dest, { from });
    expect(discarded).toHaveLength(1);
    expect(out.dump).toEqual({ stageId: staged[staged.length - 1]!.stageId });
    expect(discarded[0]).not.toBe((out.dump as { stageId: string }).stageId);
    expect(out.revision).toBe('r2');
  });

  it(`a source that moves under every one of ${TRANSFER_ATTEMPTS} attempts is refused with 409, nothing moved`, async () => {
    const { source, calls } = pagedSource([[fragment([['a']])], [fragment([['b']])]], (n, attempt) => `r${attempt}.${n}`);
    const { dest, discarded } = stagingDest();
    const refused = await transferScope(source, dest, { from }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ControlPlaneError);
    expect((refused as ControlPlaneError).status).toBe(409);
    expect(calls.filter((c) => c.cursor === null)).toHaveLength(TRANSFER_ATTEMPTS);
    expect(discarded).toHaveLength(TRANSFER_ATTEMPTS);
  });
});
