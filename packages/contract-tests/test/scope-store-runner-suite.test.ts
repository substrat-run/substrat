/**
 * #2213: the runner suite is only worth running if a broken runner fails it. The
 * trivial driver passes every check, and each twin below breaks one rule and must fail
 * the check that names it — while still passing the rest, so the failure is that
 * rule's and not a side effect.
 */
import { describe, expect, it } from 'vitest';
import type { StoreRequest, StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreAddress, ScopeStoreRunner } from '@substrat-run/kernel';
import { counterScopeStoreRunner } from '../src/counter-runner.js';
import {
  scopeStoreRunnerChecks,
  scopeStoreRunnerContractSuite,
  type ScopeStoreRunnerFixture,
} from '../src/scope-store-runner-suite.js';

const counterFixture = (makeRunner: () => ScopeStoreRunner): ScopeStoreRunnerFixture => ({
  makeRunner,
  write: { operation: 'increment', input: { by: 1 } },
  read: { operation: 'read' },
});

scopeStoreRunnerContractSuite('counter', counterFixture(counterScopeStoreRunner));

/** The counter, with one operation answered differently. */
function overriding(
  override: (
    address: ScopeStoreAddress,
    request: StoreRequest,
    inner: ScopeStoreRunner,
  ) => Promise<StoreResponse> | undefined,
): () => ScopeStoreRunner {
  return () => {
    const inner = counterScopeStoreRunner();
    return {
      ...inner,
      invoke: (address, request) => override(address, request, inner) ?? inner.invoke(address, request),
    };
  };
}

const CHECK = {
  stop: 'a stop without a start resolves',
  envelope: 'a driver call answers the envelope, and an unknown operation answers its error',
  readBack: 'a write is read back on its own address',
  address: 'the object is keyed on the whole address: tenant, vertical, scope and binding',
  restart: 'a stop and a start serve the same repositories',
  size: 'substrat.size answers { bytes }',
  export: 'substrat.export answers { tables } in the scope-dump table shape',
  import: 'substrat.import replaces the whole object and answers the tables it wrote',
  wipe: 'substrat.wipe answers {} and leaves an empty object, also where nothing was written',
  erase: 'substrat.erase answers { erased }, and a repeat erases nothing more',
} as const;

/** The counter, blind to one field of the address: two addresses that differ only there share an object. */
const blindTo = (field: keyof ScopeStoreAddress) =>
  overriding((address, request, inner) => inner.invoke({ ...address, [field]: 'shared' }, request));

const answering = (operation: string, answer: StoreResponse) =>
  overriding((_address, request) => (request.operation === operation ? Promise.resolve(answer) : undefined));

/** Each twin breaks one rule, and names every check that rule reaches. */
const TWINS: { name: string; breaks: readonly string[]; makeRunner: () => ScopeStoreRunner }[] = [
  {
    name: 'a stop that needs a start',
    breaks: [CHECK.stop],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      let started = false;
      return {
        ...inner,
        async start() {
          started = true;
        },
        async stop() {
          if (!started) throw new Error('stopped before it started');
        },
      };
    },
  },
  {
    // Nothing to read back, and so nothing for an import to tell apart from its source.
    name: 'a write that changes nothing',
    breaks: [CHECK.readBack, CHECK.import],
    makeRunner: answering('increment', { result: 0 }),
  },
  ...(['tenantId', 'vertical', 'scopeId', 'binding'] as const).map((field) => ({
    name: `an object keyed without the ${field}`,
    breaks: [CHECK.address],
    makeRunner: blindTo(field),
  })),
  {
    name: 'objects that live in the process it starts',
    breaks: [CHECK.restart],
    makeRunner: () => {
      let inner = counterScopeStoreRunner();
      return {
        driver: 'counter',
        async start() {},
        async stop() {
          inner = counterScopeStoreRunner();
        },
        invoke: (address, request) => inner.invoke(address, request),
      };
    },
  },
  {
    name: 'an unknown operation thrown, not answered',
    breaks: [CHECK.envelope],
    makeRunner: overriding((_address, request) => {
      if (request.operation === 'conformance-unknown-operation') throw new Error('unknown operation');
      return undefined;
    }),
  },
  {
    name: 'an unknown operation answered as a result',
    breaks: [CHECK.envelope],
    makeRunner: answering('conformance-unknown-operation', { result: null }),
  },
  {
    name: 'a size that is not { bytes }',
    breaks: [CHECK.size],
    makeRunner: answering('substrat.size', { result: { size: 1 } }),
  },
  {
    // An empty export also leaves nothing for an import to restore.
    name: 'an export with no tables',
    breaks: [CHECK.export, CHECK.import],
    makeRunner: answering('substrat.export', { result: { tables: [] } }),
  },
  {
    name: 'an import that merges instead of replacing',
    breaks: [CHECK.import],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.import') return undefined;
      return (async () => {
        await inner.invoke(address, { operation: 'increment', input: { by: 1 } });
        return { result: { tables: 1 } };
      })();
    }),
  },
  {
    name: 'an import that miscounts the tables it wrote',
    breaks: [CHECK.import],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.import') return undefined;
      return (async () => {
        await inner.invoke(address, request);
        return { result: { tables: 0 } };
      })();
    }),
  },
  {
    name: 'a wipe that keeps the data',
    breaks: [CHECK.wipe],
    makeRunner: answering('substrat.wipe', { result: {} }),
  },
  {
    name: 'a wipe that refuses an object nothing was written to',
    breaks: [CHECK.wipe],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const written = new Set<string>();
      return {
        ...inner,
        invoke(address, request) {
          const id = JSON.stringify(address);
          if (request.operation === 'substrat.wipe' && !written.has(id)) {
            return Promise.resolve({ error: { code: 'not_found', status: 404 } });
          }
          if (request.operation === 'increment' || request.operation === 'substrat.import') written.add(id);
          return inner.invoke(address, request);
        },
      };
    },
  },
  {
    name: 'an erase that counts again on a repeat',
    breaks: [CHECK.erase],
    makeRunner: answering('substrat.erase', { result: { erased: 1 } }),
  },
];

describe('scope-store runner suite: each broken twin fails the rules it breaks (#2213)', () => {
  it('the suite has exactly the checks named here', () => {
    const names = scopeStoreRunnerChecks(counterFixture(counterScopeStoreRunner)).map((check) => check.name);
    expect(names).toEqual(Object.values(CHECK));
  });

  it('every check is broken by some twin', () => {
    const broken = new Set(TWINS.flatMap((twin) => twin.breaks));
    expect(Object.values(CHECK).filter((name) => !broken.has(name))).toEqual([]);
  });

  for (const twin of TWINS) {
    it(`fails ${twin.breaks.length === 1 ? 'one check' : 'its checks'}: ${twin.name}`, async () => {
      for (const check of scopeStoreRunnerChecks(counterFixture(twin.makeRunner))) {
        if (twin.breaks.includes(check.name)) {
          await expect(check.run(), check.name).rejects.toThrow();
        } else {
          await expect(check.run(), check.name).resolves.toBeUndefined();
        }
      }
    });
  }
});
