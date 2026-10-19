import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSubjectId, platformActorId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  NOTIFICATIONS_PERM as PERM,
  notificationsModule,
  notify,
  type NotificationsDeliveryRecordedPayload,
  type NotificationsDeliverySettledPayload,
  type NotifyInput,
} from '../src/index.js';
import { deliveriesOf, intentsOf, settleEmail } from './kit.js';

/**
 * engine-notifications, tested directly: `notify` is called the way a vertical calls it — inside
 * an operation's transaction, through the kit's `run` — and the platform's drain is played by
 * `host.settlePlatformRequest`, the same settle the real drain calls. Nothing here sends mail.
 */

const ORDER = { entityType: 'workorder', entityId: '01JEXAMPLEORDER00000000000' } as const;

const assigned = (recipients: string[], over: Partial<NotifyInput> = {}): NotifyInput => ({
  topic: 'order-assigned',
  description: 'A work order was assigned to you',
  dedupeKey: ulid(),
  recipients,
  vars: { orderId: 'WO-1', title: 'Fix the brakes' },
  about: ORDER,
  template: { subject: 'Assigned: {{orderId}}', text: 'You have work order {{orderId}}: {{title}}.' },
  ...over,
});

describe('engine-notifications', () => {
  let h: EngineHarness;
  let tech: { principal: PrincipalId; stub: ScopeStub };

  const staff = platformActorId.parse(ulid());
  const send = (input: NotifyInput) => h.run((ctx) => notify(ctx, input));
  const intents = () => intentsOf(h);
  const deliveries = (filter: { status?: string } = {}) => deliveriesOf(h, filter);
  const recorded = () =>
    h.eventsOfType('notifications.delivery-recorded').map((e) => e.payload as NotificationsDeliveryRecordedPayload);

  beforeEach(async () => {
    h = await engineHarness({ modules: [notificationsModule] });
    tech = await h.mintPrincipal([PERM.self]);
    await tech.stub.invoke('notifications/set-my-address', { email: 'tech@example.test' });
  });

  afterEach(async () => {
    await h.close();
  });

  it('one occasion becomes one rendered send intent, keyed on the recipient', async () => {
    const [outcome] = await send(assigned([tech.principal]));
    expect(outcome).toMatchObject({ principal: tech.principal, status: 'requested', reason: null });

    const [intent, ...rest] = await intents();
    expect(rest).toEqual([]);
    expect(intent!.id).toBe(outcome!.request);
    expect(intent!.kind).toBe('send-email');
    expect(intent!.payload).toMatchObject({
      to: 'tech@example.test',
      subject: 'Assigned: WO-1',
      text: 'You have work order WO-1: Fix the brakes.',
      html: '<p>You have work order WO-1: Fix the brakes.</p>',
      about: ORDER,
      // The erasure handle: a subject erasure finds the held send by it.
      subjectId: tech.principal,
      piiClass: 'direct',
    });

    expect(await deliveries()).toMatchObject([
      {
        topic: 'order-assigned',
        principal: tech.principal,
        status: 'requested',
        request_id: intent!.id,
        about_type: 'workorder',
        about_id: ORDER.entityId,
      },
    ]);
    // The event names the person and never the address.
    const [ev] = h.eventsOfType('notifications.delivery-recorded');
    expect(ev!.subjectId).toBe(tech.principal);
    expect(JSON.stringify(ev!.payload)).not.toContain('tech@example.test');
  });

  it('the same occasion twice mails nobody twice — a redelivered event is a no-op', async () => {
    const key = ulid();
    await send(assigned([tech.principal], { dedupeKey: key }));
    const again = await send(assigned([tech.principal], { dedupeKey: key }));
    expect(again).toMatchObject([{ status: 'skipped', reason: 'duplicate', deliveryId: null }]);
    expect(await intents()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it('a muted topic records a skip and writes no intent; unmuting restores it', async () => {
    await send(assigned([], { dedupeKey: 'first-use' })); // the scope learns the topic
    await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
    await send(assigned([tech.principal]));
    expect(await intents()).toEqual([]);
    expect(recorded()).toMatchObject([{ status: 'skipped', reason: 'muted', request: null }]);

    await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true });
    await send(assigned([tech.principal]));
    expect(await intents()).toHaveLength(1);
  });

  it('a mute reaches only the muted topic and only the person who set it', async () => {
    const watched = { topic: 'order-watched', description: 'A watched order was assigned' };
    const other = await h.mintPrincipal([PERM.self]);
    await other.stub.invoke('notifications/set-my-address', { email: 'other@example.test' });
    await send(assigned([], watched));
    await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-watched', enabled: false });

    await send(assigned([other.principal]));
    await send(assigned([tech.principal, other.principal], watched));
    // tech muted only the watcher topic; other hears both.
    expect((await intents()).map((i) => (i.payload as { to: string }).to)).toEqual([
      'other@example.test',
      'other@example.test',
    ]);
  });

  it('a required topic refuses to be muted, and overrides a mute written before it was required', async () => {
    await send(assigned([], { topic: 'account-locked', description: 'Your account was locked' }));
    await tech.stub.invoke('notifications/set-my-preference', { topic: 'account-locked', enabled: false });

    const locked = { topic: 'account-locked', description: 'Your account was locked', required: true };
    await send(assigned([], locked));
    await expect(
      tech.stub.invoke('notifications/set-my-preference', { topic: 'account-locked', enabled: false }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await send(assigned([tech.principal], locked));
    expect(await intents()).toHaveLength(1);
  });

  it('no address records a skip, and so does clearing one', async () => {
    const nobody = await h.mintPrincipal([PERM.self]);
    await send(assigned([nobody.principal]));
    await tech.stub.invoke('notifications/set-my-address', { email: null });
    await send(assigned([tech.principal]));
    expect(await intents()).toEqual([]);
    expect(recorded().map((r) => r.reason)).toEqual(['no_address', 'no_address']);
  });

  it('a duplicate recipient is sent once', async () => {
    await send(assigned([tech.principal, tech.principal]));
    expect(await intents()).toHaveLength(1);
  });

  it("a template variable the caller did not pass throws, and the caller's transaction writes nothing", async () => {
    await expect(send(assigned([tech.principal], { vars: { orderId: 'WO-2' } }))).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('missing_variable:title'),
    });
    expect(await intents()).toEqual([]);
    expect(await deliveries()).toEqual([]);
    // Not even the topic: the whole call rolled back with its caller.
    expect(await tech.stub.invoke('notifications/my-preferences', {})).toMatchObject({ topics: [] });
  });

  it("a declared html part that renders empty is the engine's refusal, naming the topic and the part", async () => {
    await expect(
      send(assigned([tech.principal], { template: { subject: 's', text: 't', html: '{{title}}' }, vars: { title: '' } })),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringMatching(/topic 'order-assigned'.*empty_message:html/),
    });
    expect(await intents()).toEqual([]);
  });

  it('a recipient that is not a principal id throws rather than mailing nobody quietly', async () => {
    await expect(send(assigned(['bob']))).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('a variable is escaped in the HTML part and kept off the subject line', async () => {
    await send(
      assigned([tech.principal], {
        vars: { orderId: 'WO-3\r\nBcc: x@evil.test', title: '<script>alert(1)</script>' },
      }),
    );
    const [intent] = await intents();
    const mail = intent!.payload as { subject: string; html: string; text: string };
    expect(mail.subject).toBe('Assigned: WO-3 Bcc: x@evil.test');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    // The text part is plain text: nothing to escape into.
    expect(mail.text).toContain('<script>alert(1)</script>');
  });

  describe('the outcome comes back', () => {

    for (const [type, status, code] of [
      ['email.sent', 'sent', null],
      ['email.refused', 'refused', 'recipient_rejected'],
      ['email.dead-lettered', 'dead_lettered', 'provider_unavailable'],
    ] as const) {
      it(`${type} settles the delivery ${status}`, async () => {
        await send(assigned([tech.principal]));
        const [intent] = await intents();
        await settleEmail(h, type, intent!.id, { code, about: ORDER });

        const [row] = await deliveries();
        expect(row).toMatchObject({ status, reason: code });
        expect(row!.settled_at).not.toBeNull();
        const settled = h.eventsOfType('notifications.delivery-settled').map((e) => e.payload as NotificationsDeliverySettledPayload);
        expect(settled).toMatchObject([{ status, code, request: intent!.id, principal: tech.principal }]);
      });
    }

    it("another module's mail is not ours to settle", async () => {
      await send(assigned([tech.principal]));
      const foreign = await h.run((ctx) =>
        ctx.requestPlatform({
          kind: 'send-email',
          payload: { to: 'x@example.test', subject: 's', html: '<p>t</p>', text: 't' },
        }),
      );
      await settleEmail(h, 'email.sent', foreign);
      expect(await deliveries()).toMatchObject([{ status: 'requested' }]);
      expect(h.eventsOfType('notifications.delivery-settled')).toEqual([]);
      expect(h.deadLetters()).toEqual([]);
    });
  });

  it("an erasure deletes the person's address and cancels their held send", async () => {
    await send(assigned([tech.principal]));
    const receipt = await h.host.admin.shredSubject(staff, h.tenant, h.scope, dataSubjectId.parse(tech.principal));
    expect(receipt.verticalRows).toMatchObject([
      { entityType: 'notification-digest-item', mode: 'delete', rows: 0 },
      { entityType: 'notification-recipient', mode: 'delete', rows: 1 },
    ]);

    expect(await tech.stub.invoke('notifications/my-preferences', {})).toMatchObject({ email: null });
    const [intent] = await intents();
    expect(intent!.status).toBe('failed');
    expect(JSON.stringify(intent!.payload)).not.toContain('tech@example.test');
  });

  describe('topics are learned from use', () => {
    it('a topic is listed once used, sorted, with each switch', async () => {
      await send(assigned([], { topic: 'order-watched', description: 'A watched order was assigned' }));
      await send(assigned([], { topic: 'account-locked', description: 'Your account was locked', required: true }));
      await send(assigned([]));
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-watched', enabled: false });
      expect(await tech.stub.invoke('notifications/my-preferences', {})).toEqual({
        email: 'tech@example.test',
        topics: [
          { topic: 'account-locked', description: 'Your account was locked', channel: 'email', enabled: true, required: true, cadence: 'immediate' },
          { topic: 'order-assigned', description: 'A work order was assigned to you', channel: 'email', enabled: true, required: false, cadence: 'immediate' },
          { topic: 'order-watched', description: 'A watched order was assigned', channel: 'email', enabled: false, required: false, cadence: 'immediate' },
        ],
      });
    });

    it('a topic follows its latest declaration, and announces only a change', async () => {
      await send(assigned([]));
      await send(assigned([]));
      await send(assigned([], { description: 'Reworded' }));
      expect(h.eventsOfType('notifications.topic-recorded').map((e) => e.payload)).toEqual([
        { topic: 'order-assigned', description: 'A work order was assigned to you', required: false },
        { topic: 'order-assigned', description: 'Reworded', required: false },
      ]);
    });

    it('a topic never used cannot be muted', async () => {
      await expect(
        tech.stub.invoke('notifications/set-my-preference', { topic: 'nope', enabled: false }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('a topic that is not a slug is refused', async () => {
      await expect(send(assigned([], { topic: 'Order Assigned' }))).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('preferences are a person’s own', () => {
    it("one person's address is not another's", async () => {
      const other = await h.mintPrincipal([PERM.self]);
      expect(await other.stub.invoke('notifications/my-preferences', {})).toMatchObject({ email: null });
    });

    it('a malformed address is refused at the door, in front of whoever typed it', async () => {
      await expect(tech.stub.invoke('notifications/set-my-address', { email: 'not-an-address' })).rejects.toThrow();
    });

    it('every mutation is announced, and the announcement names no address', async () => {
      await send(assigned([]));
      await tech.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      expect(h.eventsOfType('notifications.preference-set').map((e) => e.payload)).toEqual([
        { principal: tech.principal, topic: 'order-assigned', channel: 'email', enabled: false, cadence: 'immediate' },
      ]);
      expect(h.eventsOfType('notifications.recipient-updated').map((e) => e.payload)).toEqual([
        { principal: tech.principal, hasAddress: true },
      ]);
    });

    it('the delivery list filters on the declared columns', async () => {
      const nobody = await h.mintPrincipal([PERM.self]);
      await send(assigned([tech.principal, nobody.principal]));
      expect(await deliveries({ status: 'skipped' })).toMatchObject([{ principal: nobody.principal, reason: 'no_address' }]);
    });
  });

  describe('every operation checks first', () => {
    for (const [op, input] of [
      ['notifications/my-preferences', {}],
      ['notifications/set-my-address', { email: 'a@example.test' }],
      ['notifications/set-my-preference', { topic: 'order-assigned', enabled: false }],
      ['notifications/list-deliveries', {}],
      ['notifications/send-digests', {}],
    ] as const) {
      it(`${op} refuses a principal holding nothing`, async () => {
        const nobody = await h.as([]);
        await expect(nobody.invoke(op, input)).rejects.toMatchObject({ code: 'permission_denied' });
      });
    }

    it('the delivery log needs notifications:read, not notifications:self', async () => {
      await expect(tech.stub.invoke('notifications/list-deliveries', {})).rejects.toMatchObject({
        code: 'permission_denied',
      });
    });
  });
});
