import { describe, expect, it } from 'vitest';
import { mergeDumpPages, StoreError, storeResponse, type ReservedStoreOperation, type ScopeDumpTable, type StoreRequest } from '@substrat-run/contracts';
import {
  callReservedStoreOperation,
  callScopeStore,
  readStoreDump,
  ulid,
  writeStoreDump,
  type ScopeStoreAddress,
  type ScopeStoreRunner,
} from '@substrat-run/kernel';

/**
 * What a driver hands the runner suite. The suite knows nothing about the driver beyond
 * two calls of its own catalog.
 */
export interface ScopeStoreRunnerFixture {
  /** A runner nobody has started. Called once per check. */
  makeRunner(): ScopeStoreRunner | Promise<ScopeStoreRunner>;
  /** A driver operation that changes the object. Each call must change what `read` answers. */
  readonly write: StoreRequest;
  /**
   * A driver operation that writes the n-th distinct row, so a dump of the object grows by one row
   * for each n. `write` may only ever touch one row; this is what lets the suite fill a store with
   * many.
   */
  writeRow(n: number): StoreRequest;
  /** A driver operation that reads the object back. Equal answers mean equal objects. */
  readonly read: StoreRequest;
  /**
   * Optional: tables the driver stages and then refuses at commit (a row it cannot take, or a table
   * it has no name for). With it the suite proves a refused stage leaves the object as it was.
   * Without it that check is skipped, and its name says so.
   */
  readonly refusedStage?: readonly ScopeDumpTable[];
  /**
   * Optional: a driver operation that writes a row held against `subjectId`, so that
   * `substrat.erase` of it erases something. With it the suite proves an erase that erased moves
   * the revision. Without it that check is skipped, and its name says so.
   */
  writeSubject?(subjectId: string): StoreRequest;
  /** Every catalog operation the driver serves: what its `substrat.selfcheck` must answer (#2814). */
  readonly catalog: readonly string[];
}

/** One check of the runner contract. It throws when the runner breaks it. */
export interface ScopeStoreRunnerCheck {
  readonly name: string;
  /** Set on a check that needs a fixture hook the driver did not give: it is listed, and skipped. */
  readonly skip?: true;
  run(): Promise<void>;
}

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/** A page size no test dump needs more than one page of. */
const LARGE_PAGE = 1024 * 1024;

const sizeOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const rowCount = (tables: readonly ScopeDumpTable[]): number => tables.reduce((sum, table) => sum + table.rows.length, 0);

/** A whole chain of `substrat.export-page`, read at `maxBytes`. */
interface Chain {
  readonly pages: ScopeDumpTable[][];
  /** The pages merged: each table once, its fragments joined in page order. */
  readonly tables: ScopeDumpTable[];
  readonly revisions: Set<string>;
}

async function chainOf(runner: ScopeStoreRunner, address: ScopeStoreAddress, maxBytes: number): Promise<Chain> {
  const pages: ScopeDumpTable[][] = [];
  const revisions = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { tables: ScopeDumpTable[]; next: string | null; revision: string } = await callReservedStoreOperation(
      (r) => runner.invoke(address, r),
      'substrat.export-page',
      { cursor, maxBytes },
    );
    pages.push(page.tables);
    revisions.add(page.revision);
    expect(page.next === null || page.next !== cursor, 'a chain moves on').toBe(true);
    expect(pages.length, 'a chain ends').toBeLessThan(10_000);
    cursor = page.next;
  } while (cursor !== null);
  return { pages, tables: mergeDumpPages(pages), revisions };
}

/**
 * The revision a chain carries, read to its end: a driver that refuses writes while a chain is open
 * is not left with one.
 */
async function revisionOf(runner: ScopeStoreRunner, address: ScopeStoreAddress): Promise<string> {
  return (await chainOf(runner, address, LARGE_PAGE)).revisions.values().next().value as string;
}

/** A stage the object does not hold, or will not take again, is refused with 409 `stage_refused`. */
const refused = (answer: Promise<unknown>) => expect(answer).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });

