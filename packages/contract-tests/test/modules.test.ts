/**
 * #2403: `contractTestModules` is the list the Durable Object test worker hands `defineScopeDO`,
 * and the DO refuses an operation bound twice, as the coordinator does. `connectorMod` once
 * appeared in it twice (once through `contractTestInitialModules`); it binds six operations, so the
 * repeat would have stopped the worker from starting once the DO refused a name bound twice. The
 * list is held to what the hosts need of it, so the next repeat is red here and not in a worker
 * that fails to start.
 */
import { describe, expect, it } from 'vitest';
import { contractTestInitialModules, contractTestModules } from '../src/modules.js';

describe('contractTestModules (#2403)', () => {
  it('lists each registration once', () => {
    expect(new Set(contractTestModules).size).toBe(contractTestModules.length);
  });

  it('lists each module id once', () => {
    const ids = contractTestModules.map((m) => m.manifest.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('binds no operation name from two registrations, withdrawals aside', () => {
    const withdrawn = new Set(contractTestModules.flatMap((m) => m.manifest.withdraws ?? []));
    const bound = contractTestModules.flatMap((m) => Object.keys(m.operations?.handlers ?? {}));
    expect(bound.filter((name, i) => bound.indexOf(name) !== i && !withdrawn.has(name))).toEqual([]);
  });

  it('keeps its initial modules as a prefix, in order', () => {
    expect(contractTestModules.slice(0, contractTestInitialModules.length)).toEqual(contractTestInitialModules);
  });
});
