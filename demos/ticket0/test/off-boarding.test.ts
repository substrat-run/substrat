/**
 * Off-boarding (#1083): an agent an admin has taken off the desk is not handed work, not
 * told about work nobody holds, and cannot be put back by themselves.
 *
 * The column MIRRORS a role revocation rather than deriving from one — module code cannot
 * read another principal's roles — so what is pinned here is the mirror's behaviour, in
 * every place that asks "who is on this desk": the round-robin ring, a manual `assign`,
 * and the broadcast `notifyStaff` sends when nobody holds a conversation. One predicate
 * serves all three, and this suite walks the same person through each door.
 *
 * Each block reads back through the operations the app calls, and each claim is driven in
 * both directions: an agent who is skipped while off the desk must be picked again once
 * reinstated, or the suite would pass against a handler that skipped everybody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalId } from '@substrat-run/contracts';
import { createKit, type Desk, type Kit } from './desk-kit.js';

const HOUR = 60 * 60_000;

let kit: Kit;
beforeAll(() => {
  kit = createKit('ticket0-off-boarding-');
});
afterAll(() => kit.dispose());

const sweepRing = (d: Desk) => kit.sweep(d, 'ticket0/assign-round-robin', 'assigned');
const sweepNotify = (d: Desk) => kit.sweep(d, 'ticket0/notify-no-reply', 'notified');

const setOff = async (d: Desk, principal: PrincipalId, offboarded: boolean) =>
  (await (await kit.as(d, d.admin)).invoke('ticket0/set-agent-offboarded', { principal, offboarded })) as {
    principal: string;
    offboarded_at: string | null;
    display_name: string;
  };

const escalations = (d: Desk, who: PrincipalId, conversationId: string) => kit.escalations(d, who, conversationId);

const directory = async (d: Desk) =>
  (
    (await (await kit.as(d, d.admin)).invoke('ticket0/list-agents', {})) as {
      entries: { principal: string; offboarded_at: string | null }[];
    }
  ).entries;

/** The ring's order: by principal, ascending — the comparison SQLite's `ORDER BY` makes on ULIDs. */
const ringOf = (d: Desk): PrincipalId[] => [...d.agents].sort();

describe('the ring skips an off-boarded agent', () => {
  let desk: Desk;
  let ring: PrincipalId[];
  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 3 });
    ring = ringOf(desk);
    await kit.configure(desk, { roundRobin: true });
  });

  it('hands work to the people still on the desk, in turn, and never to the one who left', async () => {
    const [first, leaver, third] = ring as [PrincipalId, PrincipalId, PrincipalId];
    const off = await setOff(desk, leaver, true);
    expect(off.offboarded_at).toBe(kit.clock.read());

    const handed: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await kit.mail(desk);
      expect(await sweepRing(desk)).toBe(1);
      handed.push((await kit.read(desk, id)).assignee!);
    }
    // Two people are on the desk, so the rotation alternates between exactly them.
    expect(handed).toEqual([first, third, first, third, first, third]);
    expect(handed).not.toContain(leaver);
  });

  it('no conversation is ever assigned to them, whatever the backlog', async () => {
    const [, leaver] = ring as [PrincipalId, PrincipalId, PrincipalId];
    for (let i = 0; i < 9; i++) await kit.mail(desk);
    expect(await sweepRing(desk)).toBe(9);
    const held = kit.sql(desk, (db) =>
      db.prepare('SELECT COUNT(*) AS n FROM ticket0_conversations WHERE assignee = ?').get(leaver),
    ) as { n: number };
    expect(held.n).toBe(0);
    expect(
      kit.events(desk, 'ticket0.conversation-assigned').filter((e) => JSON.parse(e.payload).assignee === leaver),
    ).toEqual([]);
  });

  it('reinstated, they are back in the rotation', async () => {
    const [, leaver] = ring as [PrincipalId, PrincipalId, PrincipalId];
    const back = await setOff(desk, leaver, false);
    expect(back.offboarded_at).toBeNull();

    const handed = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const id = await kit.mail(desk);
      await sweepRing(desk);
      handed.add((await kit.read(desk, id)).assignee!);
    }
    expect([...handed].sort()).toEqual(ring);
  });

  it('somebody who was last in line and then left still marks a place in the order', async () => {
    const d = await kit.freshDesk({ agents: 3 });
    const [a, b, c] = ringOf(d) as [PrincipalId, PrincipalId, PrincipalId];
    await kit.configure(d, { roundRobin: true });
    for (let i = 0; i < 2; i++) await kit.mail(d);
    expect(await sweepRing(d)).toBe(2); // a, then b: the cursor stands on b
    await setOff(d, b, true);
    const next = await kit.mail(d);
    await sweepRing(d);
    expect((await kit.read(d, next)).assignee).toBe(c);
    const after = await kit.mail(d);
    await sweepRing(d);
    expect((await kit.read(d, after)).assignee).toBe(a);
  });

  it('a desk where everybody has left assigns nothing, leaves the conversations, and is not an error', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    await kit.configure(d, { roundRobin: true });
    for (const a of d.agents) await setOff(d, a, true);
    const id = await kit.mail(d);
    expect(await sweepRing(d)).toBe(0);
    expect((await kit.read(d, id)).assignee).toBeNull();
    // And the first person back is handed what was waiting.
    await setOff(d, d.agents[0]!, false);
    expect(await sweepRing(d)).toBe(1);
    expect((await kit.read(d, id)).assignee).toBe(d.agents[0]);
  });
});

