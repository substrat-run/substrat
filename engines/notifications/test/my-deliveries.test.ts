import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Page, type PrincipalId } from '@substrat-run/contracts';
import { manualClock, ulid, type OperationContext, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  DIGEST_TOPIC,
  NOTIFICATIONS_PERM as PERM,
  listMyDeliveries,
  notificationsModule,
  notify,
  sendDigests,
  type NotifyInput,
} from '../src/index.js';
import { deliveriesOf, intentsOf, settleEmail } from './kit.js';

/**
 * `notifications/my-deliveries` (#118): a person reads what became of the notifications sent to
 * THEM, under `notifications:self`, with their own principal pinned in and no way to name another.
 * Driven the way the other suites drive the engine — `notify` through the kit's `run`, the
 * platform's drain played by `settlePlatformRequest` — on a clock the test moves, so the order of
 * a page is an assertion rather than a coincidence of milliseconds.
 */

const DAY = 24 * 60 * 60_000;
const ORDER = { entityType: 'workorder', entityId: '01JEXAMPLEORDER00000000000' } as const;

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

type Mine = {
  id: string;
  topic: string;
  channel: string;
  status: string;
  reason: string | null;
  about_type: string | null;
  about_id: string | null;
  created_at: string;
  settled_at: string | null;
};

