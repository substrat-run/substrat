/**
 * What hangs under a widget session (#1853) — the edges a visitor's live feed walks.
 *
 * The widget's socket is narrowed to its own session, with `vouchedWithin`: the scope
 * walks parent edges from each changed row and nudges the socket if the walk reaches the
 * session. So the session's subtree IS the filter, and it must be exactly what
 * `widget-thread` shows the visitor — the public messages of their current conversation.
 * The hosted half, frames on a real socket, is in `test/workerd/sweeper.test.ts`; this file
 * holds the edges themselves, on the node host, through `reachesWithin` — the walk the
 * fan-out runs, and the one `ctx.check` runs.
 *
 * Two kinds of claim, and each has its twin:
 *
 * - **Nothing private reaches the session.** An internal note and an assistant draft are
 *   written on the conversation and do not reach it; a public message does.
 * - **The session reaches nothing it should not.** A message under a session reaches every
 *   parent the session has, so a session left under a conversation it moved away from
 *   would widen `ctx.check` for that conversation's followers. After a move to a
 *   follow-up, neither thread's messages reach the other's conversation.
 *
 * Since #2044 a public message hangs once under its conversation's `publicThread`, and the
 * thread hangs under the sessions on that conversation. The second block pins the
 * invariant that makes that safe — thread X under session s exactly while s is on X —
 * across every path that seats or moves a session, and the costs the node exists for.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { EntityRef } from '@substrat-run/contracts';
import { reachesWithin, type ScopeStub } from '@substrat-run/kernel';
import { createKit, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-session-edges-');
afterAll(() => kit.dispose());

const message = (id: string) => ({ entityType: 'message', entityId: id });
const session = (id: string) => ({ entityType: 'widgetSession', entityId: id });
const conversation = (id: string) => ({ entityType: 'conversation', entityId: id });
const publicThread = (id: string) => ({ entityType: 'publicThread', entityId: id });

/** The walk, over the desk's own parent edges — exactly the rows the evaluator reads. */
function reaches(desk: Desk, from: EntityRef, root: EntityRef) {
  const edges = kit.sql(desk, (db) =>
    db
      .prepare(`SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples WHERE relation = 'parent'`)
      .all() as { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
  );
  return reachesWithin(
    { parents: (object) => edges.filter((e) => e.subject === object) },
    from,
    root,
    new Date().toISOString(),
  );
}

/** The thread as the desk sees it — every message, public or not. */
async function thread(admin: ScopeStub, conversationId: string) {
  return (
    (await admin.invoke('ticket0/list-messages', { conversationId })) as {
      entries: { id: string; visibility: string; body_text: string }[];
    }
  ).entries;
}

describe('a widget session holds its conversation’s public messages, and nothing else (#1853)', () => {
  it('hangs a public message under the session — and neither an internal note nor a draft', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    const visit = await kit.chat(desk, 'Where is my order?');
    await admin.invoke('ticket0/post-note', { conversationId: visit.conversationId, body: 'internal only' });
    await admin.invoke('ticket0/post-public-reply', { conversationId: visit.conversationId, body: 'On its way.' });
    const turn = (await admin.invoke('ticket0/record-answer', {
      conversationId: visit.conversationId,
      turnId: 'edges-draft',
      model: 'offline/extractive',
      body: 'a draft nobody approved',
      inputTokens: 0,
      outputTokens: 0,
      citedArticleIds: [],
      outcome: 'drafted',
    })) as { id: string };

    const rows = await thread(admin, visit.conversationId);
    const note = rows.find((m) => m.body_text === 'internal only')!;
    const publics = rows.filter((m) => m.visibility === 'public');
    expect(publics.map((m) => m.body_text)).toEqual(expect.arrayContaining(['Where is my order?', 'On its way.']));

    expect(await reaches(desk, message(note.id), session(visit.sessionId))).toBe(false);
    expect(await reaches(desk, { entityType: 'aiTurn', entityId: turn.id }, session(visit.sessionId))).toBe(false);
    // The twin: both public messages — the visitor's own and the desk's reply — do.
    for (const m of publics) expect(await reaches(desk, message(m.id), session(visit.sessionId))).toBe(true);
    // And another visitor's session holds none of them.
    const other = await kit.chat(desk, 'Somebody else entirely');
    for (const m of publics) expect(await reaches(desk, message(m.id), session(other.sessionId))).toBe(false);
  });

  it('moves the session onto a follow-up without widening either thread to the other’s followers', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    const widget = await kit.as(desk, desk.widget);
    const visit = await kit.chat(desk, 'First question');
    await admin.invoke('ticket0/post-public-reply', { conversationId: visit.conversationId, body: 'First answer' });
    await admin.invoke('ticket0/close', { conversationId: visit.conversationId });
    // The visitor writes again on the same token: a closed thread opens a follow-up and the
    // session moves to it (`moveSession`).
    const next = (await widget.invoke('ticket0/widget-post', {
      sessionId: visit.sessionId,
      token: visit.token,
      body: 'Second question',
    })) as { id: string; conversation_id: string };
    expect(next.conversation_id).not.toBe(visit.conversationId);
    const before = (await thread(admin, visit.conversationId)).filter((m) => m.visibility === 'public');

    // One parent: the follow-up. The closed thread's edge is tombstoned, not left beside it.
    const parents = kit.sql(desk, (db) =>
      db
        .prepare(`SELECT object FROM _substrat_tuples WHERE subject = ? AND relation = 'parent' AND revoked_at IS NULL`)
        .all(`widgetSession:${visit.sessionId}`),
    );
    expect(parents).toEqual([{ object: `conversation:${next.conversation_id}` }]);

    // The follow-up's message is under the session; the closed thread's are not any more.
    expect(await reaches(desk, message(next.id), session(visit.sessionId))).toBe(true);
    for (const m of before) expect(await reaches(desk, message(m.id), session(visit.sessionId))).toBe(false);

    // The property the invariant exists for: a grant on either conversation reaches only
    // its own thread. Each message still reaches its own conversation (the twin).
    expect(await reaches(desk, message(next.id), conversation(visit.conversationId))).toBe(false);
    expect(await reaches(desk, message(next.id), conversation(next.conversation_id))).toBe(true);
    for (const m of before) {
      expect(await reaches(desk, message(m.id), conversation(next.conversation_id))).toBe(false);
      expect(await reaches(desk, message(m.id), conversation(visit.conversationId))).toBe(true);
    }
  });

  it('leaves the desk’s read of a visitor’s browser where it was after a move', async () => {
    // `widget-session` is the one staff read of a session, and it has always selected by the
    // session's CURRENT conversation in SQL: the closed thread showed no browser after a move
    // while the session was still linked to it, and shows none now that it is relinked. No
    // read reaches a session through the walk, so the relink takes nothing from anybody.
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    const visit = await kit.chat(desk, 'Before the close');
    await admin.invoke('ticket0/close', { conversationId: visit.conversationId });
    const next = (await (await kit.as(desk, desk.widget)).invoke('ticket0/widget-post', {
      sessionId: visit.sessionId,
      token: visit.token,
      body: 'After the close',
    })) as { conversation_id: string };
    const browserOn = async (conversationId: string) =>
      ((await admin.invoke('ticket0/widget-session', { conversationId })) as { session: { id: string } | null }).session;
    expect(await browserOn(visit.conversationId)).toBeNull();
    expect((await browserOn(next.conversation_id))?.id).toBe(visit.sessionId);
  });

  it('after a merge, every session on the survivor holds every public message on it', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    const widget = await kit.as(desk, desk.widget);
    const loser = await kit.chat(desk, 'Asked once');
    // The same visitor again, in a second thread: the merge rule is one contact.
    const started = (await widget.invoke('ticket0/widget-start', { origin: 'https://desk.example' })) as {
      sessionId: string;
      token: string;
    };
    // A verified visitor's opening names their contact; set it as the host's signature would.
    const contact = (await kit.read(desk, loser.conversationId)).contact_id;
    kit.sql(desk, (db) =>
      db.prepare('UPDATE ticket0_widget_openings SET contact_id = ? WHERE id = ?').run(contact, started.sessionId),
    );
    const second = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'Asked twice',
    })) as { id: string; conversation_id: string };
    await admin.invoke('ticket0/post-public-reply', { conversationId: second.conversation_id, body: 'Survivor reply' });
    await admin.invoke('ticket0/post-note', { conversationId: loser.conversationId, body: 'moved note' });
    const moved = (await thread(admin, loser.conversationId));

    await admin.invoke('ticket0/merge', { conversationId: loser.conversationId, intoConversationId: second.conversation_id });

    const merged = await thread(admin, second.conversation_id);
    const publics = merged.filter((m) => m.visibility === 'public');
    expect(publics.length).toBeGreaterThanOrEqual(3);
    // …and the moved internal note went nowhere near either session.
    const note = moved.find((m) => m.body_text === 'moved note')!;
    for (const s of [loser.sessionId, started.sessionId]) {
      for (const m of publics) expect(await reaches(desk, message(m.id), session(s))).toBe(true);
      expect(await reaches(desk, message(note.id), session(s))).toBe(false);
    }
  });

  it('widget-watch proves the token, and nothing else, before a feed opens', async () => {
    const desk = await kit.freshDesk({ agents: 0 });
    const widget = await kit.as(desk, desk.widget);
    const visit = await kit.chat(desk);
    expect(await widget.invoke('ticket0/widget-watch', { sessionId: visit.sessionId, token: visit.token })).toEqual({
      sessionId: visit.sessionId,
    });
    await expect(
      widget.invoke('ticket0/widget-watch', { sessionId: visit.sessionId, token: 'not-the-token' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    // An opening — no message yet — is watchable too: its public messages will hang under
    // the same id the moment it is bound.
    const opening = (await widget.invoke('ticket0/widget-start', { origin: 'https://desk.example' })) as {
      sessionId: string;
      token: string;
    };
    expect(await widget.invoke('ticket0/widget-watch', opening)).toEqual({ sessionId: opening.sessionId });
  });
});

/** Every live `publicThread → widgetSession` edge, as `thread>session` strings. */
function threadSeats(desk: Desk): string[] {
  return (
    kit.sql(desk, (db) =>
      db
        .prepare(
          `SELECT subject, object FROM _substrat_tuples
            WHERE relation = 'parent' AND revoked_at IS NULL
              AND subject LIKE 'publicThread:%' AND object LIKE 'widgetSession:%'`,
        )
        .all(),
    ) as { subject: string; object: string }[]
  )
    .map((e) => `${e.subject.slice('publicThread:'.length)}>${e.object.slice('widgetSession:'.length)}`)
    .sort();
}

/** What the invariant says those edges must be: each session's CURRENT conversation's thread. */
function expectedSeats(desk: Desk): string[] {
  return (
    kit.sql(desk, (db) => db.prepare('SELECT id, conversation_id FROM ticket0_widget_sessions').all()) as {
      id: string;
      conversation_id: string;
    }[]
  )
    .map((w) => `${w.conversation_id}>${w.id}`)
    .sort();
}

/** The live parents of one entity. */
function liveParents(desk: Desk, subject: string): string[] {
  return (
    kit.sql(desk, (db) =>
      db
        .prepare(`SELECT object FROM _substrat_tuples WHERE subject = ? AND relation = 'parent' AND revoked_at IS NULL`)
        .all(subject),
    ) as { object: string }[]
  )
    .map((e) => e.object)
    .sort();
}

/** How many `entity.relinked` one operation has written so far. */
function relinks(desk: Desk, operation: string): number {
  return (
    kit.sql(desk, (db) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM _substrat_outbox WHERE type = 'entity.relinked' AND operation = ?`)
        .get(operation),
    ) as { n: number }
  ).n;
}

/** A second widget thread for the same contact as `first`, so the two may be merged. */
async function sameVisitorAgain(desk: Desk, first: { conversationId: string }, body: string) {
  const widget = await kit.as(desk, desk.widget);
  const started = (await widget.invoke('ticket0/widget-start', { origin: 'https://desk.example' })) as {
    sessionId: string;
    token: string;
  };
  const contact = (await kit.read(desk, first.conversationId)).contact_id;
  kit.sql(desk, (db) =>
    db.prepare('UPDATE ticket0_widget_openings SET contact_id = ? WHERE id = ?').run(contact, started.sessionId),
  );
  const posted = (await widget.invoke('ticket0/widget-post', { ...started, body })) as { conversation_id: string };
  return { conversationId: posted.conversation_id, sessionId: started.sessionId, token: started.token };
}

/** The visitor writes into a closed thread, and is moved to its follow-up. */
async function writeAfterClose(desk: Desk, visit: { sessionId: string; token: string }, body: string) {
  const widget = await kit.as(desk, desk.widget);
  return (await widget.invoke('ticket0/widget-post', { sessionId: visit.sessionId, token: visit.token, body })) as {
    id: string;
    conversation_id: string;
  };
}

describe('one public thread per conversation, hung under the sessions on it (#2044)', () => {
  it('holds the invariant across bind, follow-up, merge, merge-then-move and discard', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    const check = () => expect(threadSeats(desk)).toEqual(expectedSeats(desk));

    // Bind: the first message seats the opening's thread under it.
    const a = await kit.chat(desk, 'Thread A');
    expect(threadSeats(desk)).toEqual([`${a.conversationId}>${a.sessionId}`]);
    check();

    // Follow-up: the closed thread comes off, the follow-up's goes on.
    await admin.invoke('ticket0/close', { conversationId: a.conversationId });
    const f = await writeAfterClose(desk, a, 'After the close');
    expect(threadSeats(desk)).toEqual([`${f.conversation_id}>${a.sessionId}`]);
    check();

    // Merge: the loser's session leaves the loser's thread for the survivor's.
    const b = await sameVisitorAgain(desk, { conversationId: f.conversation_id }, 'Thread B');
    await admin.invoke('ticket0/merge', { conversationId: f.conversation_id, intoConversationId: b.conversationId });
    expect(threadSeats(desk)).toEqual([`${b.conversationId}>${a.sessionId}`, `${b.conversationId}>${b.sessionId}`].sort());
    check();

    // Merge, then a move: only the session that moved leaves the survivor's thread.
    await admin.invoke('ticket0/close', { conversationId: b.conversationId });
    const g = await writeAfterClose(desk, a, 'After the merge and the close');
    expect(threadSeats(desk)).toEqual([`${b.conversationId}>${b.sessionId}`, `${g.conversation_id}>${a.sessionId}`].sort());
    check();

    // Discard: the session goes, and so does its hold on the thread.
    const junk = await kit.chat(desk, 'junk');
    await admin.invoke('ticket0/suspend', { conversationId: junk.conversationId });
    check();
    await admin.invoke('ticket0/discard', { conversationId: junk.conversationId });
    expect(threadSeats(desk).some((s) => s.startsWith(`${junk.conversationId}>`))).toBe(false);
    check();
  });

  it('never lets a follower of one conversation reach another’s thread through a shared session', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    // A, merged into B, then B closed and the visitor moved on to C — every path at once.
    const a = await kit.chat(desk, 'In A');
    await admin.invoke('ticket0/post-public-reply', { conversationId: a.conversationId, body: 'Reply in A' });
    const b = await sameVisitorAgain(desk, a, 'In B');
    await admin.invoke('ticket0/post-public-reply', { conversationId: b.conversationId, body: 'Reply in B' });
    await admin.invoke('ticket0/close', { conversationId: a.conversationId });
    const c = await writeAfterClose(desk, a, 'In C');
    await admin.invoke('ticket0/post-public-reply', { conversationId: c.conversation_id, body: 'Reply in C' });
    await admin.invoke('ticket0/close', { conversationId: b.conversationId });
    const d = await writeAfterClose(desk, b, 'In D');
    await admin.invoke('ticket0/merge', { conversationId: c.conversation_id, intoConversationId: d.conversation_id });

    const conversations = [a.conversationId, b.conversationId, d.conversation_id];
    for (const own of conversations) {
      const messages = (await thread(admin, own)).filter((m) => m.visibility === 'public');
      expect(messages.length).toBeGreaterThan(0);
      for (const other of conversations) {
        // A follow is a grant on the conversation; the walk from a message or its thread to
        // another conversation is the grant reaching where it must not.
        const expected = own === other;
        expect(await reaches(desk, publicThread(own), conversation(other))).toBe(expected);
        for (const m of messages) expect(await reaches(desk, message(m.id), conversation(other))).toBe(expected);
      }
    }
  });

  it('a public message holds two edges, whatever the number of sessions on its conversation', async () => {
    const desk = await kit.freshDesk({ agents: 1 });
    const admin = await kit.as(desk, desk.admin);
    let survivor: { conversationId: string } = await kit.chat(desk, 'One');
    // Three sessions on one conversation, by merging two more chats into it.
    for (const body of ['Two', 'Three']) {
      const more = await sameVisitorAgain(desk, survivor, body);
      await admin.invoke('ticket0/merge', { conversationId: survivor.conversationId, intoConversationId: more.conversationId });
      survivor = more;
    }
    expect(expectedSeats(desk).filter((s) => s.startsWith(`${survivor.conversationId}>`))).toHaveLength(3);
    const reply = (await admin.invoke('ticket0/post-public-reply', {
      conversationId: survivor.conversationId,
      body: 'Answer',
    })) as { id: string };
    for (const m of (await thread(admin, survivor.conversationId)).filter((x) => x.visibility === 'public')) {
      expect(liveParents(desk, `message:${m.id}`)).toEqual(
        [`conversation:${survivor.conversationId}`, `publicThread:${survivor.conversationId}`].sort(),
      );
    }
    // …and each of the three sessions still hears the reply.
    for (const s of expectedSeats(desk).filter((x) => x.startsWith(`${survivor.conversationId}>`))) {
      expect(await reaches(desk, message(reply.id), session(s.split('>')[1]!))).toBe(true);
    }
  });

  it('a session move writes the same two relinks for a thread of one message or of twelve', async () => {
    const moveCost = async (replies: number) => {
      const desk = await kit.freshDesk({ agents: 1 });
      const admin = await kit.as(desk, desk.admin);
      const visit = await kit.chat(desk, 'Opening line');
      for (let i = 0; i < replies; i++) {
        await admin.invoke('ticket0/post-public-reply', { conversationId: visit.conversationId, body: `Reply ${i}` });
      }
      await admin.invoke('ticket0/close', { conversationId: visit.conversationId });
      const before = relinks(desk, 'ticket0/widget-post');
      await writeAfterClose(desk, visit, 'Again');
      return relinks(desk, 'ticket0/widget-post') - before;
    };
    // The session's own edge, and the closed thread coming off the session.
    expect(await moveCost(0)).toBe(2);
    expect(await moveCost(11)).toBe(2);
  });
});
