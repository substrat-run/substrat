import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * The router: the one component that knows who a dispatch is for.
 *
 * Two doors to the store, both decided by the identity the router set, never by
 * what the vertical says:
 *
 * - `StoreCalls` is today's path (#2207): the vertical fetches `store.substrat.internal`,
 *   the egress worker hands the call here with the caller it was dispatched with.
 * - `StoreDoor` is the candidate for a call from inside a scope: a request-scoped
 *   capability the router mints with `ctx.exports.StoreDoor({ props })` and hands to the
 *   vertical with the dispatch (on Workers for Platforms, through dynamic dispatch
 *   `props`). The vertical can call its methods. It cannot read or change its props.
 *
 * Both address the store object the same way. In production the router signs a K-52
 * envelope and goes through the dispatch namespace to the store script. Here it holds a
 * direct binding to the store script, because the signing and the namespace hop are the
 * same on both paths and are not what this spike compares.
 */

function storeFor(env, caller, binding) {
  const declared = caller.stores.includes(binding);
  if (!declared) {
    const error = new Error(`store call refused: '${binding}' is not a store this version declares`);
    error.name = 'StoreRefused';
    throw error;
  }
  const name = `${caller.tenant}/${caller.vertical}/${caller.scope}/${binding}`;
  return env.STORE.get(env.STORE.idFromName(name));
}

export class StoreDoor extends WorkerEntrypoint {
  /** The vertical names a binding and an input. The scope is the props', not an argument. */
  async read(binding, input) {
    const answer = await storeFor(this.env, this.ctx.props, binding).read(input);
    return answer;
  }
}

export class StoreCalls extends WorkerEntrypoint {
  async invoke(caller, request) {
    if (request.scopeId !== caller.scope) {
      return { ok: false, status: 403, message: 'store call refused: this dispatch reaches only its own scope' };
    }
    try {
      const answer = await storeFor(this.env, caller, request.binding).read(request.input);
      return { ok: true, status: 200, body: { result: answer } };
    } catch (error) {
      return { ok: false, status: 404, message: String(error?.message ?? error) };
    }
  }
}

/**
 * The dispatch. `GET /run?mode=…&scope=…&bytes=…&delayMs=…`. The caller identity is fixed
 * here, as the router fixes it from the hostname.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope') ?? 'scope-1';
    const caller = { tenant: 'tenant-a', vertical: 'todo', scope, stores: ['GRAPH'] };
    const door = ctx.exports.StoreDoor({ props: caller });
    const args = {
      mode: url.searchParams.get('mode') ?? 'local',
      scope,
      binding: url.searchParams.get('binding') ?? 'GRAPH',
      bytes: Number(url.searchParams.get('bytes') ?? '0'),
      delayMs: Number(url.searchParams.get('delayMs') ?? '0'),
      tag: url.searchParams.get('tag') ?? '',
      failAfter: url.searchParams.get('failAfter') === '1',
      txn: url.searchParams.get('txn') !== '0',
      grantMs: Number(url.searchParams.get('grantMs') ?? '1000'),
    };
    if (url.pathname === '/bench') return bench(env, door, args, url.searchParams);
    if (url.pathname === '/gate') return gate(env, door, args, caller);
    try {
      const result = await env.VERTICAL.run(args, door);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({ ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` }, { status: 500 });
    }
  },
};

/**
 * Timing inside workerd, so the miniflare proxy between Node and workerd is not measured.
 * `Date.now()` here advances across I/O, which is all that is timed.
 *
 * - `kind=seq`: `n` calls of `mode`, one at a time. Returns each call's ms.
 * - `kind=stall`: `reads` calls of `mode` started together, then, after the first has been
 *   had 2 ms, `locals` local operations on the same scope. Returns each local op's ms and the
 *   time until every read had answered.
 */
async function bench(env, door, args, params) {
  const kind = params.get('kind');
  const timed = async (callArgs) => {
    const started = Date.now();
    await env.VERTICAL.run(callArgs, door);
    return Date.now() - started;
  };
  if (kind === 'seq') {
    const n = Number(params.get('n') ?? '50');
    const times = [];
    for (let i = 0; i < n; i += 1) times.push(await timed(args));
    return Response.json({ times });
  }
  const reads = Number(params.get('reads') ?? '20');
  const locals = Number(params.get('locals') ?? '20');
  const started = Date.now();
  const readCalls = Array.from({ length: reads }, () => timed(args));
  // 2 ms, so the reads are sent (and the first is in its transaction) before the locals.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const localCalls = Array.from({ length: locals }, () => timed({ ...args, mode: 'local', tag: 'local' }));
  // Timed in its own continuation, so a read group that ends first is not charged for the locals.
  const allReads = Promise.all(readCalls).then(() => Date.now() - started);
  const [localMs, allReadsMs] = await Promise.all([Promise.all(localCalls), allReads]);
  return Response.json({ localMs, allReadsMs });
}

/**
 * The gate probe, run inside workerd, ordered by a handshake rather than by time. The held
 * operation's store read is held by the store until the router releases it. The router waits
 * until the store reports the read held, sends the second call, and gives that call a chance
 * to finish while the read is still held. Then it releases the read through the store, which
 * is a path independent of the scope. Whether the second call finished before the release,
 * and the rows left behind, are the results. The in-object times are diagnostics only.
 */
async function gate(env, door, args, caller) {
  const store = env.STORE.get(env.STORE.idFromName(`${caller.tenant}/${caller.vertical}/${caller.scope}/${args.binding}`));
  const hold = env.VERTICAL.run({ ...args, mode: 'gate-hold' }, door);
  const waitStarted = Date.now();
  while ((await store.pending()) === 0) {
    if (Date.now() - waitStarted > 5000) return Response.json({ error: 'the read never started' }, { status: 500 });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  let writeDone = false;
  const write = env.VERTICAL.run({ ...args, mode: 'gate-write' }, door).then((result) => {
    writeDone = true;
    return result;
  });
  // A chance, not a bound: a held second call cannot finish however long this is.
  await Promise.race([write, new Promise((resolve) => setTimeout(resolve, args.grantMs))]);
  const finishedWhileHeld = writeDone;
  const releasedAt = Date.now();
  await store.release();
  const [written, held] = await Promise.all([write, hold]);
  const rows = await env.VERTICAL.run({ ...args, mode: 'rows' }, door);
  return Response.json({ finishedWhileHeld, releasedAt, ranAt: written.ranAt, ...held, rows });
}
