import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

/**
 * The vertical: a worker (host code) and its scope's Durable Object.
 *
 * The ScopeDO runs every operation the way `packages/adapter-cloudflare/src/scope-do.ts`
 * does: on a per-scope `OperationQueue` (K-6, `serialization.ts`), inside
 * `ctx.storage.transaction(async …)` (the K-4 boundary). A store read awaited in an
 * operation is therefore awaited inside both.
 */

/** Copied from `packages/adapter-cloudflare/src/serialization.ts`. */
class OperationQueue {
  tail = Promise.resolve();
  enqueue(op) {
    const result = this.tail.then(op);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const STORE_CALL_URL = 'https://store.substrat.internal/invoke';

export class ScopeDO extends DurableObject {
  queue = new OperationQueue();
  /** Set by `stash-door`, to show what a stub kept past its request does. */
  stashed = null;

  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, tag TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL)',
    );
  }

  write(tag, kind, n = 0) {
    this.ctx.storage.sql.exec('INSERT INTO log (tag, kind, n) VALUES (?, ?, ?)', tag, kind, n);
  }

  /** One operation, queued and transactional: the production shape. */
  invoke(args, door) {
    return this.queue.enqueue(() =>
      this.ctx.storage.transaction(async () => {
        const read = (input) => this.readFrom(args.mode, door, args.binding, input);
        switch (args.mode) {
          case 'local':
          case 'attempt':
          case 'record':
            this.write(args.tag, args.mode, args.bytes);
            return { wrote: 1 };
          case 'inside-raw':
          case 'inside-door':
          case 'inside-fetch': {
            this.write(args.tag, 'before-read');
            const answer = await read({ bytes: args.bytes, delayMs: args.delayMs });
            this.write(args.tag, args.mode, answer.payload.length);
            if (args.failAfter) throw new Error('the operation threw after its read');
            return { bytes: answer.payload.length };
          }
          default:
            throw new Error(`unknown mode ${args.mode}`);
        }
      }),
    );
  }

  async readFrom(mode, door, binding, input) {
    if (mode === 'inside-door') return door.read(binding, input);
    if (mode === 'inside-raw') {
      // A raw binding to the store script, held by the vertical. Hosted uploads carry none.
      const name = `tenant-a/todo/${this.ctx.id.name ?? 'scope'}/${binding}`;
      return this.env.STORE.get(this.env.STORE.idFromName(name)).read(input);
    }
    // inside-fetch: the DO fetches the store host itself.
    const response = await fetch(STORE_CALL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeId: this.ctx.id.name, binding, operation: 'read', input }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`store call refused: ${JSON.stringify(body)}`);
    return body.result;
  }

  // ── Probes ───────────────────────────────────────────────────────────────────────────

  /**
   * The gate probe: the production transaction WITHOUT the queue. It writes, awaits the
   * store, and then throws if asked. Whatever another call wrote while it waited shows
   * whether the platform's input gate held that call out.
   */
  gateHold(args, door) {
    const body = async () => {
      this.write(args.tag, 'hold-before');
      await door.read(args.binding, { bytes: args.bytes, delayMs: args.delayMs });
      this.write(args.tag, 'hold-after');
      if (args.failAfter) throw new Error('the holding operation threw after its read');
      return { held: true };
    };
    // `txn=0`: the same await with no transaction around it, to tell the gate from the transaction.
    return args.txn ? this.ctx.storage.transaction(body) : body();
  }

  /** A second call that writes, with no queue and no transaction of its own. */
  gateWrite(args) {
    this.write(args.tag, 'interloper');
    return { wrote: 1 };
  }

  rows(tag) {
    return this.ctx.storage.sql.exec('SELECT kind FROM log WHERE tag = ? ORDER BY id', tag).toArray().map((r) => r.kind);
  }

  stashDoor(door) {
    // Kept as received. A stub handed in as an RPC argument belongs to the request that
    // carried it; whether it can be used after that request is what the probe asks.
    this.stashed = door;
    return { stashed: true };
  }

  async useStashed(args) {
    if (!this.stashed) return { outcome: 'nothing stashed' };
    try {
      const answer = await this.stashed.read(args.binding, { bytes: 3 });
      return { outcome: 'answered', bytes: answer.payload.length };
    } catch (error) {
      return { outcome: 'refused', error: `${error?.name}: ${error?.message}` };
    }
  }

  async armAlarm() {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alarm_result (id INTEGER PRIMARY KEY, outcome TEXT)');
    this.ctx.storage.sql.exec('DELETE FROM alarm_result');
    await this.ctx.storage.setAlarm(Date.now() + 10);
    return { armed: true };
  }

  async alarm() {
    const result = await this.useStashed({ binding: 'GRAPH' });
    this.ctx.storage.sql.exec('INSERT INTO alarm_result (outcome) VALUES (?)', JSON.stringify(result));
  }

  alarmResult() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alarm_result (id INTEGER PRIMARY KEY, outcome TEXT)');
    const row = this.ctx.storage.sql.exec('SELECT outcome FROM alarm_result').toArray()[0];
    return row ? JSON.parse(row.outcome) : null;
  }
}

export default class Vertical extends WorkerEntrypoint {
  async run(args, door) {
    const scope = this.env.SCOPE.getByName(args.scope);
    switch (args.mode) {
      case 'local':
      case 'inside-raw':
      case 'inside-door':
      case 'inside-fetch':
        return scope.invoke(args, door);
      case 'host': {
        // K-64's shape: commit an attempt, host code makes the call, a second operation records it.
        await scope.invoke({ ...args, mode: 'attempt' });
        const response = await fetch(STORE_CALL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scopeId: args.scope,
            binding: args.binding,
            operation: 'read',
            input: { bytes: args.bytes, delayMs: args.delayMs },
          }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(`store call refused: ${JSON.stringify(body)}`);
        await scope.invoke({ ...args, mode: 'record', bytes: body.result.payload.length });
        return { bytes: body.result.payload.length };
      }
      case 'host-door': {
        // The same shape, with host code calling the door instead of fetching through egress.
        await scope.invoke({ ...args, mode: 'attempt' });
        const answer = await door.read(args.binding, { bytes: args.bytes, delayMs: args.delayMs });
        await scope.invoke({ ...args, mode: 'record', bytes: answer.payload.length });
        return { bytes: answer.payload.length };
      }
      case 'gate-hold':
        return scope.gateHold(args, door);
      case 'gate-write':
        return scope.gateWrite(args);
      case 'rows':
        return scope.rows(args.tag);
      case 'stash-door':
        return scope.stashDoor(door);
      case 'use-stashed':
        return scope.useStashed(args);
      case 'arm-alarm':
        return scope.armAlarm();
      case 'alarm-result':
        return scope.alarmResult();
      default:
        throw new Error(`unknown mode ${args.mode}`);
    }
  }

  fetch() {
    return new Response('reached through the router only', { status: 404 });
  }
}
