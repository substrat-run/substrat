/** Production reads shared with the provisioned-scope query-plan regression suite. */
import { inTheInbox } from '../spec/model.js';

export const REAP_ABANDONED_SQL = `SELECT * FROM ticket0_conversations c
        WHERE c.state = 'new'
          AND c.merged_into IS NULL
          AND ${inTheInbox('c')}
          AND c.updated_at <= ?
          AND NOT EXISTS (
                SELECT 1 FROM ticket0_ai_turns t
                 WHERE t.conversation_id = c.id AND t.outcome = 'drafted'
              )
        ORDER BY c.updated_at LIMIT ?`;

export const ASSISTANT_HEALTH_COUNTS_SQL = `SELECT COUNT(*) AS turns,
              SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN outcome = 'drafted' THEN 1 ELSE 0 END) AS drafted
         FROM ticket0_ai_turns
        WHERE created_at >= ?`;

export const ASSISTANT_HEALTH_RECENT_SQL = `SELECT t.id, t.conversation_id, c.subject, t.model, t.error, t.created_at
         FROM ticket0_ai_turns t
         JOIN ticket0_conversations c ON c.id = t.conversation_id
        WHERE t.outcome = 'failed'
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`;

/**
 * Pinned to the partial desk-reply index (`INDEXED BY`, as `NO_REPLY_WAITING` is pinned to
 * its own), because the planner's unaided choice was a tie it broke the other way the
 * moment the message table grew a column (#1086): without statistics it took the kernel's
 * `(visibility, created_at, id)` list index and read every public message on the desk per
 * waiting draft. The index is migration 0015's and is on every desk this code runs on.
 */
const WAITING = `FROM ticket0_ai_turns t
         JOIN ticket0_conversations c ON c.id = t.conversation_id
        WHERE t.outcome = 'drafted'
          AND ${inTheInbox('c')}
          AND NOT EXISTS (
                SELECT 1 FROM ticket0_messages m INDEXED BY ticket0_messages_desk_reply
                 WHERE m.conversation_id = t.conversation_id
                   AND m.visibility = 'public'
                   AND m.author_kind != 'contact'
                   AND m.created_at >= t.created_at
              )`;

export const ASSISTANT_HEALTH_WAITING_TOTAL_SQL = `SELECT COUNT(*) AS n ${WAITING}`;

export const ASSISTANT_HEALTH_WAITING_SQL = `SELECT t.id, t.conversation_id, c.subject, t.model, t.created_at ${WAITING}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`;
