/**
 * engine-notifications on the Durable-Object host: one scope walked from an assignment to a
 * settled mail, a daily digest and an erasure, with every statement the engine runs executed by
 * DO SQLite.
 * Nothing is sent — the platform's drain is played by `settlePlatformRequest`, the settle the
 * real drain calls.
 */
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataSubjectId,
  isPlatformRequest,
  moduleId,
  platformActorId,
  platformRequestId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PlatformRequest,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ScopeStub } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { DIGEST_TOPIC, NOTIFICATIONS_PERM, notificationsManifest } from '../../src/index.js';
import { MODULES, PROBE_EMIT } from './fixture.js';

const ORDER = { entityType: 'workorder', entityId: '01JEXAMPLEORDER00000000000' } as const;

describe('engine-notifications on workerd', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const techId: PrincipalId = principalId.parse(ulid());
  const adminId: PrincipalId = principalId.parse(ulid());
  // Holds the schedule's key, so a pass can be run on demand and its result read.
  const systemId: PrincipalId = principalId.parse(ulid());
  let host: CloudflareScopeHost;
  let tech: ScopeStub;
  let admin: ScopeStub;

  const intents = async (): Promise<PlatformRequest[]> =>
    (await host.listPlatformRequestHistory(t, s)).filter(isPlatformRequest);
  const deliveries = async (filters: { status?: string; topic?: string } = {}) =>
    (await admin.invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', filters)).entries;
  const assign = (orderId: string) =>
    admin.invoke('probe/emit', {
      type: 'workorder.assigned',
      schemaVersion: 1,
      entity: ORDER,
      piiClass: 'none',
      payload: { orderId, technician: techId },
    });

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    for (const m of MODULES) host.registerModule(m);
    await host.admin.createTenant(staff, { id: t, slug: `notif-${ulid().toLowerCase()}`, name: 'Notifications' });
    for (const key of ['notifications', 'probe']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'tech', permissions: [NOTIFICATIONS_PERM.self], source: 'vertical' });
    await host.admin.defineRole(staff, t, {
      key: 'office',
      permissions: [NOTIFICATIONS_PERM.read, PROBE_EMIT],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, { principalId: techId, roleKey: 'tech', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: adminId, roleKey: 'office', node: { tenantId: t, scopeId: s } });
    await host.admin.defineRole(staff, t, { key: 'digests', permissions: [NOTIFICATIONS_PERM.sendDigests], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: systemId, roleKey: 'digests', node: { tenantId: t, scopeId: s } });
    tech = await host.getScope(techId, t, s);
    admin = await host.getScope(adminId, t, s);
  });

  afterAll(async () => {
    await host.close();
  });

  it('an assignment becomes a send intent and a requested delivery', async () => {
    await tech.invoke('notifications/set-my-address', { email: 'tech@example.test' });
    await assign('WO-1');
    const [intent, ...rest] = await intents();
    expect(rest).toEqual([]);
    expect(intent!.payload).toMatchObject({ to: 'tech@example.test', subject: 'Assigned: WO-1', subjectId: techId, about: ORDER });
    expect(await deliveries()).toMatchObject([{ status: 'requested', request_id: intent!.id, principal: techId }]);
  });

  it('a mute skips, and the paged list filters on the declared index', async () => {
    await tech.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
    await assign('WO-2');
    expect(await intents()).toHaveLength(1);
    expect(await deliveries({ status: 'skipped' })).toMatchObject([{ reason: 'muted' }]);
    await tech.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true });
  });

  it("the platform's outcome settles the delivery", async () => {
    const [intent] = await intents();
    await host.settlePlatformRequest(t, s, platformRequestId.parse(intent!.id), {
      status: 'done',
      event: {
        type: 'email.sent',
        entity: ORDER,
        payload: {
          request: platformRequestId.parse(intent!.id),
          about: ORDER,
          sender: 'platform',
          messageId: 'msg-1',
          attempts: 1,
          code: null,
          status: null,
        },
      },
    });
    const [row] = await deliveries({ status: 'sent' });
    expect(row).toMatchObject({ request_id: intent!.id, reason: null });
    expect(row!.settled_at).not.toBeNull();
  });

  it('a digest topic is held, and once a day old the schedule sends one mail of everything held', async () => {
    await tech.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
    const before = (await intents()).length;
    await assign('WO-D1');
    await assign('WO-D2');
    expect(await intents()).toHaveLength(before);
    expect((await deliveries({ status: 'skipped' })).filter((d) => d.reason === 'digest')).toHaveLength(2);

    // Never run on this scope, so the first pass is due — and finds nobody whose digest is.
    const schedule = moduleId.parse(notificationsManifest.id);
    expect(await host.runDueSchedules(schedule, t, s)).toMatchObject({ fired: 1, failed: 0 });
    expect(await intents()).toHaveLength(before);

    await admin.invoke('probe/age-held', {});
    const pass = await (await host.getScope(systemId, t, s)).invoke('notifications/send-digests', {});
    expect(pass).toEqual({ digests: 1, items: 2, failed: 0, deferred: 0 });
    const digest = (await intents()).find((i) => (i.payload as { subject: string }).subject === 'Assigned: WO-D1 (+1)');
    expect(digest).toBeDefined();
    expect(await intents()).toHaveLength(before + 1);
    expect(await deliveries({ topic: DIGEST_TOPIC })).toMatchObject([{ status: 'requested', request_id: digest!.id, principal: techId }]);
    // The occasions it carried are settled into it.
    const carried = (await deliveries({ status: 'skipped' })).filter((d) => d.reason === 'digest');
    expect(carried.every((d) => d.settled_at !== null)).toBe(true);
  });

  it('a switch-off withdraws what is held, and its deliveries read as muted', async () => {
    await assign('WO-W');
    await tech.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
    const muted = (await deliveries({ status: 'skipped' })).filter((d) => d.reason === 'muted' && d.settled_at !== null);
    expect(muted).toHaveLength(1);
    await tech.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true });
  });

  it("an erasure deletes the address and the held digest items, and cancels the person's held send", async () => {
    await assign('WO-3'); // held for tomorrow's digest
    // The digest's own send, still pending.
    const held = (await intents()).find((i) => i.status === 'pending')!;
    const receipt = await host.admin.shredSubject(staff, t, s, dataSubjectId.parse(techId));
    expect(receipt.verticalRows).toMatchObject([
      { entityType: 'notification-digest-item', mode: 'delete', rows: 1 },
      { entityType: 'notification-recipient', mode: 'delete', rows: 1 },
    ]);
    expect(await tech.invoke('notifications/my-preferences', {})).toMatchObject({ email: null });
    const after = (await intents()).find((i) => i.id === held.id)!;
    expect(after.status).toBe('failed');
    expect(JSON.stringify(after.payload)).not.toContain('tech@example.test');
  });
});
