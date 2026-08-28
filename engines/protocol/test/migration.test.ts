import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import {
  ulid,
  type ModuleRegistration,
  type OperationHandler,
  type SqlValue,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  protocolModule,
  protocolMigrations,
  protocolContentHash,
  PROTOCOL_PERM as PERM,
  type ProtocolInstanceRow,
  type ProtocolResponseRow,
  type ProtocolSignatureRow,
  type ProtocolTemplateRow,
} from '../src/index.js';

/**
 * The 0002 migration, exercised as an UPGRADE rather than as a fresh install.
 *
 * A fresh scope runs 0002 against empty tables, so every demo and every other
 * test in this package proves only that the DDL parses. The parts that can
 * silently do nothing — the row copy and the `frozen_hash` backfill — are only
 * reachable by starting a scope on 0001, writing rows the way the 0001-era
 * engine wrote them, and then bringing the real migration list to it. That is
 * what a deployed scope does on wake, so it is what this tests.
 *
 * Phase 1 writes the instance, its response and the signature through the
 * probe's raw SQL rather than through the handlers, because today's engine
 * writes AND READS columns 0002 adds (#771: every read names the published
 * columns, so `instantiate` on a 0001 table is a SQL error naming
 * `content_ref_type`) — a scope still on 0001 was, by definition, running the
 * code that predates them. The template is the one row today's code can still
 * write there, since 0002 leaves `protocol_templates` untouched.
 */

const V1_ONLY: ModuleRegistration = {
  ...protocolModule,
  migrations: protocolMigrations.slice(0, 1), // 0001-init only
};

const CONTENT = {
  sections: [
    { title: 'Broms', items: [{ key: 'front-brake', label: 'Frambroms', type: 'check' as const }] },
  ],
};

