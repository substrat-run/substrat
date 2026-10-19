import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  dataSubjectId,
  isPlatformRequest,
  moduleId,
  platformActorId,
  platformRequestId,
  type Page,
  type PlatformRequest,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  DIGEST_TOPIC,
  NOTIFICATIONS_PERM as PERM,
  notificationsManifest,
  notificationsModule,
  notify,
  sendDigests,
  type NotificationsDeliveryRecordedPayload,
  type NotificationsDigestSentPayload,
  type NotifyInput,
} from '../src/index.js';

/**
 * Digests (#118): a topic a person takes as `daily-digest` is held rather than mailed, and the
 * engine's daily schedule sends each person one mail of everything held for them. The schedule
 * is driven the way the platform drives it — `runDueSchedules`, under the engine's system
 * principal — on a clock the test moves, so "a day later" is an assertion rather than a wait.
 */

const ORDER = { entityType: 'workorder', entityId: '01JEXAMPLEORDER00000000000' } as const;
const DAY = 24 * 60 * 60_000;
const ENGINE = moduleId.parse(notificationsManifest.id);

const assigned = (recipients: string[], over: Partial<NotifyInput> = {}): NotifyInput => ({
  topic: 'order-assigned',
  description: 'A work order was assigned to you',
  dedupeKey: ulid(),
  recipients,
  vars: { orderId: 'WO-1' },
  about: ORDER,
  template: { subject: 'Assigned: {{orderId}}', text: 'You have work order {{orderId}}.' },
  ...over,
});
const watched = { topic: 'order-watched', description: 'A watched order changed' };
const locked = { topic: 'account-locked', description: 'Your account was locked', required: true };

