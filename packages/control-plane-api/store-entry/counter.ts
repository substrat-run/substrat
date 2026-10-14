import { DurableObject } from 'cloudflare:workers';

/** The test kind. Its counter moves only when the entry constructed it. */
export class CounterStore extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { operation?: string; input?: { by?: number } };
    const current = (await this.ctx.storage.get<number>('n')) ?? 0;
    if (body.operation === 'read') return Response.json({ result: current });
    const next = current + (body.input?.by ?? 1);
    await this.ctx.storage.put('n', next);
    return Response.json({ result: next });
  }
}
