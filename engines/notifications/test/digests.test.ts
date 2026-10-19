import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  dataSubjectId,
  MAX_PENDING_PLATFORM_REQUESTS,
  type DomainEventInput,
  moduleId,
  platformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type OperationContext, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  DIGEST_MAX_ITEMS,
  DIGEST_RESERVE,
  DIGEST_TICK_MINUTES,
  DIGEST_TOPIC,
  NOTIFICATIONS_PERM as PERM,
  notificationsManifest,
  notificationsModule,
  notify,
  sendDigests,
  type NotificationsDeliveryRecordedPayload,
  type NotificationsDigestFailedPayload,
  type NotificationsDigestSentPayload,
  type NotifyInput,
} from '../src/index.js';
import { deliveriesOf, intentsOf, settleEmail } from './kit.js';

/**
 * Digests (#118): a topic a person takes as `daily-digest` is held rather than mailed, and the
 * engine's digest schedule sends each person whose oldest held message is a day old one mail of
 * what is held, up to `DIGEST_MAX_ITEMS`. The schedule
 * is driven the way the platform drives it — `runDueSchedules`, under the engine's system
 * principal — on a clock the test moves, so "a day later" is an assertion rather than a wait.
 */

const ORDER = { entityType: 'workorder', entityId: '01JEXAMPLEORDER00000000000' } as const;
const DAY = 24 * 60 * 60_000;
const TICK = DIGEST_TICK_MINUTES * 60_000;
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
  const intents = () => intentsOf(h);
  const deliveries = (filter: { status?: string; topic?: string } = {}) => deliveriesOf(h, filter);
  const digestsSent = () =>
    h.eventsOfType('notifications.digest-sent').map((e) => e.payload as NotificationsDigestSentPayload);
  const held = () =>
    h.run((ctx) =>
      ctx.sql.query<{ id: string; principal: string; topic: string }>('SELECT id, principal, topic FROM notifications_digest_items'),
    );
  const sweep = () => h.host.runDueSchedules(ENGINE, h.tenant, h.scope);
  const pass = () => h.run((ctx) => sendDigests(ctx));
  /** A person with an address. */
  const person = async (email: string) => {
    const p = await h.mintPrincipal([PERM.self]);
    await p.stub.invoke('notifications/set-my-address', { email });
    return p;
  };
  const chooseDigest = (p: { stub: ScopeStub }, topic = 'order-assigned') =>
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
      await chooseDigest(tech);
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
      await chooseDigest(tech);
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
      await chooseDigest(tech, 'order-watched');
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
      await chooseDigest(tech);
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'digest', request: null });
      expect(await intents()).toEqual([]);
      expect(await held()).toEqual([{ id: outcome!.deliveryId, principal: tech.principal, topic: 'order-assigned' }]);
      const recorded = h.eventsOfType('notifications.delivery-recorded').map((e) => e.payload as NotificationsDeliveryRecordedPayload);
      // The occasion's own announcement stays inside the shipped enum: skipped, with why.
      expect(recorded.at(-1)).toMatchObject({ deliveryId: outcome!.deliveryId, status: 'skipped', reason: 'digest' });
    });

    it('only the chosen topic is held: another topic still goes out at once', async () => {
      await chooseDigest(tech);
      await send(assigned([tech.principal], watched));
      expect(await intents()).toHaveLength(1);
      expect(await held()).toEqual([]);
    });

    it('a mute still wins over a digest: a muted topic is skipped as muted and never held', async () => {
      await chooseDigest(tech);
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'muted' });
      expect(await held()).toEqual([]);
    });

    it('switching a topic off withdraws what is already held for it, and nothing else — and says so', async () => {
      await chooseDigest(tech);
      await chooseDigest(tech, 'order-watched');
      const [withdrawn] = await send(assigned([tech.principal]));
      const [kept] = await send(assigned([tech.principal], watched));
      clock.advance(60_000);
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      expect((await held()).map((r) => r.topic)).toEqual(['order-watched']);

      // The withdrawn occasion reads as a mute now, settled when it was withdrawn; the kept one waits.
      const rows = await deliveries({ status: 'skipped' });
      expect(rows.find((r) => r.id === withdrawn!.deliveryId)).toMatchObject({ reason: 'muted', settled_at: clock.now() });
      expect(rows.find((r) => r.id === kept!.deliveryId)).toMatchObject({ reason: 'digest', settled_at: null });
      expect(h.eventsOfType('notifications.preference-set').at(-1)!.payload).toMatchObject({
        topic: 'order-assigned',
        enabled: false,
        withdrawn: [withdrawn!.deliveryId],
      });
    });

    it('a switch-off with nothing held names nothing withdrawn', async () => {
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      expect(h.eventsOfType('notifications.preference-set').at(-1)!.payload).not.toHaveProperty('withdrawn');
    });

    it('messages held twice a day too long — a schedule that is not running — say so on the next hold', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const warnings = () =>
          warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('is the digest schedule running'));
        await chooseDigest(tech);
        await send(assigned([tech.principal]));
        clock.advance(2 * DAY - 60_000);
        await send(assigned([tech.principal]));
        expect(warnings()).toEqual([]);
        clock.advance(60_001);
        await send(assigned([tech.principal]));
        expect(warnings()).toHaveLength(1);
        expect(JSON.parse(warnings()[0]!)).toMatchObject({ level: 'warn', fields: { principal: tech.principal } });
      } finally {
        warn.mockRestore();
      }
    });

    it('no address is skipped as before, and not held', async () => {
      await chooseDigest(tech);
      await tech.stub.invoke('notifications/set-my-address', { email: null });
      const [outcome] = await send(assigned([tech.principal]));
      expect(outcome).toMatchObject({ status: 'skipped', reason: 'no_address' });
      expect(await held()).toEqual([]);
    });

    it('a redelivered occasion is held once: the delivery row is still the idempotency', async () => {
      await chooseDigest(tech);
      const key = ulid();
      await send(assigned([tech.principal], { dedupeKey: key }));
      const [again] = await send(assigned([tech.principal], { dedupeKey: key }));
      expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate', deliveryId: null });
      expect(await held()).toHaveLength(1);
    });
  });

  describe('sending the digest', () => {
    it('composes ONE mail per person from everything held for them, oldest first, and settles what it carried', async () => {
      const other = await person('other@example.test');
      await chooseDigest(tech);
      await chooseDigest(tech, 'order-watched');
      await chooseDigest(other);
      const a = await send(assigned([tech.principal, other.principal], { vars: { orderId: 'WO-1' } }));
      clock.advance(60_000);
      const b = await send(assigned([tech.principal], { ...watched, vars: { orderId: 'WO-2' } }));
      clock.advance(60_000);
      const c = await send(assigned([tech.principal], { vars: { orderId: 'WO-3' } }));

      clock.advance(DAY);
      const result = await (await h.as([PERM.sendDigests])).invoke('notifications/send-digests', {});
      expect(result).toEqual({ digests: 2, items: 4, failed: 0, deferred: 0, quarantined: 0, released: 0 });

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
      // Each occasion it carried is settled into it: still skipped as `digest`, now with a time.
      const carried = new Set([a[0]!.deliveryId, a[1]!.deliveryId, b[0]!.deliveryId, c[0]!.deliveryId]);
      const occasions = (await deliveries({ status: 'skipped' })).filter((d) => carried.has(d.id as string));
      expect(occasions).toHaveLength(4);
      for (const o of occasions) expect(o).toMatchObject({ reason: 'digest', settled_at: clock.now() });

      const sent = digestsSent().find((d) => d.principal === tech.principal)!;
      expect(sent).toMatchObject({ channel: 'email', cadence: 'daily-digest', status: 'requested', reason: null, request: toTech.id });
      expect(sent.items.map((i) => i.deliveryId)).toEqual([a[0]!.deliveryId, b[0]!.deliveryId, c[0]!.deliveryId]);
      expect(sent.items[0]).toMatchObject({ topic: 'order-assigned', about: ORDER });
      expect(JSON.stringify(sent)).not.toContain('tech@example.test');
      expect(h.eventsOfType('notifications.digest-sent')[0]).toMatchObject({ piiClass: 'pseudonymous' });
    });

    it('a subject is escaped where it becomes a heading', async () => {
      await chooseDigest(tech);
      await send(assigned([tech.principal], { vars: { orderId: '<b>1</b>' } }));
      await send(assigned([tech.principal], { vars: { orderId: '2' } }));
      clock.advance(DAY);
      await pass();
      const [mail] = await intents();
      const html = (mail!.payload as { html: string }).html;
      expect(html).toContain('<h2>Assigned: &lt;b&gt;1&lt;/b&gt;</h2>');
      expect(html).not.toContain('<b>1</b>');
    });

    it('a digest of whole-document templates is one document: each nested one gives way to its text', async () => {
      await chooseDigest(tech);
      const branded = { subject: 'Assigned: {{orderId}}', text: 'You have work order {{orderId}}.', html: '<!doctype html><html><body><p>{{orderId}}</p></body></html>' };
      await send(assigned([tech.principal], { template: branded, vars: { orderId: 'WO-1' } }));
      await send(assigned([tech.principal], { template: branded, vars: { orderId: 'WO-2' } }));
      clock.advance(DAY);
      await pass();
      const html = ((await intents())[0]!.payload as { html: string }).html;
      expect(html).not.toMatch(/<!doctype|<html|<body/i);
      expect(html).toContain('<p>You have work order WO-1.</p>');
    });

    it('a digest settles like any delivery when the outcome comes back', async () => {
      await chooseDigest(tech);
      await send(assigned([tech.principal]));
      clock.advance(DAY);
      await pass();
      const [mail] = await intents();
      // A digest is about nobody's entity, so its outcome is about the request itself.
      await settleEmail(h, 'email.sent', mail!.id);
      expect(await deliveries({ topic: DIGEST_TOPIC })).toMatchObject([{ status: 'sent', principal: tech.principal }]);
    });

    it('an address cleared since is a skipped digest, and what it held is let go', async () => {
      await chooseDigest(tech);
      const [held1] = await send(assigned([tech.principal]));
      await tech.stub.invoke('notifications/set-my-address', { email: null });
      clock.advance(DAY);
      await pass();
      expect(await intents()).toEqual([]);
      expect(await held()).toEqual([]);
      expect(await deliveries({ topic: DIGEST_TOPIC })).toMatchObject([{ status: 'skipped', reason: 'no_address' }]);
      expect(digestsSent()).toMatchObject([
        { status: 'skipped', reason: 'no_address', request: null, items: [{ deliveryId: held1!.deliveryId }] },
      ]);
    });

    it('nothing held sends nothing', async () => {
      expect(await pass()).toEqual({ digests: 0, items: 0, failed: 0, deferred: 0, quarantined: 0, released: 0 });
      expect(digestsSent()).toEqual([]);
    });

    it('the operation is the schedule’s key and nobody else’s', async () => {
      await expect((await h.as([PERM.read, PERM.self])).invoke('notifications/send-digests', {})).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });
  });

  describe('who is due, and when', () => {
    it('the schedule ticks every few minutes, under its own key', () => {
      expect(notificationsManifest.schedules).toEqual([
        {
          operation: 'notifications/send-digests',
          cadence: { everyMinutes: DIGEST_TICK_MINUTES },
          permissions: ['notifications:send-digests'],
        },
      ]);
      expect(DIGEST_TICK_MINUTES).toBeLessThan(60);
    });

    it('a person is due once their oldest held message is a day old: not a tick sooner, and then everything held', async () => {
      // The first pass after provisioning fires and finds nobody due.
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      await chooseDigest(tech);
      await send(assigned([tech.principal], { vars: { orderId: 'WO-1' } }));

      clock.advance(DAY - TICK);
      await send(assigned([tech.principal], { vars: { orderId: 'WO-2' } }));
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      expect(await intents()).toEqual([]);

      clock.advance(TICK);
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      const [mail, ...rest] = await intents();
      expect(rest).toEqual([]);
      expect(mail!.payload).toMatchObject({ to: 'tech@example.test', subject: 'Assigned: WO-1 (+1)' });

      // At most one a day: what arrives after waits its own day, however often the schedule ticks.
      await send(assigned([tech.principal], { vars: { orderId: 'WO-3' } }));
      for (let t = 0; t < DAY / TICK - 1; t += 1) {
        clock.advance(TICK);
        await sweep();
      }
      expect(await intents()).toHaveLength(1);
      clock.advance(TICK);
      await sweep();
      expect(await intents()).toHaveLength(2);
    });

    it('each person is due on their own clock, not on when the schedule first ran', async () => {
      const other = await person('other@example.test');
      await chooseDigest(tech);
      await chooseDigest(other);
      await send(assigned([tech.principal]));
      clock.advance(DAY / 2);
      await send(assigned([other.principal]));
      clock.advance(DAY / 2);
      expect(await pass()).toMatchObject({ digests: 1 });
      expect((await intents()).map((i) => (i.payload as { to: string }).to)).toEqual(['tech@example.test']);
      clock.advance(DAY / 2);
      expect(await pass()).toMatchObject({ digests: 1 });
      expect((await intents()).map((i) => (i.payload as { to: string }).to).sort()).toEqual([
        'other@example.test',
        'tech@example.test',
      ]);
    });
  });

  describe('the send backlog has room for so many, and a digest never takes the last of it', () => {
    /** `n` people taking `order-assigned` as a digest, each holding one occasion. */
    const crowd = async (n: number) => {
      const people = [];
      for (let i = 0; i < n; i += 1) {
        const p = await person(`p${i}@example.test`);
        await chooseDigest(p);
        people.push(p);
      }
      await send(assigned(people.map((p) => p.principal)));
      return people;
    };
    const room = MAX_PENDING_PLATFORM_REQUESTS - DIGEST_RESERVE;
    const drainAll = async () => {
      for (const i of await intents()) if (i.status === 'pending') await settleEmail(h, 'email.sent', i.id);
    };

    it(`more people than the cap allows: a pass sends ${room}, never throws, and the rest go on later ticks — once each`, async () => {
      const people = await crowd(MAX_PENDING_PLATFORM_REQUESTS + 8);
      clock.advance(DAY);
      const first = await (await h.as([PERM.sendDigests])).invoke('notifications/send-digests', {});
      expect(first).toEqual({ digests: room, items: room, failed: 0, deferred: people.length - room, quarantined: 0, released: 0 });
      expect(await intents()).toHaveLength(room);

      // Nothing drained yet: the next tick finds no room, defers everyone, and still succeeds.
      clock.advance(TICK);
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      expect(await intents()).toHaveLength(room);

      await drainAll();
      clock.advance(TICK);
      expect(await sweep()).toMatchObject({ fired: 1, failed: 0 });
      const to = (await intents()).map((i) => (i.payload as { to: string }).to).sort();
      expect(to).toEqual(people.map((_, i) => `p${i}@example.test`).sort());
      expect(await held()).toEqual([]);
      expect(digestsSent()).toHaveLength(people.length);
    });

    it('sends waiting on the drain shrink the room a pass takes', async () => {
      await crowd(20);
      // Ten immediate mails nobody has drained yet.
      for (let i = 0; i < 10; i += 1) await send(assigned([tech.principal], watched));
      clock.advance(DAY);
      expect(await pass()).toMatchObject({ digests: room - 10, items: room - 10, failed: 0, deferred: 20 - (room - 10) });
    });

    it('a full digest pass leaves room for mail that must not wait', async () => {
      await crowd(room + 4);
      clock.advance(DAY);
      expect(await pass()).toMatchObject({ digests: room, deferred: 4 });
      const [outcome] = await send(assigned([tech.principal], locked));
      expect(outcome).toMatchObject({ status: 'requested' });
    });
  });

  describe('one digest is bounded', () => {
    it(`it carries at most ${DIGEST_MAX_ITEMS}, oldest first; the rest follow on the next pass`, async () => {
      await chooseDigest(tech);
      for (let i = 1; i <= DIGEST_MAX_ITEMS + 10; i += 1) {
        await send(assigned([tech.principal], { vars: { orderId: `WO-${i}` } }));
        clock.advance(1_000);
      }
      clock.advance(DAY);
      expect(await pass()).toMatchObject({ digests: 1, items: DIGEST_MAX_ITEMS });
      expect((await intents())[0]!.payload).toMatchObject({ subject: `Assigned: WO-1 (+${DIGEST_MAX_ITEMS - 1})` });
      expect(await held()).toHaveLength(10);
      // Still as old, so due on the very next pass.
      clock.advance(TICK);
      expect(await pass()).toMatchObject({ digests: 1, items: 10 });
      const [latest] = await intents();
      expect(latest!.payload).toMatchObject({ subject: `Assigned: WO-${DIGEST_MAX_ITEMS + 1} (+9)` });
      expect(await held()).toEqual([]);
    });

    it('a younger remainder waits for its own day, not the next pass', async () => {
      await chooseDigest(tech);
      for (let i = 1; i <= DIGEST_MAX_ITEMS; i += 1) await send(assigned([tech.principal], { vars: { orderId: `WO-${i}` } }));
      clock.advance(DAY / 2);
      for (let i = 1; i <= 5; i += 1) await send(assigned([tech.principal], { vars: { orderId: `LATE-${i}` } }));
      clock.advance(DAY / 2);
      expect(await pass()).toMatchObject({ digests: 1, items: DIGEST_MAX_ITEMS });
      clock.advance(TICK);
      expect(await pass()).toMatchObject({ digests: 0 });
      clock.advance(DAY / 2 - TICK);
      expect(await pass()).toMatchObject({ digests: 1, items: 5 });
    });
  });

  describe('one person at a time', () => {
    /**
     * `ctx` with the `digest-sent` emit failing for one person — a failure AFTER that person's
     * send, delivery, settle and delete were written, which is what the per-person
     * sub-transaction exists to undo.
     */
    const failingFor =
      (victim: string) =>
      (ctx: OperationContext): OperationContext =>
        new Proxy(ctx, {
          get(target, prop) {
            if (prop === 'emit') {
              return (event: DomainEventInput) => {
                if (event.type === 'notifications.digest-sent' && (event.payload as { principal: string }).principal === victim) {
                  throw new Error('the digest-sent write failed');
                }
                target.emit(event);
              };
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
    const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

    it("a failure after a person's writes undoes all of them — no mail, no digest delivery, everything still held — and nobody else's", async () => {
      const error = quiet();
      try {
        const other = await person('other@example.test');
        await chooseDigest(tech);
        await chooseDigest(other);
        const [mine, theirs] = await send(assigned([tech.principal, other.principal]));
        clock.advance(DAY);
        expect(await h.run((ctx) => sendDigests(failingFor(tech.principal)(ctx)))).toEqual({
          digests: 1,
          items: 1,
          failed: 1,
          deferred: 0,
          quarantined: 0,
          released: 0,
        });

        expect((await intents()).map((i) => (i.payload as { to: string }).to)).toEqual(['other@example.test']);
        expect((await deliveries({ topic: DIGEST_TOPIC })).map((d) => d.principal)).toEqual([other.principal]);
        expect(await held()).toEqual([{ id: mine!.deliveryId, principal: tech.principal, topic: 'order-assigned' }]);
        const occasions = await deliveries({ status: 'skipped' });
        expect(occasions.find((d) => d.id === mine!.deliveryId)).toMatchObject({ reason: 'digest', settled_at: null });
        expect(occasions.find((d) => d.id === theirs!.deliveryId)).toMatchObject({ reason: 'digest', settled_at: clock.now() });
        expect(digestsSent().map((d) => d.principal)).toEqual([other.principal]);
      } finally {
        error.mockRestore();
      }
    });

    it('a failed person is said, waits a day rather than failing every pass, and is tried again', async () => {
      const error = quiet();
      try {
        await chooseDigest(tech);
        await send(assigned([tech.principal]));
        clock.advance(DAY);
        const failing = () => h.run((ctx) => sendDigests(failingFor(tech.principal)(ctx)));
        expect(await failing()).toMatchObject({ failed: 1 });
        const failed = () =>
          h.eventsOfType('notifications.digest-failed').map((e) => e.payload as NotificationsDigestFailedPayload);
        const retryAt = new Date(Date.parse(clock.now()) + DAY).toISOString();
        expect(failed()).toEqual([
          { principal: tech.principal, channel: 'email', cadence: 'daily-digest', items: 1, code: 'internal', retryAt },
        ]);
        const lines = error.mock.calls.map(([l]) => JSON.parse(String(l)) as { fields: Record<string, unknown>; message: string });
        expect(lines).toEqual([
          expect.objectContaining({
            fields: expect.objectContaining({ principal: tech.principal, items: 1 }),
            message: expect.stringContaining('the digest-sent write failed'),
          }),
        ]);

        clock.advance(DAY - TICK);
        expect(await failing()).toMatchObject({ failed: 0, digests: 0 });
        expect(failed()).toHaveLength(1);
        clock.advance(TICK);
        // The cause is gone: the retry sends it.
        expect(await pass()).toMatchObject({ digests: 1, failed: 0 });
        expect(await held()).toEqual([]);
      } finally {
        error.mockRestore();
      }
    });

    it('a person stuck behind failures is not masked from the two-day warning', async () => {
      const error = quiet();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await chooseDigest(tech);
        await send(assigned([tech.principal]));
        clock.advance(DAY);
        await h.run((ctx) => sendDigests(failingFor(tech.principal)(ctx)));
        clock.advance(DAY + 1);
        await send(assigned([tech.principal]));
        const warnings = warn.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('are sends being drained'));
        expect(warnings).toHaveLength(1);
      } finally {
        error.mockRestore();
        warn.mockRestore();
      }
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

    await chooseDigest(tech);
    await chooseDigest(tech, 'order-watched');
    await send(assigned([tech.principal]));
    await send(assigned([tech.principal], watched));
    // Withdrawn by a switch-off: its delivery settles skipped/muted.
    await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-watched', enabled: false });
    await tech.stub.invoke('notifications/set-my-address', { email: null });
    await send(assigned([tech.principal], locked)); // skipped as no_address beside the held one
    await tech.stub.invoke('notifications/set-my-address', { email: 'tech@example.test' });
    clock.advance(DAY);
    await pass();

    const rows = await deliveries();
    expect(rows.map((r) => [r.topic, r.status, r.reason])).toEqual(
      expect.arrayContaining([
        ['order-assigned', 'skipped', 'digest'],
        ['order-watched', 'skipped', 'muted'],
        ['account-locked', 'skipped', 'no_address'],
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
    await chooseDigest(tech);
    await chooseDigest(other);
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
    clock.advance(DAY);
    await pass();
    expect((await intents()).map((i) => (i.payload as { to: string }).to)).toEqual(['other@example.test']);
  });
});
