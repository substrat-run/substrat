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
import {
  answerConversation,
  describeModel,
  errorText,
  modelFor,
  platformModel,
  recordAssistantFailure,
  searchQueriesOf,
  type Model,
  type ModelDescription,
} from '../harness/assistant.js';
import { createModelHost } from '@substrat-run/vertical-host/model';
import { MockLanguageModelV3 } from 'ai/test';
import { MODEL_USAGE_KIND, modelUsageLine } from '@substrat-run/contracts';
import { mountAssistantStatus } from '../harness/assistant-status.js';
import { ASSISTANT_ERROR_MAX } from '../spec/model.js';
import { Hono } from 'hono';
import { fetchArticles, parseLlmsFull, parseLlmsIndex, runIngest } from '../harness/kb-ingest.js';
import { mountKbRefresh, readSource } from '../harness/kb-refresh.js';
import { mountApi } from '../src/routes.js';
import { buildHost, seed, signIdentity, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const at = (
  desk: Desk,
  role: 'admin' | 'agent' | 'assistant' | 'assistantAutonomous' | 'widget',
): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

/** A model that answers predictably, so the test is about the plumbing. */
const fakeModel = (text = 'Append a new migration; a shipped one is never edited.'): Model => ({
  label: 'test/fake',
  async answer() {
    return { text, inputTokens: 900, outputTokens: 120, confidence: 0.8 };
  },
});

/** What the status route says about a fake — a description, not a model. */
const fakeDescription: ModelDescription = {
  label: 'test/fake',
  generative: true,
  spec: 'test:fake',
  configured: true,
  missing: [],
  hosting: null,
};

/**
 * The platform's model host over the AI SDK's mock — the same seam the worker wires
 * `createAnthropic` into, so what is under test is ticket0's use of the host, not a
 * provider's wire format.
 */
function platformHost(text: string, tokens: { input: number; output: number } | null) {
  const mock = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: tokens?.input, noCache: tokens?.input, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: tokens?.output, text: tokens?.output, reasoning: undefined },
      },
      warnings: [],
    } as never,
  });
  return createModelHost({
    env: { ANTHROPIC_API_KEY: 'k' },
    factories: { anthropic: () => () => mock as never },
    sent: 'Customer messages and the knowledge-base excerpts they match',
  });
}

