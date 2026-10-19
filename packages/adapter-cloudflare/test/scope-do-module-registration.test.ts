/**
 * #2412: the ScopeDO accepted a module id registered twice and a module that withdraws an
 * operation it binds itself, while the coordinator in front of it (and the pure host) refuse both
 * (`module already registered: <id>`, `<id> withdraws its own operation: <name>`). The two halves
 * of one adapter must agree about the same module list; same construction as #2403's suite.
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
const construct = (modules: ModuleRegistration[]) =>
  runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(`module-reg-${ulid()}`)), (_instance, state) => {
    const ScopeDO = defineScopeDO(modules, {});
    new ScopeDO(state, env as unknown as ScopeDoEnv);
    return true; // the instance itself cannot cross the boundary back
  });

describe('a ScopeDO refuses a duplicate module id, as its coordinator does (#2412)', () => {
  it('refuses two registrations of one id, even with disjoint operations', async () => {
    await expect(construct([moduleOf('@test/reg-dup', ['reg/a']), moduleOf('@test/reg-dup', ['reg/b'])])).rejects.toThrow(
      'module already registered: @test/reg-dup',
    );
  });

  it('refuses the same registration listed twice', async () => {
    const once = moduleOf('@test/reg-twice', ['reg/twice']);
    await expect(construct([once, once])).rejects.toThrow('module already registered: @test/reg-twice');
  });

  it('starts for distinct ids', async () => {
    await expect(construct([moduleOf('@test/reg-x', ['reg/x']), moduleOf('@test/reg-y', ['reg/y'])])).resolves.toBe(true);
  });
});

describe('a ScopeDO refuses a module that withdraws its own operation, as its coordinator does (#2412)', () => {
  it('refuses a withdrawal of an operation the same module binds', async () => {
    await expect(construct([moduleOf('@test/reg-self', ['reg/own'], ['reg/own'])])).rejects.toThrow(
      '@test/reg-self withdraws its own operation: reg/own',
    );
  });

  it('refuses the self-withdrawal even when another operation is withdrawn legitimately first', async () => {
    await expect(
      construct([moduleOf('@test/reg-mixed', ['reg/kept', 'reg/own'], ['reg/elsewhere', 'reg/own'])]),
    ).rejects.toThrow('@test/reg-mixed withdraws its own operation: reg/own');
  });

  it('starts when a module withdraws another module\'s operation, or one nobody binds', async () => {
    await expect(
      construct([moduleOf('@test/reg-owner', ['reg/theirs']), moduleOf('@test/reg-withdrawer', ['reg/mine'], ['reg/theirs'])]),
    ).resolves.toBe(true);
    // and in the reverse registration order: withdrawer first, owner after
    await expect(
      construct([moduleOf('@test/reg-withdrawer2', ['reg/mine2'], ['reg/theirs2']), moduleOf('@test/reg-owner2', ['reg/theirs2'])]),
    ).resolves.toBe(true);
    await expect(construct([moduleOf('@test/reg-lone', ['reg/lone'], ['reg/unbound'])])).resolves.toBe(true);
  });
});
