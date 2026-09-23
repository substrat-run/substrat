/** #1554: measure the production reads on an upgraded, populated scope, including
 * the kernel's competing list indexes. Removing each new index must lose its seek. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { listIndexPlans, listQuery, ulid } from '@substrat-run/kernel';
import { MODULES } from '../src/provision.js';
import { ticket0Manifest } from '../src/manifest.js';
import {
  REAP_ABANDONED_SQL, ASSISTANT_HEALTH_COUNTS_SQL, ASSISTANT_HEALTH_RECENT_SQL,
  ASSISTANT_HEALTH_WAITING_SQL, ASSISTANT_HEALTH_WAITING_TOTAL_SQL,
} from '../src/health-queries.js';

type Query = { sql: string; args: (string | number)[] };
const queries = {
  reap: { sql: REAP_ABANDONED_SQL, args: ['2026-08-01T00:00:00.000Z', 200] },
  counts: { sql: ASSISTANT_HEALTH_COUNTS_SQL, args: ['2026-09-22T00:00:00.000Z'] },
  recent: { sql: ASSISTANT_HEALTH_RECENT_SQL, args: [10] },
  waiting: { sql: ASSISTANT_HEALTH_WAITING_SQL, args: [10] },
  waitingTotal: { sql: ASSISTANT_HEALTH_WAITING_TOTAL_SQL, args: [] },
} satisfies Record<string, Query>;
const old = '2026-01-01T00:00:00.000Z';
const recent = '2026-09-23T00:00:00.000Z';
let dir: string;
let db: Database.Database;
let beforeRows: unknown;
let afterRows: unknown;
let beforeResults: unknown;
let beforePlans: Record<string, string[]>;
let afterPlans: Record<string, string[]>;

function explain(query: Query): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args) as { detail: string }[])
    .map(row => row.detail);
}
function plans() { return Object.fromEntries(Object.entries(queries).map(([name, q]) => [name, explain(q)])); }
function results() { return Object.fromEntries(Object.entries(queries).map(([name, q]) => [name, db.prepare(q.sql).all(...q.args)])); }
function rows() {
  // Literal tables/columns are fixture facts, not derived from the emitted model.
  return ['ticket0_contacts', 'ticket0_conversations', 'ticket0_ai_turns', 'ticket0_messages']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}
function populate() {
  db.prepare('INSERT INTO ticket0_contacts (id, created_at) VALUES (?, ?)').run('contact', old);
  const conversation = db.prepare(`INSERT INTO ticket0_conversations
    (id, contact_id, channel, subject, state, priority, created_at, updated_at, merged_into)
    VALUES (?, 'contact', 'email', 'Fixture', ?, 'normal', ?, ?, ?)`);
  const turn = db.prepare(`INSERT INTO ticket0_ai_turns
    (id, conversation_id, model, input_tokens, output_tokens, cited_article_ids, outcome, created_at)
    VALUES (?, ?, 'fixture', 1, 1, '[]', ?, ?)`);
  const message = db.prepare(`INSERT INTO ticket0_messages
    (id, conversation_id, author_kind, visibility, body_text, created_at)
    VALUES (?, ?, ?, ?, 'Fixture', ?)`);
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const id = `c${String(i).padStart(4, '0')}`;
      const at = i < 1800 ? old : recent;
      conversation.run(id, ['new', 'open', 'snoozed', 'resolved', 'closed'][i % 5], at, at, i % 17 === 0 ? 'c0001' : null);
      for (let j = 0; j < 10; j++) {
        // Drafts with a desk reply, drafts with only contact replies, and drafts
        // with only internal desk notes: both sides of the partial predicate.
        turn.run(`t${id}-${j}`, id, j === 0 ? (i % 2 === 0 ? 'drafted' : 'failed') : 'answered', at);
        message.run(`m${id}-${j}`, id, i % 4 === 0 ? 'agent' : 'contact', 'public', at);
      }
      if (i % 4 === 2) message.run(`internal-${id}`, id, 'agent', 'internal', at);
    }
  })();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-health-indexes-'));
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  const provision = { tenantId: tenant, scopeId: scope, vertical: 'ticket0' };
  const previous = new SqliteScopeHost({ dir });
  for (const module of MODULES) previous.registerModule(module.manifest.id === ticket0Manifest.id
    ? { ...module, migrations: (module.migrations ?? []).filter(m => m.version <= '0014') }
    : module);
  try {
    await previous.admin.createTenant(actor, { id: tenant, slug: 'index-upgrade', name: 'Index upgrade' });
    await previous.admin.grantEntitlement(actor, tenant, ticket0Manifest.entitlementKey as string);
    await previous.provisionScope(actor, provision);
  } finally { await previous.close(); }
  const filename = join(dir, `${tenant}__${scope}.sqlite`);
  db = new Database(filename);
  populate();
  beforeRows = rows();
  beforeResults = results();
  beforePlans = plans();
  db.close();
  const upgraded = new SqliteScopeHost({ dir });
  for (const module of MODULES) upgraded.registerModule(module);
  try {
    await upgraded.provisionScope(actor, provision);
    // Real provisioning a second time must remain idempotent.
    await upgraded.provisionScope(actor, provision);
  } finally { await upgraded.close(); }
  db = new Database(filename);
  afterRows = rows();
  afterPlans = plans();
}, 30_000);

afterAll(() => { db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('preserves every populated pre-0015 row and every production read result across provisioning twice', () => {
  expect(afterRows).toEqual(beforeRows);
  expect(results()).toEqual(beforeResults);
  expect(db.prepare(queries.counts.sql).get(...queries.counts.args)).toEqual({ turns: 2000, failed: 100, drafted: 100 });
  expect(db.prepare(queries.waitingTotal.sql).get()).toEqual({ n: 500 });
  expect(db.prepare(queries.reap.sql).all(...queries.reap.args)).toHaveLength(169);
  expect(db.prepare(queries.recent.sql).all(...queries.recent.args)).toHaveLength(10);
  expect(db.prepare(queries.waiting.sql).all(...queries.waiting.args)).toHaveLength(10);
});

const cases: { index: string; query: keyof typeof queries; seek: RegExp }[] = [
  { index: 'ticket0_ai_turns_conversation_outcome', query: 'reap', seek: /USING COVERING INDEX ticket0_ai_turns_conversation_outcome \(conversation_id=\? AND outcome=\?\)/ },
  { index: 'ticket0_ai_turns_created_outcome', query: 'counts', seek: /USING COVERING INDEX ticket0_ai_turns_created_outcome \(created_at>\?\)/ },
  { index: 'ticket0_ai_turns_outcome_created', query: 'recent', seek: /USING INDEX ticket0_ai_turns_outcome_created \(outcome=\?\)/ },
  { index: 'ticket0_ai_turns_outcome_created', query: 'waiting', seek: /USING INDEX ticket0_ai_turns_outcome_created \(outcome=\?\)/ },
  { index: 'ticket0_ai_turns_outcome_created', query: 'waitingTotal', seek: /USING INDEX ticket0_ai_turns_outcome_created \(outcome=\?\)/ },
  { index: 'ticket0_messages_desk_reply', query: 'waiting', seek: /USING INDEX ticket0_messages_desk_reply \(conversation_id=\? AND created_at>\?\)/ },
  { index: 'ticket0_messages_desk_reply', query: 'waitingTotal', seek: /USING INDEX ticket0_messages_desk_reply \(conversation_id=\? AND created_at>\?\)/ },
];

describe.each([false, true])('planner with ANALYZE=%s', analyzed => {
  it.each(cases)('$query gains $index; dropping it defeats the positive assertion', ({ index, query, seek }) => {
    db.exec('SAVEPOINT probe');
    try {
      if (analyzed) db.exec('ANALYZE');
      const assertion = () => expect(explain(queries[query])).toContainEqual(expect.stringMatching(seek));
      assertion();
      expect(beforePlans[query]).not.toContainEqual(expect.stringMatching(seek));
      db.exec(`DROP INDEX ${index}`);
      // A mutation twin: execute the identical positive assertion after reverting
      // only this index, and prove that assertion actually rejects the old plan.
      expect(assertion).toThrow();
    } finally { db.exec('ROLLBACK TO probe; RELEASE probe'); }
  });
});

it('removes turn scans and health sorts while retaining the existing reaper conversation seek', () => {
  expect(beforePlans.counts).toContain('SCAN ticket0_ai_turns');
  expect(beforePlans.recent).toContain('USE TEMP B-TREE FOR ORDER BY');
  expect(beforePlans.waiting).toContain('USE TEMP B-TREE FOR ORDER BY');
  for (const name of Object.keys(queries)) {
    expect(afterPlans[name]?.filter(p => /^SCAN (t|ticket0_ai_turns)\b|TEMP B-TREE/.test(p))).toEqual([]);
  }
  expect(afterPlans.reap).toContainEqual(expect.stringMatching(/conversation_state_updated_at \(state=\? AND updated_at<\?\)/));
});

it('audits shipped list coverage and records the default multi-state inbox caveat', () => {
  const plan = listIndexPlans(ticket0Manifest.id, ticket0Manifest.lists).find(p => p.entityType === 'conversation')!;
  for (const sort of ['updated_at', 'created_at', 'priority']) {
    for (const [filter, value] of Object.entries({ state: 'new', assignee: 'agent', channel: 'email', priority: 'normal', contact_id: 'contact' })) {
      const q = listQuery(plan, { sort, order: 'desc', limit: 50, filters: { [filter]: value } });
      const details = explain({ sql: q.sql, args: q.params as string[] });
      expect(details).toContainEqual(expect.stringMatching(/SEARCH ticket0_conversations USING INDEX _substrat_list_/));
      expect(details.some(p => /TEMP B-TREE/.test(p))).toBe(false);
    }
  }
  const inbox = listQuery(plan, { limit: 50, order: 'desc', filters: { state: ['new', 'open', 'snoozed', 'resolved'] } });
  const q = { sql: inbox.sql, args: inbox.params as string[] };
  // IN across states cannot promise a globally sorted equality-index walk. With
  // stats this fixture uses the already-shipped updated_at walk instead. Neither
  // plan warrants another speculative list index or a general kernel change.
  expect(explain(q)).toContainEqual(expect.stringMatching(/USING INDEX _substrat_list_/));
  db.exec('SAVEPOINT statistics');
  try {
    db.exec('ANALYZE');
    expect(explain(q)).toContainEqual(expect.stringMatching(/USING INDEX _substrat_list_/));
  } finally { db.exec('ROLLBACK TO statistics; RELEASE statistics'); }
});
