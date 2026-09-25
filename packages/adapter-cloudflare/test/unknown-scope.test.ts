import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectionId,
  dataSubjectId,
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1718: every unknown-scope refusal on this adapter carries `not_found`, for a scope that
 * does not exist AND for one that belongs to another tenant (K-3: the two are the same
 * answer). The adapter-sqlite twin is `packages/adapter-sqlite/test/unknown-scope.test.ts`.
 *
 * On workerd, so the Durable Object boundary is real: an error thrown inside the
 * ControlPlaneDO reaches the coordinator with its code gone. The `principal`, `drain` and
 * `jobs` doors go through `validateScopeAccess`, and `transition`
 * through `transitionScope` — the two gates whose pair check lives in the DO. Every other
 * door is a coordinator-side check. One door per gate, and each refused call has an
 * own-tenant twin that is let through, so a gate that refuses everything fails too.
 */
const doors = [
  // Through the ControlPlaneDO's pair checks.
  'principal', 'drain', 'jobs', 'transition',
  // Coordinator-side.
  'migrate', 'attachments', 'restore', 'snapshot', 'deleteSnapshot', 'connector',
  'connectionGrant', 'hostname', 'version', 'provisioned', 'servingRef', 'expiry',
  'appliedMigrations', 'bookmarks', 'rewind', 'reap', 'subjectKeys', 'scopeRead',
] as const;
type Door = (typeof doors)[number];

const PAIR = ['principal', 'drain', 'jobs', 'transition', 'migrate', 'subjectKeys', 'scopeRead'];
const CONNECTION = ['connector', 'attachments'];

const messageFor = (door: Door, own: string, target: string): string =>
  CONNECTION.includes(door)
    ? `unknown scope for connection: ${target}`
    : PAIR.includes(door)
      ? `unknown scope for tenant: (${own}, ${target})`
      : `unknown scope ${target} in tenant ${own}`;

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('unknown-scope refusals are typed not_found (#1718)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());

  it.each(doors)('%s: a missing and a foreign scope are not_found; the own scope is let through', async (door) => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      // Configured so the attachments door reaches its gate; no bucket is ever touched.
      attachmentBuckets: () => ({}),
    });
    const own = tenantId.parse(ulid());
    const foreign = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const other = scopeId.parse(ulid());
    const missing = scopeId.parse(ulid());
    const principal = principalId.parse(ulid());
    const conn = connectionId.parse(ulid());
    const version = ulid();
    const vertical = `v-${own.toLowerCase()}`;
    for (const [tenant, scope] of [[own, s], [foreign, other]] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug: `t-${tenant.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical, kind: 'preview' });
      await host.admin.activateScope(staff, tenant, scope);
    }
    await host.admin.createConnection(staff, {
      id: conn, tenantId: own, vertical, provider: 'test', label: 'Test', secret: { token: 'test' },
    });
    await host.admin.registerVertical(staff, { slug: vertical, name: 'V', source: 'builtin' });
    await host.admin.publishVersion(staff, {
      id: version, verticalSlug: vertical, version: '1.0.0', manifestDigest: 'm1',
      permissionDigest: 'p1', migrationDigest: 'g1', deploymentRef: null,
    });
    const dump = await host.admin.exportScope(staff, own, s);
    if (door === 'reap') await host.admin.archiveScope(staff, own, s);

    const call = async (target: ScopeId): Promise<unknown> => {
      switch (door) {
        case 'principal': return host.getScope(principal, own, target);
        case 'drain': return host.drainDue(own, target);
        case 'jobs': return host.jobRuns(own, target);
        case 'transition': return host.admin.suspendScope(staff, own, target);
        case 'migrate': return host.migrateScope(own, target);
        case 'attachments': return host.getConnectorAttachments(conn, target);
        case 'restore': return host.restoreScope(staff, own, target, dump);
        case 'snapshot': return host.snapshotScope(staff, own, target);
        case 'deleteSnapshot': return host.deleteSnapshot(staff, own, target);
        case 'connector': return host.getConnectorScope(conn, target);
        case 'connectionGrant':
          return host.admin.grantToConnection(staff, {
            connectionId: conn, permission: permissionKey.parse('test:read'),
            node: { tenantId: own, scopeId: target }, grantedBy: staff,
          });
        case 'hostname':
          return host.admin.bindHostname(staff, {
            hostname: `${target.toLowerCase()}.example.test`, tenantId: own, scopeId: target,
            surface: 'app', region: null, canonical: true,
          });
        case 'version': return host.admin.bindScopeVersion(staff, own, target, version);
        case 'provisioned': return host.admin.markScopeProvisioned(staff, own, target, version);
        case 'servingRef': return host.admin.setScopeServingRef(staff, own, target, 'test-ref');
        case 'expiry': return host.admin.setScopeExpiresAt(staff, own, target, '2099-01-01T00:00:00.000Z');
        case 'appliedMigrations': return host.admin.scopeAppliedMigrations(staff, own, target);
        case 'bookmarks': return host.admin.scopeMigrationBookmarks(staff, own, target);
        // `localApply: false` answers after the gate without a PITR, which the pool cannot run.
        case 'rewind': return host.admin.rewindScope(staff, own, target, 'bookmark', { localApply: false });
        case 'reap': return host.admin.reapScope(staff, own, target, { force: true });
        case 'subjectKeys':
          return host.admin.sealSubjectPayloads(staff, own, target, [
            { subjectId: dataSubjectId.parse(ulid()), plaintext: 'canary' },
          ]);
        case 'scopeRead': return host.admin.listScopeTables(staff, own, target);
      }
    };

    const foreignBefore = await host.admin.getScopeRecord(staff, foreign, other);
    for (const target of [missing, other]) {
      const error = await refusal(call(target));
      expect(errorCodeOf(error)).toBe('not_found');
      expect(error).toHaveProperty('message', messageFor(door, own, target));
    }
    // The refused call on the foreign scope changed nothing of it.
    expect(await host.admin.getScopeRecord(staff, foreign, other)).toEqual(foreignBefore);
    // The positive twin: the same door, on the tenant's own scope, is let through.
    await expect(call(s)).resolves.not.toThrow();
    await host.close();
  });
});