/** A dump cut into `parts` pages, each table's rows spread over them, every table named on every page. */
function spreadOver(tables: readonly ScopeDumpTable[], parts: number): ScopeDumpTable[][] {
  return Array.from({ length: parts }, (_, part) =>
    tables.map((table) => {
      const size = Math.ceil(table.rows.length / parts);
      return { ...table, rows: table.rows.slice(part * size, (part + 1) * size) };
    }),
  );
}

/** An address no other check, and no earlier run, has used. */
function freshAddress(): ScopeStoreAddress {
  return { tenantId: ulid(), vertical: 'conformance', scopeId: ulid(), binding: 'STORE' };
}

/** An operation name no driver declares, and still a valid label. */
const UNKNOWN_OPERATION = 'conformance-unknown-operation';

/**
 * The runner contract (#2213, RFC §7) as a list of checks, so a broken runner can be
 * shown to fail the one it breaks. {@link scopeStoreRunnerContractSuite} runs them all.
 *
 * Every call goes through the kernel's callers both hosts use (`callScopeStore`,
 * `callReservedStoreOperation`), so an answer is held to the same envelope and result
 * schema a host would hold it to.
 *
 * A restart is `stop()` then `start()` on the same runner instance: what a host does
 * between a `close` and the next first store call. A driver's repositories must survive
 * it. Blob cells in an export are not asserted (their spelling over JSON is not settled).
 */
