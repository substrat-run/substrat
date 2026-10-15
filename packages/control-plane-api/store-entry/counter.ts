import { DurableObject } from 'cloudflare:workers';

/**
 * The test kind. Its counter moves only when the entry constructed it and handed it a call.
 * `env` answers the binding names the kind was constructed with, `echo` the exact body it
 * received, `arm` sets an alarm and `alarmed` counts the alarms the entry forwarded. The
 * reserved operations answer the way a kind's must, from the counter.
 */
export class CounterStore extends DurableObject<Record<string, unknown>> {
  override async fetch(request: Request): Promise<Response> {
    const raw = await request.text();
    const body = JSON.parse(raw) as { operation?: string; input?: { by?: number } };
    const current = (await this.ctx.storage.get<number>('n')) ?? 0;
    switch (body.operation) {
      case 'read':
        return Response.json({ result: current });
      case 'env':
        return Response.json({ result: Object.keys(this.env).sort() });
      case 'echo':
        return Response.json({ result: raw });
      case 'arm':
        await this.ctx.storage.setAlarm(Date.now());
        return Response.json({ result: null });
      case 'alarmed':
        return Response.json({ result: (await this.ctx.storage.get<number>('alarms')) ?? 0 });
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