describe('engine-notifications — digests', () => {
  let h: EngineHarness;
  let clock: ReturnType<typeof manualClock>;
  let tech: { principal: PrincipalId; stub: ScopeStub };

  const send = (input: NotifyInput) => h.run((ctx) => notify(ctx, input));
  const intents = async (): Promise<PlatformRequest[]> =>
    (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);
  const deliveries = async (filter: { status?: string; topic?: string } = {}) => {
    const admin = await h.as([PERM.read]);
    return (await admin.invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', filter)).entries;
  };
  const digestsSent = () =>
    h.eventsOfType('notifications.digest-sent').map((e) => e.payload as NotificationsDigestSentPayload);
  const held = () => h.run((ctx) => ctx.sql.query('SELECT id, principal, topic FROM notifications_digest_items'));
  const sweep = () => h.host.runDueSchedules(ENGINE, h.tenant, h.scope);
  /** The person, with an address, and `topics` used once so they can be chosen. */
  const person = async (email: string) => {
    const p = await h.mintPrincipal([PERM.self]);
    await p.stub.invoke('notifications/set-my-address', { email });
    return p;
  };
  const digestOf = (p: { stub: ScopeStub }, topic = 'order-assigned') =>
    p.stub.invoke('notifications/set-my-preference', { topic, enabled: true, cadence: 'daily-digest' });

  beforeEach(async () => {
    clock = manualClock('2026-03-02T07:00:00.000Z');
    h = await engineHarness({ modules: [notificationsModule], clock: clock.read });
    tech = await person('tech@example.test');
    // The scope learns the topics by use, as it would from a vertical.
    for (const t of [{}, watched, locked]) await send(assigned([], { ...t, dedupeKey: `first-${ulid()}` }));
  });

  afterEach(async () => {
    await h.close();
  });

  describe('choosing a digest', () => {
    it('every topic starts immediate, and a chosen cadence is the caller’s own', async () => {
      const other = await person('other@example.test');
      await digestOf(tech);
      const mine = await tech.stub.invoke<{ topics: { topic: string; cadence: string }[] }>('notifications/my-preferences', {});
      expect(mine.topics.map((t) => [t.topic, t.cadence])).toEqual([
        ['account-locked', 'immediate'],
        ['order-assigned', 'daily-digest'],
        ['order-watched', 'immediate'],
      ]);
      const theirs = await other.stub.invoke<{ topics: { cadence: string }[] }>('notifications/my-preferences', {});
      expect(theirs.topics.map((t) => t.cadence)).toEqual(['immediate', 'immediate', 'immediate']);
    });

    it('the choice is announced with the cadence it left, and omitting it leaves it alone', async () => {
      await digestOf(tech);
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true });
      await tech.stub.invoke('notifications/set-my-preference', {
        topic: 'order-assigned',
        enabled: true,
        cadence: 'immediate',
      });
      expect(h.eventsOfType('notifications.preference-set').map((e) => e.payload)).toEqual([
        { principal: tech.principal, topic: 'order-assigned', channel: 'email', enabled: true, cadence: 'daily-digest' },
        { principal: tech.principal, topic: 'order-assigned', channel: 'email', enabled: true, cadence: 'daily-digest' },
        { principal: tech.principal, topic: 'order-assigned', channel: 'email', enabled: true, cadence: 'immediate' },
      ]);
    });

    it('a required topic refuses a digest, and still accepts immediate', async () => {
      await expect(
        tech.stub.invoke('notifications/set-my-preference', { topic: 'account-locked', enabled: true, cadence: 'daily-digest' }),
      ).rejects.toMatchObject({ code: 'conflict', extensions: { reason: 'topic_required' } });
      await expect(
        tech.stub.invoke('notifications/set-my-preference', { topic: 'account-locked', enabled: true, cadence: 'immediate' }),
      ).resolves.toMatchObject({ topics: expect.arrayContaining([expect.objectContaining({ topic: 'account-locked', cadence: 'immediate' })]) });
    });

    it('a cadence chosen before a topic became required is overridden: it goes out at once', async () => {
      await digestOf(tech, 'order-watched');
      // A later deploy makes the topic required.
      await send(assigned([], { ...watched, required: true }));
      const [outcome] = await send(assigned([tech.principal], { ...watched, required: true }));
      expect(outcome).toMatchObject({ status: 'requested', reason: null });
      expect(await intents()).toHaveLength(1);
      expect(await held()).toEqual([]);
      const mine = await tech.stub.invoke<{ topics: { topic: string; cadence: string }[] }>('notifications/my-preferences', {});
      expect(mine.topics.find((t) => t.topic === 'order-watched')).toMatchObject({ cadence: 'immediate' });
    });
  });

  describe('holding an occasion', () => {
    it('a digest topic is held, not mailed: a skipped delivery says digest, and the message waits', async () => {
      await digestOf(tech);
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'digest', request: null });
      expect(await intents()).toEqual([]);
      expect(await held()).toEqual([{ id: outcome!.deliveryId, principal: tech.principal, topic: 'order-assigned' }]);
      const recorded = h.eventsOfType('notifications.delivery-recorded').map((e) => e.payload as NotificationsDeliveryRecordedPayload);
      // The occasion's own announcement stays inside the shipped enum: skipped, with why.
      expect(recorded.at(-1)).toMatchObject({ deliveryId: outcome!.deliveryId, status: 'skipped', reason: 'digest' });
    });

    it('only the chosen topic is held: another topic still goes out at once', async () => {
      await digestOf(tech);
      await send(assigned([tech.principal], watched));
      expect(await intents()).toHaveLength(1);
      expect(await held()).toEqual([]);
    });

    it('a mute still wins over a digest: a muted topic is skipped as muted and never held', async () => {
      await digestOf(tech);
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'muted' });
      expect(await held()).toEqual([]);
    });

    it('switching a topic off withdraws what is already held for it, and nothing else', async () => {
      await digestOf(tech);
      await digestOf(tech, 'order-watched');
      await send(assigned([tech.principal]));
      await send(assigned([tech.principal], watched));
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      expect((await held()).map((r) => (r as { topic: string }).topic)).toEqual(['order-watched']);
    });

    it('no address is skipped as before, and not held', async () => {
      await digestOf(tech);
      await tech.stub.invoke('notifications/set-my-address', { email: null });
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'no_address' });
      expect(await held()).toEqual([]);
    });

    it('a redelivered occasion is held once: the delivery row is still the idempotency', async () => {
      await digestOf(tech);
      const key = ulid();
      await send(assigned([tech.principal], { dedupeKey: key }));
      const [again] = await send(assigned([tech.principal], { dedupeKey: key }));
      expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate', deliveryId: null });
      expect(await held()).toHaveLength(1);
    });
  });

  describe('sending the digest', () => {
    it('composes ONE mail per person from everything held for them, oldest first', async () => {
      const other = await person('other@example.test');
      await digestOf(tech);
      await digestOf(tech, 'order-watched');
      await digestOf(other);
      const a = await send(assigned([tech.principal, other.principal], { vars: { orderId: 'WO-1' } }));
      clock.advance(60_000);
      const b = await send(assigned([tech.principal], { ...watched, vars: { orderId: 'WO-2' } }));
      clock.advance(60_000);
      const c = await send(assigned([tech.principal], { vars: { orderId: 'WO-3' } }));

      const result = await (await h.as([PERM.sendDigests])).invoke('notifications/send-digests', {});
      expect(result).toEqual({ digests: 2, items: 4 });

      const mails = await intents();
      expect(mails).toHaveLength(2);
      const toTech = mails.find((m) => (m.payload as { to: string }).to === 'tech@example.test')!;
      expect(toTech.payload).toMatchObject({
        subject: 'Assigned: WO-1 (+2)',
        subjectId: tech.principal,
        text: [
          'Assigned: WO-1\n\nYou have work order WO-1.',
          'Assigned: WO-2\n\nYou have work order WO-2.',
          'Assigned: WO-3\n\nYou have work order WO-3.',
        ].join('\n\n----\n\n'),
      });
      // A digest of one is that one message, word for word.
      const toOther = mails.find((m) => (m.payload as { to: string }).to === 'other@example.test')!;
      expect(toOther.payload).toMatchObject({ subject: 'Assigned: WO-1', text: 'You have work order WO-1.' });

      expect(await held()).toEqual([]);
      const digests = await deliveries({ topic: DIGEST_TOPIC });
      expect(digests).toHaveLength(2);
      expect(digests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ principal: tech.principal, status: 'requested', request_id: toTech.id, about_type: null }),
          expect.objectContaining({ principal: other.principal, status: 'requested', request_id: toOther.id }),
        ]),
      );

      const sent = digestsSent().find((d) => d.principal === tech.principal)!;
      expect(sent).toMatchObject({ channel: 'email', cadence: 'daily-digest', status: 'requested', reason: null, request: toTech.id });
      expect(sent.items.map((i) => i.deliveryId)).toEqual([a[0]!.deliveryId, b[0]!.deliveryId, c[0]!.deliveryId]);
      expect(sent.items[0]).toMatchObject({ topic: 'order-assigned', about: ORDER });
      expect(JSON.stringify(sent)).not.toContain('tech@example.test');
      expect(h.eventsOfType('notifications.digest-sent')[0]).toMatchObject({ piiClass: 'pseudonymous' });
    });

    it('a subject is escaped where it becomes a heading', async () => {
      await digestOf(tech);
      await send(assigned([tech.principal], { vars: { orderId: '<b>1</b>' } }));
      await send(assigned([tech.principal], { vars: { orderId: '2' } }));
      await h.run((ctx) => sendDigests(ctx));
      const [mail] = await intents();
      const html = (mail!.payload as { html: string }).html;
      expect(html).toContain('<h2>Assigned: &lt;b&gt;1&lt;/b&gt;</h2>');
      expect(html).not.toContain('<b>1</b>');
    });

    it('a digest settles like any delivery when the outcome comes back', async () => {
      await digestOf(tech);
      await send(assigned([tech.principal]));
      await h.run((ctx) => sendDigests(ctx));
      const [mail] = await intents();
      await h.host.settlePlatformRequest(h.tenant, h.scope, platformRequestId.parse(mail!.id), {
        status: 'done',
        event: {
          type: 'email.sent',
          entity: ORDER,
          payload: {
            request: platformRequestId.parse(mail!.id),
            about: null,
            sender: 'platform',
            messageId: 'msg-1',
            attempts: 1,
            code: null,
            status: null,
          },
        },
      });
      expect(await deliveries({ topic: DIGEST_TOPIC })).toMatchObject([{ status: 'sent', principal: tech.principal }]);
    });

    it('an address cleared since is a skipped digest, and what it held is let go', async () => {
      await digestOf(tech);
      const [held1] = await send(assigned([tech.principal]));
      await tech.stub.invoke('notifications/set-my-address', { email: null });
      await h.run((ctx) => sendDigests(ctx));
      expect(await intents()).toEqual([]);
      expect(await held()).toEqual([]);
      expect(await deliveries({ topic: DIGEST_TOPIC })).toMatchObject([{ status: 'skipped', reason: 'no_address' }]);
      expect(digestsSent()).toMatchObject([
        { status: 'skipped', reason: 'no_address', request: null, items: [{ deliveryId: held1!.deliveryId }] },
      ]);
    });

    it('nothing held sends nothing', async () => {
      expect(await h.run((ctx) => sendDigests(ctx))).toEqual({ digests: 0, items: 0 });
      expect(digestsSent()).toEqual([]);
    });

    it('the operation is the schedule’s key and nobody else’s', async () => {
      await expect((await h.as([PERM.read, PERM.self])).invoke('notifications/send-digests', {})).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });
  });

  describe('the daily schedule', () => {
    it('is declared on the engine, under its own key', () => {
      expect(notificationsManifest.schedules).toEqual([
        { operation: 'notifications/send-digests', cadence: { everyMinutes: 1440 }, permissions: ['notifications:send-digests'] },
      ]);
    });

    it('sends once a day, on the clock: not before the day is up, and then everything held', async () => {
      // The first pass after provisioning fires and finds nothing.
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      await digestOf(tech);
      await send(assigned([tech.principal], { vars: { orderId: 'WO-1' } }));

      clock.advance(DAY - 60_000);
      await send(assigned([tech.principal], { vars: { orderId: 'WO-2' } }));
      expect(await sweep()).toMatchObject({ fired: 0, skipped: 1 });
      expect(await intents()).toEqual([]);

      clock.advance(60_000);
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      const [mail, ...rest] = await intents();
      expect(rest).toEqual([]);
      expect(mail!.payload).toMatchObject({ to: 'tech@example.test', subject: 'Assigned: WO-1 (+1)' });

      // What arrives after is held for the next day's digest.
      await send(assigned([tech.principal], { vars: { orderId: 'WO-3' } }));
      clock.advance(DAY - 1);
      await sweep();
      expect(await intents()).toHaveLength(1);
      clock.advance(1);
      await sweep();
      expect(await intents()).toHaveLength(2);
    });
  });

  it('what digests write, a reader built before digests still reads: the shipped delivery shape and status enums', async () => {
    // The published delivery row and event statuses as 0.1.x shipped them, written out rather
    // than imported, so this oracle cannot move with the code under test. A revert to that code
    // reads every row and event below with exactly these.
    const shippedDeliveryRow = z.object({
      id: z.string(),
      topic: z.string(),
      dedupe_key: z.string(),
      principal: z.string(),
      channel: z.string(),
      status: z.enum(['requested', 'skipped', 'sent', 'refused', 'dead_lettered']),
      reason: z.string().nullable(),
      request_id: z.string().nullable(),
      about_type: z.string().nullable(),
      about_id: z.string().nullable(),
      created_at: z.string(),
      settled_at: z.string().nullable(),
    }).strict();
    const shippedRecorded = z.object({ status: z.enum(['requested', 'skipped']), reason: z.string().nullable(), topic: z.string() });

    await digestOf(tech);
    await send(assigned([tech.principal]));
    await tech.stub.invoke('notifications/set-my-address', { email: null });
    await send(assigned([tech.principal], watched)); // skipped as no_address beside the held one
    await tech.stub.invoke('notifications/set-my-address', { email: 'tech@example.test' });
    await h.run((ctx) => sendDigests(ctx));

    const rows = await deliveries();
    expect(rows.map((r) => [r.topic, r.status, r.reason])).toEqual(
      expect.arrayContaining([
        ['order-assigned', 'skipped', 'digest'],
        [DIGEST_TOPIC, 'requested', null],
      ]),
    );
    for (const row of rows) expect(shippedDeliveryRow.safeParse(row).success, JSON.stringify(row)).toBe(true);
    for (const e of h.eventsOfType('notifications.delivery-recorded')) {
      expect(shippedRecorded.safeParse(e.payload).success, JSON.stringify(e.payload)).toBe(true);
    }
  });

  it("an erasure deletes the person's held items with their address — the rendered mail goes with them", async () => {
    const other = await person('other@example.test');
    await digestOf(tech);
    await digestOf(other);
    await send(assigned([tech.principal, other.principal]));
    const staff = platformActorId.parse(ulid());
    const receipt = await h.host.admin.shredSubject(staff, h.tenant, h.scope, dataSubjectId.parse(tech.principal));
    expect(receipt.verticalRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'notification-digest-item', mode: 'delete', rows: 1 }),
        expect.objectContaining({ entityType: 'notification-recipient', mode: 'delete', rows: 1 }),
      ]),
    );
    // Only theirs: the other person's held item waits for their digest.
    expect(await held()).toEqual([expect.objectContaining({ principal: other.principal })]);
    await h.run((ctx) => sendDigests(ctx));
    expect((await intents()).map((i) => (i.payload as { to: string }).to)).toEqual(['other@example.test']);
  });
});
