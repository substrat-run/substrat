/** The same ticket0 erasure story, against a real scope on either adapter. */
import { expect } from 'vitest';
import {
  dataSubjectId,
  platformActorId,
  scopeId,
  tenantId,
  type ScopeId,
  type SubjectShredReceipt,
  type TenantId,
} from '@substrat-run/contracts';
import { searchIndexPlans, ulid, type ScopeHost } from '@substrat-run/kernel';
import { ticket0Manifest } from '../src/manifest.js';

type Value = string | number | null;
type Row = Record<string, unknown>;
export type ErasureSql = (tenant: TenantId, scope: ScopeId, sql: string, params?: readonly Value[]) => Promise<Row[]>;

const at = '2026-01-01T00:00:00.000Z';

/** The setup writes through the adapter's real scope SQLite, not a mocked module context. */
export async function checkTicket0SubjectErasure(host: ScopeHost, raw: ErasureSql): Promise<void> {
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  const customer = dataSubjectId.parse(ulid());
  const otherCustomer = dataSubjectId.parse(ulid());
  const agent = dataSubjectId.parse(ulid());
  const otherAgent = dataSubjectId.parse(ulid());
  const customerConversation = ulid();
  const otherConversation = ulid();
  const customerWord = `customer${ulid().toLowerCase()}`;
  const agentWord = `agent${ulid().toLowerCase()}`;
  const otherWord = `other${ulid().toLowerCase()}`;
  const sql = (query: string, params: readonly Value[] = []) => raw(tenant, scope, query, params);
  const one = async (query: string, params: readonly Value[] = []) => (await sql(query, params))[0];
  const rowsFor = (receipt: SubjectShredReceipt, entityType: string) =>
    receipt.verticalRows.find((r) => r.module === ticket0Manifest.id && r.entityType === entityType)?.rows;

  await host.admin.createTenant(actor, { id: tenant, slug: `erasure-${tenant.toLowerCase()}`, name: 'Erasure' });
  await host.admin.grantEntitlement(actor, tenant, 'ticket0');
  await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
  await host.admin.activateScope(actor, tenant, scope);

  for (const [id, email, name] of [
    [customer, 'first@example.test', 'First'],
    [otherCustomer, 'second@example.test', 'Second'],
  ]) {
    await sql('INSERT INTO ticket0_contacts (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', [id!, email!, name!, at]);
  }
  for (const [id, name] of [[agent, 'Agent One'], [otherAgent, 'Agent Two']]) {
    await sql('INSERT INTO ticket0_agent_profiles (principal, display_name, signature, created_at) VALUES (?, ?, ?, ?)', [id!, name!, `${name} signature`, at]);
  }
  for (const [id, contact] of [[customerConversation, customer], [otherConversation, otherCustomer]]) {
    await sql(`INSERT INTO ticket0_conversations
      (id, contact_id, channel, subject, state, priority, created_at, updated_at)
      VALUES (?, ?, 'widget', 'A question', 'open', 'normal', ?, ?)`, [id!, contact!, at, at]);
  }
  const messages = [
    ['customer', customerConversation, 'contact', customer, null, customerWord],
    ['legacy', customerConversation, 'contact', null, null, `${customerWord} legacy`],
    // A second contact wrote into the SAME conversation. Erasing its owner must leave this row.
    ['other-contact', customerConversation, 'contact', otherCustomer, null, otherWord],
    ['agent', customerConversation, 'agent', null, agent, agentWord],
    ['other-agent', customerConversation, 'agent', null, otherAgent, otherWord],
    ['other-conversation', otherConversation, 'contact', otherCustomer, null, otherWord],
  ] as const;
  for (const [id, conversation, kind, contact, principal, body] of messages) {
    await sql(`INSERT INTO ticket0_messages
      (id, conversation_id, author_kind, author_contact_id, author_principal, visibility, body_text, created_at)
      VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`, [id, conversation, kind, contact, principal, body, at]);
  }
  for (const [conversation, comment] of [[customerConversation, 'first rating'], [otherConversation, 'second rating']]) {
    await sql('INSERT INTO ticket0_csat (conversation_id, score, comment, submitted_at) VALUES (?, 5, ?, ?)', [conversation!, comment!, at]);
  }
  for (const [id, conversation, error] of [['first-turn', customerConversation, 'first error'], ['second-turn', otherConversation, 'second error']]) {
    await sql(`INSERT INTO ticket0_ai_turns
      (id, conversation_id, model, input_tokens, output_tokens, cited_article_ids, outcome, error, created_at)
      VALUES (?, ?, 'test', 0, 0, '[]', 'failed', ?, ?)`, [id!, conversation!, error!, at]);
  }
  for (const [id, owner, title] of [['first-reply', agent, 'First reply'], ['second-reply', otherAgent, 'Second reply'], ['shared-reply', '', 'Shared reply']]) {
    await sql(`INSERT INTO ticket0_saved_replies
      (id, title, body, created_by, created_at, owner)
      VALUES (?, ?, 'Body', ?, ?, ?)`, [id!, title!, agent, at, owner!]);
  }

  const index = searchIndexPlans(ticket0Manifest.id, ticket0Manifest.searchables)
    .find((plan) => plan.entityType === 'message')?.indexTable;
  expect(index).toBeDefined();
  const matches = async (word: string) => Number((await one(
    `SELECT count(*) AS n FROM ${index} WHERE ${index} MATCH ?`, [word],
  ))?.n);
  expect(await matches(customerWord)).toBeGreaterThan(0);
  expect(await matches(agentWord)).toBeGreaterThan(0);
  expect(await matches(otherWord)).toBeGreaterThan(0);

  const customerReceipt = await host.admin.shredSubject(actor, tenant, scope, customer);
  expect(await one('SELECT email, display_name FROM ticket0_contacts WHERE id = ?', [customer]))
    .toEqual({ email: null, display_name: null });
  expect(await one('SELECT email FROM ticket0_contacts WHERE id = ?', [otherCustomer]))
    .toEqual({ email: 'second@example.test' });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['customer']))
    .toEqual({ body_text: '' });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['legacy']))
    .toEqual({ body_text: '' });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['other-contact']))
    .toEqual({ body_text: otherWord });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['agent']))
    .toEqual({ body_text: agentWord });
  expect(await one('SELECT comment FROM ticket0_csat WHERE conversation_id = ?', [customerConversation]))
    .toEqual({ comment: null });
  expect(await one('SELECT comment FROM ticket0_csat WHERE conversation_id = ?', [otherConversation]))
    .toEqual({ comment: 'second rating' });
  expect(await one('SELECT error FROM ticket0_ai_turns WHERE id = ?', ['first-turn']))
    .toEqual({ error: null });
  expect(await one('SELECT error FROM ticket0_ai_turns WHERE id = ?', ['second-turn']))
    .toEqual({ error: 'second error' });
  expect(await matches(customerWord)).toBe(0);
  expect(await matches(otherWord)).toBeGreaterThan(0);
  expect(rowsFor(customerReceipt, 'contact')).toBe(1);
  expect(rowsFor(customerReceipt, 'message')).toBe(1);
  expect(customerReceipt.hookRows).toContainEqual({ module: ticket0Manifest.id, rows: 3 });

  const agentReceipt = await host.admin.shredSubject(actor, tenant, scope, agent);
  expect(await one('SELECT display_name, signature FROM ticket0_agent_profiles WHERE principal = ?', [agent]))
    .toEqual({ display_name: '', signature: null });
  expect(await one('SELECT display_name FROM ticket0_agent_profiles WHERE principal = ?', [otherAgent]))
    .toEqual({ display_name: 'Agent Two' });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['agent']))
    .toEqual({ body_text: '' });
  expect(await one('SELECT body_text FROM ticket0_messages WHERE id = ?', ['other-agent']))
    .toEqual({ body_text: otherWord });
  expect(await sql('SELECT id FROM ticket0_saved_replies WHERE id = ?', ['first-reply'])).toEqual([]);
  expect(await sql('SELECT id FROM ticket0_saved_replies WHERE id = ?', ['second-reply'])).toHaveLength(1);
  expect(await sql('SELECT id FROM ticket0_saved_replies WHERE id = ?', ['shared-reply'])).toHaveLength(1);
  expect(await matches(agentWord)).toBe(0);
  expect(await matches(otherWord)).toBeGreaterThan(0);
  expect(rowsFor(agentReceipt, 'agentProfile')).toBe(1);
  expect(rowsFor(agentReceipt, 'message')).toBe(1);
  expect(rowsFor(agentReceipt, 'savedReply')).toBe(1);
  expect(agentReceipt.hookRows).toContainEqual({ module: ticket0Manifest.id, rows: 0 });
}
