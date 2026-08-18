/**
 * The declaration and the registration are two descriptions of one surface.
 *
 * Same guard as engine-protocol's: `ModuleRegistration` erases its keys, so a
 * name in one file and not the other is a route a vertical can declare and never
 * reach. Not derived from the declaration — a test that read the names off
 * `invoicingOperations` would agree with a wrong declaration forever (plan §6).
 */
import { describe, expect, it } from 'vitest';
import { permissionsUsedBy } from '@substrat-run/contracts';
import { invoicingManifest, invoicingModule, INVOICING_PERM } from '../src/index.js';
import { invoicingOperations, INVOICING_PERMISSIONS } from '../src/operations.js';

describe('the declared operations agree with the registered ones', () => {
  it('declares exactly the operations the module registers', () => {
    const registered = invoicingModule.operations;
    expect(registered, 'the module registers no operations at all').toBeDefined();
    expect(Object.keys(invoicingOperations).sort()).toEqual(Object.keys(registered ?? {}).sort());
  });

  it('declares the three that exist, and no creator', () => {
    // The absence is the design: this engine is composed by EVENT, so a basis is
    // created by a consumer and never by a caller. A creating operation
    // appearing here would mean the engine had grown a second way in, past the
    // invariants its consumers hold.
    expect(Object.keys(invoicingOperations).sort()).toEqual([
      'invoicing/export',
      'invoicing/get',
      'invoicing/list',
    ]);
  });

  it('composes by event — the consumers are the real surface', () => {
    expect(Object.keys(invoicingModule.consumers ?? {}).sort()).toEqual([
      'commerce.order-placed',
      'timesheet.period-closed',
      'workorder.completed',
    ]);
  });
});

describe('the declared permissions agree with the manifest', () => {
  const manifestKeys = invoicingManifest.permissions.map((p) => p.key).sort();

  it('checks only keys the manifest declares', () => {
    for (const key of permissionsUsedBy(invoicingOperations)) {
      expect(manifestKeys, `'${key}' is checked but not declared`).toContain(key);
    }
  });

  it('lists the same key set the implementation checks', () => {
    expect([...INVOICING_PERMISSIONS].sort()).toEqual(manifestKeys);
    expect([...INVOICING_PERMISSIONS].sort()).toEqual(Object.values(INVOICING_PERM).sort());
  });

  it('gates export behind its own key, not the read key', () => {
    // Export makes a basis immutable and emits to an accounting connector.
    // Reading one must never be enough to do it.
    const exportOp = invoicingOperations['invoicing/export'] as { permission: string };
    expect(exportOp.permission).toBe('invoicing:export');
  });
});
