/**
 * The desk reads migration 0023 indexes (#1554), each as the statement the module sends and
 * the index its plan must name.
 *
 * Literal SQL, so a reader sees the shape without running anything, and so the workerd suite
 * can EXPLAIN the same text on a Durable Object. That is only honest if the text is what the
 * handlers send: `desk-read-indexes.test.ts` drives the operations, records the statements
 * they prepare, and fails if any shape here is not one of them. No node-only imports, for the
 * workerd suite.
 */

/** A statement and what to bind when asking for its plan. */
export interface Shape {
  readonly sql: string;
  /** Bound for EXPLAIN only: a plan does not depend on these without statistics. */
  readonly args: readonly (string | number)[];
}

export interface DeskRead extends Shape {
  /** Which handler sends it: named when a shape is missing from what the handlers sent. */
  readonly operation: string;
  /** The index the plan must name. */
  readonly index: string;
  /** Answered from the index alone. */
  readonly covering?: boolean;
  /**
   * Whether the plan also holds after `ANALYZE`. The platform never runs it, so the plan
   * without statistics is the production plan; this records which ones a desk that did run it
   * would keep, rather than leaving a reader to assume all of them.
   */
  readonly withStatistics: boolean;
}

/** The inbox's default state set, as `list-conversations` binds it. */
const OPEN = '["new","open","snoozed","resolved"]';
/** The id-free stand-ins a plan is asked about. */
const C = 'c-plan';

