import { describe, expect, it } from 'vitest';
import { storeResponse, type ReservedStoreOperation, type StoreRequest } from '@substrat-run/contracts';
import {
  callReservedStoreOperation,
  callScopeStore,
  ulid,
  type ScopeStoreAddress,
  type ScopeStoreRunner,
} from '@substrat-run/kernel';

/**
 * What a kind hands the runner suite. The suite knows nothing about the kind beyond
 * two calls of its own catalog.
 */
export interface ScopeStoreRunnerFixture {
  /** A runner nobody has started. Called once per check. */
  makeRunner(): ScopeStoreRunner | Promise<ScopeStoreRunner>;
  /** A kind operation that changes the object. Each call must change what `read` answers. */
  readonly write: StoreRequest;
  /** A kind operation that reads the object back. Equal answers mean equal objects. */
  readonly read: StoreRequest;
}

/** One check of the runner contract. It throws when the runner breaks it. */
export interface ScopeStoreRunnerCheck {
  readonly name: string;
  run(): Promise<void>;
}

/** An address no other check, and no earlier run, has used. */
function freshAddress(): ScopeStoreAddress {
  return { tenantId: ulid(), vertical: 'conformance', scopeId: ulid(), binding: 'STORE' };
}

/** An operation name no kind declares, and still a valid label. */
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
 * between a `close` and the next first store call. A kind's repositories must survive
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
      name: 'a kind call answers the envelope, and an unknown operation answers its error',
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
      name: 'substrat.export answers { tables } in the scope-dump table shape',
      async run() {
        await withRunner(async (runner) => {
          const address = freshAddress();
          await write(runner, address);
          const { tables } = await reserved(runner, address, 'substrat.export');
          expect(tables.length).toBeGreaterThan(0);
        });
      },
    },
    {
      name: 'substrat.import replaces the whole object and answers the tables it wrote',
      async run() {
        await withRunner(async (runner) => {
          const source = freshAddress();
          const target = freshAddress();
          await write(runner, source);
          await write(runner, target);
          await write(runner, target);
          // The target holds more than the source, so a merge cannot pass for a replace.
          expect(await read(runner, target)).not.toEqual(await read(runner, source));
          const { tables } = await reserved(runner, source, 'substrat.export');
          const imported = await reserved(runner, target, 'substrat.import', { tables });
          expect(imported.tables).toBe(tables.length);
          expect(await read(runner, target)).toEqual(await read(runner, source));
        });
      },
    },
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
 * The runner contract a scope-store driver's runner passes (#2213). A kind runs it in its
 * own repository, against its own runner: the platform runs only the trivial kind.
 *
 * ```ts
 * scopeStoreRunnerContractSuite('graph', {
 *   makeRunner: () => graphRunner({ dir }),
 *   write: { operation: 'apply', input: { … } },
 *   read: { operation: 'inspect' },
 * });
 * ```
 */
export function scopeStoreRunnerContractSuite(kind: string, fixture: ScopeStoreRunnerFixture): void {
  describe(`scope-store runner (#2213): ${kind}`, () => {
    for (const check of scopeStoreRunnerChecks(fixture)) {
      it(check.name, () => check.run());
    }
  });
}
