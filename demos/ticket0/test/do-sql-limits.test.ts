/**
 * Statements whose bound-parameter count grows with the input, driven past a Durable
 * Object's limit of 100 (#1759, found by #1741's guard).
 *
 * The node adapter now refuses on `ctx.sql` what a DO refuses, so each case below is
 * red under the old one-`?`-per-element spelling and green under one bound JSON array.
 * They are here because no other suite drives these statements at size: the guard
 * counts the parameters of the statement that ran, and is blind to a size no test asks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Page } from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { SENDER_BLOCKED } from '../src/module.js';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let desk: Desk;

type Role = 'admin' | 'agent' | 'assistant' | 'ingest' | 'relay';
const at = (role: Role): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-do-sql-limits-'));
  host = buildHost(dir);
  world = await seed(host);
  // Kestrel: the supervised desk, which no other suite's assertions depend on.
  desk = world.kestrel;
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A knowledge base of `n` articles that all match the word `zeppelin`. */
async function fill(n: number): Promise<{ sourceId: string; ids: string[] }> {
  const admin = await at('admin');
  const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<{ id: string }>;
  const sourceId = sources.entries[0]!.id;
  const ingest = await at('ingest');
  await ingest.invoke('ticket0/record-kb-articles', {
    sourceId,
    articles: Array.from({ length: n }, (_, i) => ({
      url: `https://docs.acme.example/zeppelin-${i}`,
      title: `Zeppelin ${i}`,
      headingPath: `Zeppelin > ${i}`,
      body: `Everything about the zeppelin, part ${i}.`,
    })),
  });
  // Harness read of the scope's store: the ids of every article, not the page of them
  // a search returns.
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  const rows = db
    .prepare('SELECT id FROM ticket0_kb_articles WHERE title LIKE ?')
    .all('Zeppelin %') as { id: string }[];
  db.close();
  return { sourceId, ids: rows.map((r) => r.id) };
}

async function conversation(email: string): Promise<string> {
  const relay = await at('relay');
  const m = (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: email,
    contactName: null,
    subject: 'Hello',
    bodyText: 'Is anybody there?',
    emailMessageId: `<${email}-1@mail.example>`,
  })) as { conversation_id: string };
  return m.conversation_id;
}

describe('cited articles, past a hundred distinct ones', () => {
  async function citedPage(email: string) {
    const { ids } = await fill(120);
    expect(ids).toHaveLength(120);
    // 150 distinct ids on one turn, 120 of them real: the page cites past the
    // hundred parameters a DO binds. Unknown ids are dropped, as they always were.
    const cited = [...ids, ...Array.from({ length: 30 }, (_, i) => `gone-${i}`)];
    const conversationId = await conversation(email);

    const assistant = await at('assistant');
    await assistant.invoke('ticket0/record-answer', {
      conversationId,
      turnId: `turn-${conversationId}`,
      model: 'test/fake',
      body: 'See the zeppelin pages.',
      inputTokens: 1,
      outputTokens: 1,
      citedArticleIds: cited,
      outcome: 'drafted',
    });
    const agent = await at('agent');
    await agent.invoke('ticket0/post-public-reply', {
      conversationId,
      body: 'See the zeppelin pages.',
      citedArticleIds: cited,
    });

    return { conversationId, ids, agent };
  }

  it('list-turns reads every citation of a page', async () => {
    const { conversationId, ids, agent } = await citedPage('turns@customer.example');
    const turns = (await agent.invoke('ticket0/list-turns', { conversationId })) as Page<{
      citations: { id: string }[];
    }>;
    expect(turns.entries[0]!.citations.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it('list-messages reads every citation of a page', async () => {
    const { conversationId, ids, agent } = await citedPage('messages@customer.example');
    const messages = (await agent.invoke('ticket0/list-messages', { conversationId })) as Page<{
      citations: { id: string }[];
    }>;
    const replied = messages.entries.find((m) => m.citations.length > 0);
    expect(replied?.citations.map((c) => c.id).sort()).toEqual([...ids].sort());
  });
});

describe('search-kb with a source filter over a hundred hits', () => {
  it('hydrates every hit and the filter, rank kept', async () => {
    const { sourceId } = await fill(120);
    const agent = await at('agent');
    // The index is asked for 100 hits (`overfetch`); with `sourceId` that was 101 parameters.
    const found = (await agent.invoke('ticket0/search-kb', {
      q: 'zeppelin',
      limit: 25,
      sourceId,
    })) as { results: { id: string; rank: number }[] };
    expect(found.results).toHaveLength(25);
    expect(found.results.map((r) => r.rank)).toEqual([...Array(25).keys()]);
  });
});

describe('the blocklist probe with an address the sender wrote', () => {
  // 120 labels: within the 253 characters a domain may be, and far past 100 parameters.
  const LABELS = Array.from({ length: 120 }, (_, i) => `a${i}`);
  const domain = `${LABELS.join('.')}.example`;

  it('accepts the mail', async () => {
    const relay = await at('relay');
    const m = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: `someone@${domain}`,
      contactName: null,
      subject: 'Hello',
      bodyText: 'Is anybody there?',
      emailMessageId: '<deep@mail.example>',
    })) as { id: string };
    expect(m.id).toBeTruthy();
  });

  it('still refuses it by a rule on a suffix of the chain', async () => {
    const admin = await at('admin');
    // The rule sits 100 labels up the chain from the address.
    const suffix = `${LABELS.slice(100).join('.')}.example`;
    const rule = (await admin.invoke('ticket0/add-block-rule', {
      kind: 'domain',
      value: suffix,
    })) as { id: string };
    const relay = await at('relay');
    await expect(
      relay.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: `other@${domain}`,
        contactName: null,
        subject: 'Hello',
        bodyText: 'Is anybody there?',
        emailMessageId: '<deep2@mail.example>',
      }),
    ).rejects.toThrow(SENDER_BLOCKED);
    await admin.invoke('ticket0/remove-block-rule', { ruleId: rule.id });
  });
});
