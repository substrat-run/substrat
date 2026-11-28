/**
 * The delivery broker's own tables (K-74), as ordered steps. Not spine: no scope holds them, and
 * module code never reaches them. Both adapters' brokers open the same `BrokerStore` over their own
 * SQLite, so this list is the one schema both run.
 *
 * **Append only.** A broker that already ran a step never runs it again, and a step is never edited
 * once it merged: `broker_schema` records how many have run, and the store runs the rest, each in
 * its own transaction, when it opens. A new column or table is a new step at the end. A step written
 * in a branch that another merges before is renumbered by moving it to the end, exactly as a
 * decision record is.
 *
 * Step 1 is A1's tables as #3483 shipped them, `IF NOT EXISTS`, so a broker opened before the steps
 * existed (it has the tables and no `broker_schema`) runs it as a no-op and continues at step 2.
 */
import type { BrokerSql } from './delivery-broker.js';

/** One step: statements run in order, in one transaction. */
export interface BrokerSchemaStep {
  /** Who added it, for the reader: the issue it came with. */
  readonly by: string;
  readonly statements: readonly string[];
}

export const BROKER_SCHEMA: readonly BrokerSchemaStep[] = [
  {
    by: '#3467 (A1): messages and the handoff marks',
    statements: [
      `CREATE TABLE IF NOT EXISTS broker_messages (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         tenant_id TEXT NOT NULL,
         scope_id TEXT NOT NULL,
         type TEXT NOT NULL,
         body TEXT NOT NULL,
         committed_at TEXT NOT NULL,
         received_at INTEGER NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         next_at INTEGER,
         last_error TEXT,
         delivered_at INTEGER
       )`,
      'CREATE INDEX IF NOT EXISTS broker_messages_due ON broker_messages (next_at) WHERE next_at IS NOT NULL',
      `CREATE TABLE IF NOT EXISTS broker_marks (
         tenant_id TEXT NOT NULL,
         scope_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         mark TEXT NOT NULL,
         PRIMARY KEY (tenant_id, scope_id, kind)
       )`,
    ],
  },
  {
    by: '#3470 (A4): a delivery per (message, receiver), a breaker per receiver, the ordering key',
    statements: [
      // The sender's ordering key (RFC §4.5). NULL: the message is unordered at every receiver.
      'ALTER TABLE broker_messages ADD COLUMN ordering_key TEXT',
      // One row per (message, receiver) the message is for. A message with none is held: the broker
      // had no receiver when it arrived. The message row keeps the content; this keeps the fate.
      `CREATE TABLE broker_deliveries (
         message_id TEXT NOT NULL,
         receiver TEXT NOT NULL,
         -- the message's ordering key when this receiver's subscription asks for order, else NULL
         lane TEXT,
         -- 'pending' | 'delivered' | 'dead' | 'discarded' | 'expired'
         state TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         -- pending: epoch ms of the next attempt. NULL in every other state
         next_at INTEGER,
         last_error TEXT,
         -- the receiver's HTTP status on the last failure, when it gave one
         last_status INTEGER,
         -- dead: when the broker gave up on it
         dead_at INTEGER,
         -- delivered, discarded, expired: when it settled
         settled_at INTEGER,
         -- how many times a dead letter was resent
         resends INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (message_id, receiver)
       )`,
      "CREATE INDEX broker_deliveries_due ON broker_deliveries (next_at) WHERE state = 'pending'",
      // A lane's head: the lowest message id still pending or dead, per (receiver, lane).
      `CREATE INDEX broker_deliveries_lane ON broker_deliveries (receiver, lane, message_id)
         WHERE lane IS NOT NULL AND state IN ('pending', 'dead')`,
      "CREATE INDEX broker_deliveries_dead ON broker_deliveries (dead_at) WHERE state = 'dead'",
      // The pause per receiver (circuit breaker) and its slow-down (429, Retry-After).
      `CREATE TABLE broker_receivers (
         receiver TEXT PRIMARY KEY,
         -- consecutive failures that count toward the pause; a success or a refusal resets it
         failures INTEGER NOT NULL DEFAULT 0,
         -- 1 while paused: once blocked_until passes, the next send is the one probe
         open INTEGER NOT NULL DEFAULT 0,
         -- the pause now in force, which a failed probe grows
         pause_ms INTEGER,
         -- epoch ms before which nothing is sent: a pause, or a slow-down
         blocked_until INTEGER
       )`,
      // A1's single receiver becomes the subscription named 'default'; its state moves over.
      `INSERT INTO broker_deliveries (message_id, receiver, state, attempts, next_at, last_error, settled_at)
         SELECT id, 'default',
                CASE WHEN delivered_at IS NOT NULL THEN 'delivered' ELSE 'pending' END,
                attempts,
                CASE WHEN delivered_at IS NULL THEN next_at END,
                last_error,
                delivered_at
           FROM broker_messages WHERE delivered_at IS NOT NULL OR next_at IS NOT NULL`,
      'DROP INDEX broker_messages_due',
      'ALTER TABLE broker_messages DROP COLUMN attempts',
      'ALTER TABLE broker_messages DROP COLUMN next_at',
      'ALTER TABLE broker_messages DROP COLUMN last_error',
      'ALTER TABLE broker_messages DROP COLUMN delivered_at',
    ],
  },
];

/** Run the steps a broker's database has not run yet, each in one transaction. */
export function migrateBrokerStore(sql: BrokerSql): void {
  sql.run('CREATE TABLE IF NOT EXISTS broker_schema (version INTEGER NOT NULL)');
  const row = sql.all<{ version: number }>('SELECT version FROM broker_schema')[0];
  const ran = Number(row?.version ?? 0);
  if (!row) sql.run('INSERT INTO broker_schema (version) VALUES (0)');
  for (let i = ran; i < BROKER_SCHEMA.length; i++) {
    sql.transaction(() => {
      for (const statement of BROKER_SCHEMA[i]!.statements) sql.run(statement);
      sql.run('UPDATE broker_schema SET version = ?', i + 1);
    });
  }
}
