import { describe, expect, it } from 'vitest';
import { scopeId, type ScopeDumpChange, type ScopeDumpChanges, type ScopeDumpPage, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { TRANSFER_ATTEMPTS, beginTransfer, transferScope, transferStep, type TransferState, type VerticalClient } from '../src/vertical-client.js';

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

/**
 * A destination that stages pages (or predates them) and change batches. `changes: 'predates'` is
 * one built before catch-up; `takenChanges`, the change seqs the stage took before this test's calls.
 */
function stagingDest(
  answer: 'staged' | 'predates' = 'staged',
  opts: { changes?: 'staged' | 'predates'; takenChanges?: number[] } = {},
) {
  const staged: { sid: string; stageId: string; seq: number; rows: number }[] = [];
  const changes: { stageId: string; seq: number; tables: ScopeDumpChange[] }[] = [];
  const discarded: string[] = [];
  const dest = {
    stageScopePage: async (sid: string, stageId: string, seq: number, tables: ScopeDumpTable[]) => {
      if (answer === 'predates') return 'predates' as const;
      staged.push({ sid, stageId, seq, rows: tables.reduce((n, t) => n + t.rows.length, 0) });
      return { staged: true };
    },
    stageScopeChanges: async (_sid: string, stageId: string, seq: number, tables: ScopeDumpChange[]) => {
      if (opts.changes === 'predates') return 'predates' as const;
      changes.push({ stageId, seq, tables });
      return { staged: !(opts.takenChanges ?? []).includes(seq) };
    },
    discardStagedScope: async (_sid: string, stageId: string) => {
      discarded.push(stageId);
    },
  };
  return { dest: dest as unknown as VerticalClient, staged, changes, discarded };
}

const rowChange = (rows: [number, string][], deleted: number[] = []): ScopeDumpChange => ({
  ...fragment(rows.map(([, id]) => [id])), rowids: rows.map(([rid]) => rid), deleted,
});

/**
 * A source that captures (#2450 step 3): `pages` pages of one row each, read at a revision that
 * moves on every page (it is busy), and the change `batches` it serves, in order, once the pages
 * are read; each batch is final where it says so, with revision `final`. `refuseOpen` answers the
 * capture's opening 412 (an index it cannot key); `echo: false` is a host that predates the echo.
 * `lost` answers a 412 for that batch on the first attempt, as a capture gone mid-way does.
 */
function capturingSource(o: {
  pages: number;
  batches: { tables: ScopeDumpChange[]; final?: boolean }[];
  refuseOpen?: boolean;
  echo?: boolean;
  lost?: number;
}) {
  const reads: { cursor: string | null; capture?: string }[] = [];
  const asked: { copyId: string; seq: number }[] = [];
  const ended: string[] = [];
  let attempt = 0;
  let revision = 0;
  const source = {
    exportScope: async () => { throw new Error('whole export not expected'); },
    exportScopeStamped: async () => { throw new Error('whole export not expected'); },
    exportScopePage: async (_sid: string, cursor: string | null, opts: { capture?: string } = {}): Promise<ScopeDumpPage> => {
      reads.push({ cursor, ...(opts.capture ? { capture: opts.capture } : {}) });
      if (cursor === null && opts.capture && o.refuseOpen) throw new ControlPlaneError(412, 'cannot capture');
      if (cursor === null) attempt++;
      const n = cursor === null ? 0 : Number(cursor);
      const captured = opts.capture !== undefined && o.echo !== false;
      return {
        tables: captured
          ? [{ ...fragment([[`p${n}`]]), rowids: [n + 1] }, ...(n === 0 ? [{ ...meta, rowids: [1] }] : [])]
          : [fragment([[`p${n}`]]), ...(n === 0 ? [meta] : [])],
        next: n + 1 < o.pages ? String(n + 1) : null,
        loadStamp: 'stamp',
        // Busy: a capture needs no quiet moment. A plain read sees the store at rest.
        revision: captured ? `r${++revision}` : 'r0',
        ...(captured ? { captured: true as const } : {}),
      };
    },
    exportScopeChanges: async (_sid: string, copyId: string, seq: number): Promise<ScopeDumpChanges> => {
      asked.push({ copyId, seq });
      if (attempt === 1 && seq === o.lost) throw new ControlPlaneError(412, 'the capture is gone');
      const batch = o.batches[Math.min(seq, o.batches.length - 1)]!;
      return { tables: batch.tables, final: batch.final === true, revision: batch.final ? 'final' : `r${++revision}` };
    },
    endScopeCapture: async (_sid: string, copyId: string) => {
      ended.push(copyId);
    },
  };
  return { source: source as unknown as VerticalClient, reads, asked, ended };
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

  describe('a busy source, caught up on its writes (#2450 step 3)', () => {
    it('pages read at moving revisions are caught up in change batches, and the copy is true at the final one', async () => {
      const carried: ScopeDumpChange = { ...meta, rows: [['carried_away', 'y']], rowids: [1], deleted: [] };
      const { source, reads, asked, ended } = capturingSource({
        pages: 3,
        batches: [{ tables: [rowChange([[2, 'p1-new']], [3]), carried] }, { tables: [rowChange([[4, 'p4']])], final: true }],
      });
      const { dest, staged, changes, discarded } = stagingDest();
      const out = await transferScope(source, dest, { from, to });
      const stageId = staged[0]!.stageId;
      // Every page asks under the capture the stage's id names; nothing restarts.
      expect(reads).toEqual([null, '1', '2'].map((cursor) => ({ cursor, capture: stageId })));
      expect(asked).toEqual([{ copyId: stageId, seq: 0 }, { copyId: stageId, seq: 1 }]);
      expect(changes.map((c) => [c.stageId, c.seq])).toEqual([[stageId, 3], [stageId, 4]]);
      expect(out).toMatchObject({ dump: { stageId }, revision: 'final', loadStamp: 'stamp' });
      // The meta row written mid-copy is what the carried-away check reads; no rowid leaks out.
      expect(out.meta).toEqual([{ ...meta, rows: [['carried_away', 'y']] }]);
      // The final batch ended the capture at the source; nothing was discarded or ended here.
      expect({ ended, discarded }).toEqual({ ended: [], discarded: [] });
    });

    it.each([
      ['refuses to open a capture (412)', { refuseOpen: true }, false],
      ['answers a plain page (a host that predates the echo)', { echo: false }, true],
    ])('a source that %s is copied at a quiet moment', async (_, o, endsIt) => {
      const { source, reads, asked, ended } = capturingSource({ pages: 2, batches: [], ...o });
      const { dest, staged } = stagingDest();
      const out = await transferScope(source, dest, { from, to });
      expect(out).toMatchObject({ dump: { stageId: staged[0]!.stageId }, revision: 'r0' });
      expect(reads.slice(-1)).toEqual([{ cursor: '1' }]);
      expect(asked).toEqual([]);
      // A plain page may still have opened a capture there (#2761 took `capture` before the echo).
      expect(ended).toEqual(endsIt ? [staged[0]!.stageId] : []);
    });

    it('a scope that fits one page moves whole, and its capture is ended', async () => {
      const { source, ended, asked } = capturingSource({ pages: 1, batches: [] });
      const out = await transferScope(source, stagingDest().dest, { from });
      expect(Array.isArray(out.dump)).toBe(true);
      expect(ended).toHaveLength(1);
      expect(asked).toEqual([]);
    });

    it('a destination that cannot stage changes ends the capture and copies again at a quiet moment', async () => {
      const { source, reads, ended } = capturingSource({ pages: 2, batches: [{ tables: [rowChange([[1, 'x']])], final: true }] });
      const { dest, staged, discarded } = stagingDest('staged', { changes: 'predates' });
      const out = await transferScope(source, dest, { from, to });
      const [torn, kept] = [staged[0]!.stageId, staged[2]!.stageId];
      expect({ ended, discarded }).toEqual({ ended: [torn], discarded: [torn] });
      expect(reads.slice(2)).toEqual([{ cursor: null }, { cursor: '1' }]);
      expect(out).toMatchObject({ dump: { stageId: kept }, revision: 'r0' });
    });

    it('a capture lost mid-way (a lost final answer, asked again, among them) starts the copy again', async () => {
      const { source, ended, asked } = capturingSource({ pages: 2, batches: [{ tables: [rowChange([[1, 'x']])], final: true }], lost: 0 });
      const { dest, staged, discarded } = stagingDest();
      const out = await transferScope(source, dest, { from, to });
      const torn = staged[0]!.stageId;
      expect({ ended, discarded }).toEqual({ ended: [torn], discarded: [torn] });
      expect(asked.map((a) => a.copyId === torn)).toEqual([true, false]);
      expect(out).toMatchObject({ revision: 'final' });
    });

    it(`a catch-up that never reaches a final batch is bounded, then refused with 409 after ${TRANSFER_ATTEMPTS} attempts`, async () => {
      const { source, ended, asked } = capturingSource({ pages: 2, batches: [{ tables: [rowChange([[1, 'x']])] }] });
      const { dest, discarded } = stagingDest();
      const refused = await transferScope(source, dest, { from, to }, { catchUpBatches: 2 }).catch((e: unknown) => e);
      expect((refused as ControlPlaneError).status).toBe(409);
      expect(asked).toHaveLength(2 * TRANSFER_ATTEMPTS);
      // Every attempt's capture ended beside its stage (an end is best effort, so one may be ended twice).
      expect(discarded).toHaveLength(TRANSFER_ATTEMPTS);
      expect(new Set(ended)).toEqual(new Set(discarded));
    });
  });

  describe('in resumable steps, for a copy that outlasts a request', () => {
    const pages = [[fragment([['a']]), meta], [fragment([['b']])], [fragment([['c']])], [fragment([['d']])]];

    it('a step stops when told, and a state that crossed JSON resumes the same stage to the end', async () => {
      const { source } = pagedSource(pages);
      const { dest, staged } = stagingDest();
      const begun = await beginTransfer({ source, dest }, { from, to });
      expect('state' in begun).toBe(true);
      const state = (begun as { state: TransferState }).state;
      expect(state).toMatchObject({ from, into: to, seq: 0, pages: 1, rows: 2, attempt: 1, cursor: '1' });
      // One page, then the budget is spent.
      const one = await transferStep({ source, dest }, JSON.parse(JSON.stringify(state)) as TransferState, { until: () => true });
      const after = (one as { state: TransferState }).state;
      expect(after).toMatchObject({ seq: 1, pages: 2, rows: 3, cursor: '2', stageId: state.stageId });
      // Resumed elsewhere, from its JSON.
      const rest = await transferStep({ source, dest }, JSON.parse(JSON.stringify(after)) as TransferState);
      expect(rest).toEqual({ done: { dump: { stageId: state.stageId }, loadStamp: 'stamp', revision: 'r1', meta: [meta] } });
      expect(staged.map((s) => [s.stageId, s.seq])).toEqual([0, 1, 2, 3].map((n) => [state.stageId, n]));
    });

    it('alwaysStage stages even a scope that fits one page, so a job never holds it in memory', async () => {
      const { source } = pagedSource([[fragment([['a']])]]);
      const { dest, staged } = stagingDest();
      const begun = await beginTransfer({ source, dest }, { from, to }, { alwaysStage: true });
      expect(begun).toEqual({ done: { dump: { stageId: staged[0]!.stageId }, loadStamp: 'stamp', revision: 'r1', meta: [] } });
    });

    it('a step resumed from a record older than its stage stages the batch served now after the one staged then', async () => {
      // The stage took seq 2 (a change batch) before the job's record did: it says so, and the
      // fresh batch goes in at 3.
      const { source } = capturingSource({ pages: 2, batches: [{ tables: [rowChange([[2, 'b2']])], final: true }] });
      const { dest, changes } = stagingDest('staged', { takenChanges: [2] });
      const begun = (await beginTransfer({ source, dest }, { from, to })) as { state: TransferState };
      const out = await transferStep({ source, dest }, begun.state);
      expect(changes.map((c) => c.seq)).toEqual([2, 3]);
      expect(out).toMatchObject({ done: { revision: 'final' } });
    });

    it('a step that finds the source written restarts under a new stage, and counts the attempt', async () => {
      const { source } = pagedSource(pages, (n, attempt) => (attempt === 1 && n === 2 ? 'moved' : `r${attempt}`));
      const { dest, discarded } = stagingDest();
      const begun = (await beginTransfer({ source, dest }, { from, to })) as { state: TransferState };
      // The step that meets the moved revision hands back the fresh copy's first state.
      const restarted = (await transferStep({ source, dest }, begun.state)) as { state: TransferState };
      expect(discarded).toEqual([begun.state.stageId]);
      expect(restarted.state).toMatchObject({ attempt: 2, seq: 0, revision: 'r2', pages: 1 });
      expect(restarted.state.stageId).not.toBe(begun.state.stageId);
      const step = await transferStep({ source, dest }, restarted.state);
      expect(step).toMatchObject({ done: { dump: { stageId: restarted.state.stageId }, revision: 'r2' } });
    });
  });
});

