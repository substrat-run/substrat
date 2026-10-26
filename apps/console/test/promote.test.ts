import { describe, expect, it } from 'vitest';
import type { ExportBreak } from '@substrat-run/contracts';
import { exportBreakAckNeeded, promoteAckSatisfied } from '../src/lib/promote';

const row = { tenantId: 't', scopeId: 's', vertical: 'acme/board', version: 'v', type: 'crm.a', schemaVersion: 1, incoming: null } as unknown as ExportBreak;

describe('the console promote dialog: the export-break acknowledgement (#1705 PR 3)', () => {
  it('is required exactly when the impact read names an app, here or in another tenant', () => {
    expect(exportBreakAckNeeded({ kind: 'ready', affected: [row], otherTenants: 0 })).toBe(true);
    expect(exportBreakAckNeeded({ kind: 'ready', affected: [], otherTenants: 2 })).toBe(true);
    expect(exportBreakAckNeeded({ kind: 'ready', affected: [], otherTenants: 0 })).toBe(false);
    // Unreadable or loading does not block: the registry's gate still refuses a breaking promote.
    expect(exportBreakAckNeeded({ kind: 'error', message: 'x' })).toBe(false);
    expect(exportBreakAckNeeded({ kind: 'loading' })).toBe(false);
  });

  it('Promote waits for every acknowledgement the dialog shows, each on its own', () => {
    const needs = { permission: true, migration: false, exportBreak: true };
    const review = { kind: 'ready', permission: null, migration: null, binding: { base: 'v1', digest: '0'.repeat(64) } } as const;
    expect(promoteAckSatisfied(needs, { permissionChange: true }, review)).toBe(false);
    expect(promoteAckSatisfied(needs, { exportBreak: true }, review)).toBe(false);
    expect(promoteAckSatisfied(needs, { permissionChange: true, exportBreak: true }, review)).toBe(true);
    expect(promoteAckSatisfied(needs, { permissionChange: true, exportBreak: true }, { ...review, binding: null })).toBe(false);
    expect(promoteAckSatisfied({ permission: false, migration: false, exportBreak: false }, {}, { kind: 'loading' })).toBe(true);
  });
});