describe('a manual assign refuses them, and takes them again once reinstated', () => {
  it('names the reason, leaves the conversation where it was, and leaves what they already hold alone', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    const [stays, leaver] = d.agents as [PrincipalId, PrincipalId];
    const admin = await kit.as(d, d.admin);

    const heldByThem = await kit.mail(d);
    await admin.invoke('ticket0/assign', { conversationId: heldByThem, assignee: leaver });
    const other = await kit.mail(d);

    await setOff(d, leaver, true);
    await expect(admin.invoke('ticket0/assign', { conversationId: other, assignee: leaver })).rejects.toThrow(
      /not on this desk any more/,
    );
    expect((await kit.read(d, other)).assignee).toBeNull();
    // Somebody else is still assignable: the refusal is about the person, not the door.
    await admin.invoke('ticket0/assign', { conversationId: other, assignee: stays });
    expect((await kit.read(d, other)).assignee).toBe(stays);
    // What they already held is theirs until a person moves it: nothing reassigned it.
    expect((await kit.read(d, heldByThem)).assignee).toBe(leaver);

    await setOff(d, leaver, false);
    const again = await kit.mail(d);
    await admin.invoke('ticket0/assign', { conversationId: again, assignee: leaver });
    expect((await kit.read(d, again)).assignee).toBe(leaver);
  });

  it('putting a conversation back, or handing it on, still works while its holder is gone', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    const [stays, leaver] = d.agents as [PrincipalId, PrincipalId];
    const admin = await kit.as(d, d.admin);
    const id = await kit.mail(d);
    await admin.invoke('ticket0/assign', { conversationId: id, assignee: leaver });
    await setOff(d, leaver, true);
    // `null` is nobody, not a person: only the incoming assignee is judged.
    await admin.invoke('ticket0/assign', { conversationId: id, assignee: stays });
    expect((await kit.read(d, id)).assignee).toBe(stays);
    await admin.invoke('ticket0/assign', { conversationId: id, assignee: null });
    expect((await kit.read(d, id)).assignee).toBeNull();
  });
});

