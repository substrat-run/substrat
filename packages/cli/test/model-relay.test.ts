import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_TOKEN_REFRESH_MARGIN_MS, startModelRelay, type ModelRelay, type RelayAccess } from '../src/model-relay.js';
import { modelAccessFor } from '../src/dev-models.js';

/**
 * `substrat dev`'s model relay (#3420): the app holds a loopback URL and a per-run key, and the
 * relay holds the workspace's short-lived token, replacing it before it runs out.
 */

const relays: ModelRelay[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLANE = 'https://cp.test/api/model-access/TENANT/v1';

function world(answer: (token: string) => Response = () => new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })) {
  let clock = Date.parse('2026-11-27T10:00:00Z');
  let issued = 0;
  const calls: { url: string; authorization: string | null; metadata: string | null; body: string }[] = [];
  const issue = async (): Promise<RelayAccess> => {
    issued++;
    return { token: `t${issued}`, expiresAt: new Date(clock + 15 * 60_000).toISOString(), tenant: { id: 'TENANT', slug: 'acme' }, baseUrl: PLANE };
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get('authorization'), metadata: headers.get('cf-aig-metadata'), body: new TextDecoder().decode(init.body as Uint8Array) });
    return answer(headers.get('authorization')!.slice(7));
  }) as typeof globalThis.fetch;
  return {
    calls,
    issued: () => issued,
    advance: (ms: number) => (clock += ms),
    start: async () => {
      const relay = await startModelRelay({ issue, fetch, now: () => clock });
      relays.push(relay);
      return relay;
    },
  };
}

const chat = (relay: ModelRelay, key = relay.key, path = '/chat/completions') =>
  globalThis.fetch(`${relay.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'cf-aig-metadata': '{"vertical":"@acme/shop"}' },
    body: JSON.stringify({ model: '@cf/meta/llama-3.1-8b-instruct', stream: true, messages: [] }),
  });

describe('substrat dev model relay', () => {
  it('forwards a chat call on the held token, and refuses another key or path', async () => {
    const w = world();
    const relay = await w.start();
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    expect((await chat(relay, 'guess')).status).toBe(401);
    expect((await chat(relay, relay.key, '/models')).status).toBe(404);
    const res = await chat(relay);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('[DONE]');
    expect(w.calls).toEqual([
      {
        url: `${PLANE}/chat/completions`,
        authorization: 'Bearer t1',
        metadata: '{"vertical":"@acme/shop"}',
        body: JSON.stringify({ model: '@cf/meta/llama-3.1-8b-instruct', stream: true, messages: [] }),
      },
    ]);
  });

  it('replaces a token near its expiry, and one the plane refuses, once', async () => {
    const w = world((token) => (token === 't2' ? new Response('expired', { status: 401 }) : Response.json({ ok: true })));
    const relay = await w.start();
    await (await chat(relay)).text();
    await (await chat(relay)).text();
    expect(w.issued()).toBe(1);

    w.advance(15 * 60_000 - MODEL_TOKEN_REFRESH_MARGIN_MS + 1);
    const res = await chat(relay);
    expect(res.status).toBe(200);
    expect(w.calls.map((c) => c.authorization)).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t2', 'Bearer t3']);
  });

  it('stays out of the way of a project that uses no models, or brings its own key in the environment or .env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-dev-models-'));
    dirs.push(dir);
    const lines: string[] = [];
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ substrat: { slug: 'shop' } }));
    expect(await modelAccessFor(dir, {}, {}, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ substrat: { slug: 'shop', usesModels: true } }));
    expect(await modelAccessFor(dir, { CLOUDFLARE_AI_API_TOKEN: 'own' }, {}, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual(['models: using CLOUDFLARE_AI_* from your environment (unset them to use your substrat login)']);

    writeFileSync(join(dir, '.env'), '# a key of its own\nCLOUDFLARE_AI_API_TOKEN=own\n');
    expect(await modelAccessFor(dir, {}, {}, (l) => lines.push(l))).toBeUndefined();
    expect(lines.at(-1)).toBe('models: using CLOUDFLARE_AI_* from .env (remove them to use your substrat login)');
  });
});