export function scopeStoreRunnerChecks(fixture: ScopeStoreRunnerFixture): ScopeStoreRunnerCheck[] {
  /** A started runner for one check, stopped after it whatever happens. */
  const withRunner = async (body: (runner: ScopeStoreRunner) => Promise<void>): Promise<void> => {
    const runner = await fixture.makeRunner();
    await runner.start();
    try {
      await body(runner);
    } finally {
      await runner.stop();
    }
  };
  const call = (runner: ScopeStoreRunner, address: ScopeStoreAddress, request: StoreRequest) =>
    callScopeStore((r) => runner.invoke(address, r), request.operation, request.input);
  const read = (runner: ScopeStoreRunner, address: ScopeStoreAddress) => call(runner, address, fixture.read);
  const write = (runner: ScopeStoreRunner, address: ScopeStoreAddress) => call(runner, address, fixture.write);
  const writeRow = (runner: ScopeStoreRunner, address: ScopeStoreAddress, n: number) => call(runner, address, fixture.writeRow(n));
  const reserved = <O extends ReservedStoreOperation>(
    runner: ScopeStoreRunner,
    address: ScopeStoreAddress,
    operation: O,
    input?: unknown,
  ) => callReservedStoreOperation((r) => runner.invoke(address, r), operation, input);

  return [
    {
      name: 'a stop without a start resolves',
      async run() {
        const runner = await fixture.makeRunner();
        await runner.stop();
      },
    },
    {
      name: 'a driver call answers the envelope, and an unknown operation answers its error',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          expect(storeResponse.safeParse(await runner.invoke(address, fixture.read)).success).toBe(true);
          const unknown = storeResponse.parse(await runner.invoke(address, { operation: UNKNOWN_OPERATION }));
          expect('error' in unknown).toBe(true);
        });
      },
    },
    {
      name: 'a write is read back on its own address',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          const before = await read(runner, address);
          await write(runner, address);
          expect(await read(runner, address)).not.toEqual(before);
        });
      },
    },
    {
      name: 'the object is keyed on the whole address: tenant, vertical, scope and binding',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          const empty = await read(runner, freshAddress());
          await write(runner, address);
          // Each neighbour differs from the written address in exactly one field.
          const neighbours: ScopeStoreAddress[] = [
            { ...address, tenantId: ulid() },
            { ...address, vertical: 'conformance-other' },
            { ...address, scopeId: ulid() },
            { ...address, binding: 'OTHER' },
          ];
          for (const neighbour of neighbours) {
            expect(await read(runner, neighbour), JSON.stringify(neighbour)).toEqual(empty);
          }
        });
      },
    },
    {
      name: 'a stop and a start serve the same repositories',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const written = await read(runner, address);
          await runner.stop();
          await runner.start();
          expect(await read(runner, address)).toEqual(written);
        });
      },
    },
    {
      name: 'substrat.size answers { bytes }',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const { bytes } = await reserved(runner, address, 'substrat.size');
          expect(Number.isInteger(bytes)).toBe(true);
        });
      },
    },
    {
      // What the rollout's canary does (#2814): rows loaded first, so the runtime is built over
      // data, and the answer compared exactly with the catalog the release is approved with.
      name: 'substrat.selfcheck, on an object that loaded rows, answers exactly the catalog',
      async run() {
        await withRunner(async (runner) => {
          const source = freshAddress();
          const target = freshAddress();
          await write(runner, source);
          const dump = await readStoreDump((operation, input) => reserved(runner, source, operation, input), 1);
          await writeStoreDump((operation, input) => reserved(runner, target, operation, input), dump, 1);
          const { operations } = await reserved(runner, target, 'substrat.selfcheck');
          expect([...operations].sort()).toEqual([...fixture.catalog].sort());
        });
      },
    },
    {
      name: 'substrat.export-page answers a chain that ends, one revision, and the same dump at any page size',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const large = await chainOf(runner, address, LARGE_PAGE);
          const small = await chainOf(runner, address, 1);
          expect(large.tables.length).toBeGreaterThan(0);
          expect(large.revisions.size, 'one revision along a chain with no write').toBe(1);
          expect(small.revisions.size, 'one revision along a chain with no write').toBe(1);
          expect(small.tables).toEqual(large.tables);
          expect([...small.revisions], 'the revision does not depend on the page size').toEqual([...large.revisions]);
          await write(runner, address);
          expect((await chainOf(runner, address, LARGE_PAGE)).revisions, 'a write changes the revision').not.toEqual(large.revisions);
        });
      },
    },
    {
      name: 'substrat.export-page cuts many rows into pages within maxBytes, and loses none between them',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          for (let n = 0; n < 12; n += 1) await writeRow(runner, address, n);
          const large = await chainOf(runner, address, LARGE_PAGE);
          const rows = rowCount(large.tables);
          expect(rows, 'writeRow writes distinct rows').toBeGreaterThanOrEqual(12);
          for (const maxBytes of [1, 150, 400]) {
            const chain = await chainOf(runner, address, maxBytes);
            // A page holds at least one table heading and one row, and is otherwise within maxBytes.
            for (const page of chain.pages) {
              const lone = page.length <= 1 && rowCount(page) <= 1;
              expect(sizeOf(page) <= maxBytes || lone, `a page of ${sizeOf(page)} bytes at maxBytes ${maxBytes}`).toBe(true);
            }
            expect(chain.tables, `maxBytes ${maxBytes}: the merged pages are the large read`).toEqual(large.tables);
          }
          // The smallest page holds one row, so the rows are spread over at least as many pages.
          expect((await chainOf(runner, address, 1)).pages.length).toBeGreaterThanOrEqual(rows);
        });
      },
    },
    {
      name: 'a chain is one moment: a wipe between two of its pages cannot tear it',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          for (let n = 0; n < 4; n += 1) await writeRow(runner, address, n);
          const whole = (await chainOf(runner, address, LARGE_PAGE)).tables;
          const first = await reserved(runner, address, 'substrat.export-page', { cursor: null, maxBytes: 1 });
          // A driver may refuse the write while the chain is open, refuse the cursor after it, move the
          // revision, or answer the dump from before the wipe. It may not answer a torn one under the
          // revision it began with.
          if (!(await reserved(runner, address, 'substrat.wipe').then(() => true, () => false))) return;
          const pages = [first.tables];
          let cursor = first.next;
          for (let seen = 0; cursor !== null; seen += 1) {
            expect(seen, 'a chain ends').toBeLessThan(10_000);
            let page;
            try {
              page = await reserved(runner, address, 'substrat.export-page', { cursor, maxBytes: 1 });
            } catch {
              return;
            }
            if (page.revision !== first.revision) return;
            pages.push(page.tables);
            cursor = page.next;
          }
          expect(mergeDumpPages(pages), 'a chain under one revision is the dump from before the wipe').toEqual(whole);
        });
      },
    },
    {
      name: 'substrat.commit-stage replaces the whole object and answers the distinct tables it wrote',
      async run() {
        await withRunner(async (runner) => {
          const source = freshAddress();
          const target = freshAddress();
          await write(runner, source);
          await write(runner, target);
          await write(runner, target);
          // The target holds more than the source, so a merge cannot pass for a replace.
          expect(await read(runner, target)).not.toEqual(await read(runner, source));
          const tables = await readStoreDump((operation, input) => reserved(runner, source, operation, input), LARGE_PAGE);
          const before = await read(runner, target);
          const stageId = ulid();
          expect(await reserved(runner, target, 'substrat.stage-page', { stageId, seq: 0, tables })).toEqual({ staged: true });
          expect(await read(runner, target), 'a stage changes nothing a call can see').toEqual(before);
          const { tables: wrote } = await reserved(runner, target, 'substrat.commit-stage', { stageId });
          expect(wrote).toBe(tables.length);
          expect(await read(runner, target)).toEqual(await read(runner, source));
        });
      },
    },
    {
      name: 'a stage spread over several pages commits whole, not only its first page',
      async run() {
        await withRunner(async (runner) => {
          const source = freshAddress();
          const target = freshAddress();
          for (let n = 0; n < 6; n += 1) await writeRow(runner, source, n);
          for (let n = 50; n < 53; n += 1) await writeRow(runner, target, n);
          const tables = (await chainOf(runner, source, LARGE_PAGE)).tables;
          const pages = spreadOver(tables, 3);
          const stageId = ulid();
          for (const [seq, page] of pages.entries()) {
            expect(await reserved(runner, target, 'substrat.stage-page', { stageId, seq, tables: page })).toEqual({ staged: true });
          }
          expect(await reserved(runner, target, 'substrat.commit-stage', { stageId })).toEqual({ tables: tables.length });
          expect((await chainOf(runner, target, LARGE_PAGE)).tables).toEqual(tables);
          expect(await read(runner, target)).toEqual(await read(runner, source));
        });
      },
    },
    {
      name: 'a page already staged answers staged: false, and a gap is refused',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const tables = await readStoreDump((operation, input) => reserved(runner, address, operation, input), LARGE_PAGE);
          const before = await read(runner, address);
          const stageId = ulid();
          expect(await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables })).toEqual({ staged: true });
          // The resend carries other content: the first version is the one held.
          const emptied = tables.map((table) => ({ ...table, rows: [] }));
          expect(await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables: emptied })).toEqual({ staged: false });
          await expect(reserved(runner, address, 'substrat.stage-page', { stageId, seq: 5, tables })).rejects.toBeInstanceOf(StoreError);
          await reserved(runner, address, 'substrat.commit-stage', { stageId });
          expect(await read(runner, address), 'the resent page is not held twice, and does not replace the first').toEqual(before);
        });
      },
    },
    {
      name: 'page 0 of a new stage drops the old one, which then cannot stage or commit; discarding another id leaves the held stage',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const tables = await readStoreDump((operation, input) => reserved(runner, address, operation, input), LARGE_PAGE);
          const before = await read(runner, address);
          const old = ulid();
          const held = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId: old, seq: 0, tables: [] });
          await reserved(runner, address, 'substrat.stage-page', { stageId: held, seq: 0, tables });
          await refused(reserved(runner, address, 'substrat.stage-page', { stageId: old, seq: 1, tables: [] }));
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId: old }));
          expect(await reserved(runner, address, 'substrat.discard-stage', { stageId: ulid() })).toEqual({ discarded: false });
          expect(await reserved(runner, address, 'substrat.stage-page', { stageId: held, seq: 1, tables: [] })).toEqual({ staged: true });
          await reserved(runner, address, 'substrat.commit-stage', { stageId: held });
          expect(await read(runner, address), 'the held stage is the one that committed').toEqual(before);
        });
      },
    },
    {
      name: 'substrat.discard-stage drops a stage, which then cannot commit, and leaves the object',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const before = await read(runner, address);
          const stageId = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables: [] });
          expect(await reserved(runner, address, 'substrat.discard-stage', { stageId })).toEqual({ discarded: true });
          expect(await reserved(runner, address, 'substrat.discard-stage', { stageId })).toEqual({ discarded: false });
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId }));
          expect(await read(runner, address)).toEqual(before);
        });
      },
    },
    {
      name: 'a commit and a wipe move the revision, and a read does not',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const first = await revisionOf(runner, address);
          await read(runner, address);
          expect(await revisionOf(runner, address), 'the same state reads the same revision').toBe(first);
          const tables = await readStoreDump((operation, input) => reserved(runner, address, operation, input), LARGE_PAGE);
          // The object changes after the dump was taken, so the commit of that dump changes it back.
          await write(runner, address);
          const changed = await revisionOf(runner, address);
          expect(changed, 'a write moves the revision').not.toBe(first);
          const stageId = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables });
          expect(await revisionOf(runner, address), 'a stage changes nothing').toBe(changed);
          await reserved(runner, address, 'substrat.commit-stage', { stageId });
          const committed = await revisionOf(runner, address);
          expect(committed, 'a commit that changes the dump moves the revision').not.toBe(changed);
          await reserved(runner, address, 'substrat.wipe');
          expect(await revisionOf(runner, address), 'a wipe moves the revision').not.toBe(committed);
        });
      },
    },
    {
      name: 'substrat.size counts what is staged',
      async run() {
        await withRunner(async (runner) => {
          const source = freshAddress();
          const target = freshAddress();
          for (let n = 0; n < 6; n += 1) await writeRow(runner, source, n);
          await write(runner, target);
          const tables = (await chainOf(runner, source, LARGE_PAGE)).tables;
          const before = await reserved(runner, target, 'substrat.size');
          await reserved(runner, target, 'substrat.stage-page', { stageId: ulid(), seq: 0, tables });
          const staged = await reserved(runner, target, 'substrat.size');
          expect(staged.bytes, 'a stage of more rows than the object holds makes it larger').toBeGreaterThan(before.bytes);
        });
      },
    },
    {
      name: 'a wipe and an erase drop every stage: its commit is refused, and nothing comes back',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          const empty = await read(runner, freshAddress());
          await write(runner, address);
          const tables = await readStoreDump((operation, input) => reserved(runner, address, operation, input), LARGE_PAGE);
          const stageId = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables });
          await reserved(runner, address, 'substrat.wipe');
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId }));
          expect(await read(runner, address)).toEqual(empty);

          // An erase drops a stage too, since the stage may hold the subject, even one that erased nothing.
          await write(runner, address);
          const before = await read(runner, address);
          const second = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId: second, seq: 0, tables });
          await reserved(runner, address, 'substrat.erase', { subjectId: ulid() });
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId: second }));
          expect(await read(runner, address)).toEqual(before);
        });
      },
    },
    {
      name: 'a commit asked again answers the same count and changes nothing; a stage never held is refused',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const tables = await readStoreDump((operation, input) => reserved(runner, address, operation, input), LARGE_PAGE);
          const stageId = ulid();
          await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables });
          const first = await reserved(runner, address, 'substrat.commit-stage', { stageId });
          await write(runner, address);
          const after = await read(runner, address);
          const revision = await revisionOf(runner, address);
          expect(await reserved(runner, address, 'substrat.commit-stage', { stageId }), 'a lost answer is retried').toEqual(first);
          expect(await read(runner, address), 'the repeat changes nothing').toEqual(after);
          expect(await revisionOf(runner, address)).toBe(revision);
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId: ulid() }));
          // A wipe ends the memory of the last commit.
          await reserved(runner, address, 'substrat.wipe');
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId }));
          // Only the stage last committed answers again: an older one is refused.
          const [older, newer] = [ulid(), ulid()];
          await reserved(runner, address, 'substrat.stage-page', { stageId: older, seq: 0, tables });
          await reserved(runner, address, 'substrat.commit-stage', { stageId: older });
          await reserved(runner, address, 'substrat.stage-page', { stageId: newer, seq: 0, tables });
          const latest = await reserved(runner, address, 'substrat.commit-stage', { stageId: newer });
          await refused(reserved(runner, address, 'substrat.commit-stage', { stageId: older }));
          expect(await reserved(runner, address, 'substrat.commit-stage', { stageId: newer })).toEqual(latest);
          // A stage id that was committed is not used again.
          await refused(reserved(runner, address, 'substrat.stage-page', { stageId: newer, seq: 0, tables }));
        });
      },
    },
    fixture.refusedStage
      ? {
          name: 'a stage the driver refuses leaves the object as it was',
          async run() {
            await withRunner(async (runner) => {
              const address = freshAddress();
              await write(runner, address);
              const before = await read(runner, address);
              const dump = (await chainOf(runner, address, LARGE_PAGE)).tables;
              const stageId = ulid();
              // Refused when staged or when committed: either way it did not land.
              const landed = await reserved(runner, address, 'substrat.stage-page', { stageId, seq: 0, tables: [...fixture.refusedStage!] })
                .then(() => reserved(runner, address, 'substrat.commit-stage', { stageId }))
                .then(() => true, () => false);
              expect(landed, 'the driver refuses this stage').toBe(false);
              expect(await read(runner, address), 'a refused stage changes nothing').toEqual(before);
              expect((await chainOf(runner, address, LARGE_PAGE)).tables).toEqual(dump);
            });
          },
        }
      : { name: 'skipped: a stage the driver refuses leaves the object as it was (the fixture gives no refusedStage)', skip: true as const, async run() {} },
    fixture.writeSubject
      ? {
          name: 'an erase that erased something moves the revision',
          async run() {
            await withRunner(async (runner) => {
              const address = freshAddress();
              const subjectId = ulid();
              await call(runner, address, fixture.writeSubject!(subjectId));
              const before = await revisionOf(runner, address);
              expect((await reserved(runner, address, 'substrat.erase', { subjectId })).erased, 'writeSubject writes a row to erase').toBeGreaterThan(0);
              expect(await revisionOf(runner, address)).not.toBe(before);
            });
          },
        }
      : { name: 'skipped: an erase that erased something moves the revision (the fixture gives no writeSubject)', skip: true as const, async run() {} },
    {
      name: 'substrat.wipe answers {} and leaves an empty object, also where nothing was written',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          const empty = await read(runner, freshAddress());
          await write(runner, address);
          expect(await reserved(runner, address, 'substrat.wipe')).toEqual({});
          expect(await read(runner, address)).toEqual(empty);
          expect(await reserved(runner, freshAddress(), 'substrat.wipe')).toEqual({});
        });
      },
    },
    {
      name: 'substrat.erase answers { erased }, and a repeat erases nothing more',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          const subjectId = ulid();
          await write(runner, address);
          await reserved(runner, address, 'substrat.erase', { subjectId });
          expect(await reserved(runner, address, 'substrat.erase', { subjectId })).toEqual({ erased: 0 });
        });
      },
    },
  ];
}

/**
 * The runner contract a scope-store driver's runner passes (#2213). A driver runs it in its
 * own repository, against its own runner: the platform runs only the trivial driver.
 *
 * ```ts
 * scopeStoreRunnerContractSuite('graph', {
 *   makeRunner: () => graphRunner({ dir }),
 *   write: { operation: 'apply', input: { … } },
 *   writeRow: (n) => ({ operation: 'apply', input: { …, n } }),
 *   read: { operation: 'inspect' },
 * });
 * ```
 */
export function scopeStoreRunnerContractSuite(driver: string, fixture: ScopeStoreRunnerFixture): void {
  describe(`scope-store runner (#2213): ${driver}`, () => {
    for (const check of scopeStoreRunnerChecks(fixture)) {
      if (check.skip) it.skip(check.name, () => check.run());
      else it(check.name, () => check.run());
    }
  });
}
