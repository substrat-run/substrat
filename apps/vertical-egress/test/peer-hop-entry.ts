import { WorkerEntrypoint } from 'cloudflare:workers';
import { traceIdOf } from '@substrat-run/contracts';
import { ControlPlaneDO } from '../../../packages/adapter-cloudflare/src/control-plane-do.js';
import { handlePeerCall, type Env } from '../../router/src/worker.js';

/**
 * The router for the peer-hop probe (peer-hop.workerd.test.ts, #3395 follow-up): the production
 * `handlePeerCall` over a real directory object and a real KV namespace, with each binding it
 * touches timed and the time kept under the call's trace id (#3386). Miniflare's local dispatch
 * namespace hosts no user worker, so `DISPATCH.get` fetches the one target the probe bound.
 */

/** One call's hops, as the router saw them. Epoch ms: workerd advances the clock at I/O. */
interface Hops {
  routerEnter: number;
  directory: { calls: number; ms: number };
  kv: { calls: number; ms: number };
  dispatchStart?: number;
  routerExit?: number;
}

const hops = new Map<string, Hops>();
let mode = 'off';

const timed = async <T>(bucket: { calls: number; ms: number }, f: () => Promise<T>): Promise<T> => {
  const at = Date.now();
  try {
    return await f();
  } finally {
    bucket.calls += 1;
    bucket.ms += Date.now() - at;
  }
};

interface ProbeEnv {
  CONTROL_PLANE: DurableObjectNamespace;
  ROUTES: KVNamespace;
  TARGET: Fetcher;
}

/** The directory the router reads, with the read model on (the KV namespace is bound as `ROUTES`). */
export class ProbeControlPlaneDO extends ControlPlaneDO {
  seed(statements: Array<[string, ...unknown[]]>): void {
    for (const [sql, ...params] of statements) this.ctx.storage.sql.exec(sql, ...params);
  }
}

export class PeerCalls extends WorkerEntrypoint<ProbeEnv> {
  async invoke(caller: unknown, request: unknown, context?: unknown) {
    const trace = traceIdOf((context as { traceparent?: unknown } | undefined)?.traceparent) ?? 'none';
    const h: Hops = { routerEnter: Date.now(), directory: { calls: 0, ms: 0 }, kv: { calls: 0, ms: 0 } };
    hops.set(trace, h);
    const cp = this.env.CONTROL_PLANE;
    const routes = this.env.ROUTES;
    const env = {
      PLATFORM_SECRET: 'probe',
      PEER_READ_MODEL: mode,
      CONTROL_PLANE: {
        idFromName: (name: string) => cp.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = cp.get(id) as unknown as { peerCallTarget(...a: unknown[]): Promise<unknown> };
          return { peerCallTarget: (...a: unknown[]) => timed(h.directory, () => stub.peerCallTarget(...a)) };
        },
      },
      ROUTES: { get: (key: string, opts: unknown) => timed(h.kv, () => routes.get(key, opts as never)) },
      DISPATCH: {
        get: () => ({
          fetch: (req: Request) => {
            h.dispatchStart = Date.now();
            return this.env.TARGET.fetch(req);
          },
        }),
      },
    } as unknown as Env;
    const out = await handlePeerCall(env, caller, request, context, this.ctx);
    h.routerExit = Date.now();
    return out;
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
      seed(statements: unknown[]): Promise<void>;
      settleRouteReadModel(): Promise<void>;
    };
    if (url.pathname === '/seed') {
      await dir.seed((await request.json()) as unknown[]);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/settle') {
      await dir.settleRouteReadModel();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/mode') {
      mode = url.searchParams.get('m') ?? 'off';
      return Response.json({ mode });
    }
    if (url.pathname === '/hops') return Response.json(hops.get(url.searchParams.get('trace') ?? '') ?? null);
    return new Response('peer-hop router', { status: 404 });
  },
};
