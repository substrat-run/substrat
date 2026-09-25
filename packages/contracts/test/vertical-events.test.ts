import { describe, expect, it } from 'vitest';
import {
  importsOfManifestJson,
  buildPermissionRegistry,
  eventsExportedBy,
  exportedEventSchemasOf,
  EDGE_STATE,
  LEVER_EFFECT,
  REPLAY_EFFECT,
  SKIP_EFFECT,
  importCursorMove,
  lagText,
  leverOffered,
  leverRequest,
  type EdgeHealth,
  emitModel,
  emittedModel,
  z,
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

describe('exportedEventSchemasOf — the payload another vertical parses, into the model (#1705 PR 3, D-22)', () => {
  const output = z.object({ id: z.string(), name: z.string(), note: z.string().optional(), secret: z.string() });
  const op = (payload?: string[], out: z.ZodType = output) => ({
    output: out,
    emits: { entity: 'thing', entityIdFrom: 'id', type: 'm.made', schemaVersion: 1, piiClass: 'none', ...(payload ? { payload } : {}) },
  });
  const exported = [{ type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' }];

  it('is the output picked to the declared payload fields, and nothing else of it', () => {
    const [e] = exportedEventSchemasOf({ 'm/make': op(['id', 'name', 'note']) }, exported);
    expect(e).toMatchObject({ type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' });
    expect(Object.keys((e!.payload as { properties: object }).properties).sort()).toEqual(['id', 'name', 'note']);
    expect((e!.payload as { required: string[] }).required.sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(e!.payload)).not.toContain('secret');
    expect(e!.payload).not.toHaveProperty('$schema');
  });

  it('an operation that declares no payload promises an empty object', () => {
    const [e] = exportedEventSchemasOf({ 'm/make': op() }, exported);
    expect((e!.payload as { properties: object }).properties).toEqual({});
  });

  it('refuses two operations promising different shapes under one (type, version); the same shape twice is fine', () => {
    expect(() => exportedEventSchemasOf({ 'm/a': op(['id']), 'm/b': op(['id', 'name']) }, exported)).toThrow(
      /m\/a and m\/b with different payloads/,
    );
    expect(exportedEventSchemasOf({ 'm/a': op(['id']), 'm/b': op(['id']) }, exported)).toHaveLength(1);
  });

  it('refuses a payload drawn from a non-object output, and an export nobody emits', () => {
    expect(() => exportedEventSchemasOf({ 'm/make': op(['id'], z.array(z.string())) }, exported)).toThrow(/not an object/);
    expect(() => exportedEventSchemasOf({}, exported)).toThrow(/no operation emits it/);
  });

  it('lands in the emitted model, sorted, and a model that exports nothing is unchanged', () => {
    const entities = { thing: { table: 'things', fields: z.object({ id: z.string() }) } };
    const none = emitModel(entities);
    expect(none).not.toHaveProperty('exports');
    const withExports = emitModel(entities, { exports: exportedEventSchemasOf({ 'm/make': op(['id']) }, exported) });
    expect(Object.keys(withExports.exports ?? {})).toEqual(['m.made']);
    // What a control plane re-parses at a trust boundary still parses.
    expect(emittedModel.parse(JSON.parse(JSON.stringify(withExports)))).toEqual(withExports);
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
 * stored manifest, in three answers. Only a manifest that genuinely declares no imports may
 * drop a scope. Anything the parser cannot vouch for is `unreadable`, and the scope is kept:
 * excluding a consumer wrongly would lose its edge with no trace.
 */
describe('importsOfManifestJson (#1705 PR 2)', () => {
  const row = { from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1, declaredBy: ['@acme/board'] };
  it("lifts the registry's imports rows", () => {
    expect(importsOfManifestJson(JSON.stringify({ registry: { permissions: [], roles: [], imports: [row] } }))).toEqual({
      kind: 'imports',
      rows: [{ from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1 }],
    });
  });
  it.each([
    ['no manifest', null],
    ['no registry', JSON.stringify({ outbound: [] })],
    ['a registry with no imports key (a CLI before 0.34.0, or nothing imported)', JSON.stringify({ registry: { permissions: [], roles: [] } })],
  ])('%s imports nothing', (_why, json) => {
    expect(importsOfManifestJson(json)).toEqual({ kind: 'none' });
  });
  it.each([
    ['unparseable JSON', '{not json', /not JSON/],
    ['imports that are not a list', JSON.stringify({ registry: { imports: { from: 'acme/crm' } } }), /not a list/],
    ['one malformed row among good ones', JSON.stringify({ registry: { imports: [row, { from: 'acme/crm' }] } }), /malformed/],
    ['a row at version 0', JSON.stringify({ registry: { imports: [{ ...row, schemaVersion: 0 }] } }), /malformed/],
  ])('%s is unreadable, never "imports nothing"', (_why, json, reason) => {
    const out = importsOfManifestJson(json);
    expect(out.kind).toBe('unreadable');
    expect(out.kind === 'unreadable' && out.reason).toMatch(reason);
  });
});

describe('what the console and the dashboard say about an edge (#1705 PR 3)', () => {
  const APP = '01J0000000000000000000APP0';
  const edge = (over: Partial<EdgeHealth>): EdgeHealth =>
    ({
      tenantId: '01J0000000000000000000TNT0',
      consumer: { scopeId: APP, vertical: 'acme/board' },
      producer: { vertical: 'acme/crm', scopeId: '01J0000000000000000000PRD0' },
      state: 'caught-up',
      reason: null,
      watermark: null,
      oldestPending: null,
      lagMs: null,
      unexported: [],
      lastDelivered: null,
      lastProblem: null,
      ...over,
    }) as EdgeHealth;

  it('never renders an edge nobody could ask as healthy: only caught-up is green', () => {
    expect(EDGE_STATE.unavailable.tone).toBe('danger');
    expect(Object.entries(EDGE_STATE).filter(([, v]) => v.tone === 'success').map(([k]) => k)).toEqual(['caught-up']);
  });

  it('offers the lever only on a resolved, reachable edge INTO the viewed scope', () => {
    expect(leverOffered(edge({}), APP)).toBe(true);
    expect(leverOffered(edge({ consumer: { scopeId: '01J0000000000000000000OTH0' as EdgeHealth['consumer']['scopeId'], vertical: 'acme/x' } }), APP)).toBe(false);
    expect(leverOffered(edge({ state: 'unresolved', producer: { vertical: 'acme/crm', scopeId: null } }), APP)).toBe(false);
    expect(leverOffered(edge({ state: 'unavailable' }), APP)).toBe(false);
  });

  it("says what a lever does in the platform's own words, and sends the matching acknowledgement", () => {
    expect(LEVER_EFFECT.replay).toBe(REPLAY_EFFECT);
    expect(LEVER_EFFECT.replay).toContain('anything they send or call outside this app happens again');
    expect(LEVER_EFFECT.skip).toBe(SKIP_EFFECT);
    expect(importCursorMove.parse(leverRequest('replay', 'acme/crm', ' lost a day '))).toMatchObject({
      mode: 'replay',
      after: null,
      acknowledge: 'rerun-handlers',
      reason: 'lost a day',
    });
    expect(importCursorMove.parse(leverRequest('skip', 'acme/crm', 'start today'))).toMatchObject({
      mode: 'skip',
      through: 'now',
      acknowledge: 'skip-events',
    });
  });

  it('writes a lag a person can read', () => {
    expect(lagText(null)).toBeNull();
    expect(lagText(12_000)).toBe('12s');
    expect(lagText(5 * 60_000)).toBe('5 min');
    expect(lagText(3 * 3_600_000)).toBe('3 h');
    expect(lagText(3 * 86_400_000)).toBe('3 days');
  });
});