export const DESK_READS = {
  // list-conversations' count: every inbox load, and every filter on it (kernel-composed).
  inboxCount: {
    operation: 'ticket0/list-conversations {}',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL',
    args: [OPEN],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: true,
  },
  inboxStateCount: {
    operation: 'ticket0/list-conversations { state }',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE state = ? AND quarantine IS NULL',
    args: ['new'],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: true,
  },
  inboxChannelCount: {
    operation: 'ticket0/list-conversations { channel }',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE channel = ? AND state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL',
    args: ['email', OPEN],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: true,
  },
  inboxPriorityCount: {
    operation: 'ticket0/list-conversations { priority }',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE priority = ? AND state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL',
    args: ['urgent', OPEN],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: false,
  },
  inboxAssigneeCount: {
    operation: 'ticket0/list-conversations { assignee }',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE assignee = ? AND state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL',
    args: ['agent-1', OPEN],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: false,
  },
  suspendedCount: {
    operation: 'ticket0/list-conversations { queue: suspended }',
    sql: 'SELECT COUNT(*) AS n FROM ticket0_conversations WHERE state IN (SELECT value FROM json_each(?)) AND quarantine = ?',
    args: [OPEN, 'suspended'],
    index: 'ticket0_conversations_queue_filters',
    covering: true,
    withStatistics: true,
  },

  myNotifications: {
    operation: 'ticket0/my-notifications',
    sql: 'SELECT * FROM ticket0_notifications WHERE principal = ? ORDER BY id LIMIT ?',
    args: ['agent-1', 51],
    index: 'ticket0_notifications_by_principal',
    withStatistics: true,
  },
  myNotificationsAfter: {
    operation: 'ticket0/my-notifications { cursor }',
    sql: 'SELECT * FROM ticket0_notifications WHERE principal = ? AND id > ? ORDER BY id LIMIT ?',
    args: ['agent-1', 'n', 51],
    index: 'ticket0_notifications_by_principal',
    withStatistics: true,
  },
  retireNotifications: {
    operation: 'ticket0/suspend, ticket0/discard',
    sql: 'DELETE FROM ticket0_notifications WHERE conversation_id = ?',
    args: [C],
    index: 'ticket0_notifications_by_conversation',
    withStatistics: true,
  },
  moveNotifications: {
    operation: 'ticket0/merge',
    sql: 'UPDATE ticket0_notifications SET conversation_id = ? WHERE conversation_id = ?',
    args: ['c-survivor', C],
    index: 'ticket0_notifications_by_conversation',
    withStatistics: true,
  },

  widgetSession: {
    operation: 'ticket0/widget-session',
    sql: `SELECT id, conversation_id, contact_id, origin, started_at, last_seen_at,
                user_agent, language, browser, browser_version, os, os_version, device,
                country, region, city, timezone
           FROM ticket0_widget_sessions
          WHERE conversation_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
    args: [C],
    index: 'ticket0_widget_sessions_by_conversation',
    withStatistics: true,
  },
  sessionsToMove: {
    operation: 'ticket0/merge',
    sql: 'SELECT id FROM ticket0_widget_sessions WHERE conversation_id = ?',
    args: [C],
    index: 'ticket0_widget_sessions_by_conversation',
    covering: true,
    withStatistics: true,
  },
  moveSessions: {
    operation: 'ticket0/merge',
    sql: 'UPDATE ticket0_widget_sessions SET conversation_id = ? WHERE conversation_id = ?',
    args: ['c-survivor', C],
    index: 'ticket0_widget_sessions_by_conversation',
    withStatistics: true,
  },
  dropSessions: {
    operation: 'ticket0/discard',
    sql: 'DELETE FROM ticket0_widget_sessions WHERE conversation_id = ?',
    args: [C],
    index: 'ticket0_widget_sessions_by_conversation',
    withStatistics: true,
  },

  forgetDeliveredMessages: {
    operation: 'ticket0/discard',
    sql: 'UPDATE ticket0_mail_deliveries SET message_id = NULL WHERE conversation_id = ?',
    args: [C],
    index: 'ticket0_mail_deliveries_by_conversation',
    withStatistics: true,
  },
  moveDeliveries: {
    operation: 'ticket0/merge',
    sql: 'UPDATE ticket0_mail_deliveries SET conversation_id = ? WHERE conversation_id = ?',
    args: ['c-survivor', C],
    index: 'ticket0_mail_deliveries_by_conversation',
    withStatistics: true,
  },

  threadRepliedTo: {
    operation: 'ticket0/ingest-message { emailInReplyTo }',
    sql: 'SELECT conversation_id FROM ticket0_messages WHERE email_message_id = ?',
    args: ['<m@mail.example>'],
    index: 'ticket0_messages_by_email_message_id',
    withStatistics: true,
  },

  followers: {
    operation: 'ticket0/list-participants',
    sql: 'SELECT principal FROM ticket0_conversation_follows WHERE conversation_id = ? ORDER BY principal',
    args: [C],
    index: 'ticket0_conversation_follows_by_conversation',
    covering: true,
    withStatistics: true,
  },
  dropFollows: {
    operation: 'ticket0/discard, ticket0/merge',
    sql: 'DELETE FROM ticket0_conversation_follows WHERE conversation_id = ?',
    args: [C],
    index: 'ticket0_conversation_follows_by_conversation',
    withStatistics: true,
  },
} as const satisfies Record<string, DeskRead>;

/**
 * The pages beside those counts. 0023 adds nothing for them and must not move them: without
 * statistics each keeps walking its kernel ordering index to the end of the page.
 *
 * Ascending, because that is what reaches `ctx.page` when a caller names no order: the
 * declaration's `order: 'desc'` is applied by neither the route nor the page. Ascending, the
 * unfiltered walk passes every closed conversation before the first live one, and no index
 * shortens that, since the planner keeps the walk that needs no sort.
 */
export const INBOX_PAGES = {
  inbox: {
    sql: 'SELECT * FROM ticket0_conversations WHERE state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL ORDER BY updated_at ASC, id ASC LIMIT ?',
    args: [OPEN, 51],
  },
  channel: {
    sql: 'SELECT * FROM ticket0_conversations WHERE channel = ? AND state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL ORDER BY updated_at ASC, id ASC LIMIT ?',
    args: ['email', OPEN, 51],
  },
  assignee: {
    sql: 'SELECT * FROM ticket0_conversations WHERE assignee = ? AND state IN (SELECT value FROM json_each(?)) AND quarantine IS NULL ORDER BY updated_at ASC, id ASC LIMIT ?',
    args: ['agent-1', OPEN, 51],
  },
} as const satisfies Record<string, Shape>;

/**
 * `ticket0/list-suspended`'s first page. No new index: it is pinned to the partial index 0021
 * built for it, because unpinned the planner takes the kernel's `quarantine` index and sorts
 * the whole queue for every page.
 */
export const SUSPENDED_QUEUE = {
  sql: `SELECT c.id, c.channel, c.subject, c.contact_id, k.email AS contact_email,
          k.display_name AS contact_name, c.suspended_at, c.suspicion,
          c.created_at, c.updated_at,
          (SELECT substr(m.body_text, 1, ?) FROM ticket0_messages m
            WHERE m.conversation_id = c.id AND m.visibility = 'public'
              AND m.author_kind = 'contact'
            ORDER BY m.id LIMIT 1) AS excerpt,
          (SELECT COUNT(*) FROM ticket0_messages m WHERE m.conversation_id = c.id)
            AS messages
     FROM ticket0_conversations c INDEXED BY ticket0_conversations_suspended
     JOIN ticket0_contacts k ON k.id = c.contact_id
    WHERE c.quarantine = 'suspended' ORDER BY c.id DESC LIMIT ?`,
  args: [240, 51],
} as const satisfies Shape;

/** The indexes 0023 adds: every one is named by a read above, which is what asserts its seek. */
export const DESK_READ_INDEXES = [...new Set(Object.values(DESK_READS).map((read) => read.index))];

/** Does a plan sort rows itself, rather than reading them in an index's order? */
export const sorts = (plan: readonly string[]): boolean => plan.some((d) => d.startsWith('USE TEMP B-TREE'));

/**
 * Does `plan` (EXPLAIN QUERY PLAN's detail lines) read `read`'s table through its index, with
 * no sort of its own? The message names what it got, so a red test says which plan it was.
 */
export function planUsesIndex(read: DeskRead, plan: readonly string[]): string | null {
  // A write that touches only the index's columns plans as COVERING too; only a read that
  // claims it is held to it.
  const how = read.covering ? ['USING COVERING INDEX'] : ['USING INDEX', 'USING COVERING INDEX'];
  const seek = plan.find((d) => d.startsWith('SEARCH ') && how.some((h) => d.includes(`${h} ${read.index} (`)));
  if (!seek) return `no SEARCH ${how.join(' or ')} ${read.index} in: ${plan.join(' | ')}`;
  if (sorts(plan)) return `a sort of its own in: ${plan.join(' | ')}`;
  return null;
}
