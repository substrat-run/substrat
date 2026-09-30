/**
 * The built-in behaviours after round-robin (#1083): auto-tag, auto-close, no-reply
 * notify, and the per-behaviour "last fired" they and their two siblings stamp.
 *
 * Every claim a handler's comments make is driven here, in both directions: a suite that
 * only watched a behaviour act would pass against one that always acted, and one that only
 * watched it hold back would pass against one that did nothing. The property each block
 * pins is named in its title, and the ones a reviewer would ask about next are beside it:
 * off by default, idempotent across sweeps, bounded per pass, on the manual door's key.
 *
 * The clock is the test's (`manualClock`), so a window measured in days is tested at its
 * boundary — a second short, and exactly on it — instead of on either side of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalId } from '@substrat-run/contracts';
import {
  AUTO_CLOSE_BATCH,
  AUTO_CLOSE_DUE,
  AUTO_TAG_BATCH,
  AUTO_TAG_PENDING,
  HANDED_TO_A_PERSON,
  NO_REPLY_BATCH,
  NO_REPLY_WAITING,
} from '../src/module.js';
import { ticket0Manifest } from '../src/manifest.js';
import { createKit, TICKET0, type Desk, type Kit } from './desk-kit.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let kit: Kit;
beforeAll(() => {
  kit = createKit('ticket0-automation-');
});
afterAll(() => kit.dispose());

const sweepTag = (d: Desk) => kit.sweep(d, 'ticket0/auto-tag', 'tagged');
const sweepClose = (d: Desk) => kit.sweep(d, 'ticket0/auto-close', 'closed');
const sweepNotify = (d: Desk) => kit.sweep(d, 'ticket0/notify-no-reply', 'notified');

const RULES = [
  { in: 'subject', contains: 'Refund', tag: 'billing' },
  { in: 'body', contains: 'crash', tag: 'bug' },
  { in: 'either', contains: 'urgent', tag: 'priority' },
] as const;

describe('off by default: a desk that has switched nothing on has none of the three', () => {
  it('acts on nothing however old, and has nothing to say about it', async () => {
    const desk = await kit.freshDesk({ agents: 2 });
    const refund = await kit.mail(desk, { subject: 'Refund please', body: 'the app crashes' });
    const resolved = await kit.mail(desk);
    await kit.resolve(desk, resolved);
    const waiting = await kit.mail(desk);
    kit.clock.advance(400 * DAY);

    expect(await sweepTag(desk)).toBe(0);
    expect(await sweepClose(desk)).toBe(0);
    expect(await sweepNotify(desk)).toBe(0);

    expect(await kit.tags(desk, refund)).toEqual([]);
    expect((await kit.read(desk, refund)).auto_tagged_at).toBeNull();
    expect((await kit.read(desk, resolved)).state).toBe('resolved');
    expect((await kit.read(desk, waiting)).no_reply_notified_at).toBeNull();
    expect(await kit.notifications(desk, desk.agents[0]!)).toEqual([]);
    expect(await kit.runs(desk)).toEqual([]);
  });

  it('reads anything that is not a usable switch as off, rather than as a number nobody chose', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const resolved = await kit.mail(desk);
    await kit.resolve(desk, resolved);
    const waiting = await kit.mail(desk);
    kit.clock.advance(400 * DAY);

    // A rollback leaves rows this version never wrote. `closed` is terminal, so a window of
    // zero, a string, or a value past the ceiling must not read as "close everything".
    for (const raw of [
      { autoClose: { afterDays: 0 } },
      { autoClose: { afterDays: '3' } },
      { autoClose: { afterDays: 3.5 } },
      { autoClose: { afterDays: 100_000 } },
      { autoClose: 3 },
      { autoClose: null },
      { noReplyNotify: { afterHours: 0 } },
      { noReplyNotify: { afterHours: '4' } },
      { noReplyNotify: { afterHours: 100_000 } },
      { autoTag: { rules: 'refund' } },
      { autoTag: { rules: [{ in: 'nowhere', contains: 'x', tag: 'y' }] } },
      { autoTag: { rules: [] } },
      [],
    ]) {
      kit.sql(desk, (db) => db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run(JSON.stringify(raw)));
      expect(await sweepClose(desk)).toBe(0);
      expect(await sweepNotify(desk)).toBe(0);
      expect(await sweepTag(desk)).toBe(0);
    }
    kit.sql(desk, (db) => db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run('not json'));
    expect(await sweepClose(desk)).toBe(0);
    expect((await kit.read(desk, resolved)).state).toBe('resolved');
    expect((await kit.read(desk, waiting)).no_reply_notified_at).toBeNull();
  });

  it('refuses a switch it does not know, and a rule or window outside the bounds, at save time', async () => {
    const desk = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(desk, desk.admin);
    const refused = (settings: Record<string, unknown>) =>
      expect(admin.invoke('ticket0/configure-desk', { settings })).rejects.toThrow();

    await refused({ autoclose: { afterDays: 3 } });
    await refused({ autoClose: { afterDays: 0 } });
    await refused({ autoClose: { afterDays: 366 } });
    await refused({ autoClose: { afterDays: 2.5 } });
    await refused({ autoClose: { days: 3 } });
    await refused({ noReplyNotify: { afterHours: 0 } });
    await refused({ noReplyNotify: { afterHours: 721 } });
    await refused({ autoTag: { rules: [] } });
    await refused({ autoTag: { rules: [{ in: 'subject', contains: '', tag: 'x' }] } });
    await refused({ autoTag: { rules: [{ in: 'subject', contains: 'x', tag: '   ' }] } });
    // A typo that saved cleanly would be a rule that never matches.
    await refused({ autoTag: { rules: [{ in: 'subject', contain: 'x', tag: 'y' }] } });
    // Not a pattern language: an unknown place to look is refused rather than guessed.
    await refused({ autoTag: { rules: [{ in: 'sender', contains: 'x', tag: 'y' }] } });
    await refused({
      autoTag: { rules: Array.from({ length: 21 }, (_, i) => ({ in: 'either', contains: `w${i}`, tag: 't' })) },
    });

    // The bounds themselves are accepted, and nothing above left anything behind.
    await admin.invoke('ticket0/configure-desk', {
      settings: {
        autoClose: { afterDays: 1 },
        noReplyNotify: { afterHours: 720 },
        autoTag: {
          rules: Array.from({ length: 20 }, (_, i) => ({ in: 'either', contains: `w${i}`, tag: 't' })),
        },
      },
    });
    // `null` is how a switch goes off again, and one key does not disturb another.
    await admin.invoke('ticket0/configure-desk', { settings: { autoClose: null } });
    const desk2 = (await admin.invoke('ticket0/get-desk', {})) as { settings: string };
    const stored = JSON.parse(desk2.settings) as Record<string, unknown>;
    expect(stored.autoClose).toBeNull();
    expect(stored.noReplyNotify).toEqual({ afterHours: 720 });
  });
});

describe('auto-tag: each new conversation is read once against the desk’s rules', () => {
  let desk: Desk;
  let refund: string;
  let crash: string;
  let plain: string;
  let urgentSubject: string;
  let bodyOnlyRefund: string;

  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 1 });
    // The desk's backlog: arrived before any rule existed.
    refund = await kit.mail(desk, { subject: 'REFUND for order 12', body: 'I was charged twice.' });
    crash = await kit.mail(desk, { subject: 'Hello', body: 'The app CRASHED when I opened it.' });
    plain = await kit.mail(desk, { subject: 'Hello again', body: 'Where is the export button?' });
    urgentSubject = await kit.mail(desk, { subject: 'Urgent: cannot log in', body: 'Help.' });
    bodyOnlyRefund = await kit.mail(desk, { subject: 'Order', body: 'I would like a refund.' });
  });

  it('tags the backlog once switched on: subject, body and either, in any case', async () => {
    await kit.configure(desk, { autoTag: { rules: [...RULES] } });
    const before = await kit.read(desk, refund);

    // 'billing' on the refund subject; 'bug' from the body; 'priority' from the subject via
    // `either`. A refund named only in the BODY does not match a rule that reads the subject.
    expect(await sweepTag(desk)).toBe(3);
    expect(await kit.tags(desk, refund)).toEqual(['billing']);
    expect(await kit.tags(desk, crash)).toEqual(['bug']);
    expect(await kit.tags(desk, urgentSubject)).toEqual(['priority']);
    expect(await kit.tags(desk, plain)).toEqual([]);
    expect(await kit.tags(desk, bodyOnlyRefund)).toEqual([]);

    // It looked at all five, matched or not — that mark is the idempotency.
    for (const id of [refund, crash, plain, urgentSubject, bodyOnlyRefund]) {
      expect((await kit.read(desk, id)).auto_tagged_at).not.toBeNull();
    }
    // A tag is not the customer or the desk doing something: `updated_at` stays put.
    expect((await kit.read(desk, refund)).updated_at).toBe(before.updated_at);
  });

  it('a second sweep finds nothing it has already handled', async () => {
    expect(await sweepTag(desk)).toBe(0);
    expect(await sweepTag(desk)).toBe(0);
    expect(await kit.tags(desk, refund)).toEqual(['billing']);
    expect(kit.events(desk, 'ticket0.conversation-tagged', refund)).toHaveLength(1);
  });

  it('a tag a person took off is not put back, and a rule edited later does not re-read old mail', async () => {
    const admin = await kit.as(desk, desk.admin);
    await admin.invoke('ticket0/untag-conversation', { conversationId: refund, tag: 'billing' });
    await kit.configure(desk, {
      autoTag: { rules: [...RULES, { in: 'either', contains: 'export', tag: 'howto' }] },
    });
    expect(await sweepTag(desk)).toBe(0);
    expect(await kit.tags(desk, refund)).toEqual([]);
    // `plain` says "export" and was read before the rule existed: it stays as it was.
    expect(await kit.tags(desk, plain)).toEqual([]);
  });

  it('reads a conversation that arrives later, and only tags what a rule names', async () => {
    const later = await kit.mail(desk, { subject: 'Where is the export?', body: 'and it might crash' });
    expect(await sweepTag(desk)).toBe(2);
    expect((await kit.tags(desk, later)).sort()).toEqual(['bug', 'howto']);
  });

  it('is the manual door’s act: the same event, on the trail as the desk’s, under the same key', async () => {
    const [event] = kit.events(desk, 'ticket0.conversation-tagged', crash);
    expect(JSON.parse(event!.actor)).toEqual({ system: ticket0Manifest.id });
    expect(event!.operation).toBe('ticket0/auto-tag');
    const authorization = JSON.parse(event!.authorization ?? '[]') as { permission: string }[];
    expect(authorization.map((a) => a.permission)).toContain('conversation:assign');
    expect(JSON.parse(event!.payload)).toEqual(
      expect.objectContaining({ conversation_id: crash, tag: 'bug' }),
    );
  });

  it('leaves finished work alone, and reads a parked conversation', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const done = await kit.mail(d, { subject: 'Refund', body: 'x' });
    await kit.resolve(d, done);
    const parked = await kit.mail(d, { subject: 'Refund too', body: 'x' });
    await kit.park(d, parked, 7 * DAY);
    await kit.configure(d, { autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] } });
    expect(await sweepTag(d)).toBe(1);
    expect(await kit.tags(d, parked)).toEqual(['billing']);
    expect(await kit.tags(d, done)).toEqual([]);
    expect((await kit.read(d, done)).auto_tagged_at).toBeNull();
  });

  it('stamps last-fired when it tagged something, and leaves it alone when it found nothing', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] } });
    await kit.mail(d, { subject: 'Hello', body: 'nothing to see' });
    expect(await sweepTag(d)).toBe(0);
    // It read a conversation and matched nothing: not a firing.
    expect(await kit.runs(d)).toEqual([]);

    const at = kit.clock.read();
    await kit.mail(d, { subject: 'Refund', body: 'x' });
    await kit.mail(d, { subject: 'Another refund', body: 'x' });
    expect(await sweepTag(d)).toBe(2);
    const [run] = await kit.runs(d);
    expect(run).toMatchObject({ behaviour: 'autoTag', last_count: 2 });
    expect(run!.last_fired_at >= at).toBe(true);

    const firedAt = run!.last_fired_at;
    kit.clock.advance(HOUR);
    expect(await sweepTag(d)).toBe(0);
    expect((await kit.runs(d))[0]!.last_fired_at).toBe(firedAt);
  });

  it('counts conversations in last-fired, not tags: two rules on one conversation are one', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, {
      autoTag: {
        rules: [
          { in: 'subject', contains: 'refund', tag: 'billing' },
          { in: 'either', contains: 'urgent', tag: 'priority' },
        ],
      },
    });
    await kit.mail(d, { subject: 'Urgent refund', body: 'x' });
    await kit.mail(d, { subject: 'Refund', body: 'x' });
    expect(await sweepTag(d)).toBe(3); // three tags went on ...
    expect((await kit.runs(d))[0]).toMatchObject({ behaviour: 'autoTag', last_count: 2 }); // ... on two conversations
  });

  it('is bounded per pass, and the next pass takes the rest', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] } });
    for (let i = 0; i < AUTO_TAG_BATCH + 5; i++) await kit.mail(d, { subject: 'Refund', body: 'x' });
    expect(await sweepTag(d)).toBe(AUTO_TAG_BATCH);
    expect(await sweepTag(d)).toBe(5);
    expect(await sweepTag(d)).toBe(0);
  });

  it('is refused to a caller without conversation:assign, and stops when the grant is revoked', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] } });
    await expect((await kit.as(d, d.relay)).invoke('ticket0/auto-tag')).rejects.toThrow(/denied/i);
    const c = await kit.mail(d, { subject: 'Refund', body: 'x' });
    kit.revokeSystemGrant(d, 'conversation:assign');
    await expect(sweepTag(d)).rejects.toThrow(/denied/i);
    expect(await kit.tags(d, c)).toEqual([]);
  });
});

describe('auto-close: a resolved conversation left alone for the window is closed', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 1 });
    await kit.configure(desk, { autoClose: { afterDays: 3 } });
  });

  it('closes at exactly the window and not a second before', async () => {
    const id = await kit.mail(desk);
    await kit.resolve(desk, id);
    const resolved = await kit.read(desk, id);
    expect(resolved.state).toBe('resolved');

    kit.clock.advance(3 * DAY - 1000);
    expect(await sweepClose(desk)).toBe(0);
    expect((await kit.read(desk, id)).state).toBe('resolved');

    kit.clock.advance(1000);
    expect(await sweepClose(desk)).toBe(1);
    const closed = await kit.read(desk, id);
    expect(closed.state).toBe('closed');
    // Closing later does not un-answer it: the reports count `resolved_at`.
    expect(closed.resolved_at).toBe(resolved.resolved_at);
  });

  it('is idempotent: closed is terminal, so a second sweep finds nothing', async () => {
    expect(await sweepClose(desk)).toBe(0);
    expect(kit.events(desk, 'ticket0.conversation-closed')).toHaveLength(1);
  });

  it('a reply resets the clock: the customer writes back, and the window starts again from the next resolve', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { autoClose: { afterDays: 3 } });
    const id = await kit.mail(d);
    await kit.resolve(d, id);

    kit.clock.advance(2 * DAY);
    // The customer writes back: it is open again, and a resolved-only sweep cannot see it.
    await kit.mail(d, { into: id, body: 'Actually it is still broken.' });
    expect((await kit.read(d, id)).state).toBe('open');
    kit.clock.advance(2 * DAY);
    expect(await sweepClose(d)).toBe(0);
    expect((await kit.read(d, id)).state).toBe('open');

    // Resolved again, on a new clock: three days short of it is not closed, three days is.
    await kit.resolve(d, id);
    kit.clock.advance(3 * DAY - 1000);
    expect(await sweepClose(d)).toBe(0);
    kit.clock.advance(1000);
    expect(await sweepClose(d)).toBe(1);
    expect((await kit.read(d, id)).state).toBe('closed');
  });

  it('a note on a resolved conversation is somebody touching it, and restarts the window', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { autoClose: { afterDays: 3 } });
    const id = await kit.mail(d);
    await kit.resolve(d, id);
    kit.clock.advance(2 * DAY);
    await (await kit.as(d, d.admin)).invoke('ticket0/post-note', { conversationId: id, body: 'Checked again.' });
    kit.clock.advance(2 * DAY);
    expect(await sweepClose(d)).toBe(0);
    kit.clock.advance(DAY);
    expect(await sweepClose(d)).toBe(1);
  });

  it('only ever takes resolved: new, open and parked work is untouched however long it sits', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    const fresh = await kit.mail(d);
    const open = await kit.mail(d);
    await (await kit.as(d, d.admin)).invoke('ticket0/post-public-reply', { conversationId: open, body: 'Looking.' });
    const parked = await kit.mail(d);
    await kit.park(d, parked, 90 * DAY);
    const done = await kit.mail(d);
    await kit.resolve(d, done);

    kit.clock.advance(30 * DAY);
    expect(await sweepClose(d)).toBe(1);
    expect((await kit.read(d, fresh)).state).toBe('new');
    expect((await kit.read(d, open)).state).toBe('open');
    expect((await kit.read(d, parked)).state).toBe('snoozed');
    expect((await kit.read(d, done)).state).toBe('closed');
  });

  it('is the manual close’s event on the desk’s key, and the trail says which behaviour closed it', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    const id = await kit.mail(d);
    await kit.resolve(d, id);
    kit.clock.advance(DAY);
    expect(await sweepClose(d)).toBe(1);

    const [event] = kit.events(d, 'ticket0.conversation-closed', id);
    expect(JSON.parse(event!.actor)).toEqual({ system: ticket0Manifest.id });
    expect(event!.operation).toBe('ticket0/auto-close');
    const authorization = JSON.parse(event!.authorization ?? '[]') as { permission: string }[];
    expect(authorization.map((a) => a.permission)).toContain('conversation:resolve');
    expect(JSON.parse(event!.payload)).toEqual({ id });
    // Nobody is told: the desk resolved it themselves.
    expect(await kit.notifications(d, d.agents[0]!)).toEqual([]);
  });

  it('stamps last-fired only when it closed something', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    const id = await kit.mail(d);
    await kit.resolve(d, id);
    expect(await sweepClose(d)).toBe(0);
    expect(await kit.runs(d)).toEqual([]);
    kit.clock.advance(DAY);
    expect(await sweepClose(d)).toBe(1);
    const [run] = await kit.runs(d);
    expect(run).toMatchObject({ behaviour: 'autoClose', last_count: 1, last_fired_at: kit.clock.read() });
  });

  it('is bounded per pass, and the next pass takes the rest', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoClose: { afterDays: 2 } });
    for (let i = 0; i < AUTO_CLOSE_BATCH + 4; i++) await kit.mail(d);
    // Stand the whole inbox at resolved a long time ago — harness SQL, because 200 real
    // replies-and-resolves would test the reply path 200 times and this one not at all.
    kit.sql(d, (db) =>
      db
        .prepare(`UPDATE ticket0_conversations SET state = 'resolved', updated_at = ?`)
        .run(new Date(Date.parse(kit.clock.read()) - 5 * DAY).toISOString()),
    );
    expect(await sweepClose(d)).toBe(AUTO_CLOSE_BATCH);
    expect(await sweepClose(d)).toBe(4);
    expect(await sweepClose(d)).toBe(0);
  });

  it('is refused to a caller without conversation:resolve, and stops when the grant is revoked', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    await expect((await kit.as(d, d.relay)).invoke('ticket0/auto-close')).rejects.toThrow(/denied/i);
    const id = await kit.mail(d);
    await kit.resolve(d, id);
    kit.clock.advance(2 * DAY);
    kit.revokeSystemGrant(d, 'conversation:resolve');
    await expect(sweepClose(d)).rejects.toThrow(/denied/i);
    expect((await kit.read(d, id)).state).toBe('resolved');
  });
});

describe('no-reply notify: the desk hears once about a customer who has waited too long', () => {
  let desk: Desk;
  let agentA: PrincipalId;
  let agentB: PrincipalId;
  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 2 });
    [agentA, agentB] = desk.agents as [PrincipalId, PrincipalId];
    await kit.configure(desk, { noReplyNotify: { afterHours: 4 } });
  });

  const told = (who: PrincipalId, conversationId: string) => kit.escalations(desk, who, conversationId);

  it('tells everybody when nobody holds it — at the window, not a second before', async () => {
    const id = await kit.mail(desk);
    kit.clock.advance(4 * HOUR - 1000);
    expect(await sweepNotify(desk)).toBe(0);
    kit.clock.advance(1000);
    expect(await sweepNotify(desk)).toBe(1);
    expect(await told(agentA, id)).toBe(1);
    expect(await told(agentB, id)).toBe(1);
  });

  it('is idempotent: a customer who keeps waiting is one notification, however many sweeps', async () => {
    const [id] = (await kit.notifications(desk, agentA)).map((n) => n.conversation_id!);
    expect(await sweepNotify(desk)).toBe(0);
    kit.clock.advance(3 * DAY);
    expect(await sweepNotify(desk)).toBe(0);
    expect(await told(agentA, id!)).toBe(1);
    expect(kit.events(desk, 'ticket0.no-reply-notified', id)).toHaveLength(1);
  });

  it('a customer who keeps chasing is announced again at most once a window — both sides of it', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 4 } });
    const id = await kit.mail(d);
    kit.clock.advance(4 * HOUR);
    expect(await sweepNotify(d)).toBe(1);
    const noticeAt = (await kit.read(d, id)).no_reply_notified_at!;
    expect(await sweepNotify(d)).toBe(0); // nothing new: the notice stands

    // The customer chases. That re-arms the scan, but the notice is not yet a window old, so
    // a sweep every quarter of an hour stays quiet instead of announcing them each time.
    kit.clock.advance(MINUTE);
    await kit.mail(d, { into: id, body: 'Hello? Anyone?' });
    for (let i = 0; i < 3; i++) {
      kit.clock.advance(15 * MINUTE);
      expect(await sweepNotify(d)).toBe(0);
    }
    // A second short of a whole window since the notice: still quiet. Exactly a window: told.
    kit.clock.set(new Date(Date.parse(noticeAt) + 4 * HOUR - 1000).toISOString());
    expect(await sweepNotify(d)).toBe(0);
    kit.clock.set(new Date(Date.parse(noticeAt) + 4 * HOUR).toISOString());
    expect(await sweepNotify(d)).toBe(1);
    expect(await kit.escalations(d, d.agents[0]!, id)).toBe(2);
    expect(await sweepNotify(d)).toBe(0); // and that notice stands until the next chase
    // The window is measured from the notice, so a chase does not pull a later one forward.
    kit.clock.advance(MINUTE);
    await kit.mail(d, { into: id, body: 'Please?' });
    kit.clock.advance(HOUR);
    expect(await sweepNotify(d)).toBe(0);
  });

  it('the wait runs from the OLDEST unanswered message: a nudge does not restart the clock', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 4 } });
    const id = await kit.mail(d);
    kit.clock.advance(3 * HOUR);
    await kit.mail(d, { into: id, body: 'Any news?' });
    kit.clock.advance(HOUR - 60_000 - 1000);
    expect(await sweepNotify(d)).toBe(0); // 4h minus a second since the FIRST message
    kit.clock.advance(1000);
    expect(await sweepNotify(d)).toBe(1);
    expect(await kit.escalations(d, d.agents[0]!, id)).toBe(1);
    // The announcement reports when the wait began, not when the nudge came.
    const [event] = kit.events(d, 'ticket0.no-reply-notified', id);
    expect(Date.parse(kit.clock.read()) - Date.parse(JSON.parse(event!.payload).waiting_since)).toBeGreaterThanOrEqual(
      4 * HOUR,
    );
  });

  it('an answer from the desk ends the wait, and the next message starts a new one from itself', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 4 } });
    const id = await kit.mail(d);
    kit.clock.advance(3 * HOUR);
    await (await kit.as(d, d.admin)).invoke('ticket0/post-public-reply', { conversationId: id, body: 'On it.' });
    kit.clock.advance(HOUR);
    await kit.mail(d, { into: id, body: 'Thanks — and one more thing.' });
    // Four hours since the FIRST message, but the desk answered it: this is a fresh wait.
    kit.clock.advance(4 * HOUR - 1000);
    expect(await sweepNotify(d)).toBe(0);
    kit.clock.advance(1000);
    expect(await sweepNotify(d)).toBe(1);
  });

  it('only the holder is told when somebody holds it', async () => {
    const id = await kit.mail(desk);
    await (await kit.as(desk, desk.admin)).invoke('ticket0/assign', { conversationId: id, assignee: agentB });
    // A person picking it up is not an answer to the customer.
    kit.clock.advance(4 * HOUR);
    expect(await sweepNotify(desk)).toBe(1);
    expect(await told(agentB, id)).toBe(1);
    expect(await told(agentA, id)).toBe(0);
  });

  it('a public answer ends the wait; an internal note does not', async () => {
    const answered = await kit.mail(desk);
    const noted = await kit.mail(desk);
    const admin = await kit.as(desk, desk.admin);
    await admin.invoke('ticket0/post-public-reply', { conversationId: answered, body: 'On it.' });
    await admin.invoke('ticket0/post-note', { conversationId: noted, body: 'Looking into it.' });
    kit.clock.advance(5 * HOUR);
    expect(await sweepNotify(desk)).toBe(1);
    expect(await told(agentA, noted)).toBe(1);
    expect(await told(agentA, answered)).toBe(0);
  });

  it('leaves parked and finished conversations alone', async () => {
    const parked = await kit.mail(desk);
    await kit.park(desk, parked, 30 * DAY);
    const done = await kit.mail(desk);
    await kit.resolve(desk, done);
    kit.clock.advance(10 * HOUR);
    expect(await sweepNotify(desk)).toBe(0);
    expect(await told(agentA, parked)).toBe(0);
    expect(await told(agentA, done)).toBe(0);
  });

  it('a request for a person that nobody has answered is a customer waiting, and an answered one is not', async () => {
    const widget = await kit.as(desk, desk.widget);
    const unanswered = await kit.chat(desk);
    await widget.invoke('ticket0/request-human', { sessionId: unanswered.sessionId, token: unanswered.token });
    const answered = await kit.chat(desk);
    await widget.invoke('ticket0/request-human', { sessionId: answered.sessionId, token: answered.token });
    await (await kit.as(desk, desk.admin)).invoke('ticket0/post-public-reply', {
      conversationId: answered.conversationId,
      body: 'Here I am.',
    });
    // The acknowledgement the host wrote is the newest public word on the first; an agent
    // has said something since on the second.
    // `request-human` tells the desk itself, in the same kind of notice; only what the SWEEP
    // adds on top of that is this behaviour.
    const beforeUnanswered = await told(agentA, unanswered.conversationId);
    const beforeAnswered = await told(agentA, answered.conversationId);
    kit.clock.advance(5 * HOUR);
    expect(await sweepNotify(desk)).toBe(1);
    expect(await told(agentA, unanswered.conversationId)).toBe(beforeUnanswered + 1);
    expect(await told(agentA, answered.conversationId)).toBe(beforeAnswered);
  });

  it('carries the conversation’s id and nothing a customer wrote or gave — not in the notice, not on the trail', async () => {
    const secret = await kit.mail(desk, {
      subject: 'My card 4242 4242 4242 4242',
      body: 'Please call me on +46 70 000 00 00',
      from: 'private.person@customer.example',
    });
    kit.clock.advance(5 * HOUR);
    await sweepNotify(desk);

    const notice = (await kit.notifications(desk, agentA)).find((n) => n.conversation_id === secret)!;
    expect(Object.keys(notice).sort()).toEqual(
      expect.arrayContaining(['conversation_id', 'kind']),
    );
    expect(JSON.stringify(notice)).not.toMatch(/4242|private\.person|\+46/);

    const [event] = kit.events(desk, 'ticket0.no-reply-notified', secret);
    expect(Object.keys(JSON.parse(event!.payload)).sort()).toEqual(
      ['assignee', 'id', 'state', 'told', 'waiting_since'].sort(),
    );
    expect(event!.payload).not.toMatch(/4242|private\.person|\+46/);
    // And it is the desk's notice, under the escalation key, on the trail as this behaviour.
    expect(event!.operation).toBe('ticket0/notify-no-reply');
    const authorization = JSON.parse(event!.authorization ?? '[]') as { permission: string }[];
    expect(authorization.map((a) => a.permission)).toContain('conversation:escalate');
  });

  it('does not touch updated_at, and stamps last-fired', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const id = await kit.mail(d);
    const before = await kit.read(d, id);
    expect(await sweepNotify(d)).toBe(0);
    expect(await kit.runs(d)).toEqual([]);
    kit.clock.advance(HOUR);
    expect(await sweepNotify(d)).toBe(1);
    expect((await kit.read(d, id)).updated_at).toBe(before.updated_at);
    expect((await kit.read(d, id)).no_reply_notified_at).toBe(kit.clock.read());
    expect(await kit.runs(d)).toEqual([{ behaviour: 'noReplyNotify', last_fired_at: kit.clock.read(), last_count: 1 }]);
  });

  it('a desk with nobody on it announces nothing and stamps nothing — the day somebody joins is the day it is told', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const id = await kit.mail(d);
    kit.clock.advance(2 * HOUR);
    expect(await sweepNotify(d)).toBe(0);
    expect((await kit.read(d, id)).no_reply_notified_at).toBeNull();
    expect(await kit.runs(d)).toEqual([]);

    const newcomer = await kit.hire(d);
    expect(await sweepNotify(d)).toBe(1);
    expect((await kit.notifications(d, newcomer)).map((n) => n.conversation_id)).toEqual([id]);
  });

  it('is bounded per pass, and the next pass takes the rest', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    for (let i = 0; i < NO_REPLY_BATCH + 3; i++) await kit.mail(d);
    kit.clock.advance(2 * HOUR);
    expect(await sweepNotify(d)).toBe(NO_REPLY_BATCH);
    expect(await sweepNotify(d)).toBe(3);
    expect(await sweepNotify(d)).toBe(0);
  });

  it('is refused to a caller without conversation:escalate, and stops when the grant is revoked', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    await expect((await kit.as(d, d.relay)).invoke('ticket0/notify-no-reply')).rejects.toThrow(/denied/i);
    await kit.mail(d);
    kit.clock.advance(2 * HOUR);
    kit.revokeSystemGrant(d, 'conversation:escalate');
    await expect(sweepNotify(d)).rejects.toThrow(/denied/i);
  });
});

describe('last fired: every behaviour says when it last did something', () => {
  it('is read behind desk:configure, and lists only behaviours that have fired', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    expect(await kit.runs(d)).toEqual([]);
    await expect((await kit.as(d, d.agents[0]!)).invoke('ticket0/list-behaviour-runs', {})).rejects.toThrow(/denied/i);
  });

  it('round-robin and service levels stamp it too, each under its own key', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { roundRobin: true, sla: { firstResponseMinutes: { normal: 10 } } });
    await kit.mail(d);
    const system = await kit.system(d);
    expect(((await system.invoke('ticket0/assign-round-robin')) as { assigned: number }).assigned).toBe(1);
    kit.clock.advance(11 * MINUTE);
    expect(((await system.invoke('ticket0/escalate-sla-breaches')) as { breached: number }).breached).toBe(1);

    const runs = await kit.runs(d);
    expect(runs.map((r) => [r.behaviour, r.last_count])).toEqual([
      ['roundRobin', 1],
      ['sla', 1],
    ]);
    // A sweep that finds nothing leaves the stamp where it was.
    const before = runs;
    kit.clock.advance(HOUR);
    await system.invoke('ticket0/assign-round-robin');
    await system.invoke('ticket0/escalate-sla-breaches');
    expect(await kit.runs(d)).toEqual(before);
  });

  it('service levels count conversations: one that missed both targets is one', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { sla: { firstResponseMinutes: { normal: 10 }, resolutionMinutes: { normal: 20 } } });
    await kit.mail(d);
    kit.clock.advance(30 * MINUTE);
    const system = await kit.system(d);
    expect(((await system.invoke('ticket0/escalate-sla-breaches')) as { breached: number }).breached).toBe(2);
    expect((await kit.runs(d))[0]).toMatchObject({ behaviour: 'sla', last_count: 1 });
  });

  it('a behaviour that is switched off never stamps, however often the schedule comes round', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.mail(d);
    const system = await kit.system(d);
    for (const op of [
      'ticket0/assign-round-robin',
      'ticket0/escalate-sla-breaches',
      'ticket0/auto-tag',
      'ticket0/auto-close',
      'ticket0/notify-no-reply',
    ]) {
      kit.clock.advance(DAY);
      await system.invoke(op);
    }
    expect(await kit.runs(d)).toEqual([]);
  });
});

describe('the scans are indexed, because they run on every tick', () => {
  it('each scan is an index seek and never a table scan; the two ordered by their index sort nothing', async () => {
    // A real scope's database, as the adapter built it: the module's migrations AND the
    // kernel's own list indexes. Those are the competition.
    const d = await kit.freshDesk({ agents: 0 });
    await kit.mail(d);
    const plan = (sql: string, ...params: (string | number)[]): string[] =>
      kit.sql(d, (db) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail),
      );

    const tag = plan(AUTO_TAG_PENDING, 200);
    expect(tag).toContainEqual(expect.stringMatching(/USING INDEX ticket0_conversations_untagged\b/));
    expect(tag.filter((x) => /TEMP B-TREE/.test(x))).toEqual([]);

    const close = plan(AUTO_CLOSE_DUE, '2026-01-01T00:00:00.000Z', 200);
    // The kernel's own `(state, updated_at)` list index, seeked on both columns.
    expect(close).toContainEqual(expect.stringMatching(/USING INDEX \S*conversation_state_updated_at \(state=\? AND updated_at<\?\)/));
    expect(close.filter((x) => /^SCAN\b|TEMP B-TREE/.test(x))).toEqual([]);

    const notify = plan(
      NO_REPLY_WAITING,
      HANDED_TO_A_PERSON,
      HANDED_TO_A_PERSON,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      200,
    );
    // No index of its own, and that is measured: the kernel's `state` list index already seeks
    // the live conversations, and a partial one duplicated it at a write cost on every
    // conversation. Every table is SEARCHed — the conversations by that index, each
    // message lookup by the messages index or its primary key — and nothing is walked end
    // to end. The one sort is the `ORDER BY` over the LIVE set, which cannot arrive in
    // order (the wait is a subquery's), and which the batch bounds on the way out.
    expect(notify).toContainEqual(expect.stringMatching(/^SEARCH c USING INDEX \S*conversation_state_\w+ \(state=\?\)/));
    expect(notify.filter((x) => /^SCAN\b/.test(x))).toEqual([]);
  });
});

describe('the platform sweep is the caller', () => {
  it('fires all three declared schedules, and each does its work', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, {
      autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] },
      autoClose: { afterDays: 1 },
      noReplyNotify: { afterHours: 1 },
    });
    const tagged = await kit.mail(d, { subject: 'Refund', body: 'x' });
    const done = await kit.mail(d);
    await kit.resolve(d, done);
    kit.clock.advance(2 * DAY);

    // Nothing here invokes an operation: the sweep reads what the manifest declares, and
    // provisioning granted the system principal the keys they check.
    const report = await kit.host.runDueSchedules(TICKET0, d.tenant, d.scope);
    expect(report.errors).toEqual([]);
    for (const operation of ['ticket0/auto-tag', 'ticket0/auto-close', 'ticket0/notify-no-reply']) {
      expect(report.runs).toContainEqual({ operation, outcome: 'ok' });
    }
    expect(await kit.tags(d, tagged)).toEqual(['billing']);
    expect((await kit.read(d, done)).state).toBe('closed');
    expect((await kit.runs(d)).map((r) => r.behaviour).sort()).toEqual(['autoClose', 'autoTag', 'noReplyNotify']);
  });
});

describe('the per-conversation check is real: a refusal on one conversation skips it and the pass goes on', () => {
  // The schedule's principal holds a node-wide grant, so the real checker cannot refuse one
  // conversation and allow its neighbour. The kit's wrapped checker can, and that is what
  // makes the per-row check observable rather than assumed.
  it('auto-tag leaves the refused conversation unread, tags the rest, and reads it once the refusal is lifted', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] } });
    const [a, victim, c] = [
      await kit.mail(d, { subject: 'Refund A', body: 'x' }),
      await kit.mail(d, { subject: 'Refund B', body: 'x' }),
      await kit.mail(d, { subject: 'Refund C', body: 'x' }),
    ] as [string, string, string];
    kit.denyEntities([victim]);
    expect(await sweepTag(d)).toBe(2);
    expect(await kit.tags(d, a)).toEqual(['billing']);
    expect(await kit.tags(d, c)).toEqual(['billing']);
    expect(await kit.tags(d, victim)).toEqual([]);
    expect((await kit.read(d, victim)).auto_tagged_at).toBeNull();
    kit.denyEntities([]);
    expect(await sweepTag(d)).toBe(1);
    expect(await kit.tags(d, victim)).toEqual(['billing']);
  });

  it('auto-close leaves the refused conversation resolved, closes the rest, and takes it once lifted', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    const ids = [await kit.mail(d), await kit.mail(d), await kit.mail(d)] as [string, string, string];
    for (const id of ids) await kit.resolve(d, id);
    kit.clock.advance(2 * DAY);
    kit.denyEntities([ids[1]]);
    expect(await sweepClose(d)).toBe(2);
    expect((await kit.read(d, ids[0])).state).toBe('closed');
    expect((await kit.read(d, ids[1])).state).toBe('resolved');
    expect((await kit.read(d, ids[2])).state).toBe('closed');
    kit.denyEntities([]);
    expect(await sweepClose(d)).toBe(1);
    expect((await kit.read(d, ids[1])).state).toBe('closed');
  });

  it('no-reply notify does not announce the refused conversation, announces the rest, and does it once lifted', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const ids = [await kit.mail(d), await kit.mail(d), await kit.mail(d)] as [string, string, string];
    kit.clock.advance(2 * HOUR);
    kit.denyEntities([ids[1]]);
    expect(await sweepNotify(d)).toBe(2);
    expect(await kit.escalations(d, d.agents[0]!, ids[0])).toBe(1);
    expect(await kit.escalations(d, d.agents[0]!, ids[1])).toBe(0);
    expect(await kit.escalations(d, d.agents[0]!, ids[2])).toBe(1);
    expect((await kit.read(d, ids[1])).no_reply_notified_at).toBeNull();
    kit.denyEntities([]);
    expect(await sweepNotify(d)).toBe(1);
    expect(await kit.escalations(d, d.agents[0]!, ids[1])).toBe(1);
  });

  it('the node-level check still stops a sweep outright — the refusal above is per row, not per behaviour', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { autoClose: { afterDays: 1 } });
    const id = await kit.mail(d);
    await kit.resolve(d, id);
    kit.clock.advance(2 * DAY);
    kit.denyEntities([id]);
    expect(await sweepClose(d)).toBe(0); // skipped, not thrown
    kit.denyEntities([]);
    kit.revokeSystemGrant(d, 'conversation:resolve');
    await expect(sweepClose(d)).rejects.toThrow(/denied/i);
  });
});
