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
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@substrat-run/contracts';
import { manualClock } from '@substrat-run/kernel';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import {
  answerConversation,
  describeModel,
  errorText,
  modelFor,
  platformModel,
  recordAssistantFailure,
  priorMessages,
  searchQueriesOf,
  spreadAcrossDocuments,
  wantsHuman,
  type Model,
  type PriorMessage,
  type RetrievedArticle,
  type ModelDescription,
} from '../harness/assistant.js';
import { createModelHost } from '@substrat-run/vertical-host/model';
import { MockLanguageModelV3 } from 'ai/test';
import { MODEL_USAGE_KIND, modelUsageLine } from '@substrat-run/contracts';
import { mountAssistantStatus } from '../harness/assistant-status.js';
import { ASSISTANT_ERROR_MAX } from '../spec/model.js';
import { Hono } from 'hono';
import { fetchArticles, parseLlmsFull, parseLlmsIndex, runIngest } from '../harness/kb-ingest.js';
import { KB_REFRESH_TOKEN_HEADER, mountKbRefresh, readSource } from '../harness/kb-refresh.js';
import { mountApi } from '../src/routes.js';
import { HANDED_TO_A_PERSON } from '../src/module.js';
import { mountWidgetSurface } from '../harness/widget-surface.js';
import { buildHost, seed, signIdentity, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const at = (
  desk: Desk,
  role: 'admin' | 'agent' | 'assistant' | 'assistantAutonomous' | 'widget' | 'ingest',
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

/**
 * The refresh hook — the door a docs pipeline pushes on.
 *
 * The gap this closes: `llms-full.txt` is current on the site the moment the docs
 * deploy, and the desk's COPY of it only moves when someone presses Re-read. Nothing
 * drove that, so a published change reached customers as a stale answer. A hook is what
 * lets the deploy drive it.
 *
 * What these cases are actually about is the second door not being a way around the
 * first: the token authorises ONE source, as a principal holding one key, and a bad one
 * is refused rather than quietly falling back to asking for a login.
 */
describe('the refresh hook', () => {
  const CORPUS = [
    '# Rotating an API key',
    '',
    'Source: https://docs.kestrel.example/api-keys.md',
    '',
    'Rotating a key issues a new secret and keeps the old one valid for twenty-four',
    'hours, so a deploy can pick up the new value without any downtime at all.',
  ].join('\n');
  const fakeFetch = (async () => new Response(CORPUS)) as unknown as typeof fetch;

  type Hooked = {
    id: string;
    status: string;
    refresh_token_hint: string | null;
    token_created_at: string | null;
    token_last_used_at: string | null;
  };

  const firstSource = async (admin: ScopeStub): Promise<Hooked> =>
    ((await admin.invoke('ticket0/list-kb-sources', {})) as Page<Hooked>).entries[0]!;

  /** The route as a hosted desk mounts it: caller door + hook door, over one app. */
  const hookedApp = async (desk: Desk, fetchImpl = fakeFetch) => {
    const admin = await at(desk, 'admin');
    const ingest = await at(desk, 'ingest');
    const app = new Hono();
    mountApi(app, async () => admin);
    mountKbRefresh(app, async () => admin, fetchImpl, async () => asTarget(ingest));
    return { app, admin };
  };

  const fire = (app: Hono, sourceId: string, token: string) =>
    app.request(`/api/kb/sources/${sourceId}/refresh`, {
      method: 'POST',
      headers: { [KB_REFRESH_TOKEN_HEADER]: token },
    });

  it('a minted token reads the source, and the row records that it fired', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
      sourceId: source.id,
    })) as { token: string; refresh_token_hint: string; token_last_used_at: string | null };

    // The hint is the tail of the token, which is the only part a person may see again.
    expect(minted.token).toMatch(/^t0kb_/);
    expect(minted.refresh_token_hint).toBe(minted.token.slice(-6));
    expect(minted.token_last_used_at).toBeNull();

    const res = await fire(app, source.id, minted.token);
    expect(res.status).toBe(200);
    // One article accounted for, however it lands: whether this corpus reads as added,
    // updated or unchanged depends on what the cases above left behind, and the
    // bookkeeping is theirs to assert. What is THIS case's is that the hook read it.
    const counts = (await res.json()) as { added: number; updated: number; unchanged: number };
    expect(counts.added + counts.updated + counts.unchanged).toBe(1);

    // The column the whole feature is for: a hook that stopped firing is visible here
    // instead of in a wrong answer to a customer.
    const after = await firstSource(admin);
    expect(after.token_last_used_at).not.toBeNull();
    expect(after.status).toBe('idle');
  });

  it('the hash never leaves the desk, on any read of the row', async () => {
    const admin = await at(world.kestrel, 'admin');
    const page = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<
      Record<string, unknown>
    >;
    for (const row of page.entries) expect(row).not.toHaveProperty('refresh_token_hash');
    // And not on the way out of the operations that return one row either.
    const source = await firstSource(admin);
    const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
      sourceId: source.id,
    })) as Record<string, unknown>;
    expect(minted).not.toHaveProperty('refresh_token_hash');
    const ingested = (await admin.invoke('ticket0/ingest-kb-source', {
      sourceId: source.id,
    })) as Record<string, unknown>;
    expect(ingested).not.toHaveProperty('refresh_token_hash');
  });

  /**
   * The case the two-door design exists for.
   *
   * A wrong token must be REFUSED, not fall through to the caller door — which here is
   * a working admin stub. If it fell through, a bad token would read as a successful
   * refresh, and the hook would be authorising nothing at all.
   */
  it('a wrong token is refused even when the caller door would have opened', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    await admin.invoke('ticket0/mint-kb-refresh-token', { sourceId: source.id });

    const res = await fire(app, source.id, 't0kb_not-the-token');
    expect(res.status).toBe(403);
    // The hook was not spent: a refused token must not move the row it failed against,
    // or a wrong guess would cost the real hook its next minute.
    expect((await firstSource(admin)).token_last_used_at).toBeNull();

    // Same request with no token at all IS the caller door, and it opens.
    const asPerson = await app.request(`/api/kb/sources/${source.id}/refresh`, { method: 'POST' });
    expect(asPerson.status).toBe(200);
  });

  it('a token minted for another source does not open this one', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    const other = (await admin.invoke('ticket0/add-kb-source', {
      kind: 'markdown',
      url: 'https://docs.kestrel.example/other-page',
      label: 'Another page',
    })) as { id: string };
    const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
      sourceId: other.id,
    })) as { token: string };

    const res = await fire(app, source.id, minted.token);
    expect(res.status).toBe(403);
  });

  it('revoking takes the hook back, and the row stops claiming to have one', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
      sourceId: source.id,
    })) as { token: string };

    // Fire it once first, so the revoke has something to clear.
    expect((await fire(app, source.id, minted.token)).status).toBe(200);
    expect((await firstSource(admin)).token_last_used_at).not.toBeNull();

    const revoked = (await admin.invoke('ticket0/revoke-kb-refresh-token', {
      sourceId: source.id,
    })) as Hooked;
    expect(revoked.refresh_token_hint).toBeNull();
    expect(revoked.token_created_at).toBeNull();
    // And when it last fired: that is the HOOK's column, so a row with no hook must
    // not still be claiming one fired on Tuesday. The firing itself is in the history
    // (`ticket0.kb-refresh-hook-redeemed`), which is where a fact about a credential
    // that no longer exists belongs.
    expect(revoked.token_last_used_at).toBeNull();

    expect((await fire(app, source.id, minted.token)).status).toBe(403);

    // Idempotent: revoking a source that has no hook is a request to be in the state it
    // is already in, and the safe reflex should not read as a failure.
    await expect(
      admin.invoke('ticket0/revoke-kb-refresh-token', { sourceId: source.id }),
    ).resolves.toBeDefined();
  });

  /**
   * The three ways to fail are ONE answer, and an unknown source is the third.
   *
   * A refusal that separates "no such source" from "wrong token" hands an
   * unauthenticated caller a source-id oracle: fire at an id, read the status, learn
   * whether this desk holds it. The message is the same too, because a caller reading
   * two different sentences has been told the same thing.
   */
  it('an unknown source is refused exactly as a bad token is', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    await admin.invoke('ticket0/mint-kb-refresh-token', { sourceId: source.id });

    const unknown = await fire(app, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 't0kb_anything');
    const wrongToken = await fire(app, source.id, 't0kb_not-the-token');
    expect(unknown.status).toBe(403);
    expect(wrongToken.status).toBe(403);
    // The same refusal, word for word — a difference in wording is the same leak as a
    // difference in status. Everything but `instance`, which is the request's own path
    // and says nothing the caller did not already type.
    const body = async (r: Response) => {
      const { instance: _instance, ...rest } = (await r.json()) as Record<string, unknown>;
      return rest;
    };
    expect(await body(unknown)).toEqual(await body(wrongToken));
  });

  /**
   * Spending a hook is a MUTATION, so it announces itself like the mint and the revoke
   * beside it. Without the event, the only writes a hook can cause are the ones nothing
   * records, and "has this pipeline been firing, and when did it stop" — the question a
   * stale knowledge base actually raises — has no answer in the history.
   */
  it('a spent hook leaves an event carrying the hint and never the token', async () => {
    const { app, admin } = await hookedApp(world.kestrel);
    const source = await firstSource(admin);
    const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
      sourceId: source.id,
    })) as { token: string; refresh_token_hint: string };

    expect((await fire(app, source.id, minted.token)).status).toBe(200);

    const db = new Database(join(dir, `${world.kestrel.tenant}__${world.kestrel.scope}.sqlite`), {
      readonly: true,
    });
    const row = db
      .prepare(
        `SELECT * FROM _substrat_outbox WHERE type = 'ticket0.kb-refresh-hook-redeemed' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { entity_type: string; entity_id: string; pii_class: string; payload: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.entity_type).toBe('kbSource');
    expect(row!.entity_id).toBe(source.id);
    expect(row!.pii_class).toBe('none');
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.id).toBe(source.id);
    expect(payload.refresh_token_hint).toBe(minted.refresh_token_hint);
    expect(payload.token_last_used_at).toEqual(expect.any(String));
    // The one thing an event must never carry: an event is read later, by people who
    // were not here, and this one names a live credential's owner.
    expect(JSON.stringify(payload)).not.toContain(minted.token);
  });

  /**
   * A desk that has not been reconciled onto the version that mints the `ingest`
   * principal has no hook service. That is a 503 naming the fix, never a fallback onto
   * a principal that holds more than a hook is allowed to (#1172 is the lesson).
   */
  it('a desk with no ingest service refuses the hook rather than borrowing a principal', async () => {
    const admin = await at(world.kestrel, 'admin');
    const source = await firstSource(admin);
    const app = new Hono();
    mountApi(app, async () => admin);
    mountKbRefresh(app, async () => admin, fakeFetch, async () => null);

    const res = await fire(app, source.id, 't0kb_anything');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------

/**
 * The throttle, on its own world and its own clock.
 *
 * `manualClock` rather than a sleep: the rule is a minute between hook-driven reads,
 * and a test that waited one would be a minute of CI for one assertion. The button is
 * deliberately not throttled, and that is asserted here too — making an authenticated
 * person wait would be pretending they are the risk.
 */
describe('the refresh hook throttle', () => {
  const CORPUS = [
    '# Rotating an API key',
    '',
    'Source: https://docs.kestrel.example/api-keys.md',
    '',
    'Rotating a key issues a new secret and keeps the old one valid for twenty-four hours.',
  ].join('\n');
  const fakeFetch = (async () => new Response(CORPUS)) as unknown as typeof fetch;

  it('a second read inside the minute is 429 with how long to wait', async () => {
    const ownDir = mkdtempSync(join(tmpdir(), 'ticket0-hook-throttle-'));
    try {
      const clock = manualClock('2026-03-02T09:00:00.000Z');
      const ownHost = buildHost(ownDir, clock.read);
      const ownWorld = await seed(ownHost);
      const desk = ownWorld.kestrel;
      const admin = await ownHost.getScope(desk.admin.principal, desk.tenant, desk.scope);
      const ingest = await ownHost.getScope(desk.ingest.principal, desk.tenant, desk.scope);

      const app = new Hono();
      mountApi(app, async () => admin);
      mountKbRefresh(app, async () => admin, fakeFetch, async () => asTarget(ingest));

      const source = ((await admin.invoke('ticket0/list-kb-sources', {})) as Page<{ id: string }>)
        .entries[0]!;
      const minted = (await admin.invoke('ticket0/mint-kb-refresh-token', {
        sourceId: source.id,
      })) as { token: string };
      const fire = () =>
        app.request(`/api/kb/sources/${source.id}/refresh`, {
          method: 'POST',
          headers: { [KB_REFRESH_TOKEN_HEADER]: minted.token },
        });

      expect((await fire()).status).toBe(200);

      clock.advance(20_000);
      const tooSoon = await fire();
      expect(tooSoon.status).toBe(429);
      // With the remainder, so a pipeline that fires twice on one merge can wait it out
      // instead of guessing.
      expect((await tooSoon.json()) as { retryAfter?: number }).toMatchObject({ retryAfter: 40 });

      // The button is a person who can see what they are doing, and is not throttled.
      const asPerson = await app.request(`/api/kb/sources/${source.id}/refresh`, { method: 'POST' });
      expect(asPerson.status).toBe(200);

      clock.advance(60_000);
      expect((await fire()).status).toBe(200);
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  }, 60_000);
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

describe('choosing which sections the model sees', () => {
  /** A hit list as the index hands it over: rank order, sections carrying anchors. */
  const hit = (url: string) => ({ id: url, title: url, url, body: url });

  it('leads with one section per document, best-ranked first', () => {
    const spread = spreadAcrossDocuments([
      hit('/connectors/#what-a-connector-is-not'),
      hit('/connectors/#available-connectors'),
      hit('/engines/invoicing/composing#reaching-the-outside-world'),
    ]);
    // Breadth before depth: the second page is ahead of the first page's second
    // section, so a narrow question still gets more than one place to look.
    expect(spread.map((s) => s.url)).toEqual([
      '/connectors/#what-a-connector-is-not',
      '/engines/invoicing/composing#reaching-the-outside-world',
      '/connectors/#available-connectors',
    ]);
  });

  /**
   * The regression this function exists for. Asked "what connectors exist in
   * Substrat?", the index ranked the connectors page's *What a connector is not*
   * above its *Available connectors* — the table that lists them. One section per
   * document dropped the table, and the desk told a customer that Substrat has no
   * connectors while the answer sat one rank below in the same result set.
   */
  it('does not drop a page’s answering section for its best-ranked one', () => {
    const spread = spreadAcrossDocuments([
      hit('/connectors/#what-a-connector-is-not'),
      hit('/connectors/#available-connectors'),
    ]);
    expect(spread.map((s) => s.url)).toContain('/connectors/#available-connectors');
  });

  it('caps a document so one page cannot crowd out the rest', () => {
    const spread = spreadAcrossDocuments([
      hit('/connectors/#one'),
      hit('/connectors/#two'),
      hit('/connectors/#three'),
      hit('/guide/deploying#four'),
    ]);
    expect(spread.filter((s) => s.url.startsWith('/connectors/'))).toHaveLength(2);
    expect(spread.map((s) => s.url)).not.toContain('/connectors/#three');
  });

  it('treats a page with no anchor as its own document', () => {
    const spread = spreadAcrossDocuments([hit('/connectors/'), hit('/connectors/#available-connectors')]);
    expect(spread).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('what reaches the model', () => {
  /**
   * A page that answers in several sections, and a second page that answers in one —
   * the shape the real corpus has and the shape the one-per-document rule mishandled.
   */
  const CORPUS = [
    '# What is a connector?',
    '',
    'Source: https://docs.kestrel.example/connectors.md',
    '',
    '## What a connector is not',
    '',
    'A connector is not an engine and not an adapter. It owns no tables, no domain',
    'state and no permissions of its own; it consumes an event and effects something',
    'outside. Nothing here lists which connectors a deployment can actually use.',
    '',
    '## Available connectors',
    '',
    'The connectors that exist today, one row each. Kestrel Sign is published and',
    'connects a tenant’s signing account; the accounting connectors are not written',
    'yet. This is the list a person asking "which connectors exist" wants.',
    '',
    '# Deploying',
    '',
    'Source: https://docs.kestrel.example/deploying.md',
    '',
    'A push builds the vertical and binds it to a hostname. Connectors are declared by',
    'the vertical and run by the platform, so a deploy carries whichever connectors',
    'exist for it along with everything else.',
  ].join('\n');

  const fakeFetch = (async () => new Response(CORPUS)) as unknown as typeof fetch;

  /** A model that answers blandly and remembers what it was given. */
  const capturing = (): Model & { context: RetrievedArticle[] } => {
    const model = {
      label: 'test/capturing',
      context: [] as RetrievedArticle[],
      async answer(input: { question: string; context: RetrievedArticle[] }) {
        model.context = input.context;
        return { text: 'Kestrel Sign.', inputTokens: 10, outputTokens: 5, confidence: 0.9 };
      },
    };
    return model;
  };

  it('hands over the section that answers, not only the page’s best-ranked one', async () => {
    const admin = await at(world.kestrel, 'admin');
    const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<{ id: string; kind: 'llms-txt'; url: string }>;
    await runIngest(asTarget(admin), sources.entries[0]!, fakeFetch);

    const widget = await at(world.kestrel, 'widget');
    const desk = world.kestrel;
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      identity: {
        externalId: desk.customer.email,
        signature: await signIdentity(desk.verificationSecret, desk.customer.email),
      },
    })) as { sessionId: string; token: string };
    const question = 'What connectors exist?';
    const message = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: question,
    })) as { id: string; conversation_id: string };

    const model = capturing();
    const { autonomous } = (await widget.invoke('ticket0/assistant-mode', {})) as { autonomous: boolean };
    await answerConversation(
      asTarget(await at(desk, autonomous ? 'assistantAutonomous' : 'assistant')),
      { conversationId: message.conversation_id, messageId: message.id, question },
      model,
    );

    // The whole point: the listing section is in front of the model. Which of the
    // page’s two sections bm25 prefers is the index’s business and not asserted —
    // what is asserted is that preferring one no longer discards the other.
    const titles = model.context.map((c) => c.title);
    expect(titles).toContain('What is a connector? — Available connectors');
    // And breadth survives: the other page is still represented.
    expect(model.context.some((c) => c.url.includes('/deploying'))).toBe(true);
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
   * Turning the assistant loose does not send what it already drafted — and must not
   * hide it either.
   *
   * The panel used to gate the waiting list on the desk being supervised, so flipping
   * to autonomous made an existing backlog vanish from the one screen that knew about
   * it. That is the worst possible moment to hide it: nothing will ever send those
   * answers automatically, and the customers who asked are still waiting.
   */
  it('answers already waiting survive the desk being turned loose', async () => {
    const dana = await at(world.kestrel, 'admin');
    const r = await ask(world.kestrel, 'How do I rotate an API key?');
    expect(r.outcome).toBe('drafted');

    await dana.invoke('ticket0/configure-desk', { assistantAutonomous: true });
    try {
      const health = (await dana.invoke('ticket0/assistant-health', {})) as {
        supervised: boolean;
        waitingTotal: number;
        waiting: { id: string }[];
      };
      expect(health.supervised).toBe(false);
      expect(health.waitingTotal).toBeGreaterThan(0);
      expect(health.waiting.map((w) => w.id)).toContain(r.turnId);
    } finally {
      await dana.invoke('ticket0/configure-desk', { assistantAutonomous: false });
    }
  });

  /**
   * And age is not what makes an answer waiting — being unsent is.
   *
   * The counts above are a 24-hour window, which is right for them and wrong for this:
   * a draft nobody sent three days ago is more urgent than one from an hour ago, so it
   * has to still be on the list. `manualClock` moves the desk past the window rather
   * than sleeping through it.
   */
  it('a draft older than the counting window is still waiting', async () => {
    // Its OWN world, on its own clock: advancing three days inside the shared one would
    // move every later case in this file out of the window its counts are about.
    const ownDir = mkdtempSync(join(tmpdir(), 'ticket0-waiting-age-'));
    try {
      const clock = manualClock('2026-03-02T09:00:00.000Z');
      const ownHost = buildHost(ownDir, clock.read);
      const ownWorld = await seed(ownHost);
      const desk = ownWorld.kestrel;
      const dana = await ownHost.getScope(desk.admin.principal, desk.tenant, desk.scope);

      const widget = await ownHost.getScope(desk.widget.principal, desk.tenant, desk.scope);
      const started = (await widget.invoke('ticket0/widget-start', {
        origin: desk.origin,
        identity: {
          externalId: desk.customer.email,
          signature: await signIdentity(desk.verificationSecret, desk.customer.email),
        },
      })) as { sessionId: string; token: string };
      const question = 'How do I rotate an API key?';
      const message = (await widget.invoke('ticket0/widget-post', {
        sessionId: started.sessionId,
        token: started.token,
        body: question,
      })) as { id: string; conversation_id: string };
      const assistant = await ownHost.getScope(desk.assistant.principal, desk.tenant, desk.scope);
      const r = await answerConversation(
        asTarget(assistant),
        { conversationId: message.conversation_id, messageId: message.id, question },
        fakeModel(),
      );
      expect(r.outcome).toBe('drafted');

      clock.advance(3 * 24 * 60 * 60 * 1000);
      const health = (await dana.invoke('ticket0/assistant-health', {})) as {
        drafted: number;
        waitingTotal: number;
        waiting: { id: string }[];
      };
      // Out of the window the counts describe...
      expect(health.drafted).toBe(0);
      // ...and still on the list, because nobody sent it.
      expect(health.waiting.map((w) => w.id)).toContain(r.turnId);
      expect(health.waitingTotal).toBeGreaterThan(0);
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  }, 60_000);

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

/**
 * The route to a person — the one thing a support widget must never get wrong.
 *
 * It got it wrong for a long time in the quietest possible way: the "Talk to a human"
 * button posted a SENTENCE saying so, that sentence went to retrieval like any other,
 * and the customer got a paragraph out of whichever documentation page bm25 liked
 * best — while nobody at the desk was told anything at all.
 */
describe('asking for a person', () => {
  /** Open a widget session and return the two things a visitor's browser holds. */
  async function opened(desk: Desk) {
    const widget = await at(desk, 'widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      identity: {
        externalId: desk.customer.email,
        signature: await signIdentity(desk.verificationSecret, desk.customer.email),
      },
    })) as { sessionId: string; token: string };
    return { widget, ...started };
  }

  const notificationsOf = async (desk: Desk, who: 'admin' | 'agent', conversationId: string) => {
    const page = (await (await at(desk, who)).invoke('ticket0/my-notifications', {})) as Page<{
      kind: string;
      conversation_id: string | null;
    }>;
    return page.entries.filter((n) => n.conversation_id === conversationId);
  };

  it('tells a request for a person from a question about people', () => {
    // The button's own sentence, and the ways somebody types it.
    for (const said of [
      'Can a person take a look at this, please?',
      'human',
      'a real person please',
      'can I talk to a human?',
      "I'd like to speak with someone",
      'get me a human',
      'escalate this please',
      'could someone help me?',
      'is there an actual person there?',
    ])
      expect(wantsHuman(said), said).toBe(true);

    /**
     * And the half that matters more. This product's documentation is ABOUT people
     * holding permissions, so a classifier built from the word "person" would escalate
     * the questions the assistant exists to answer.
     */
    for (const asked of [
      'How do I run a migration against a live scope?',
      'Can a person be assigned to a work order?',
      'Do I need a person to approve a migration?',
      'How do agents work in Substrat?',
      'what permissions does the support role hold?',
      'who can see an absence?',
    ])
      expect(wantsHuman(asked), asked).toBe(false);
  });

  it('the button posts, acknowledges and tells the desk — in one call, with no model', async () => {
    const { widget, sessionId, token } = await opened(world.substrat);
    const asked = (await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Can a person take a look at this, please?',
    })) as { id: string; conversation_id: string; notified: number };

    // The visitor sees their own message and an answer to it — not silence, and not a
    // paragraph of documentation.
    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId, token })) as Page<{
      author_kind: string;
      body_text: string;
    }>;
    expect(thread.entries.map((m) => m.author_kind)).toEqual(['contact', 'system']);
    expect(thread.entries[1]!.body_text).toBe(HANDED_TO_A_PERSON);

    // Nothing was generated, so nothing was recorded as generated and nothing is owed.
    const turns = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-turns', {
      conversationId: asked.conversation_id,
    })) as Page<{ id: string }>;
    expect(turns.entries).toHaveLength(0);
  });

  /**
   * The half the assignee rule could not reach.
   *
   * A widget conversation is unassigned by construction, so "tell whoever holds it"
   * told nobody — every escalation this desk ever made went to an empty inbox row.
   */
  it('an unassigned conversation tells every agent, because nobody holds it', async () => {
    const { widget, sessionId, token } = await opened(world.substrat);
    const asked = (await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Can a person take a look at this, please?',
    })) as { conversation_id: string; notified: number };

    expect(asked.notified).toBeGreaterThan(0);
    for (const who of ['admin', 'agent'] as const) {
      const mine = await notificationsOf(world.substrat, who, asked.conversation_id);
      expect(mine.map((n) => n.kind)).toContain('escalated');
    }
    // And it counts PEOPLE: the assistant's own accounts are in the same directory,
    // because a desk must be able to hand a conversation back to them.
    const staff = (await (await at(world.substrat, 'agent')).invoke('ticket0/list-agents', {})) as Page<{
      display_name: string;
    }>;
    expect(asked.notified).toBe(
      staff.entries.filter((a) => a.display_name !== 'Assistant').length,
    );
  });

  it('an assigned one tells only whoever is holding it', async () => {
    const { widget, sessionId, token } = await opened(world.substrat);
    const first = (await widget.invoke('ticket0/widget-post', {
      sessionId,
      token,
      body: 'My invoice export is empty.',
    })) as { conversation_id: string };
    await (await at(world.substrat, 'admin')).invoke('ticket0/assign', {
      conversationId: first.conversation_id,
      assignee: world.substrat.agent.principal,
    });

    const asked = (await widget.invoke('ticket0/request-human', { sessionId, token })) as {
      conversation_id: string;
      notified: number;
    };
    expect(asked.notified).toBe(1);
    expect((await notificationsOf(world.substrat, 'agent', asked.conversation_id)).map((n) => n.kind))
      .toContain('escalated');

    // The message it is about is the one the visitor already sent; asking for a person
    // does not put words in their mouth a second time.
    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId, token })) as Page<{
      author_kind: string;
      body_text: string;
    }>;
    expect(thread.entries.filter((m) => m.author_kind === 'contact')).toHaveLength(1);
    expect(thread.entries.at(-1)!.body_text).toBe(HANDED_TO_A_PERSON);
  });

  it('asking twice while the first ask stands tells the desk once', async () => {
    const { widget, sessionId, token } = await opened(world.substrat);
    const first = (await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Can a person take a look at this, please?',
    })) as { conversation_id: string; notified: number };
    expect(first.notified).toBeGreaterThan(0);

    const again = (await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Anyone there?',
    })) as { notified: number };
    // Impatience, not news. The visitor's second message is in the thread; the desk is
    // not told a second time, and is not told the same thing twice in its own voice.
    expect(again.notified).toBe(0);

    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId, token })) as Page<{
      author_kind: string;
      body_text: string;
    }>;
    expect(thread.entries.filter((m) => m.body_text === HANDED_TO_A_PERSON)).toHaveLength(1);
    expect((await notificationsOf(world.substrat, 'agent', first.conversation_id))).toHaveLength(1);

    // An internal note is not an answer: the visitor has been told nothing, so their
    // request is still the one the desk was already told about.
    await (await at(world.substrat, 'agent')).invoke('ticket0/post-note', {
      conversationId: first.conversation_id,
      body: 'Looks like the export bug from last week — checking.',
    });
    const afterNote = (await widget.invoke('ticket0/request-human', { sessionId, token })) as {
      notified: number;
    };
    expect(afterNote.notified).toBe(0);

    // And once somebody answers, the next ask is a new one.
    await (await at(world.substrat, 'agent')).invoke('ticket0/post-public-reply', {
      conversationId: first.conversation_id,
      body: 'I am here — what is going on?',
    });
    const third = (await widget.invoke('ticket0/request-human', { sessionId, token })) as {
      notified: number;
    };
    expect(third.notified).toBeGreaterThan(0);
  });

  /**
   * The rule #1311 taught `widget-post`, on the route a visitor presses when nothing
   * else is working.
   *
   * `closed` is terminal, so a session whose thread an agent closed would have met
   * `invalid transition: conversation … is 'closed'` — the exact 409 that reached a
   * visitor of substrat.net, on the one button that is supposed to work when the rest
   * of the desk has not.
   */
  it('asking for a person in a closed thread opens the follow-up, rather than a lifecycle error', async () => {
    const { widget, sessionId, token } = await opened(world.substrat);
    const first = (await widget.invoke('ticket0/widget-post', {
      sessionId,
      token,
      body: 'My export is empty.',
    })) as { conversation_id: string };
    await (await at(world.substrat, 'agent')).invoke('ticket0/close', {
      conversationId: first.conversation_id,
    });

    const asked = (await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Can a person take a look at this, please?',
    })) as { conversation_id: string; notified: number };
    expect(asked.conversation_id).not.toBe(first.conversation_id);
    expect(asked.notified).toBeGreaterThan(0);

    const followUp = (await (await at(world.substrat, 'agent')).invoke('ticket0/get-conversation', {
      conversationId: asked.conversation_id,
    })) as { follows: string | null; state: string };
    expect(followUp.follows).toBe(first.conversation_id);

    // The visitor's bubble shows the new thread: their ask, and an answer to it.
    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId, token })) as Page<{
      author_kind: string;
      body_text: string;
    }>;
    expect(thread.entries.map((m) => m.author_kind)).toEqual(['contact', 'system']);
    expect(thread.entries[1]!.body_text).toBe(HANDED_TO_A_PERSON);
  });

  /**
   * A desk that keeps a human in the loop refuses its assistant a public word — and
   * must not take the acknowledgement down with it. The visitor asked for a person,
   * and being told one is coming is the desk confirming receipt, not the AI answering.
   */
  it('a supervised desk still answers the ask, because the desk is the one answering', async () => {
    const { widget, sessionId, token } = await opened(world.kestrel);
    await widget.invoke('ticket0/request-human', {
      sessionId,
      token,
      body: 'Can I talk to a human?',
    });
    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId, token })) as Page<{
      body_text: string;
    }>;
    expect(thread.entries.at(-1)!.body_text).toBe(HANDED_TO_A_PERSON);
  });
});

/**
 * The routing decision itself — which is host code, and the one place that decides
 * whether a customer's message reaches a model at all.
 *
 * Worth driving through the actual surface rather than asserting about `wantsHuman`
 * twice: what broke was not the classifier (there was none) but the route, which sent
 * everything to the assistant because that is all it knew how to do.
 */
describe('the widget surface routes a request for a person away from the model', () => {
  async function mounted(desk: Desk) {
    const app = new Hono();
    const answered: string[] = [];
    const stub = await at(desk, 'widget');
    mountWidgetSurface(app, {
      resolveDesk: async () => ({
        invoke: <T,>(op: string, input: unknown) => stub.invoke(op, input) as Promise<T>,
        allowedOrigins: [desk.origin],
        deskKey: `${desk.tenant}:${desk.scope}`,
      }),
      onCustomerMessage: (_c, m) => {
        answered.push(m.body);
      },
    });
    const call = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { origin: desk.origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const started = (await (await call('/widget/sessions', {})).json()) as {
      sessionId: string;
      token: string;
    };
    const thread = async () => {
      const res = await app.request(
        `/widget/sessions/${started.sessionId}/messages?token=${encodeURIComponent(started.token)}`,
        { headers: { origin: desk.origin } },
      );
      return (await res.json()) as { entries: { author_kind: string; body_text: string }[] };
    };
    return { call, answered, session: started, thread };
  }

  it('an ordinary question goes to the assistant, as it always did', async () => {
    const { call, answered, session } = await mounted(world.substrat);
    const res = await call(`/widget/sessions/${session.sessionId}/messages`, {
      token: session.token,
      body: 'How do I run a migration against a live scope?',
    });
    expect(res.status).toBe(200);
    expect(answered).toEqual(['How do I run a migration against a live scope?']);
  });

  it('a TYPED request for a person does not, and is acknowledged instead', async () => {
    const { call, answered, session, thread } = await mounted(world.substrat);
    const res = await call(`/widget/sessions/${session.sessionId}/messages`, {
      token: session.token,
      body: 'Can I speak to someone please?',
    });
    expect(res.status).toBe(200);
    // The model never ran. Before this it did, and answered from whichever page
    // mentioned people.
    expect(answered).toEqual([]);

    const said = await thread();
    expect(said.entries.map((m) => m.author_kind)).toEqual(['contact', 'system']);
    expect(said.entries[1]!.body_text).toBe(HANDED_TO_A_PERSON);
  });

  it('the button’s own route posts and escalates in one call', async () => {
    const { call, answered, session } = await mounted(world.substrat);
    const res = await call(`/widget/sessions/${session.sessionId}/handoff`, {
      token: session.token,
      body: 'Can a person take a look at this, please?',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notified: number }).notified).toBeGreaterThan(0);
    expect(answered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * The conversation, as a thing the assistant is part of rather than a sequence of
 * unrelated questions.
 *
 * Reported from the live desk on substrat.net: *"Is there a changelog?"* answered well,
 * and then *"Ok, and last week? Any big releases?"* answered about something else. Both
 * halves of that are exercised here, and the retrieval half is the one worth reading —
 * a prompt that carries the transcript still answers from whatever the index handed it,
 * so a follow-up that retrieves the wrong page keeps its context perfectly and is still
 * wrong.
 */
describe('a follow-up is a follow-up', () => {
  /**
   * A changelog page and a release-process page, arranged so the two are genuinely
   * confusable — which is the corpus property the bug needs. `last` appears on neither,
   * so the follow-up's own most specific query misses; `release` appears on both, so
   * its next-best query hits the WRONG one.
   */
  const CORPUS = [
    '# Changelog',
    '',
    'Source: https://docs.kestrel.example/changelog.md',
    '',
    '## What this is',
    '',
    'The changelog is a weekly record of what shipped. Each entry names its week and',
    'lists every package released in it, with the version span the package moved',
    'across, so a reader can see how big a week was without reading the commits.',
    '',
    '## What this is not',
    '',
    'The changelog is not a roadmap and not a status page. It says only what already',
    'went out, which is why an entry is written once its week has ended.',
    '',
    '# Release process',
    '',
    'Source: https://docs.kestrel.example/releases.md',
    '',
    '## Cutting a release',
    '',
    'A release is cut from main by a changeset, and CI pushes the tag once the version',
    'bump has merged. A release happens when the changesets say it does.',
  ].join('\n');

  const fakeFetch = (async () => new Response(CORPUS)) as unknown as typeof fetch;

  const FIRST = 'Is there a changelog?';
  const FOLLOW_UP = 'Ok, and last week? Any big releases?';

  /** Remembers everything it was handed, so the test can assert on the prompt's inputs. */
  const capturing = (): Model & {
    context: RetrievedArticle[];
    history: readonly PriorMessage[];
  } => {
    const model = {
      label: 'test/capturing',
      context: [] as RetrievedArticle[],
      history: [] as readonly PriorMessage[],
      async answer(input: {
        question: string;
        context: RetrievedArticle[];
        history: readonly PriorMessage[];
      }) {
        model.context = input.context;
        model.history = input.history;
        return { text: 'Week 35 was a quiet one.', inputTokens: 10, outputTokens: 5, confidence: 0.9 };
      },
    };
    return model;
  };

  /** Its own world: this one ingests a different corpus into the desk it uses. */
  async function ownDesk() {
    const ownDir = mkdtempSync(join(tmpdir(), 'ticket0-follow-up-'));
    const ownHost = buildHost(ownDir);
    const ownWorld = await seed(ownHost);
    // Substrat's desk answers customers directly, so the assistant's own replies are
    // PUBLIC — which is what puts them in the next message's history.
    const desk = ownWorld.substrat;
    const stub = (role: 'admin' | 'agent' | 'assistantAutonomous' | 'widget') =>
      ownHost.getScope(desk[role].principal, desk.tenant, desk.scope);

    const admin = await stub('admin');
    const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as Page<{
      id: string;
      kind: 'llms-txt';
      url: string;
    }>;
    await runIngest(asTarget(admin), sources.entries[0]!, fakeFetch);

    const widget = await stub('widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
      identity: {
        externalId: desk.customer.email,
        signature: await signIdentity(desk.verificationSecret, desk.customer.email),
      },
    })) as { sessionId: string; token: string };

    const say = (body: string) =>
      widget.invoke('ticket0/widget-post', {
        sessionId: started.sessionId,
        token: started.token,
        body,
      }) as Promise<{ id: string; conversation_id: string }>;

    return { dispose: () => rmSync(ownDir, { recursive: true, force: true }), desk, stub, say };
  }

  it('carries what the customer said and was told, and nothing they never saw', async () => {
    const { dispose, stub, say } = await ownDesk();
    try {
      const assistant = asTarget(await stub('assistantAutonomous'));

      const first = await say(FIRST);
      const opening = capturing();
      await answerConversation(
        assistant,
        { conversationId: first.conversation_id, messageId: first.id, question: FIRST },
        opening,
      );
      // The first message of a conversation has no history, and the prompt it produces
      // is the one this file has always produced.
      expect(opening.history).toEqual([]);

      // An agent's private read of the customer, which is exactly the sentence that
      // must never reach a prompt whose output is posted publicly.
      const agent = await stub('agent');
      await agent.invoke('ticket0/post-note', {
        conversationId: first.conversation_id,
        body: 'This one asks a lot of questions — keep the answers short.',
      });

      const second = await say(FOLLOW_UP);
      const following = capturing();
      await answerConversation(
        assistant,
        { conversationId: first.conversation_id, messageId: second.id, question: FOLLOW_UP },
        following,
      );

      // Oldest first, and exactly the two turns the customer lived through: what they
      // asked, and the answer they read.
      expect(following.history).toEqual([
        { role: 'customer', text: FIRST },
        { role: 'support', text: 'Week 35 was a quiet one.' },
      ]);
      // The note is the assertion this test exists for.
      expect(JSON.stringify(following.history)).not.toContain('asks a lot of questions');
      // And the message being answered is not context for itself.
      expect(following.history.map((m) => m.text)).not.toContain(FOLLOW_UP);
    } finally {
      dispose();
    }
  });

  /**
   * The half a prompt cannot fix.
   *
   * `last` is on neither page, so the follow-up's most specific query misses and the
   * walk drops to single words — where `release` matches the release-process page and
   * the changelog the customer was actually reading about never enters the ranking.
   */
  it('retrieves the page the conversation was already about', async () => {
    const { dispose, stub, say } = await ownDesk();
    try {
      const assistant = asTarget(await stub('assistantAutonomous'));

      const first = await say(FIRST);
      await answerConversation(
        assistant,
        { conversationId: first.conversation_id, messageId: first.id, question: FIRST },
        capturing(),
      );

      const second = await say(FOLLOW_UP);
      const following = capturing();
      await answerConversation(
        assistant,
        { conversationId: first.conversation_id, messageId: second.id, question: FOLLOW_UP },
        following,
      );

      const urls = following.context.map((c) => c.url);
      expect(urls.some((u) => u.includes('changelog'))).toBe(true);
      // The assertion that discriminates. `release` is on both pages, so the singles
      // rung retrieves both and the changelog page is merely PRESENT — mixed in with
      // the process page the customer never asked about, which is how the live desk
      // came to answer about cutting releases. The bridge query names the topic, so
      // the process page cannot match it at all.
      expect(urls.some((u) => u.includes('releases'))).toBe(false);
    } finally {
      dispose();
    }
  });

  /**
   * History is what makes a follow-up readable, not what makes an answer possible.
   *
   * A desk whose message read refuses still answers the message in front of it — the
   * alternative is a conversation that stops dead because a list call went wrong.
   */
  it('still answers when the conversation cannot be read', async () => {
    const { dispose, stub, say } = await ownDesk();
    try {
      const stub_ = await stub('assistantAutonomous');
      const blind = {
        invoke: <T,>(op: string, input: unknown, options?: { idempotencyKey?: string }) =>
          op === 'ticket0/list-messages'
            ? Promise.reject(new Error('the message list is unavailable'))
            : (stub_.invoke(op, input, options) as Promise<T>),
      };

      const first = await say(FIRST);
      const model = capturing();
      const outcome = await answerConversation(
        blind,
        { conversationId: first.conversation_id, messageId: first.id, question: FIRST },
        model,
      );

      expect(outcome.outcome).toBe('answered');
      expect(model.history).toEqual([]);
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the ladder a follow-up climbs', () => {
  const FOLLOW_UP_Q = 'Ok, and last week? Any big releases?';

  it('bridges to the previous question, below the specific query and above the singles', () => {
    const ladder = searchQueriesOf(FOLLOW_UP_Q, 'Is there a changelog?');
    // The specific query still leads: a self-contained message must not be dragged
    // backwards, and this rung is what lets it stand alone when it can.
    expect(ladder[0]).toBe('releas last');
    // Then the bridge — before any single word, because a single word is what quietly
    // succeeds with the wrong page and stops the walk.
    expect(ladder[1]).toBe('releas changelog');
    expect(ladder.indexOf('releas changelog')).toBeLessThan(ladder.indexOf('releas'));
  });

  it('leaves a self-contained question exactly as it was', () => {
    const alone = searchQueriesOf('How do I rotate an API key?');
    // The prior question contributes a rung and changes nothing else — and when the
    // specific query hits, as it does for a question like this, the walk never reaches
    // it at all.
    expect(searchQueriesOf('How do I rotate an API key?', 'Is there a changelog?')[0]).toBe(alone[0]);
    expect(alone[0]).toBe('rotat api');
  });

  it('answers a message that is nothing but grammar from the question before it', () => {
    // "and what about that one?" is every stop word and no content — today it searches
    // for `help`, which is a page about nothing in particular.
    expect(searchQueriesOf('And what about that one?')).toEqual(['help']);
    expect(searchQueriesOf('And what about that one?', 'How do I rotate an API key?')).toEqual([
      'rotat',
      'api',
      'key',
    ]);
  });

  it('never carries a word the follow-up already had', () => {
    // The bridge exists to WIDEN. Pairing a term with itself narrows to the query that
    // already ran.
    const ladder = searchQueriesOf('What about release notes?', 'How is a release cut?');
    expect(ladder).not.toContain('releas releas');
  });
});

// ---------------------------------------------------------------------------

/**
 * Where the transcript STOPS.
 *
 * The safety argument for history has two halves. The first — public messages only,
 * never an agent's internal note — is exercised against a real desk above. This is the
 * second: nothing at or after the message being answered, which is a claim about
 * chronology and so is provable only where the chronology can be arranged. Hence a
 * scripted message list rather than a live conversation: 120 messages with the answered
 * one anywhere in them is a fixture here and a minute of seeding there.
 */
describe('the conversation so far ends at the message being answered', () => {
  /** Newest first, as `order: 'desc'` returns them. `m0` is the newest. */
  const conversation = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      author_kind: i % 2 === 0 ? ('contact' as const) : ('agent' as const),
      visibility: 'public' as const,
      body_text: `message ${i}`,
      created_at: `2026-09-10T00:${String(count - i).padStart(2, '0')}:00.000Z`,
    }));

  /** A desk whose message list pages exactly as `ctx.page` does: cursor exclusive. */
  const paging = (rows: ReturnType<typeof conversation>) => {
    const reads: (string | undefined)[] = [];
    return {
      reads,
      invoke: (async (op: string, input: { limit: number; cursor?: string }) => {
        if (op !== 'ticket0/list-messages') throw new Error(`unexpected ${op}`);
        reads.push(input.cursor);
        const from = input.cursor ? rows.findIndex((r) => r.id === input.cursor) + 1 : 0;
        const entries = rows.slice(from, from + input.limit);
        const last = from + input.limit;
        return { entries, nextCursor: last < rows.length ? (entries.at(-1)?.id ?? null) : null };
      }) as <T>(op: string, input: unknown) => Promise<T>,
    };
  };

  it('reads the messages below it, and none of the ones above', async () => {
    // Answering m2 with m1 and m0 sitting above it — a customer who sent two more
    // messages while the turn was being taken. Those are the next questions, not
    // context for this one.
    const desk = paging(conversation(12));
    const history = await priorMessages(desk, 'c1', 'm2');

    expect(history.map((m) => m.text)).toEqual([
      'message 10',
      'message 9',
      'message 8',
      'message 7',
      'message 6',
      'message 5',
      'message 4',
      'message 3',
    ]);
    expect(history.map((m) => m.text)).not.toContain('message 2');
    expect(history.map((m) => m.text)).not.toContain('message 1');
    expect(history.map((m) => m.text)).not.toContain('message 0');
  });

  it('follows the walk onto the next page rather than losing the context there', async () => {
    // The answered message is the last row of the first page, so every word of its
    // conversation is on the second one. Nothing about the guarantee says the history
    // has to be cheap — it says it has to be older.
    const desk = paging(conversation(60));
    const history = await priorMessages(desk, 'c1', 'm29');

    expect(history).toHaveLength(8);
    expect(history.at(-1)?.text).toBe('message 30');
    expect(desk.reads).toHaveLength(2);
  });

  /**
   * The finding this test was written for.
   *
   * A message that is not on the page read is not thereby OLD. On a newest-first walk
   * it is the other way round: every row read was newer than it, so treating the page
   * as "the conversation so far" feeds later customer messages and the desk's own later
   * replies into a turn about an earlier one — and the desk then quotes the future back
   * at the customer. Chronology unknown is answered with no history, not with a guess.
   */
  it('carries no history at all when the message cannot be found', async () => {
    // Far enough down that the bounded walk gives up before reaching it: a burst of
    // traffic, or a turn retried long after the message arrived.
    const desk = paging(conversation(200));
    const history = await priorMessages(desk, 'c1', 'm150');

    expect(history).toEqual([]);
    // And it gave up rather than walking a conversation of any length.
    expect(desk.reads).toHaveLength(3);
  });

  it('carries no history when the message was erased from the list', async () => {
    const desk = paging(conversation(10));
    expect(await priorMessages(desk, 'c1', 'gone')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('what a first message pays for', () => {
  /** A host that answers blandly and keeps every system string it was handed. */
  const listening = () => {
    const systems: (string | undefined)[] = [];
    const mock = new MockLanguageModelV3({
      doGenerate: async (options: { prompt: { role: string; content: unknown }[] }) => {
        const system = options.prompt.find((m) => m.role === 'system');
        systems.push(typeof system?.content === 'string' ? system.content : undefined);
        return {
          content: [{ type: 'text', text: 'A shipped migration is never edited.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        } as never;
      },
    });
    const host = createModelHost({
      env: { ANTHROPIC_API_KEY: 'k' },
      factories: { anthropic: () => () => mock as never },
      sent: 'Customer messages and the knowledge-base excerpts they match',
    });
    return { systems, host };
  };

  const excerpt: RetrievedArticle = {
    id: 'a1',
    title: 'Migrations',
    url: 'https://docs.example/migrations',
    body: 'Append a new migration; a shipped one is never edited.',
  };
  const earlier: PriorMessage[] = [{ role: 'customer', text: 'Is there a changelog?' }];

  /**
   * The system string is metered like every other token of input, so instructions
   * about a conversation that is not there are a bill for being told to ignore
   * something. A conversation costs what it carries; a first message costs what it
   * always did.
   */
  it('says nothing about a conversation until there is one', async () => {
    const { systems, host } = listening();
    const model = platformModel(host, 'anthropic:claude-sonnet-5', attributionFor(world.substrat));

    await model.answer({ question: 'Can I edit a shipped migration?', context: [excerpt], history: [] });
    await model.answer({
      question: 'And last week?',
      context: [excerpt],
      history: earlier,
    });

    const [first, following] = systems;
    expect(first).toBeDefined();
    expect(first?.toLowerCase()).not.toContain('conversation');
    // What it does say is unchanged, and the conversation instructions are added to it
    // rather than woven through — so the two turns cannot drift apart.
    expect(following?.startsWith(first!)).toBe(true);
    expect(following).toContain('never a source of facts about the product');
    expect(following!.length).toBeGreaterThan(first!.length);
  });
});
