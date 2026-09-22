import { describe, expect, it } from 'vitest';
import { moduleManifest, type EventExport } from '@substrat-run/contracts';
import {
  CrossVerticalRegistry,
  exportReadPlan,
  planExportBatch,
  type ExportRow,
  type ImportHandler,
} from '../src/index.js';

/** #1705's shared decisions, pure: registration refusals, the read plan, and the release. */

const manifest = (id: string, events: object) =>
  moduleManifest.parse({
    id,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'thing:read', description: 'read' }],
    events,
    migrations: { journalDir: './m', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'm',
  });
const handler: ImportHandler = () => undefined;

describe('CrossVerticalRegistry — wiring refused at registration (#1705)', () => {
  const importing = (id: string, v = 1) =>
    manifest(id, { emits: [], consumes: [{ from: 'acme/crm', type: 'crm.a', schemaVersion: v }] });

  it('keeps a declared import with its handler, and answers what the deployment imports', () => {
    const r = new CrossVerticalRegistry();
    r.register(importing('@test/a'), { 'acme/crm': { 'crm.a': handler } });
    expect(r.consumes()).toEqual([{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1 }]);
    expect(r.handlersFor('acme/crm', 'crm.a').map((i) => i.moduleId)).toEqual(['@test/a']);
  });

  it('refuses a handler for a (source, type) the manifest does not declare', () => {
    const r = new CrossVerticalRegistry();
    expect(() => r.register(importing('@test/a'), { 'acme/crm': { 'crm.a': handler, 'crm.b': handler } })).toThrow(
      /import handler for 'crm.b' from 'acme\/crm', which its manifest does not declare/,
    );
    // …and a declaration under a different source is not the same declaration.
    expect(() => r.register(importing('@test/b'), { 'acme/other': { 'crm.a': handler } })).toThrow(/does not declare/);
  });

  it('refuses a declared import with no handler — it would deliver into nothing', () => {
    const r = new CrossVerticalRegistry();
    expect(() => r.register(importing('@test/a'), undefined)).toThrow(/registers no handler for it/);
  });

  it('refuses one edge asked for at two versions, and leaves nothing of the refused module', () => {
    const r = new CrossVerticalRegistry();
    r.register(importing('@test/a', 1), { 'acme/crm': { 'crm.a': handler } });
    expect(() => r.register(importing('@test/b', 2), { 'acme/crm': { 'crm.a': handler } })).toThrow(
      /schemaVersion 1 by @test\/a and 2 by @test\/b/,
    );
    expect(r.handlersFor('acme/crm', 'crm.a').map((i) => i.moduleId)).toEqual(['@test/a']);
  });

  it('refuses one type exported under two keys, and accepts the same export stated twice', () => {
    const exporting = (id: string, key: string) =>
      manifest(id, {
        emits: [{ type: 'm.made', schemaVersion: 1 }],
        consumes: [],
        exports: [{ type: 'm.made', schemaVersion: 1, readPermission: key }],
      });
    const r = new CrossVerticalRegistry();
    r.register(exporting('@test/a', 'thing:read'), undefined);
    r.register(exporting('@test/b', 'thing:read'), undefined);
    expect(() => r.register(exporting('@test/c', 'thing:admin'), undefined)).toThrow(/one export, one version, one key/);
    expect([...r.exports().values()]).toEqual([{ type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' }]);
  });
});

describe('exportReadPlan — the producer answers from its own exports (#1705)', () => {
  const exports = new Map<string, EventExport>([
    ['m.made', { type: 'm.made', schemaVersion: 1, readPermission: 'thing:read' } as EventExport],
    ['m.kept', { type: 'm.kept', schemaVersion: 1, readPermission: 'thing:read' } as EventExport],
  ]);

  it('reads only what it exports, reports the rest, and needs each key once', () => {
    const plan = exportReadPlan(exports, [
      { type: 'm.made', schemaVersion: 1 },
      { type: 'm.secret', schemaVersion: 1 },
      { type: 'm.kept', schemaVersion: 1 },
    ] as never);
    expect(plan.types).toEqual(['m.kept', 'm.made']);
    expect(plan.keys).toEqual(['thing:read']);
    expect(plan.unexported).toEqual([{ type: 'm.secret', schemaVersion: 1 }]);
  });
});

describe('planExportBatch — what is released, what is withheld, where the watermark goes (#1705)', () => {
  const row = (n: number, over: Partial<ExportRow> = {}): ExportRow => ({
    id: `01J${String(n).padStart(23, '0')}`,
    type: 'm.made',
    schema_version: 1,
    occurred_at: '2026-09-22T00:00:00.000Z',
    tenant_id: '01JTENANT00000000000000000',
    scope_id: '01JSC0PE000000000000000000',
    actor: JSON.stringify('01JZPR1NC1PA1000000000000A'),
    entity_type: 'thing',
    entity_id: `t${n}`,
    pii_class: 'none',
    subject_id: null,
    authorization: null,
    impersonation: null,
    operation: 'm/make',
    payload: JSON.stringify({ n, name: `thing ${n}` }),
    caused_by: null,
    ...over,
  });
  const wanted = new Map([['m.made', 1]]);

  it('releases the domain fact and never the producer\'s authority record', () => {
    const out = planExportBatch({ rows: [row(1)], wanted, hopsBefore: () => 0, after: null, limit: 10 });
    expect(out.events).toEqual([
      {
        id: row(1).id,
        type: 'm.made',
        schemaVersion: 1,
        occurredAt: '2026-09-22T00:00:00.000Z',
        entity: { entityType: 'thing', entityId: 't1' },
        payload: { n: 1, name: 'thing 1' },
        hops: 1,
      },
    ]);
    expect(JSON.stringify(out.events)).not.toContain('01JZPR1NC1PA1000000000000A'); // the actor stays home
  });

  it('withholds by classification first, and never carries the payload of a withheld row', () => {
    const out = planExportBatch({
      rows: [row(1, { pii_class: 'direct', subject_id: '01JSUBJECT0000000000000000', schema_version: 2 })],
      wanted,
      hopsBefore: () => 0,
      after: null,
      limit: 10,
    });
    expect(out.events).toEqual([]);
    expect(out.withheld).toEqual([expect.objectContaining({ reason: 'pii' })]);
    expect(JSON.stringify(out.withheld)).not.toContain('thing 1');
  });

  it('withholds a version, a hop past the cap, and an undecodable row — each permanent', () => {
    const out = planExportBatch({
      rows: [row(1, { schema_version: 2 }), row(2, { caused_by: 'x' }), row(3, { payload: '{not json' }), row(4)],
      wanted,
      hopsBefore: (r) => (r.caused_by ? 8 : 0),
      after: null,
      limit: 10,
    });
    expect(out.withheld.map((w) => w.reason)).toEqual(['version', 'cascade', 'undecodable']);
    expect(out.events.map((e) => e.entity.entityId)).toEqual(['t4']);
  });

  it('moves the watermark past what it walked, even when everything was withheld', () => {
    const out = planExportBatch({
      rows: [row(1, { pii_class: 'direct', subject_id: '01JSUBJECT0000000000000000' }), row(2, { pii_class: 'direct', subject_id: '01JSUBJECT0000000000000000' })],
      wanted,
      hopsBefore: () => 0,
      after: null,
      limit: 2,
    });
    expect(out.next).toBe(row(2).id);
    expect(out.more).toBe(true);
  });

  it('with nothing walked, the watermark stays where it was', () => {
    const out = planExportBatch({ rows: [], wanted, hopsBefore: () => 0, after: row(9).id as never, limit: 10 });
    expect(out).toMatchObject({ events: [], withheld: [], next: row(9).id, more: false });
  });
});
