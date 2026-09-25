import { describe, expect, it } from 'vitest';
import {
  importsOfManifestJson,
  buildPermissionRegistry,
  eventsExportedBy,
  moduleManifest,
  sweepRunsPayload,
  type ModuleManifest,
} from '../src/index.js';

/** #1705's declarations, at the contract: what parses, what is refused, and what reaches the digest. */

const base = {
  id: '@test/m',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'thing:read', description: 'read' }],
  migrations: { journalDir: './m', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'm',
};
const manifest = (events: object, extra: object = {}): ModuleManifest =>
  moduleManifest.parse({ ...base, events, ...extra });

describe('manifest: consumes `from` and exports (#1705)', () => {
  it('a consume may name the vertical it comes from, and an export the key that releases it', () => {
    const m = manifest({
      emits: [{ type: 'm.made', schemaVersion: 1 }],
      consumes: [{ from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1 }],
      exports: [{ type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' }],
    });
    expect(m.events.consumes[0]).toEqual({ from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1 });
    expect(m.events.exports).toHaveLength(1);
  });

  it('every earlier manifest parses unchanged and exports nothing', () => {
    const m = manifest({ emits: [], consumes: [{ type: 'x.y', schemaVersion: 1 }] });
    expect(m.events.exports).toBeUndefined();
    expect(m.events.consumes[0]!.from).toBeUndefined();
  });

  it('refuses the same (source, type) twice — and allows one type both locally and from a vertical', () => {
    expect(() =>
      manifest({
        emits: [],
        consumes: [
          { from: 'acme/crm', type: 'crm.a', schemaVersion: 1 },
          { from: 'acme/crm', type: 'crm.a', schemaVersion: 2 },
        ],
      }),
    ).toThrow(/consumes 'crm.a' from 'acme\/crm' twice/);
    // Two different deliveries of one type name: a local engine event and another vertical's.
    expect(() =>
      manifest({
        emits: [],
        consumes: [
          { type: 'workorder.completed', schemaVersion: 1 },
          { from: 'acme/field', type: 'workorder.completed', schemaVersion: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses one type exported twice', () => {
    expect(() =>
      manifest({
        emits: [{ type: 'm.made', schemaVersion: 1 }],
        consumes: [],
        exports: [
          { type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' },
          { type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' },
        ],
      }),
    ).toThrow(/exports 'm.made' twice/);
  });

  it('refuses a freshness expectation on an IMPORTED type — it never lands in this outbox', () => {
    const events = { emits: [], consumes: [{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1 }] };
    expect(() => manifest(events, { freshness: [{ eventType: 'crm.a', within: { hours: 24 } }] })).toThrow(
      /neither emits nor consumes/,
    );
    // Positive twin: the same type consumed LOCALLY is a legitimate expectation.
    expect(() =>
      manifest(
        { emits: [], consumes: [{ type: 'crm.a', schemaVersion: 1 }] },
        { freshness: [{ eventType: 'crm.a', within: { hours: 24 } }] },
      ),
    ).not.toThrow();
  });
});

describe('eventsExportedBy — the PII rule at declaration (#1705)', () => {
  const op = (type: string, piiClass: string, schemaVersion = 1) => ({
    emits: { entity: 'thing', entityIdFrom: 'id', type, schemaVersion, piiClass },
  });

  it('derives the version from the declaring operation', () => {
    expect(eventsExportedBy({ 'm/make': op('m.made', 'none') }, { 'm.made': 'thing:read' })).toEqual([
      { type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' },
    ]);
  });

  it('refuses a type an operation classifies as carrying personal data', () => {
    expect(() => eventsExportedBy({ 'm/add-person': op('m.person-added', 'direct') }, { 'm.person-added': 'thing:read' })).toThrow(
      /cannot be exported — m\/add-person \(direct\)/,
    );
    expect(() => eventsExportedBy({ 'm/p': op('m.p', 'pseudonymous') }, { 'm.p': 'thing:read' })).toThrow(/personal data/);
  });

  it('refuses a type ANY declaring operation classifies, even when another says none', () => {
    const ops = { 'm/make': op('m.made', 'none'), 'm/make-for-person': op('m.made', 'direct') };
    expect(() => eventsExportedBy(ops, { 'm.made': 'thing:read' })).toThrow(/m\/make-for-person \(direct\)/);
  });

  it('refuses a type no operation emits, and one emitted at two versions', () => {
    expect(() => eventsExportedBy({}, { 'm.ghost': 'thing:read' })).toThrow(/no operation emits it/);
    const ops = { 'm/a': op('m.made', 'none', 1), 'm/b': op('m.made', 'none', 2) };
    expect(() => eventsExportedBy(ops, { 'm.made': 'thing:read' })).toThrow(/schemaVersions 1, 2/);
  });
});

describe('permission registry: the edges, and a digest that does not move for nothing (#1705)', () => {
  const noEdges = { manifest: manifest({ emits: [], consumes: [{ type: 'x.y', schemaVersion: 1 }] }) };
  const withEdges = (id: string) => ({
    manifest: moduleManifest.parse({
      ...base,
      id,
      events: {
        emits: [{ type: 'm.made', schemaVersion: 1 }],
        consumes: [{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1 }],
        exports: [{ type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' }],
      },
    }),
  });

  it('a vertical with no edges gets no `exports`/`imports` keys, so its existing digest is unchanged', () => {
    const registry = buildPermissionRegistry({ modules: [noEdges], roles: [] });
    expect(Object.keys(registry).sort()).toEqual(['entityGrants', 'permissions', 'roles']);
  });

  it('an edge lands in the registry, one row per flow however many modules state it', () => {
    const registry = buildPermissionRegistry({ modules: [withEdges('@test/a'), withEdges('@test/b')], roles: [] });
    expect(registry.exports).toEqual([
      { type: 'm.made', schemaVersion: 1, readPermission: 'thing:read', declaredBy: ['@test/a', '@test/b'] },
    ]);
    expect(registry.imports).toEqual([
      { from: 'acme/crm', type: 'crm.a', schemaVersion: 1, declaredBy: ['@test/a', '@test/b'] },
    ]);
  });
});

describe('sweep runs: an edge row is the platform\'s, never a scope batch\'s (#1705)', () => {
  it('refuses a scope-drained vertical-events entry', () => {
    const parsed = sweepRunsPayload.safeParse({
      version: null,
      entries: [{ kind: 'vertical-events', outcome: 'ok', at: '2026-09-22T00:00:00.000Z' }],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * #1705 PR 2 — which scopes the hosted sweep calls at all is read from each running version's
 * stored manifest. Anything that is not a well-formed `imports` row must read as importing
 * nothing: reading it as "something" would put every legacy install back on every pass.
 */
describe('importsOfManifestJson (#1705 PR 2)', () => {
  const row = { from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1, declaredBy: ['@acme/board'] };
  it('lifts the registry\'s imports rows', () => {
    expect(importsOfManifestJson(JSON.stringify({ registry: { permissions: [], roles: [], imports: [row] } }))).toEqual([
      { from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1 },
    ]);
  });
  it.each([
    ['no manifest', null],
    ['unparseable JSON', '{not json'],
    ['no registry', JSON.stringify({ outbound: [] })],
    ['a registry predating imports', JSON.stringify({ registry: { permissions: [], roles: [] } })],
    ['imports that are not a list', JSON.stringify({ registry: { imports: { from: 'acme/crm' } } })],
  ])('%s imports nothing', (_why, json) => {
    expect(importsOfManifestJson(json)).toEqual([]);
  });
  it('drops a malformed row rather than trusting it', () => {
    const json = JSON.stringify({ registry: { imports: [row, { from: 'acme/crm' }, { ...row, schemaVersion: 0 }] } });
    expect(importsOfManifestJson(json)).toHaveLength(1);
  });
});
