/**
 * The declaration and the registration are two descriptions of one surface.
 *
 * `operations.ts` says what this engine offers; `protocolModule.operations`
 * wires the handlers. Nothing holds them together — `ModuleRegistration` erases
 * its keys, so a name that exists in one and not the other is a route a vertical
 * can declare and never reach, or a handler no vertical can find. That is the
 * defect this file exists to catch, and it is exactly the shape #738 set out to
 * close: an unchecked string joining two files.
 *
 * Deliberately NOT derived from the declaration. A test that read the operation
 * names off `protocolOperations` and asserted they equal themselves would agree
 * with a wrong declaration perfectly and forever (model-phase-plan §6).
 */
import { describe, expect, it } from 'vitest';
import { permissionsUsedBy } from '@substrat-run/contracts';
import { protocolManifest, protocolModule, PROTOCOL_PERM } from '../src/index.js';
import { protocolOperations, PROTOCOL_PERMISSIONS } from '../src/operations.js';

describe('the declared operations agree with the registered ones', () => {
  it('declares exactly the operations the module registers', () => {
    const registered = protocolModule.operations;
    expect(registered, 'the module registers no operations at all').toBeDefined();
    expect(Object.keys(protocolOperations).sort()).toEqual(Object.keys(registered ?? {}).sort());
  });

  it('declares all fourteen', () => {
    // A literal, so dropping an operation from BOTH files still fails here.
    expect(Object.keys(protocolOperations)).toHaveLength(14);
  });
});

describe('the declared permissions agree with the manifest', () => {
  const manifestKeys = protocolManifest.permissions.map((p) => p.key).sort();

  it('checks only keys the manifest declares', () => {
    // The direction that matters: an operation checking a key the manifest never
    // declares is a permission no deployment can grant, so the operation is
    // unreachable for everyone.
    for (const key of permissionsUsedBy(protocolOperations)) {
      expect(manifestKeys, `'${key}' is checked but not declared`).toContain(key);
    }
  });

  it('lists the same key set the implementation checks', () => {
    expect([...PROTOCOL_PERMISSIONS].sort()).toEqual(manifestKeys);
    expect([...PROTOCOL_PERMISSIONS].sort()).toEqual(Object.values(PROTOCOL_PERM).sort());
  });

  it('names the key the proof walk evaluates', () => {
    // `protocol/list-for-entity` declares `narrows`, not a leading permission,
    // so `checks` is the ONLY thing putting its key into the permission surface.
    // Asserted against this operation rather than against the whole derived set:
    // `protocol:read` also arrives via `protocol/get` and `protocol/list-
    // templates`, so a set-level `toContain` passes with `checks` emptied and
    // proves nothing. Verified by deleting the key and watching this go red.
    const walked = protocolOperations['protocol/list-for-entity'] as {
      narrows: { checks: readonly string[] };
    };
    expect(walked.narrows.checks).toEqual(['protocol:read']);
  });
});

describe('the entity-narrowed checks say what they narrow to', () => {
  it('narrows every per-instance check to a protocol, by its input id', () => {
    // The fail-open direction from #746: a bare key reads identically in the
    // model and checks the NODE, passing for anyone holding the key anywhere in
    // the scope. Every operation addressing one instance must therefore carry an
    // entity-narrowed check, and this asserts the pairing rather than trusting
    // that each was written correctly.
    for (const [name, op] of Object.entries(protocolOperations)) {
      const declared = op as { input?: { shape?: Record<string, unknown> }; permission?: unknown };
      if (!declared.input?.shape || !('instanceId' in declared.input.shape)) continue;
      expect(declared.permission, `${name} addresses one instance`).toMatchObject({
        entity: 'protocol',
        idFrom: 'instanceId',
      });
    }
  });
});
