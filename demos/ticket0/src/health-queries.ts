/** Production reads shared with the provisioned-scope query-plan regression suite. */

export const REAP_ABANDONED_SQL = `SELECT * FROM ticket0_conversations c
        WHERE c.state = 'new'
          AND c.merged_into IS NULL
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

const WAITING = `FROM ticket0_ai_turns t
         JOIN ticket0_conversations c ON c.id = t.conversation_id
        WHERE t.outcome = 'drafted'
          AND NOT EXISTS (
                SELECT 1 FROM ticket0_messages m
                 WHERE m.conversation_id = t.conversation_id
                   AND m.visibility = 'public'
                   AND m.author_kind != 'contact'
                   AND m.created_at >= t.created_at
              )`;

export const ASSISTANT_HEALTH_WAITING_TOTAL_SQL = `SELECT COUNT(*) AS n ${WAITING}`;

export const ASSISTANT_HEALTH_WAITING_SQL = `SELECT t.id, t.conversation_id, c.subject, t.model, t.created_at ${WAITING}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`;