describe('a follow is a read on the customer’s thread, so it is not put on somebody who has left', () => {
  const canRead = async (d: Desk, who: PrincipalId, conversationId: string) =>
    (await kit.as(d, who))
      .invoke('ticket0/get-conversation', { conversationId })
      .then(() => true, () => false);

  it('refuses to follow an off-boarded colleague onto a conversation, and takes them again once reinstated', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const guest = await kit.guest(d);
    const admin = await kit.as(d, d.admin);
    const id = await kit.mail(d);
    expect(await canRead(d, guest, id)).toBe(false);

    await setOff(d, guest, true);
    await expect(admin.invoke('ticket0/follow-conversation', { conversationId: id, follower: guest })).rejects.toThrow(
      /not on this desk any more/,
    );
    // Nothing was granted: the refusal is before the write, so they still cannot read it.
    expect(await canRead(d, guest, id)).toBe(false);

    await setOff(d, guest, false);
    await admin.invoke('ticket0/follow-conversation', { conversationId: id, follower: guest });
    expect(await canRead(d, guest, id)).toBe(true);
  });

  it('unfollowing still works for somebody who has left — the way out is not closed', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const guest = await kit.guest(d);
    const admin = await kit.as(d, d.admin);
    const id = await kit.mail(d);
    await admin.invoke('ticket0/follow-conversation', { conversationId: id, follower: guest });
    expect(await canRead(d, guest, id)).toBe(true);
    await setOff(d, guest, true);
    // Their existing follow survives being taken off the desk — the module keeps no list
    // of follows to withdraw — and an admin can still remove it by hand.
    expect(await canRead(d, guest, id)).toBe(true);
    await admin.invoke('ticket0/unfollow-conversation', { conversationId: id, follower: guest });
    expect(await canRead(d, guest, id)).toBe(false);
  });
});

describe('the broadcast leaves them out, and a conversation they hold is the desk’s to hear about', () => {
  let desk: Desk;
  let stays: PrincipalId;
  let leaver: PrincipalId;
  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 2 });
    [stays, leaver] = desk.agents as [PrincipalId, PrincipalId];
    await kit.configure(desk, { noReplyNotify: { afterHours: 1 } });
  });

  it('tells everybody on the desk about an unheld conversation, and nobody who left', async () => {
    await setOff(desk, leaver, true);
    const id = await kit.mail(desk);
    kit.clock.advance(HOUR);
    expect(await sweepNotify(desk)).toBe(1);
    expect(await escalations(desk, stays, id)).toBe(1);
    expect(await escalations(desk, leaver, id)).toBe(0);
  });

  it('a request for a person from the widget reaches the same people', async () => {
    const chatting = await kit.chat(desk);
    await (await kit.as(desk, desk.widget)).invoke('ticket0/request-human', {
      sessionId: chatting.sessionId,
      token: chatting.token,
    });
    expect(await escalations(desk, stays, chatting.conversationId)).toBe(1);
    expect(await escalations(desk, leaver, chatting.conversationId)).toBe(0);
  });

  it('a conversation held by somebody who has left is told to the desk, not to the empty chair', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    const [a, gone] = d.agents as [PrincipalId, PrincipalId];
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const id = await kit.mail(d);
    await (await kit.as(d, d.admin)).invoke('ticket0/assign', { conversationId: id, assignee: gone });
    await setOff(d, gone, true);
    // Assigned to them, and they have left: nothing has moved it.
    expect((await kit.read(d, id)).assignee).toBe(gone);
    kit.clock.advance(HOUR);
    expect(await sweepNotify(d)).toBe(1);
    expect(await escalations(d, a, id)).toBe(1);
    expect(await escalations(d, gone, id)).toBe(0);
  });

  it('a conversation held by somebody who is still here is told to them alone — the other case along', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    const [a, b] = d.agents as [PrincipalId, PrincipalId];
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const id = await kit.mail(d);
    await (await kit.as(d, d.admin)).invoke('ticket0/assign', { conversationId: id, assignee: a });
    kit.clock.advance(HOUR);
    expect(await sweepNotify(d)).toBe(1);
    expect(await escalations(d, a, id)).toBe(1);
    expect(await escalations(d, b, id)).toBe(0);
  });

  it('reinstated, they are told again', async () => {
    await setOff(desk, leaver, false);
    const id = await kit.mail(desk);
    kit.clock.advance(HOUR);
    await sweepNotify(desk);
    expect(await escalations(desk, leaver, id)).toBe(1);
    expect(await escalations(desk, stays, id)).toBe(1);
  });
});

