/**
 * #2316: a vertical declares which operation a provider's connections land through and the key
 * they hold. The declaration rides the permission registry, so it is in the permission digest and
 * the reviewed diff; the registry builder and the push boundary refuse what could never work.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPermissionRegistry,
  connectionLandingsOfManifestJson,
  pushedPermissionRegistry,
} from '../src/deploy.js';
import { moduleManifest } from '../src/manifest.js';

const manifest = (
  id: string,
  permissions: { key: string; description: string; holder?: 'system' }[],
  connections?: unknown[],
) =>
  moduleManifest.parse({
    id,
    version: '0.1.0',
    kernelContract: '^0.1.0',
    permissions,
    events: { emits: [], consumes: [] },
    migrations: { journalDir: 'm', compatibleFrom: '0.0.0' },
    attachmentTargets: [],
    entitlementKey: 'x',
    ...(connections ? { connections } : {}),
  });

const PLAN = { key: 'plan:record', description: 'land a plan' };
const LANDING = { provider: 'planima', operation: 'maintenance/record-plan', permission: 'plan:record', options: { horizonYears: 50 } };

describe('connection landings in the module manifest (#2316)', () => {
  it('parses a landing, and refuses two for one provider in a module', () => {
    expect(manifest('@acme/crm', [PLAN], [LANDING]).connections).toEqual([LANDING]);
    expect(() => manifest('@acme/crm', [PLAN], [LANDING, { ...LANDING, operation: 'maintenance/other' }])).toThrow(/at most one landing per provider/);
  });

  it('refuses a mixed Fortnox landing in one scope with an actionable error', () => {
    const ledger = { provider: 'fortnox', operation: 'ledger/record', permission: 'plan:record' };
    const invoice = { ...ledger, operation: 'invoices/record', options: { kind: 'supplier-invoice' } };
    expect(() => manifest('@acme/crm', [PLAN], [ledger, invoice])).toThrow('one Fortnox landing kind per scope; use a separate scope for the other kind');
    expect(() => buildPermissionRegistry({ modules: [
      { manifest: manifest('@acme/a', [PLAN], [ledger]) },
      { manifest: manifest('@acme/b', [], [invoice]) },
    ], roles: [] })).toThrow('one Fortnox landing kind per scope; use a separate scope for the other kind');
  });

  it('refuses an operation that is not module/operation, and an unknown field', () => {
    expect(() => manifest('@acme/crm', [PLAN], [{ ...LANDING, operation: 'record-plan' }])).toThrow(/module\/operation/);
    expect(() => manifest('@acme/crm', [PLAN], [{ ...LANDING, scope: 'x' }])).toThrow();
  });

  it('leaves a manifest that declares none without the field', () => {
    expect(manifest('@acme/crm', [PLAN]).connections).toBeUndefined();
  });
});

describe('connection landings in the permission registry (#2316)', () => {
  it('carries one row per provider, naming every module that states it', () => {
    const a = { manifest: manifest('@acme/a', [PLAN], [LANDING]) };
    const b = { manifest: manifest('@acme/b', [], [LANDING]) };
    expect(buildPermissionRegistry({ modules: [b, a], roles: [] }).connections).toEqual([{ ...LANDING, declaredBy: ['@acme/a', '@acme/b'] }]);
  });

  it('carries an on-request landing as such, and builds the row it always did from a written-out default (#2732)', () => {
    const built = (bind: string) => buildPermissionRegistry({ modules: [{ manifest: manifest('@acme/a', [PLAN], [{ ...LANDING, bind }]) }], roles: [] }).connections;
    expect(built('on-request')).toEqual([{ ...LANDING, bind: 'on-request', declaredBy: ['@acme/a'] }]);
    expect(built('every-install')).toEqual([{ ...LANDING, declaredBy: ['@acme/a'] }]);
    expect(() => manifest('@acme/a', [PLAN], [{ ...LANDING, bind: 'sometimes' }])).toThrow();
  });

  it('omits the field when nothing lands, so an existing digest does not move', () => {
    expect('connections' in buildPermissionRegistry({ modules: [{ manifest: manifest('@acme/a', [PLAN]) }], roles: [] })).toBe(false);
  });

  it('refuses two modules landing one provider differently', () => {
    const a = { manifest: manifest('@acme/a', [PLAN], [LANDING]) };
    const b = { manifest: manifest('@acme/b', [], [{ ...LANDING, options: { horizonYears: 10 } }]) };
    expect(() => buildPermissionRegistry({ modules: [a, b], roles: [] })).toThrow(/different landing for 'planima'/);
  });

  it('refuses a key no module declares, and a key reserved to a system principal', () => {
    expect(() => buildPermissionRegistry({ modules: [{ manifest: manifest('@acme/a', [], [LANDING]) }], roles: [] })).toThrow(
      /lands holding plan:record, which no module declares/,
    );
    const reserved = { manifest: manifest('@acme/a', [{ ...PLAN, holder: 'system' }], [LANDING]) };
    expect(() => buildPermissionRegistry({ modules: [reserved], roles: [] })).toThrow(/reserved to a system principal/);
  });

  it('holds a pushed registry to the same rules', () => {
    const base = { permissions: [{ key: 'plan:record', description: 'd', declaredBy: ['@acme/a'] }], roles: [], entityGrants: [] };
    const row = { ...LANDING, declaredBy: ['@acme/a'] };
    expect(pushedPermissionRegistry.safeParse({ ...base, connections: [row] }).success).toBe(true);
    expect(pushedPermissionRegistry.safeParse({ ...base, connections: [{ ...row, permission: 'other:key' }] }).success).toBe(false);
    expect(pushedPermissionRegistry.safeParse({ ...base, connections: [row, row] }).success).toBe(false);
    const reserved = { ...base, permissions: [{ ...base.permissions[0]!, holder: 'system' }] };
    expect(pushedPermissionRegistry.safeParse({ ...reserved, connections: [row] }).success).toBe(false);
  });
});

describe('connectionLandingsOfManifestJson (#2316)', () => {
  const row = { ...LANDING, declaredBy: ['@acme/a'] };
  it('reads the rows a stored manifest declares, without who declared them', () => {
    const onRequest = { ...row, provider: 'fortnox', bind: 'on-request' };
    expect(connectionLandingsOfManifestJson(JSON.stringify({ registry: { permissions: [], roles: [], connections: [row, onRequest] } }))).toEqual({
      kind: 'landings',
      rows: [LANDING, { ...LANDING, provider: 'fortnox', bind: 'on-request' }],
    });
  });

  it.each([
    ['no manifest', null],
    ['no registry', JSON.stringify({})],
    ['a registry with no connections', JSON.stringify({ registry: { permissions: [], roles: [] } })],
  ])('answers none for %s', (_why, json) => {
    expect(connectionLandingsOfManifestJson(json)).toEqual({ kind: 'none' });
  });

  it.each([
    ['JSON that does not parse', '{', /not JSON/],
    ['connections that are not a list', JSON.stringify({ registry: { connections: row } }), /not a list/],
    ['one malformed row', JSON.stringify({ registry: { connections: [row, { provider: 'fortnox' }] } }), /malformed/],
  ])('answers unreadable for %s', (_why, json, reason) => {
    const read = connectionLandingsOfManifestJson(json);
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toMatch(reason);
  });
});
