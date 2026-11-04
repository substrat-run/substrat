import { DurableObject, env as ambient } from 'cloudflare:workers';

/**
 * The test driver. Its counter moves only when the entry constructed it and handed it a call.
 * `env` answers the binding names the driver was constructed with, `ambient` the ones its module
 * reads from `cloudflare:workers`, `exports` what `ctx.exports` reaches, `echo` the exact body it
 * received, `arm` sets an alarm and `alarmed` counts the alarms the entry forwarded, `seen`
 * counts the calls this instance has had (in memory, so a driver built per call answers 1).
 * `refuse` answers a 404 refusal in the envelope, `fail` a 500 one carrying a traceback, and
 * `garble` a 500 that is not the envelope. The reserved operations answer the way a driver's
 * must, from the counter.
 */
export class CounterStore extends DurableObject<Record<string, unknown>> {
  #seen = 0;

  override async fetch(request: Request): Promise<Response> {
    this.#seen += 1;
    const raw = await request.text();
    const body = JSON.parse(raw) as { operation?: string; input?: { by?: number } };
    const current = (await this.ctx.storage.get<number>('n')) ?? 0;
    switch (body.operation) {
      case 'read':
        return Response.json({ result: current });
      case 'env':
        return Response.json({ result: Object.keys(this.env).sort() });
      case 'ambient':
        return Response.json({ result: Object.keys((ambient ?? {}) as object).sort() });
      case 'exports': {
        // Looked up by name: a loopback export need not be enumerable.
        const exports: unknown = Reflect.get(this.ctx, 'exports');
        const reached = ['SubstratStoreObject', 'default'].filter(
          (name) => exports !== null && typeof exports === 'object' && Reflect.get(exports, name) !== undefined,
        );
        return Response.json({ result: reached });
      }
      case 'echo':
        return Response.json({ result: raw });
      case 'seen':
        return Response.json({ result: this.#seen });
      case 'arm':
        await this.ctx.storage.setAlarm(Date.now());
        return Response.json({ result: null });
      case 'alarmed':
        return Response.json({ result: (await this.ctx.storage.get<number>('alarms')) ?? 0 });
      case 'refuse':
        return Response.json({ error: { code: 'session.unknown', status: 404, body: { message: 'no session s1' } } }, { status: 404 });
      case 'fail':
        return Response.json({ error: { code: 'host_failed', status: 500, body: 'Traceback: storage path /data/s1' } }, { status: 500 });
      case 'garble':
        return new Response('Traceback: storage path /data/s1', { status: 500 });
      case 'substrat.size':
        return Response.json({ result: { bytes: current } });
      default: {
        const next = current + (body.input?.by ?? 1);
        await this.ctx.storage.put('n', next);
        return Response.json({ result: next });
      }
    }
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.put('alarms', ((await this.ctx.storage.get<number>('alarms')) ?? 0) + 1);
  }
}