describe('a notice for the holder goes to the desk when the holder has left — replied, mentioned, woke', () => {
  let d: Desk;
  let stays: PrincipalId;
  let gone: PrincipalId;
  let id: string;
  const has = (who: PrincipalId, kind: string) =>
    kit.notifications(d, who).then((ns) => ns.filter((n) => n.kind === kind && n.conversation_id === id).length);

  beforeAll(async () => {
    d = await kit.freshDesk({ agents: 2 });
    [stays, gone] = d.agents as [PrincipalId, PrincipalId];
    id = await kit.mail(d);
    await (await kit.as(d, d.admin)).invoke('ticket0/assign', { conversationId: id, assignee: gone });
  });

  it('while the holder is on the desk they alone are told — replied and mentioned', async () => {
    await kit.mail(d, { into: id, body: 'Any news?' });
    await (await kit.as(d, d.admin)).invoke('ticket0/post-note', { conversationId: id, body: 'Checking.' });
    expect(await has(gone, 'replied')).toBe(1);
    expect(await has(gone, 'mentioned')).toBe(1);
    expect(await has(stays, 'replied')).toBe(0);
    expect(await has(stays, 'mentioned')).toBe(0);
  });

  it('once they have left, the same events reach the desk and not them', async () => {
    await setOff(d, gone, true);
    await kit.mail(d, { into: id, body: 'Hello again?' });
    await (await kit.as(d, d.admin)).invoke('ticket0/post-note', { conversationId: id, body: 'Still on it.' });
    expect(await has(stays, 'replied')).toBe(1);
    expect(await has(stays, 'mentioned')).toBe(1);
    // Nothing new for them: what they were told before they left is all they have.
    expect(await has(gone, 'replied')).toBe(1);
    expect(await has(gone, 'mentioned')).toBe(1);
  });

  it('a snooze that lapses on a departed holder’s conversation wakes to the desk', async () => {
    const parked = await kit.mail(d);
    await (await kit.as(d, d.admin)).invoke('ticket0/assign', { conversationId: parked, assignee: stays });
    await kit.park(d, parked, HOUR);
    // Held by somebody who has since left: put it on them through the row, because the
    // door (`assign`) now refuses them.
    kit.sql(d, (db) => db.prepare('UPDATE ticket0_conversations SET assignee = ? WHERE id = ?').run(gone, parked));
    kit.clock.advance(2 * HOUR);
    expect(await kit.sweep(d, 'ticket0/wake-snoozed', 'woke')).toBeGreaterThanOrEqual(1);
    const wokeFor = async (who: PrincipalId) =>
      (await kit.notifications(d, who)).filter((n) => n.kind === 'snooze-woke' && n.conversation_id === parked).length;
    expect(await wokeFor(stays)).toBe(1);
    expect(await wokeFor(gone)).toBe(0);
  });
});

describe('the one predicate: the same person is judged the same way at every door', () => {
  it('the assistant and an off-boarded agent are out of all three; an agent on the desk is in all three', async () => {
    const d = await kit.freshDesk({ agents: 2 });
    const [on, off] = d.agents as [PrincipalId, PrincipalId];
    await kit.configure(d, { roundRobin: true, noReplyNotify: { afterHours: 1 } });
    await setOff(d, off, true);
    const admin = await kit.as(d, d.admin);

    const assistant = (await directory(d)).find((p) => p.principal !== on && p.principal !== off)!.principal;

    // Door one: the ring. Door two: `assign`. Door three: the broadcast.
    for (let i = 0; i < 4; i++) await kit.mail(d);
    await sweepRing(d);
    const held = kit.sql(d, (db) =>
      db.prepare('SELECT DISTINCT assignee FROM ticket0_conversations').all(),
    ) as { assignee: string | null }[];
    expect(held.map((r) => r.assignee)).toEqual([on]);

    const probe = await kit.mail(d);
    for (const [who, accepted] of [
      [on, true],
      [off, false],
      [assistant, false],
    ] as const) {
      const attempt = admin.invoke('ticket0/assign', { conversationId: probe, assignee: who });
      if (accepted) await expect(attempt).resolves.toBeDefined();
      else await expect(attempt).rejects.toThrow();
    }
    await admin.invoke('ticket0/assign', { conversationId: probe, assignee: null });

    const broadcast = await kit.mail(d);
    kit.clock.advance(HOUR);
    await sweepNotify(d);
    expect(await escalations(d, on, broadcast)).toBe(1);
    expect(await escalations(d, off, broadcast)).toBe(0);
    // The assistant reads no notifications: the count of people told is the check.
    const told = kit.events(d, 'ticket0.no-reply-notified', broadcast).map((e) => JSON.parse(e.payload).told);
    expect(told).toEqual([1]);
  });
});