describe('engine-notifications — a person reads their own deliveries', () => {
  let h: EngineHarness;
  let clock: ReturnType<typeof manualClock>;
  let me: { principal: PrincipalId; stub: ScopeStub };
  let other: { principal: PrincipalId; stub: ScopeStub };

  const send = async (input: NotifyInput) => {
    const outcome = await h.run((ctx) => notify(ctx, input));
    // A new millisecond for the next one, so a page's order is the order they were sent in.
    clock.advance(1_000);
    return outcome;
  };
  const mine = (who: { stub: ScopeStub } = me, input: Record<string, unknown> = {}) =>
    who.stub.invoke<Page<Mine>>('notifications/my-deliveries', input);
  const person = async (email: string) => {
    const p = await h.mintPrincipal([PERM.self]);
    await p.stub.invoke('notifications/set-my-address', { email });
    return p;
  };

  beforeEach(async () => {
    clock = manualClock('2026-03-02T07:00:00.000Z');
    h = await engineHarness({ modules: [notificationsModule], clock: clock.read });
    me = await person('me@example.test');
    other = await person('other@example.test');
    // The scope learns the topics by use, as it would from a vertical.
    for (const t of [{}, watched]) await send(assigned([], { ...t, dedupeKey: `first-${ulid()}` }));
  });

  afterEach(async () => {
    await h.close();
  });

  it('is composed by call, and the header still says so', () => {
    const header = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').split('*/')[0]!;
    expect(header).toContain('composed **by call**');
    expect(header).not.toContain('composed **by event**');
  });

  describe('whose rows', () => {
    it('a caller sees their own deliveries and nobody else’s', async () => {
      await send(assigned([me.principal, other.principal]));
      await send(assigned([other.principal], watched));
      await send(assigned([me.principal], watched));

      const { entries: mineNow } = await mine(me);
      expect(mineNow.map((d) => d.topic)).toEqual(['order-watched', 'order-assigned']);
      const { entries: theirs } = await mine(other);
      expect(theirs.map((d) => d.topic)).toEqual(['order-watched', 'order-assigned']);
      expect(new Set([...mineNow, ...theirs].map((d) => d.id)).size).toBe(4);

      // The administrator's log holds all four, and is the only way to see them together.
      expect(await deliveriesOf(h)).toHaveLength(4);
    });

    it('a person with no deliveries reads an empty page, and no body at all is a request for the first page', async () => {
      await send(assigned([other.principal]));
      expect(await mine(me)).toMatchObject({ entries: [], nextCursor: null });
      const stranger = await h.mintPrincipal([PERM.self]);
      await expect(stranger.stub.invoke('notifications/my-deliveries')).resolves.toMatchObject({ entries: [] });
    });

    it('naming another principal changes nothing: the input has no such key, and it is dropped', async () => {
      await send(assigned([me.principal, other.principal]));
      for (const smuggled of [
        { principal: other.principal },
        { filters: { principal: other.principal } },
        { principal: [other.principal, me.principal] },
      ]) {
        const { entries } = await mine(me, smuggled);
        expect(entries).toHaveLength(1);
        expect(entries.every((d) => (d as Mine & { principal?: string }).principal === undefined)).toBe(true);
      }
      // Positive twin: the same key on the administrator's read IS honoured.
      const admin = await h.as([PERM.read]);
      const { entries } = await admin.invoke<Page<{ principal: string }>>('notifications/list-deliveries', { principal: other.principal });
      expect(entries.map((d) => d.principal)).toEqual([other.principal]);
    });

    it('the in-scope function pins the caller too, whatever filter it is handed', async () => {
      const [outcome] = await send(assigned([me.principal, other.principal]));
      const asMe = (ctx: OperationContext): OperationContext =>
        new Proxy(ctx, {
          get(target, prop) {
            if (prop === 'principal') return me.principal;
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
      const page = await h.run((ctx) => listMyDeliveries(asMe(ctx), { filters: { principal: other.principal } }));
      expect(page.entries.map((d) => d.id)).toEqual([outcome!.deliveryId]);
    });
  });

  describe('what a row says', () => {
    it('carries what became of it and what it was about, and not the caller’s key or the platform’s intent', async () => {
      const [outcome] = await send(assigned([me.principal], { dedupeKey: 'evt-1' }));
      const [{ id: intent }] = await intentsOf(h);
      await settleEmail(h, 'email.sent', intent!, { about: ORDER });

      const { entries } = await mine();
      expect(entries).toEqual([
        {
          id: outcome!.deliveryId,
          topic: 'order-assigned',
          channel: 'email',
          status: 'sent',
          reason: null,
          about_type: 'workorder',
          about_id: ORDER.entityId,
          created_at: expect.any(String),
          settled_at: expect.any(String),
        },
      ]);
      // The administrator's row is wider, so the difference is the point and not an accident.
      const [full] = await deliveriesOf(h, { topic: 'order-assigned' });
      expect(Object.keys(full!).sort()).toEqual(
        expect.arrayContaining(['dedupe_key', 'principal', 'request_id']),
      );
    });

    it('a muted or address-less skip says why, because the reason is the engine’s own word', async () => {
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-watched', enabled: false });
      await send(assigned([me.principal], watched));
      await me.stub.invoke('notifications/set-my-address', { email: null });
      await send(assigned([me.principal]));

      expect((await mine()).entries.map((d) => [d.topic, d.status, d.reason])).toEqual([
        ['order-assigned', 'skipped', 'no_address'],
        ['order-watched', 'skipped', 'muted'],
      ]);
    });

    it('a refused or dead-lettered send carries no reason: that is the platform’s code, for whoever reads the whole log', async () => {
      const [refused] = await send(assigned([me.principal]));
      const [dead] = await send(assigned([me.principal], watched));
      await settleEmail(h, 'email.refused', refused!.request!, { code: 'permission_denied', about: ORDER });
      await settleEmail(h, 'email.dead-lettered', dead!.request!, { code: 'provider_unavailable', about: ORDER });

      expect((await mine()).entries.map((d) => [d.status, d.reason]).sort()).toEqual([
        ['dead_lettered', null],
        ['refused', null],
      ]);
      // Positive twin: the administrator still reads both codes.
      expect((await deliveriesOf(h)).map((d) => d.reason).sort()).toEqual(['permission_denied', 'provider_unavailable']);
    });
  });

  describe('paging and filtering', () => {
    it('walks newest first by limit and cursor, with no row twice and none of anybody else’s', async () => {
      const sent: string[] = [];
      for (let i = 0; i < 5; i++) {
        const [mineOutcome] = await send(assigned([me.principal, other.principal]));
        sent.push(mineOutcome!.deliveryId!);
      }
      const walked: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page: Page<Mine> = await mine(me, { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.entries.length).toBeLessThanOrEqual(2);
        walked.push(...page.entries.map((d) => d.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(walked).toEqual([...sent].reverse());
    });

    it('filters by status and by topic, alone and together', async () => {
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-watched', enabled: false });
      const [first] = await send(assigned([me.principal]));
      await send(assigned([me.principal], watched));
      await send(assigned([me.principal]));
      await settleEmail(h, 'email.sent', first!.request!, { about: ORDER });

      const topics = async (input: Record<string, unknown>) => (await mine(me, input)).entries.map((d) => `${d.topic}/${d.status}`);
      expect(await topics({ status: 'skipped' })).toEqual(['order-watched/skipped']);
      expect(await topics({ topic: 'order-assigned' })).toEqual(['order-assigned/requested', 'order-assigned/sent']);
      expect(await topics({ topic: 'order-assigned', status: 'sent' })).toEqual(['order-assigned/sent']);
      expect(await topics({ topic: 'order-watched', status: 'sent' })).toEqual([]);
      // A filter never widens to somebody else's: the other person has the same topic, unmuted.
      await send(assigned([other.principal], watched));
      expect(await topics({ topic: 'order-watched' })).toEqual(['order-watched/skipped']);
    });

    it('refuses a status the engine does not know', async () => {
      await expect(mine(me, { status: 'bounced' })).rejects.toThrow();
    });
  });

  describe('digests', () => {
    const digestAfterADay = async () => {
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
      await send(assigned([me.principal], { vars: { orderId: 'WO-7' } }));
      clock.advance(DAY);
      await h.run((ctx) => sendDigests(ctx));
    };

    it('an occasion held for the digest reads skipped/digest, settled once the digest carried it, and the digest is a row of its own', async () => {
      await digestAfterADay();

      const { entries } = await mine();
      const occasion = entries.find((d) => d.topic === 'order-assigned')!;
      expect(occasion).toMatchObject({ status: 'skipped', reason: 'digest', about_type: 'workorder' });
      expect(occasion.settled_at).not.toBeNull();
      const digest = entries.find((d) => d.topic === DIGEST_TOPIC)!;
      expect(digest).toMatchObject({ status: 'requested', reason: null, about_type: null, about_id: null });
      // Newest first: the digest was written after the occasion it carries.
      expect(entries.map((d) => d.id)).toEqual([digest.id, occasion.id]);
    });

    it('the reserved topic lists the digests alone, and a digest settles like any other mail', async () => {
      await digestAfterADay();
      const [intent] = await intentsOf(h);
      await settleEmail(h, 'email.sent', intent!.id);

      expect((await mine(me, { topic: DIGEST_TOPIC })).entries).toMatchObject([{ topic: DIGEST_TOPIC, status: 'sent' }]);
    });

    it('a held occasion held back from the digest by a later mute reads skipped/muted', async () => {
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
      await send(assigned([me.principal]));
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });

      expect((await mine()).entries).toMatchObject([{ topic: 'order-assigned', status: 'skipped', reason: 'muted' }]);
    });
  });

  describe('who may ask', () => {
    it('is the person’s own key: notifications:self reads it, and notifications:read alone does not', async () => {
      await send(assigned([me.principal]));
      const admin = await h.as([PERM.read]);
      await expect(admin.invoke('notifications/my-deliveries', {})).rejects.toThrow(/permission denied/);
      const nobody = await h.as([]);
      await expect(nobody.invoke('notifications/my-deliveries', {})).rejects.toThrow(/permission denied/);
      // And the key that reads one's own history reads nobody's log.
      await expect(me.stub.invoke('notifications/list-deliveries', {})).rejects.toThrow(/permission denied/);
    });
  });

  describe('under drift', () => {
    it('a stored row that left the published shape throws, never shows as wrong data', async () => {
      await send(assigned([me.principal]));
      // A status a later version might add, written as that version would: the table is copied
      // without its CHECK, as the seam suite does it.
      const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql));
      await drift('ALTER TABLE notifications_deliveries RENAME TO old_deliveries');
      await drift('CREATE TABLE notifications_deliveries AS SELECT * FROM old_deliveries');
      await drift(`UPDATE notifications_deliveries SET status = 'bounced' WHERE principal = '${me.principal}'`);
      await expect(mine()).rejects.toMatchObject({ code: 'internal' });
    });
  });
});
