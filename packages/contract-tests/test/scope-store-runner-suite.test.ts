/**
 * #2213: the runner suite is only worth running if a broken runner fails it. The
 * trivial kind passes every check, and each twin below breaks one rule and must fail
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
    request: StoreRequest,
    address: ScopeStoreAddress,
    inner: ScopeStoreRunner,
  ) => Promise<StoreResponse> | undefined,
): () => ScopeStoreRunner {
  return () => {
    const inner = counterScopeStoreRunner();
    return {
      ...inner,
      invoke: (address, request) => override(request, address, inner) ?? inner.invoke(address, request),
    };
  };
}

const TWINS: { breaks: string; makeRunner: () => ScopeStoreRunner }[] = [
  {
    breaks: 'a stop without a start resolves',
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
    breaks: 'the object is keyed on the whole address: tenant, vertical, scope and binding',
    // Keyed on the scope alone: two tenants, verticals or bindings would share an object.
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      return {
        ...inner,
        invoke: (address, request) =>
          inner.invoke({ tenantId: 't', vertical: 'v', scopeId: address.scopeId, binding: 'b' }, request),
      };
    },
  },
  {
    breaks: 'a stop and a start serve the same repositories',
    // Its objects live in the process it starts, so a restart forgets them.
    makeRunner: () => {
      let inner = counterScopeStoreRunner();
      return {
        kind: 'counter',
        async start() {},
        async stop() {
          inner = counterScopeStoreRunner();
        },
        invoke: (address, request) => inner.invoke(address, request),
      };
    },
  },
  {
    breaks: 'a kind call answers the envelope, and an unknown operation answers its error',
    makeRunner: overriding((request) => {
      if (request.operation === 'conformance-unknown-operation') throw new Error('unknown operation');
      return undefined;
    }),
  },
  {
    breaks: 'substrat.size answers { bytes }',
    makeRunner: overriding((request) =>
      request.operation === 'substrat.size' ? Promise.resolve({ result: { size: 1 } }) : undefined,
    ),
  },
  {
    breaks: 'substrat.import replaces the whole object and answers the tables it wrote',
    // Adds the imported count to what is there, instead of replacing it.
    makeRunner: overriding((request, address, inner) => {
      if (request.operation !== 'substrat.import') return undefined;
      return (async () => {
        await inner.invoke(address, { operation: 'increment', input: { by: 1 } });
        return { result: { tables: 1 } };
      })();
    }),
  },
  {
    breaks: 'substrat.wipe answers {} and leaves an empty object, also where nothing was written',
    // Answers {} and keeps the data.
    makeRunner: overriding((request) =>
      request.operation === 'substrat.wipe' ? Promise.resolve({ result: {} }) : undefined,
    ),
  },
  {
    breaks: 'substrat.erase answers { erased }, and a repeat erases nothing more',
    makeRunner: overriding((request) =>
      request.operation === 'substrat.erase' ? Promise.resolve({ result: { erased: 1 } }) : undefined,
    ),
  },
];

describe('scope-store runner suite: each broken twin fails the rule it breaks (#2213)', () => {
  it('every twin names a check the suite has', () => {
    const names = scopeStoreRunnerChecks(counterFixture(counterScopeStoreRunner)).map((check) => check.name);
    for (const twin of TWINS) expect(names).toContain(twin.breaks);
  });

  for (const twin of TWINS) {
    it(`fails: ${twin.breaks}`, async () => {
      for (const check of scopeStoreRunnerChecks(counterFixture(twin.makeRunner))) {
        if (check.name === twin.breaks) {
          await expect(check.run()).rejects.toThrow();
        } else {
          await expect(check.run(), check.name).resolves.toBeUndefined();
        }
      }
    });
  }
});
