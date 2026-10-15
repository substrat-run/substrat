/**
 * Placement B: one Durable Object per thread holds the WebSocket (hibernating) and the
 * run. The record is still the source of truth and is written first; the object adds a
 * place for a live tail to attach to and a single instance with authority, so a dead run
 * can be recovered by the object itself (an alarm) without waiting for a client.
 */
import { DurableObject } from 'cloudflare:workers';
import { Record } from './record.mjs';
import { runTurn, currentTurn, Fenced, Died } from './loop.mjs';
import { digestOf } from './protocol.mjs';

export { Record };

const STALE_MS = 3000;
const WATCHDOG_MS = 1500;

export class ThreadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.running = false;
    this.thread = null;
    // Counts how many times this object was constructed: the evidence for hibernation
    // and eviction, since a constructor runs again on every wake.
    ctx.blockConcurrencyWhile(async () => {
      this.boots = ((await ctx.storage.get('boots')) ?? 0) + 1;
      await ctx.storage.put('boots', this.boots);
      this.thread = (await ctx.storage.get('thread')) ?? null;
    });
  }

  rec() {
    return this.env.RECORD.get(this.env.RECORD.idFromName(this.thread));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const thread = url.pathname.split('/')[2];
    if (!this.thread) {
      this.thread = thread;
      await this.ctx.storage.put('thread', thread);
    }
    if (url.pathname.endsWith('/state')) {
      return Response.json({ boots: this.boots, running: this.running, sockets: this.ctx.getWebSockets().length, record: await this.rec().state() });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sent: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push persisted events to every attached socket that has not seen them. */
  deliver(events) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() ?? { sent: 0 };
      const fresh = events.filter((e) => e.id > att.sent);
      if (fresh.length === 0) continue;
      for (const e of fresh) ws.send(JSON.stringify(e));
      ws.serializeAttachment({ sent: fresh[fresh.length - 1].id });
    }
  }

  async webSocketMessage(ws, raw) {
    const msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (msg.type === 'hello') {
      // Replay what the client has not seen, then it is attached for the live tail.
      const events = await this.rec().read(msg.after ?? 0);
      ws.serializeAttachment({ sent: msg.after ?? 0 });
      for (const e of events) ws.send(JSON.stringify(e));
      if (events.length) ws.serializeAttachment({ sent: events[events.length - 1].id });
      ws.send(JSON.stringify({ t: 'attached', boots: this.boots }));
      await this.recoverIfDead(msg.opts ?? {});
      return;
    }
    if (msg.type === 'send') {
      await this.start({ first: [{ t: 'user-message', text: msg.text }, { t: 'turn-start' }], opts: msg.opts ?? {} }, ws);
      return;
    }
    if (msg.type === 'approve') {
      const turn = currentTurn(await this.rec().read(0));
      const ask = turn.find((e) => e.t === 'approval-request' && e.callId === msg.callId);
      if (!ask) return ws.send(JSON.stringify({ t: 'error', error: 'no_such_request' }));
      if (turn.some((e) => e.t === 'approval-resolved' && e.callId === msg.callId)) {
        return ws.send(JSON.stringify({ t: 'error', error: 'already_resolved' }));
      }
      if (msg.digest !== ask.digest || msg.digest !== (await digestOf(ask.input))) {
        return ws.send(JSON.stringify({ t: 'error', error: 'digest_mismatch' }));
      }
      await this.start({ first: [{ t: 'approval-resolved', callId: msg.callId, approved: msg.approved !== false }], opts: msg.opts ?? {} }, ws);
    }
  }

  async start({ first, opts, force = false }, ws) {
    if (this.running) return ws?.send(JSON.stringify({ t: 'error', error: 'busy' }));
    const rec = this.rec();
    const runId = crypto.randomUUID();
    // The object is the only holder it recognises, so after a reset it may take the lease
    // from its own dead previous run at once (`force`) instead of waiting out staleness.
    const lease = await rec.lease(runId, Date.now(), force ? 0 : STALE_MS);
    if (!lease.ok) return ws?.send(JSON.stringify({ t: 'error', error: 'busy' }));
    this.running = true;
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    const run = (async () => {
      let died = false;
      try {
        if (first?.length) {
          const res = await rec.append(runId, Date.now(), first);
          if (!res.ok) throw new Fenced('lease lost');
          this.deliver(res.events);
        }
        await runTurn({
          rec,
          runId,
          deliver: (events) => {
            this.deliver(events);
            void this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
          },
          flushMs: opts.flushMs ?? 50,
          model: opts.model ?? {},
          hooks: {
            afterStep: (n) => {
              if (opts.abortAfterStep === n) this.ctx.abort('chaos: simulated eviction');
              if (opts.dieAfterStep === n) throw new Died();
            },
            beforeEmit: (n) => {
              if (opts.abortAtEvent === n) this.ctx.abort('chaos: simulated eviction mid-step');
              if (opts.dieAtEvent === n) throw new Died();
            },
          },
        });
      } catch (err) {
        if (err instanceof Died) died = true;
        else if (!(err instanceof Fenced)) console.error('run failed', err);
      } finally {
        this.running = false;
        if (!died) {
          await rec.release(runId).catch(() => {});
          await this.ctx.storage.deleteAlarm().catch(() => {});
        }
      }
    })();
    this.ctx.waitUntil(run);
  }

  async recoverIfDead(opts) {
    if (this.running) return;
    const turn = currentTurn(await this.rec().read(0));
    const last = turn[turn.length - 1];
    if (last && last.t !== 'turn-finish' && last.t !== 'turn-error') {
      await this.start({ first: null, opts, force: true });
    }
  }

  async alarm() {
    if (this.running) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      return;
    }
    await this.recoverIfDead({});
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/b\/([^/]+)/);
    if (!m) return Response.json({ error: 'not_found' }, { status: 404 });
    const stub = env.THREAD.get(env.THREAD.idFromName(m[1]));
    return stub.fetch(req);
  },
};
