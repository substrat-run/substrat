/**
 * A desk that has been running, for the suites that measure its reads (#1554): most of its
 * history closed, a live inbox, a held queue and a few tombstones, mail with Message-IDs and
 * widget chats with sessions, notifications for several people, and follows.
 *
 * One generator for node and workerd, so the two suites measure the same desk at different
 * sizes. It writes through `run`, which is `db.prepare(sql).run(...)` on node and
 * `sql.exec(sql, ...)` on a Durable Object, so nothing here is node-only.
 *
 * The stand-in ids the read shapes bind (`c-plan`, `agent-1`, `<m@mail.example>`) are among the
 * rows, so each read's answer is a real one.
 */

export type Run = (sql: string, ...args: (string | number | null)[]) => void;

/** The tables a desk read touches, in a stable order. Fixture facts, not the model's. */
export const DESK_TABLES = [
  'ticket0_conversations',
  'ticket0_notifications',
  'ticket0_widget_sessions',
  'ticket0_mail_deliveries',
  'ticket0_messages',
  'ticket0_conversation_follows',
] as const;

/** Every tenth conversation is live; of those, the held and the discarded are counted below. */
const LIVE_EVERY = 10;
const SUSPENDED_EVERY = 97;
const DISCARDED_EVERY = 89;
const AGENTS = 4;
const CONTACTS = 1000;

export function populateDesk(run: Run, conversations: number): void {
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
  for (let i = 0; i < conversations; i++) {
    const id = i === 0 ? 'c-plan' : `c${String(i).padStart(6, '0')}`;
    const k = `k${i % CONTACTS}`;
    if (i < CONTACTS) run('INSERT INTO ticket0_contacts (id, email, created_at) VALUES (?, ?, ?)', k, `person-${i}@customer.example`, at(i));
    const live = i % LIVE_EVERY === 0;
    const state = live ? ['new', 'open', 'snoozed', 'resolved'][(i / LIVE_EVERY) % 4]! : 'closed';
    const quarantine = i % SUSPENDED_EVERY === 0 ? 'suspended' : i % DISCARDED_EVERY === 0 ? 'discarded' : null;
    const channel = i % 2 === 0 ? 'email' : 'widget';
    run(
      `INSERT INTO ticket0_conversations
         (id, contact_id, channel, subject, state, assignee, priority, created_at, updated_at, quarantine)
       VALUES (?, ?, ?, 'Fixture', ?, ?, ?, ?, ?, ?)`,
      id, k, channel, state, state === 'new' ? null : `agent-${i % AGENTS}`,
      ['low', 'normal', 'urgent'][i % 3]!, at(i), at(i + 1), quarantine,
    );
    for (let j = 0; j < 3; j++) {
      const mail = channel === 'email' && j !== 1 ? `<${id}-${j}@mail.example>` : null;
      run(
        `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, email_message_id, created_at)
         VALUES (?, ?, ?, 'public', 'A message of an ordinary length, the kind a customer writes.', ?, ?)`,
        `${id}-m${j}`, id, j === 1 ? 'agent' : 'contact', mail, at(i),
      );
      if (mail) {
        run(
          `INSERT INTO ticket0_mail_deliveries (email_message_id, conversation_id, message_id, direction, recorded_at)
           VALUES (?, ?, ?, 'inbound', ?)`,
          mail, id, `${id}-m${j}`, at(i),
        );
      }
      run(
        `INSERT INTO ticket0_notifications (id, principal, kind, conversation_id, read_at, created_at)
         VALUES (?, ?, 'replied', ?, NULL, ?)`,
        `${id}-n${j}`, `agent-${(i + j) % AGENTS}`, id, at(i),
      );
    }
    if (channel === 'widget' || id === 'c-plan') {
      run(
        `INSERT INTO ticket0_widget_sessions (id, conversation_id, contact_id, origin, token_hash, started_at, last_seen_at)
         VALUES (?, ?, ?, 'https://desk.example', ?, ?, ?)`,
        `${id}-s`, id, k, `hash-${id}`, at(i), at(i + 1),
      );
    }
    if (i % 3 === 0) run('INSERT INTO ticket0_conversation_follows (principal, conversation_id) VALUES (?, ?)', `agent-${i % AGENTS}`, id);
  }
  // The one the thread read looks up: an inbound mail the shape's Message-ID names.
  run(
    `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, email_message_id, created_at)
     VALUES ('m-plan', 'c-plan', 'contact', 'public', 'Fixture', '<m@mail.example>', ?)`,
    at(0),
  );
}
