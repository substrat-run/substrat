/**
 * The router in front of the shards: the Node stand-in for the router Worker +
 * `env.DISPATCH.get(ref)` of the issue's mapping, without the hostname half (that is
 * `createRouteResolver` against the control plane, and nothing about it changes with shards).
 *
 * It keeps NO placement table. For each request it walks the rendezvous order of the scope
 * (`placement.ts`) and caches only one fact per scope: the shard that last answered for it.
 * Shards correct it: a `421` names the holder, and the router goes there — including when
 * the holder is the shard it just gave up on after a timeout. A live lease means that shard
 * is slow rather than gone, so the router asks it again with a growing backoff; if it really
 * is gone, its lease runs out and the next `421` names someone else. All of it inside one
 * deadline per request.
 *
 * A write that got no answer is retried, with its `Idempotency-Key`, on the next shard in
 * the order: the router cannot know whether the dead shard committed it, so the retry must
 * be one the scope can recognise. That is the kernel's idempotency recording (#116), carried
 * from the client unchanged. A write WITHOUT a key is never retried once it may have run:
 * after a timeout or a `503` the router answers with the uncertainty instead, because a
 * replay could apply it twice. (A `421` is always safe to follow — the shard refused before
 * invoking anything.)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { candidates } from './placement.js';
import { readText, send, serveLocal } from './http.js';
import { exitWithParent } from './process.js';

const port = Number(process.env.PORT ?? 0);
/** Name → URL. Replaced whole by `POST /_members` when the StatefulSet is scaled. */
let members = JSON.parse(process.env.MEMBERS ?? '{}') as Record<string, string>;
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 1500);
const deadlineMs = Number(process.env.ROUTE_DEADLINE_MS ?? 20_000);

const cache = new Map<string, string>();

interface Forward {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

async function attempt(target: string, f: Forward): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${members[target]}${f.path}`, {
    method: f.method,
    headers: f.headers,
    body: f.method === 'GET' ? undefined : f.body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function route(scope: string, f: Forward): Promise<{ status: number; json: Record<string, unknown> }> {
  const until = Date.now() + deadlineMs;
  const suspects = new Set<string>();
  let backoffs = 0;
  const order = candidates(scope, Object.keys(members));
  let target = cache.get(scope) ?? order[0]!;
  const replaySafe = f.method === 'GET' || f.headers['idempotency-key'] !== undefined;
  const unknownOutcome = (why: string) => ({
    status: 503,
    json: { error: `${why}; not retried: the write carries no Idempotency-Key, so it may or may not have applied` },
  });
  while (Date.now() < until) {
    try {
      const r = await attempt(target, f);
      if (r.status === 421) {
        const holder = r.json.holder as string | undefined;
        if (holder && holder !== target && members[holder]) {
          if (suspects.has(holder)) {
            // The lease says the shard we gave up on still holds the scope: it is slow, not
            // gone, or it would have lost the lease. Ask it again, backing off each time.
            suspects.delete(holder);
            await sleep(Math.min(50 * 2 ** backoffs++, 400));
          }
          target = holder;
          continue;
        }
        // No holder named (the scope is between holders): wait a slice, ask again.
        await sleep(Math.min(Math.max(Number(r.json.retryAfterMs ?? 0), 50), 250));
        continue;
      }
      if (r.status === 503) {
        // Fenced: the shard lost the scope while running this request. Start over.
        if (!replaySafe) return unknownOutcome(`${target} lost the scope during the write`);
        cache.delete(scope);
        target = order.find((m) => !suspects.has(m)) ?? order[0]!;
        continue;
      }
      cache.set(scope, target);
      return { ...r, json: { ...r.json, routedBy: process.env.ROUTER_NAME ?? 'router' } };
    } catch {
      // No answer: timed out or the connection died. The shard may or may not have
      // committed — only the idempotency key can tell, on whoever serves the retry.
      if (!replaySafe) return unknownOutcome(`no answer from ${target}`);
      suspects.add(target);
      cache.delete(scope);
      const next = order.find((m) => !suspects.has(m));
      if (next) target = next;
      else {
        suspects.clear();
        await sleep(100);
        target = order[0]!;
      }
    }
  }
  return { status: 504, json: { error: `no shard answered for ${scope}` } };
}

serveLocal(process.env.ROUTER_NAME ?? 'router', port, async (req, res, path) => {
  if (req.method === 'POST' && path === '/_members') {
    members = JSON.parse(await readText(req)) as Record<string, string>;
    cache.clear();
    return send(res, 200, { members: Object.keys(members) });
  }
  const m = /^\/scopes\/([^/]+)\//.exec(path);
  if (!m) return send(res, 404, {});
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = req.headers['idempotency-key'];
  if (typeof key === 'string') headers['idempotency-key'] = key;
  const r = await route(decodeURIComponent(m[1]!), { method: req.method ?? 'GET', path, body: await readText(req), headers });
  send(res, r.status, r.json);
});
exitWithParent();