describe('only an admin decides, and nobody reinstates themselves', () => {
  let desk: Desk;
  let leaver: PrincipalId;
  let colleague: PrincipalId;
  beforeAll(async () => {
    desk = await kit.freshDesk({ agents: 2 });
    [leaver, colleague] = desk.agents as [PrincipalId, PrincipalId];
    await setOff(desk, leaver, true);
  });

  it('the agent who was taken off cannot put themselves back', async () => {
    const me = await kit.as(desk, leaver);
    await expect(me.invoke('ticket0/set-agent-offboarded', { principal: leaver, offboarded: false })).rejects.toThrow(
      /denied/i,
    );
    expect((await directory(desk)).find((p) => p.principal === leaver)!.offboarded_at).not.toBeNull();
  });

  it('nor through their own profile: saving it never writes the column, whatever the call carries', async () => {
    const me = await kit.as(desk, leaver);
    const saved = (await me.invoke('ticket0/set-agent-profile', {
      displayName: 'Agent Renamed',
      avatarUrl: null,
      signature: null,
      // Not in the input schema. If it were read it would clear the column.
      offboarded_at: null,
    } as never)) as { offboarded_at: string | null; display_name: string };
    expect(saved.display_name).toBe('Agent Renamed');
    expect(saved.offboarded_at).not.toBeNull();
    expect((await directory(desk)).find((p) => p.principal === leaver)!.offboarded_at).not.toBeNull();
  });

  it('a colleague without desk:configure cannot take anybody off, or put them back', async () => {
    const peer = await kit.as(desk, colleague);
    await expect(peer.invoke('ticket0/set-agent-offboarded', { principal: leaver, offboarded: false })).rejects.toThrow(
      /denied/i,
    );
    await expect(peer.invoke('ticket0/set-agent-offboarded', { principal: colleague, offboarded: true })).rejects.toThrow(
      /denied/i,
    );
    expect((await directory(desk)).find((p) => p.principal === colleague)!.offboarded_at).toBeNull();
  });

  it('refuses somebody who is not on the desk at all, and the assistant, which never was', async () => {
    const admin = await kit.as(desk, desk.admin);
    await expect(
      admin.invoke('ticket0/set-agent-offboarded', { principal: 'not-a-person', offboarded: true }),
    ).rejects.toThrow(/not a member of this desk/);
    const assistant = kit.sql(desk, (db) =>
      db.prepare(`SELECT principal FROM ticket0_agent_profiles WHERE display_name = 'Assistant'`).get(),
    ) as { principal: string };
    await expect(
      admin.invoke('ticket0/set-agent-offboarded', { principal: assistant.principal, offboarded: true }),
    ).rejects.toThrow(/not on the desk as staff/);
  });
});

describe('idempotent, and the trail carries the principal and the instant only', () => {
  it('taking somebody off twice keeps the first instant; reinstating one who is on changes nothing', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const [p] = d.agents as [PrincipalId];
    const first = await setOff(d, p, true);
    kit.clock.advance(HOUR);
    const second = await setOff(d, p, true);
    expect(second.offboarded_at).toBe(first.offboarded_at);
    expect(kit.events(d, 'ticket0.agent-offboarding-set')).toHaveLength(1);

    await setOff(d, p, false);
    await setOff(d, p, false);
    expect(kit.events(d, 'ticket0.agent-offboarding-set')).toHaveLength(2);
  });

  it('carries no name, avatar or signature — an erasure cannot reach an event', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const [p] = d.agents as [PrincipalId];
    await (await kit.as(d, p)).invoke('ticket0/set-agent-profile', {
      displayName: 'Distinctive Person',
      avatarUrl: 'https://avatars.example/distinctive.png',
      signature: 'Distinctive Person, Head of Things',
    });
    await setOff(d, p, true);
    const [event] = kit.events(d, 'ticket0.agent-offboarding-set', p);
    expect(JSON.parse(event!.payload)).toEqual({ principal: p, offboarded_at: kit.clock.read() });
    expect(event!.payload).not.toMatch(/Distinctive|avatars/);
    expect(JSON.parse(event!.actor)).toBe(d.admin);
  });

  it('a profile that predates the column reads as on the desk', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    expect((await directory(d)).every((p) => p.offboarded_at === null)).toBe(true);
  });
});