const ORDER = { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' };

/**
 * Stands in for the vertical: declares `protocol → workorder` (the kernel
 * refuses `ctx.link` across an undeclared edge) and lends the test raw SQL, so
 * it can write 0001-era rows the current engine can no longer produce.
 */
const PROBE_PERM = 'probe:sql' as PermissionKey;

function probe(): ModuleRegistration {
  const exec: OperationHandler<{ sql: string; params?: SqlValue[] }, { changes: number }> = (
    ctx,
    input,
  ) => ctx.sql.exec(input.sql, input.params ?? []);
  const query: OperationHandler<{ sql: string; params?: SqlValue[] }, unknown[]> = (ctx, input) =>
    ctx.sql.query(input.sql, input.params ?? []);
  return {
    manifest: moduleManifest.parse({
      id: '@substrat-run/protocol-migration-probe',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: PROBE_PERM, description: 'Raw SQL (test probe)' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
      entitlementKey: 'probe',
    }),
    operations: {
      'probe/exec': exec as OperationHandler<never, unknown>,
      'probe/query': query as OperationHandler<never, unknown>,
    },
  };
}

describe('engine-protocol migration 0002 (upgrade path)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('carries rows across the rebuild and backfills frozen_hash from the earliest signature', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-protocol-migration-'));
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const principal = principalId.parse(ulid());
    const perms = [
      PERM.create,
      PERM.fill,
      PERM.sign,
      PERM.countersign,
      PERM.read,
      PROBE_PERM,
    ] as PermissionKey[];

    // -- phase 1: a scope living on 0001 ------------------------------------
    const before = new SqliteScopeHost({ dir });
    before.registerModule(V1_ONLY);
    before.registerModule(probe());
    await before.admin.createTenant(staff, { id: t, slug: 'upgrade', name: 'Upgrade' });
    await before.admin.grantEntitlement(staff, t, 'protocol');
    await before.admin.grantEntitlement(staff, t, 'probe');
    await before.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' });
    // Provisioned rows are inert until confirmed (K-31). This test builds its host by
    // hand rather than through the kit, so it confirms for itself.
    await before.admin.activateScope(staff, t, s);
    await before.admin.defineRole(staff, t, { key: 'all', permissions: perms, source: 'vertical' });
    await before.admin.assignRole(staff, {
      principalId: principal,
      roleKey: 'all',
      node: { tenantId: t, scopeId: s },
    });

    const v1 = await before.getScope(principal, t, s);
    await v1.invoke('protocol/define-template', {
      key: 'self-inspection',
      title: 'Self-inspection',
      content: CONTENT,
    });
    // Instantiate and fill it the way the 0001-era engine did: the 0001 column
    // list, and nothing 0002 added.
    const instId = ulid();
    await v1.invoke('probe/exec', {
      sql: `INSERT INTO protocol_instances
              (id, template_key, template_version, entity_type, entity_id, status, created_by, created_at)
            VALUES (?, 'self-inspection', 1, ?, ?, 'open', ?, ?)`,
      params: [instId, ORDER.entityType, ORDER.entityId, principal, '2026-01-15T09:00:00.000Z'],
    });
    await v1.invoke('probe/exec', {
      sql: `INSERT INTO protocol_responses
              (id, instance_id, item_key, value_json, note, responded_by, responded_at)
            VALUES (?, ?, 'front-brake', 'true', NULL, ?, ?)`,
      params: [ulid(), instId, principal, '2026-01-15T09:10:00.000Z'],
    });

    // Sign it the way the 0001-era engine did: no request_id, no signatory_kind,
    // and the freeze recorded only on the signature row.
    const [template] = await v1.invoke<ProtocolTemplateRow[]>('probe/query', {
      sql: 'SELECT * FROM protocol_templates WHERE key = ? AND version = 1',
      params: ['self-inspection'],
    });
    const responses = await v1.invoke<ProtocolResponseRow[]>('probe/query', {
      sql: 'SELECT * FROM protocol_responses WHERE instance_id = ? ORDER BY rowid',
      params: [instId],
    });
    const legacyHash = await protocolContentHash(template!, { 'front-brake': responses[0]! });
    const legacySignedAt = '2026-01-15T09:30:00.000Z';
    const legacySignatureId = ulid();
    await v1.invoke('probe/exec', {
      sql: `INSERT INTO protocol_signatures
              (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at)
            VALUES (?, ?, ?, 'primary', 'in-app', ?, NULL, ?)`,
      params: [legacySignatureId, instId, principal, legacyHash, legacySignedAt],
    });
    await v1.invoke('probe/exec', {
      sql: `UPDATE protocol_instances SET status = 'signed' WHERE id = ?`,
      params: [instId],
    });

    // -- phase 2: the same scope, woken by an engine carrying 0002 ----------
    const after = new SqliteScopeHost({ dir });
    after.registerModule(protocolModule); // 0001 + 0002; 0001 is already journaled
    after.registerModule(probe());
    const v2 = await after.getScope(principal, t, s);

    const detail = await v2.invoke<{
      instance: ProtocolInstanceRow;
      signatures: ProtocolSignatureRow[];
      requests: unknown[];
    }>('protocol/get', { instanceId: instId });

    // The row survived the rebuild with its identity and status intact...
    expect(detail.instance.id).toBe(instId);
    expect(detail.instance.status).toBe('signed');
    expect(detail.instance.template_version).toBe(1);
    // ...the signature came across and still carries the hash it was made with...
    expect(detail.signatures).toHaveLength(1);
    expect(detail.signatures[0]!.id).toBe(legacySignatureId);
    expect(detail.signatures[0]!.content_hash).toBe(legacyHash);
    expect(detail.signatures[0]!.signed_at).toBe(legacySignedAt);
    // ...the columns 0002 adds took their defaults...
    expect(detail.signatures[0]!.signatory_kind).toBe('principal');
    expect(detail.signatures[0]!.request_id).toBeNull();
    expect(detail.requests).toEqual([]);
    // ...and the backfill gave the instance the hash it was frozen at, which is
    // what every later counter-signature is verified against.
    expect(detail.instance.frozen_hash).toBe(legacyHash);
    expect(detail.instance.frozen_at).toBe(legacySignedAt);
    // The response history came across too — it is what the hash is replayed from.
    const carried = await v2.invoke<ProtocolResponseRow[]>('probe/query', {
      sql: 'SELECT * FROM protocol_responses WHERE instance_id = ?',
      params: [instId],
    });
    expect(carried).toHaveLength(1);

    // The real proof the backfill is right: a counter-signature re-derives the
    // hash and checks it against `frozen_hash`. A protocol migrated from 0001
    // can still take one — if the backfill were NULL this would fail closed.
    const other = principalId.parse(ulid());
    await after.admin.defineRole(staff, t, {
      key: 'counter',
      permissions: [PERM.read, PERM.countersign] as PermissionKey[],
      source: 'vertical',
    });
    await after.admin.assignRole(staff, {
      principalId: other,
      roleKey: 'counter',
      node: { tenantId: t, scopeId: s },
    });
    const counterStub = await after.getScope(other, t, s);
    const counter = await counterStub.invoke<{ signature: ProtocolSignatureRow }>(
      'protocol/countersign',
      { instanceId: instId },
    );
    expect(counter.signature.content_hash).toBe(legacyHash);
  });
});
