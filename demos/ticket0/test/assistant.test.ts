/**
 * The assistant and the ingester — the two connector-shaped jobs.
 *
 * Both run outside the scope's transaction and re-enter through ordinary operations,
 * so both are testable against a real host with a fake model and a fake fetch. No
 * network, no credentials, no waiting.
 *
 * The assertion that matters is the last one in the file: the same function, the same
 * model, the same question, and one desk sends while the other does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { answerConversation, searchQueriesOf, type Model } from '../harness/assistant.js';
import { Hono } from 'hono';
import { fetchArticles, parseLlmsFull, parseLlmsIndex, runIngest } from '../harness/kb-ingest.js';
import { mountKbRefresh, readSource } from '../harness/kb-refresh.js';
import { mountApi } from '../src/routes.js';
import { buildHost, seed, signIdentity, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const at = (desk: Desk, role: 'admin' | 'agent' | 'assistant' | 'widget'): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

/** A model that answers predictably, so the test is about the plumbing. */
const fakeModel = (text = 'Append a new migration; a shipped one is never edited.'): Model => ({
  label: 'test/fake',
  async answer() {
    return { text, inputTokens: 900, outputTokens: 120, confidence: 0.8 };
  },
});

const asTarget = (stub: ScopeStub) => ({
  invoke: <T>(op: string, input: unknown) => stub.invoke(op, input) as Promise<T>,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-assistant-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('parsing a documentation corpus', () => {
  const CORPUS = [
    '# Substrat — complete documentation',
    '',
    '> The hard parts, hosted.',
    '',
    '---',
    '',
    '# Migrations',
    '',
    'Source: https://substrat.net/concepts/migrations.md',
    '',
    'Migrations are an append-only ordered list, journaled per module and applied',
    'lazily per scope, which is what makes a live deploy survivable.',
    '',
    '## Editing a shipped migration',
    '',
    'Never. Its old text has already run against every scope that applied it, so the',
    'only correct change is to append another migration after it.',
    '',
    '## Stub',
    '',
    'Too short.',
  ].join('\n');

  it('splits documents on their own headings and keeps the source URL', () => {
    const articles = parseLlmsFull(CORPUS);
    expect(articles.length).toBeGreaterThan(0);
    expect(articles.every((a) => a.url.startsWith('https://substrat.net/'))).toBe(true);
  });

  it('splits again at sections, and anchors the citation where the answer is', () => {
    const articles = parseLlmsFull(CORPUS);
    const section = articles.find((a) => a.title.includes('Editing a shipped migration'));
    expect(section).toBeDefined();
    // Two things at once. The anchor, because citing the page would make a reader hunt
    // for the answer — and the WEB url, because the corpus names the `.md` twin it was
    // built from and a citation is for a human to open, not a machine to parse.
    expect(section!.url).toBe(
      'https://substrat.net/concepts/migrations#editing-a-shipped-migration',
    );
    expect(section!.url).not.toContain('.md');
    expect(section!.headingPath).toBe('Migrations > Editing a shipped migration');
  });

  it('drops stub sections, which are noise in an index', () => {
    expect(parseLlmsFull(CORPUS).some((a) => a.title.endsWith('Stub'))).toBe(false);
  });

  it('reads the link-index shape too, and tells the two apart by shape', () => {
    const index = [
      '# Substrat',
      '',
      '## Guides',
      '- [Deploying](https://substrat.net/guide/deploying): How a vertical reaches a hostname, in place, with data carried forward.',
      '- [Short](https://substrat.net/x): too brief',
    ].join('\n');
    // No `Source:` lines, so the corpus parser finds nothing and the index one does.
    expect(parseLlmsFull(index)).toHaveLength(0);
    const parsed = parseLlmsIndex(index);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toBe('Deploying');
  });

  it('refuses a document it cannot parse rather than ingesting nothing quietly', async () => {
    const fakeFetch = (async () =>
      new Response('just some prose with no structure at all')) as unknown as typeof fetch;
    await expect(
      fetchArticles('llms-txt', 'https://example.test/llms.txt', fakeFetch),
    ).rejects.toThrow(/not an llms.txt index or corpus/i);
  });

  it('a failed fetch surfaces the status rather than an empty knowledge base', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(
      fetchArticles('llms-txt', 'https://example.test/llms.txt', fakeFetch),
    ).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------

describe('ingesting into a desk', () => {
  const CORPUS = [
    '# Rotating an API key',
    '',
    'Source: https://docs.kestrel.example/api-keys.md',
    '',
    'Rotating a key issues a new secret and keeps the old one valid for twenty-four',
    'hours, so a deploy can pick up the new value without any downtime at all.',
  ].join('\n');

  const fakeFetch = (async () => new Response(CORPUS)) as unknown as typeof fetch;

  it('records the articles and the assistant can find them', async () => {
    const admin = await at(world.kestrel, 'admin');
    const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<{
      id: string;
      kind: 'llms-txt';
      url: string;
    }>;
    const source = sources.entries[0]!;
    const result = await runIngest(asTarget(admin), source, fakeFetch);
    // UPDATED, not added: the corpus cites `api-keys.md` and the desk was seeded with
    // `api-keys`, which are the same page. Before the `.md` was normalised away they
    // were two rows, and the knowledge base held the same article twice.
    expect(result).toEqual({ added: 0, updated: 1, unchanged: 0 });

    const assistant = await at(world.kestrel, 'assistant');
    const found = (await assistant.invoke('ticket0/search-kb', {
      q: searchQueriesOf('How do I rotate an API key?')[0],
    })) as { results: { title: string }[] };
    expect(found.results.map((r) => r.title)).toContain('Rotating an API key');
  });

  it('re-ingesting unchanged content writes nothing', async () => {
    const admin = await at(world.kestrel, 'admin');
    const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<{
      id: string;
      kind: 'llms-txt';
      url: string;
    }>;
    // The whole reason the content hash exists: a nightly re-read of an unchanged docs
    // site must leave the audit trail worth reading.
    const again = await runIngest(asTarget(admin), sources.entries[0]!, fakeFetch);
    expect(again).toEqual({ added: 0, updated: 0, unchanged: 1 });
  });

  type SourceRow = { id: string; status: string; last_error: string | null; last_ingested_at: string | null };
  const sourceRow = async (admin: ScopeStub, id: string): Promise<SourceRow> => {
    const page = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<SourceRow>;
    const row = page.entries.find((s) => s.id === id);
    if (!row) throw new Error(`source ${id} vanished`);
    return row;
  };
  const broken = (async () =>
    new Response('gone', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

  it('a read that fails is recorded on the source, keeping the last good read', async () => {
    const admin = await at(world.kestrel, 'admin');
    const source = ((await admin.invoke('ticket0/list-kb-sources', {})) as Page<SourceRow>).entries[0]!;
    // A good read of our own first, so the case does not lean on the test above for
    // the timestamp it is about to assert on.
    await readSource(asTarget(admin), source.id, fakeFetch);
    const good = await sourceRow(admin, source.id);
    expect(good.last_ingested_at).not.toBeNull();

    // Before `record-kb-ingest-failure`, this left the row at `ingesting` for good —
    // the throw was the only trace, and it went to the dev server's stdout.
    await expect(readSource(asTarget(admin), source.id, broken)).rejects.toThrow(/404/);
    const failed = await sourceRow(admin, source.id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toMatch(/404 Not Found fetching/);
    // The good read is still the last good read, to the millisecond: the assistant is
    // answering from that copy, and the desk should say when it is from.
    expect(failed.last_ingested_at).toBe(good.last_ingested_at);

    const again = await readSource(asTarget(admin), source.id, fakeFetch);
    expect(again).toEqual({ added: 0, updated: 0, unchanged: 1 });
    const cleared = await sourceRow(admin, source.id);
    expect(cleared.status).toBe('idle');
    expect(cleared.last_error).toBeNull();
  });

  it('the refresh route answers 502 with the reason, and the row agrees', async () => {
    const admin = await at(world.kestrel, 'admin');
    const source = ((await admin.invoke('ticket0/list-kb-sources', {})) as Page<SourceRow>).entries[0]!;
    const app = new Hono();
    mountApi(app, async () => admin);
    mountKbRefresh(app, async () => admin, broken);

    const res = await app.request(`/api/kb/sources/${source.id}/refresh`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/404 Not Found fetching/);
    expect((await sourceRow(admin, source.id)).status).toBe('failed');

    // A source that does not exist is a 404 of THIS desk's making, not a 502 about
    // somebody's docs site — and nothing was recorded, because there is no row.
    const missing = await app.request('/api/kb/sources/no-such-source/refresh', { method: 'POST' });
    expect(missing.status).toBe(404);

    const ok = new Hono();
    mountApi(ok, async () => admin);
    mountKbRefresh(ok, async () => admin, fakeFetch);
    const good = await ok.request(`/api/kb/sources/${source.id}/refresh`, { method: 'POST' });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ added: 0, updated: 0, unchanged: 1 });
    expect((await sourceRow(admin, source.id)).status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------

describe('turning a question into a search', () => {
  it('emits no FTS syntax, because the kernel owns it', () => {
    // `ctx.search` quotes every term and appends its own prefix `*`. An `OR` written
    // here arrives as a literal term the results must all contain — a query that
    // matches nothing and reads as an empty knowledge base.
    for (const q of searchQueriesOf('How do I rotate an "API" key?')) {
      expect(q).not.toMatch(/[*"?]/);
      expect(q.split(/\s+/)).not.toContain('OR');
    }
  });

  it('cuts a word back far enough for a prefix match to reach the docs', () => {
    // The customer types "rotate"; the page says "Rotating". Prefixing alone does not
    // bridge that, so the term has to arrive already de-suffixed.
    expect(searchQueriesOf('How do I rotate an API key?')).toContain('rotat');
  });

  it('keeps the words that carry the question and drops the grammar', () => {
    const queries = searchQueriesOf('How do I run a migration against a live scope?');
    // "against" is longer than "scope" and carries none of the question, so it has to
    // be stopped or the length ranking picks it first.
    expect(queries[0]).toBe('migrat scop');
    expect(queries.join(' ')).not.toContain('against');
  });

  it('is a ladder: specific first, then each word alone', () => {
    const queries = searchQueriesOf('How do I rotate an API key?');
    expect(queries[0]!.split(' ')).toHaveLength(2);
    expect(queries.slice(1).every((q) => !q.includes(' '))).toBe(true);
  });

  it('never produces an empty query, however little the question carries', () => {
    expect(searchQueriesOf('hi!!')).toEqual(['help']);
  });
});

// ---------------------------------------------------------------------------

describe('answering a customer', () => {
  async function ask(desk: Desk, question: string, model = fakeModel()) {
    const widget = await at(desk, 'widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      identity: {
        externalId: desk.customer.email,
        signature: await signIdentity(desk.verificationSecret, desk.customer.email),
      },
    })) as { sessionId: string; token: string };
    // The question opens the conversation; the session alone opens nothing.
    const message = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: question,
    })) as { id: string; conversation_id: string };

    const assistant = await at(desk, 'assistant');
    const outcome = await answerConversation(
      asTarget(assistant),
      {
        conversationId: message.conversation_id,
        messageId: message.id,
        question,
      },
      model,
    );
    return { ...outcome, conversationId: message.conversation_id };
  }

  it('Substrat’s desk: the assistant answers, and the customer sees it', async () => {
    const r = await ask(world.substrat, 'How do I run a migration against a live scope?');
    expect(r.outcome).toBe('answered');

    const conv = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-messages', {
      conversationId: r.conversationId,
    })) as Page<{ author_kind: string; visibility: string }>;
    // Two messages from the assistant: the internal record of the turn, and the public
    // reply that went out. The turn is evidence; the reply is the answer.
    const assistantMessages = conv.entries.filter((m) => m.author_kind === 'assistant');
    expect(assistantMessages.some((m) => m.visibility === 'internal')).toBe(true);
    expect(assistantMessages.some((m) => m.visibility === 'public')).toBe(true);
  });

  /**
   * The pair. Same function, same model, same question — and the only difference in
   * the whole system is which role Kestrel's assistant account holds.
   */
  it('Kestrel’s desk: the identical call drafts instead, and nothing goes out', async () => {
    const r = await ask(world.kestrel, 'How do I rotate an API key?');
    expect(r.outcome).toBe('drafted');
    expect(r.detail).toMatch(/human in the loop/i);

    const conv = (await (await at(world.kestrel, 'agent')).invoke('ticket0/list-messages', {
      conversationId: r.conversationId,
    })) as Page<{ author_kind: string; visibility: string }>;
    const assistantMessages = conv.entries.filter((m) => m.author_kind === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
    // Not one public word.
    expect(assistantMessages.every((m) => m.visibility === 'internal')).toBe(true);
  });

  it('a model outage records a failed turn and charges nothing for it', async () => {
    const broken: Model = {
      label: 'test/broken',
      async answer() {
        throw new Error('upstream 503');
      },
    };
    const before = (await (await at(world.substrat, 'admin')).invoke(
      'ticket0/usage-summary',
      {},
    )) as { total: string };

    const r = await ask(world.substrat, 'What happens when the model is down?', broken);
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/503/);

    const after = (await (await at(world.substrat, 'admin')).invoke(
      'ticket0/usage-summary',
      {},
    )) as { total: string };
    // Nothing ran, so nothing is owed. A failed turn that still billed would be the
    // worst possible bug in a metered product.
    expect(after.total).toBe(before.total);
  });
});
