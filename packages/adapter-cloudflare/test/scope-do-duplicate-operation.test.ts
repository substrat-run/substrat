/**
 * #2403: the ScopeDO binds a module's handlers with `defineOperation`, and a second registration
 * of one name replaced the first without a word, while the coordinator in front of it (and the
 * pure host) refuse it with `operation already defined`. The two halves of one adapter must
 * agree about the same module list.
 *
 * The class is built here, over a real Durable Object's state, because the refusal is a
 * constructor throw: a DO that declares a name twice must never start serving.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { moduleManifest } from '@substrat-run/contracts';
import { ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from '@substrat-run/contract-tests';
import { defineScopeDO, type ScopeDoEnv } from '../src/scope-do.js';

const handler = (() => undefined) as unknown as OperationHandler<never, unknown>;

/** A module with no migrations that binds exactly `operations` and withdraws `withdraws`. */
const moduleOf = (id: string, operations: string[], withdraws: string[] = []): ModuleRegistration => ({
  manifest: moduleManifest.parse({
    id,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: id.replace('@test/', ''),
    ...(withdraws.length ? { withdraws } : {}),
  }),
  migrations: [],
  ...testOperations(Object.fromEntries(operations.map((name) => [name, handler]))),
});

/** Construct a ScopeDO of `modules` over a scratch object's storage; resolves if it starts, throws if not. */
const construct = (modules: ModuleRegistration[], bareOps: Record<string, OperationHandler<never, unknown>> = {}) =>
  runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(`dup-op-${ulid()}`)), (_instance, state) => {
    const ScopeDO = defineScopeDO(modules, bareOps);
    new ScopeDO(state, env as unknown as ScopeDoEnv);
    return true; // the instance itself cannot cross the boundary back
  });

describe('a ScopeDO refuses a duplicate operation name, as its coordinator does (#2403)', () => {
  it('refuses two modules that bind one name', async () => {
    await expect(construct([moduleOf('@test/dup-a', ['dup/ping']), moduleOf('@test/dup-b', ['dup/ping'])])).rejects.toThrow(
      'operation already defined: dup/ping',
    );
  });

  it('refuses the same registration listed twice, on its id first (#2412)', async () => {
    const once = moduleOf('@test/dup-twice', ['dup/twice']);
    await expect(construct([once, once])).rejects.toThrow('module already registered: @test/dup-twice');
  });

  it('refuses a bare operation that a module already binds', async () => {
    await expect(construct([moduleOf('@test/dup-bare', ['dup/bare'])], { 'dup/bare': handler })).rejects.toThrow(
      'operation already defined: dup/bare',
    );
  });

  it('starts for distinct names, and for bare operations alone (the production shape)', async () => {
    await expect(construct([moduleOf('@test/dup-x', ['dup/x']), moduleOf('@test/dup-y', ['dup/y'])])).resolves.toBe(true);
    await expect(construct([], { 'dup/only': handler, 'dup/also': handler })).resolves.toBe(true);
    await expect(construct([moduleOf('@test/dup-m', ['dup/m'])], { 'dup/n': handler })).resolves.toBe(true);
  });

  it('does not count a name another manifest withdrew: it never binds, so there is nothing to repeat', async () => {
    await expect(
      construct([moduleOf('@test/dup-first', ['dup/gone']), moduleOf('@test/dup-withdrawer', [], ['dup/gone']), moduleOf('@test/dup-late', ['dup/gone'])]),
    ).resolves.toBe(true);
  });
});