const attributionFor = (desk: Desk) => ({
  tenant: desk.tenant,
  scope: desk.scope,
  vertical: '@substrat-run/demo-ticket0',
  version: '0.1.0',
  operation: 'ticket0/answer',
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

    /**
     * Pick the answering principal the way BOTH hosts pick it — the desk's own
     * `assistant_autonomous` setting, read as the widget service. Hard-coding the
     * supervised account here would have this test asserting something neither
     * `worker.ts` nor `server.ts` does.
     */
    const { autonomous } = (await widget.invoke('ticket0/assistant-mode', {})) as {
      autonomous: boolean;
    };
    const assistant = await at(desk, autonomous ? 'assistantAutonomous' : 'assistant');
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

    /**
     * And the ROW says so.
     *
     * The turn is written `drafted` before the send and used to stay that way forever,
     * so an answer the customer had already read still offered a "send this draft"
     * card, counted as undelivered in the deflection report, and sat in the health
     * panel's waiting list. The returned outcome was right; the stored one was not.
     */
    const turns = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-turns', {
      conversationId: r.conversationId,
    })) as Page<{ id: string; outcome: string }>;
    expect(turns.entries.find((t) => t.id === r.turnId)?.outcome).toBe('answered');
  });

  /**
   * The pair. Same function, same model, same question — and the only difference in
   * the whole system is which account the desk's setting sends the question to, and
   * which keys THAT account holds.
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

  it('through the platform’s model host: the turn carries the provider’s counts, and the platform gets its line (#1054)', async () => {
    const models = platformHost('Append a new migration; a shipped one is never edited.', { input: 1234, output: 56 });
    const model = platformModel(models, 'anthropic:claude-sonnet-5', attributionFor(world.substrat));
    expect(model.label).toBe('anthropic/claude-sonnet-5');

    const r = await ask(world.substrat, 'How do I edit a migration that already shipped?', model);
    expect(r.outcome).toBe('answered');

    // The turn names the model as the host labels it; its token counts have one door
    // (`usage:read`), so they are read below from the line the platform got.
    const admin = await at(world.substrat, 'admin');
    const listed = (await admin.invoke('ticket0/list-turns', { conversationId: r.conversationId })) as
      | { id: string; model: string }[]
      | Page<{ id: string; model: string }>;
    const turns = Array.isArray(listed) ? listed : listed.entries;
    expect(turns.find((t) => t.id === r.turnId)?.model).toBe('anthropic/claude-sonnet-5');

    // The same line, handed to the platform as an intent in the same transaction —
    // priced from the rate card on our side, attributed with the five keys.
    const intents = await host.listPlatformRequests(world.substrat.tenant, world.substrat.scope);
    const mine = intents.filter((i) => i.kind === MODEL_USAGE_KIND);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const line = modelUsageLine.parse(mine[mine.length - 1]!.payload);
    expect(line).toMatchObject({
      model: 'anthropic:claude-sonnet-5',
      reported: true,
      inputTokens: 1234,
      outputTokens: 56,
      attribution: attributionFor(world.substrat),
    });
    expect(line.listUsd).not.toBeNull();
  });

  it('a provider the platform holds nothing for falls back to the extractive model, and says so', async () => {
    const models = createModelHost({ env: {} });
    const model = modelFor({ spec: 'scaleway:llama-3.3-70b-instruct', host: models, attribution: attributionFor(world.substrat) });
    expect(model.label).toBe('offline/extractive');
    const d = describeModel(models, 'scaleway:llama-3.3-70b-instruct');
    expect(d).toMatchObject({
      generative: false,
      configured: false,
      missing: ['SCALEWAY_API_KEY'],
      spec: 'scaleway:llama-3.3-70b-instruct',
    });
    expect(d.hosting?.location).toMatch(/European Union/);
    // And the default is the platform's cheap Cloudflare row.
    expect(describeModel(models, undefined).spec).toBe('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');
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

    // And the turn says WHY, where an agent reading the conversation can see it. The
    // reason used to reach the dev server's stdout and nowhere else.
    const turns = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-turns', {
      conversationId: r.conversationId,
    })) as Page<{ id: string; outcome: string; error: string | null; model: string }>;
    const failed = turns.entries.find((t) => t.id === r.turnId);
    expect(failed?.outcome).toBe('failed');
    expect(failed?.error).toBe('upstream 503');
    expect(failed?.model).toBe('test/broken');
  });

  /** A customer message through the widget, so the assistant has something to answer. */
  async function posted(desk: Desk, body: string) {
    const widget = await at(desk, 'widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      identity: {
        externalId: desk.customer.email,
        signature: await signIdentity(desk.verificationSecret, desk.customer.email),
      },
    })) as { sessionId: string; token: string };
    // The session alone opens nothing (#951); the message is what opens the thread.
    const message = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body,
    })) as { id: string; conversation_id: string };
    return { widget, started: { ...started, conversationId: message.conversation_id }, message };
  }

  it('an index that refuses is recorded the same way, with its reason, and bills nothing', async () => {
    const { widget, started, message } = await posted(
      world.substrat,
      'How do I run a migration against a live scope?',
    );

    // The assistant can write but cannot read: retrieval throws before any model runs.
    // Before this the throw left `answerConversation` — and the host's catch — holding
    // the only copy of the reason.
    //
    // Substrat's desk is autonomous, so this is the principal it answers as — which is
    // what lets the closing assertion hold: even the failure sentence goes out publicly
    // here, where on a supervised desk it would wait with everything else.
    const assistant = await at(world.substrat, 'assistantAutonomous');
    const halfBroken = {
      invoke: <T,>(op: string, input: unknown) =>
        op === 'ticket0/search-kb'
          ? Promise.reject(new Error('fts index unavailable'))
          : (assistant.invoke(op, input) as Promise<T>),
    };
    const r = await answerConversation(
      halfBroken,
      { conversationId: started.conversationId, messageId: message.id, question: 'How do I run a migration?' },
      fakeModel(),
    );
    expect(r.outcome).toBe('failed');
    expect(r.detail).toBe('fts index unavailable');

    const turns = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-turns', {
      conversationId: started.conversationId,
    })) as Page<{ id: string; outcome: string; error: string | null }>;
    expect(turns.entries.find((t) => t.id === message.id)).toMatchObject({
      outcome: 'failed',
      error: 'fts index unavailable',
    });
    // The customer still got a sentence — a public one, from the assistant.
    const thread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: started.sessionId,
      token: started.token,
    })) as Page<{ author_kind: string; body_text: string }>;
    expect(
      thread.entries.some((m) => m.author_kind === 'assistant' && /passed it to a person/.test(m.body_text)),
    ).toBe(true);
  });

  it('when the assistant itself cannot act, the widget records that — and the customer never sees it', async () => {
    const { widget, started, message } = await posted(world.substrat, 'Is anybody there?');

    // What the host does in its catch: the assistant principal is missing, so the
    // widget — the principal that just accepted the message — writes the turn.
    await recordAssistantFailure(asTarget(widget), {
      conversationId: started.conversationId,
      messageId: message.id,
      model: 'offline/extractive',
      error: new Error('this desk has no assistant service principal'),
    });

    const agent = await at(world.substrat, 'agent');
    const turns = (await agent.invoke('ticket0/list-turns', {
      conversationId: started.conversationId,
    })) as Page<{ id: string; outcome: string; error: string | null; model: string; message_id: string | null }>;
    const turn = turns.entries.find((t) => t.id === message.id);
    expect(turn).toMatchObject({
      outcome: 'failed',
      model: 'offline/extractive',
      error: 'this desk has no assistant service principal',
    });
    expect(turn?.message_id).toBeTruthy();

    // The desk sees a system note, internal. The widget's thread carries only what the
    // customer said — the failure is the desk's to read, not the visitor's.
    const staffThread = (await agent.invoke('ticket0/list-messages', {
      conversationId: started.conversationId,
    })) as Page<{ id: string; author_kind: string; visibility: string }>;
    expect(staffThread.entries.find((m) => m.id === turn?.message_id)).toMatchObject({
      author_kind: 'system',
      visibility: 'internal',
    });
    const customerThread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: started.sessionId,
      token: started.token,
    })) as Page<{ author_kind: string }>;
    expect(customerThread.entries.every((m) => m.author_kind === 'contact')).toBe(true);

    // Idempotent on the message: an assistant that comes back and retries the job
    // finds the turn already recorded, and records nothing on top of it.
    const assistant = await at(world.substrat, 'assistant');
    const again = (await assistant.invoke('ticket0/record-answer', {
      conversationId: started.conversationId,
      turnId: message.id,
      model: 'test/fake',
      body: 'A late answer',
      inputTokens: 5,
      outputTokens: 5,
      citedArticleIds: [],
      outcome: 'drafted',
    })) as { outcome: string; model: string };
    expect(again).toMatchObject({ outcome: 'failed', model: 'offline/extractive' });
  });

  it('the failures roll up for the admin, beside the model the host would run', async () => {
    const admin = await at(world.substrat, 'admin');
    const health = (await admin.invoke('ticket0/assistant-health', {})) as {
      turns: number;
      failed: number;
      recent: { id: string; subject: string; error: string | null }[];
    };
    expect(health.failed).toBeGreaterThanOrEqual(3);
    expect(health.turns).toBeGreaterThanOrEqual(health.failed);
    // Newest first, each naming its conversation and carrying its reason.
    expect(health.recent[0]?.subject).toBeTruthy();
    expect(health.recent.map((f) => f.error)).toContain('this desk has no assistant service principal');

    // The route both hosts mount: the same numbers, plus the one fact the module
    // cannot know — which model, and whether it is one.
    const app = new Hono();
    mountApi(app, async () => admin);
    mountAssistantStatus(app, async () => admin, () => fakeDescription);
    const res = await app.request('/api/assistant/status');
    expect(res.status).toBe(200);
    const status = (await res.json()) as { model: string; generative: boolean; spec: string; health: { failed: number } };
    expect(status.model).toBe('test/fake');
    expect(status.generative).toBe(true);
    expect(status.spec).toBe('test:fake');
    expect(status.health.failed).toBe(health.failed);

    // And it is the admin's. An agent holds no `desk:configure`, and the route
    // authorises by invoking the declared operation, so it refuses the same way.
    const agent = await at(world.substrat, 'agent');
    const asAgent = new Hono();
    mountApi(asAgent, async () => agent);
    mountAssistantStatus(asAgent, async () => agent, () => fakeDescription);
    expect((await asAgent.request('/api/assistant/status')).status).toBe(403);
    await expect(agent.invoke('ticket0/assistant-health', {})).rejects.toThrow(/permission denied/i);
  });

  /**
   * The regression this whole change exists for.
   *
   * A supervised desk answers nobody and fails nothing, so a health read that counts
   * only failures calls it healthy — which is what a live desk did for days while every
   * answer it wrote sat in an inbox. The counts have to distinguish "nothing went
   * wrong" from "nothing went out".
   */
  it('a desk that drafts everything does not report itself healthy', async () => {
    const dana = await at(world.kestrel, 'admin');
    const before = (await dana.invoke('ticket0/assistant-health', {})) as {
      drafted: number;
      failed: number;
      supervised: boolean;
      waiting: { conversation_id: string; subject: string }[];
    };
    // Kestrel is the supervised desk, and it says so rather than leaving an admin to
    // infer it from an absence.
    expect(before.supervised).toBe(true);

    const r = await ask(world.kestrel, 'How do I rotate an API key?');
    expect(r.outcome).toBe('drafted');

    const after = (await dana.invoke('ticket0/assistant-health', {})) as {
      turns: number;
      drafted: number;
      failed: number;
      supervised: boolean;
      waiting: { conversation_id: string; subject: string }[];
    };
    expect(after.drafted).toBe(before.drafted + 1);
    // The thing that went wrong: this stayed 0 while the customer got nothing.
    expect(after.failed).toBe(before.failed);
    expect(after.turns).toBeGreaterThanOrEqual(after.drafted);
    // And the waiting answer is reachable, by conversation, so somebody can go send it.
    expect(after.waiting.map((w) => w.conversation_id)).toContain(r.conversationId);
    expect(after.waiting[0]?.subject).toBeTruthy();
  });

  /**
   * A person sends the draft, and it stops waiting.
   *
   * The supervised desk's whole workflow, and the half that was missing: sending from
   * the draft card posts a public reply, and until the turn moved with it the desk went
   * on offering the same draft and counting the answer as never delivered. This is what
   * the agent's "Send reply" button does.
   */
  it('a human sending the draft takes it off the waiting list', async () => {
    const dana = await at(world.kestrel, 'admin');
    const r = await ask(world.kestrel, 'How do I rotate an API key?');
    expect(r.outcome).toBe('drafted');

    const waitingFirst = (await dana.invoke('ticket0/assistant-health', {})) as {
      waiting: { id: string }[];
    };
    expect(waitingFirst.waiting.map((w) => w.id)).toContain(r.turnId);

    const omar = await at(world.kestrel, 'agent');
    await omar.invoke('ticket0/post-public-reply', {
      conversationId: r.conversationId,
      body: 'Rotate the key; the old one stays valid for 24 hours.',
      turnId: r.turnId,
    });

    const turns = (await omar.invoke('ticket0/list-turns', {
      conversationId: r.conversationId,
    })) as Page<{ id: string; outcome: string }>;
    expect(turns.entries.find((t) => t.id === r.turnId)?.outcome).toBe('answered');

    const waitingAfter = (await dana.invoke('ticket0/assistant-health', {})) as {
      waiting: { id: string }[];
    };
    expect(waitingAfter.waiting.map((w) => w.id)).not.toContain(r.turnId);
  });

  /**
   * The other side: an answer that WENT leaves nothing waiting.
   *
   * The desk still has drafted turns — the seed writes some, for the draft card, and a
   * returning customer lands back on a thread that already carries one — so this
   * asserts about the TURN it just answered rather than about a zero or a thread.
   */
  it('an autonomous desk reports itself unsupervised, and a sent answer waits for nobody', async () => {
    const admin = await at(world.substrat, 'admin');
    const r = await ask(world.substrat, 'How do I run a migration against a live scope?');
    expect(r.outcome).toBe('answered');

    const health = (await admin.invoke('ticket0/assistant-health', {})) as {
      supervised: boolean;
      waiting: { id: string }[];
    };
    expect(health.supervised).toBe(false);
    // The turn is keyed by the message it answered, and an answered turn waits for
    // nobody.
    expect(health.waiting.map((w) => w.id)).not.toContain(r.turnId);
  });

  it('a reason is cut to what a turn will hold, and never empty', () => {
    expect(errorText(new Error('x'.repeat(ASSISTANT_ERROR_MAX * 3)))).toHaveLength(ASSISTANT_ERROR_MAX);
    expect(errorText(new Error('   '))).toBe('failed without a message');
    expect(errorText('a string, not an Error')).toBe('a string, not an Error');
  });
});
