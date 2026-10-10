/**
 * #1773: the six ticket0 operations whose handler the platform now derives answer what the
 * hand-written handler they replaced answered.
 *
 * Each replaced handler was the declared check plus one read: a `get` was `SELECT *` by id with
 * `<entity> not found: <id>`, a `list` was `ctx.page` over the entity. So the oracle here is the
 * row the old body read, straight off the desk's own database: a derived read naming fewer
 * columns than the table holds, or a page projecting differently, is red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, type CountedPage, type Page } from '@substrat-run/contracts';
import { createKit, type Desk, type Kit } from './desk-kit.js';

type Row = Record<string, unknown>;

let kit: Kit;
let desk: Desk;

beforeAll(async () => {
  kit = createKit('ticket0-derived-pins-');
  desk = await kit.freshDesk({ agents: 2 });
});
afterAll(() => kit.dispose());

/** Each pinned entity's table and key, as literals: the oracle must not be read off the model it judges. */
const TABLES = {
  conversation: ['ticket0_conversations', 'id'],
  contact: ['ticket0_contacts', 'id'],
  agentProfile: ['ticket0_agent_profiles', 'principal'],
  savedReplyFolder: ['ticket0_saved_reply_folders', 'id'],
  blockRule: ['ticket0_block_rules', 'id'],
} as const;

/** What the replaced handler's `SELECT *` answered, by primary key. */
function rowsOf(entity: keyof typeof TABLES): Map<unknown, Row> {
  const [table, pk] = TABLES[entity];
  const rows = kit.sql(desk, (db) => db.prepare(`SELECT * FROM ${table}`).all() as Row[]);
  return new Map(rows.map((r) => [r[pk], r]));
}

async function pinPage(operation: string, entity: keyof typeof TABLES, input: Row = {}): Promise<Page<Row>> {
  const admin = await kit.as(desk, desk.admin);
  const page = (await admin.invoke(operation, { limit: 100, ...input })) as Page<Row>;
  const rows = rowsOf(entity);
  const pk = TABLES[entity][1];
  expect(page.entries.length).toBeGreaterThan(0);
  expect(page.entries).toStrictEqual(page.entries.map((e) => rows.get(e[pk])));
  return page;
}

describe('derived reads answer what the handlers they replaced answered (#1773)', () => {
  it('ticket0/get-conversation: the whole row, and the same not_found', async () => {
    const id = await kit.mail(desk, { subject: 'Pinned' });
    const admin = await kit.as(desk, desk.admin);
    expect(await admin.invoke('ticket0/get-conversation', { conversationId: id })).toStrictEqual(rowsOf('conversation').get(id));
    const missing = await admin.invoke('ticket0/get-conversation', { conversationId: 'nope' }).catch((e: unknown) => e);
    expect(errorCodeOf(missing)).toBe('not_found');
    expect((missing as Error).message).toContain('conversation not found: nope');
  });

  it('ticket0/get-contact: the whole row, and the same not_found', async () => {
    const id = await kit.mail(desk, { from: 'pinned@example.com' });
    const contactId = (await kit.read(desk, id)).contact_id;
    const admin = await kit.as(desk, desk.admin);
    expect(await admin.invoke('ticket0/get-contact', { contactId })).toStrictEqual(rowsOf('contact').get(contactId));
    const missing = await admin.invoke('ticket0/get-contact', { contactId: 'nope' }).catch((e: unknown) => e);
    expect(errorCodeOf(missing)).toBe('not_found');
    expect((missing as Error).message).toContain('contact not found: nope');
  });

  it('ticket0/list-contacts: the page is the rows', async () => {
    await pinPage('ticket0/list-contacts', 'contact');
  });

  it('ticket0/list-agents: the page is the rows', async () => {
    await pinPage('ticket0/list-agents', 'agentProfile');
  });

  it('ticket0/list-saved-reply-folders: the page is the rows', async () => {
    await (await kit.as(desk, desk.admin)).invoke('ticket0/create-saved-reply-folder', { name: 'Pinned' });
    await pinPage('ticket0/list-saved-reply-folders', 'savedReplyFolder');
  });

  it('ticket0/list-block-rules: the page is the rows, counted, and the kind filter still applies', async () => {
    const admin = await kit.as(desk, desk.admin);
    await admin.invoke('ticket0/add-block-rule', { kind: 'email', value: 'spam@example.com' });
    await admin.invoke('ticket0/add-block-rule', { kind: 'domain', value: 'spam.example' });
    const all = (await pinPage('ticket0/list-block-rules', 'blockRule')) as CountedPage<Row>;
    expect(all.total).toBe(2);
    const domains = (await pinPage('ticket0/list-block-rules', 'blockRule', { kind: 'domain' })) as CountedPage<Row>;
    expect(domains.entries.map((r) => r.kind)).toEqual(['domain']);
    expect(domains.total).toBe(1);
  });
});
