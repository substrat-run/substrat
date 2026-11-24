// A toy vertical, the size of the question and no bigger: a scope Durable Object that keeps facts,
// an outbox and an idempotency record in one transaction, and a Workflow whose every step is one
// scope operation. Not Substrat's kernel: the shapes are the kernel's (an operation with a key
// recorded in its own transaction, an outbox row committed with its fact, a primary flag that
// decides whether an outbound effect leaves), so what the engine does to them is what it would do
// to the real ones.
//
// Two bindings vary per run, to stand for two versions of the same vertical:
//   CODE_VERSION  stamped on every fact a step writes, so a fact says which code ran it
//   STEP_PLAN     'v1' | 'renamed' | 'inserted': the step list a promote might change
//   PRIMARY       '1' for the real install, '0' for a preview's copy (#2005)
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS facts (seq INTEGER PRIMARY KEY, kind TEXT, ref TEXT, actor TEXT, via TEXT, code TEXT)`,
  `CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, type TEXT, ref TEXT)`,
  `CREATE TABLE IF NOT EXISTS idem (key TEXT PRIMARY KEY, input TEXT, result TEXT)`,
  `CREATE TABLE IF NOT EXISTS effects (seq INTEGER PRIMARY KEY, ref TEXT, state TEXT)`,
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER)`,
];

/** The instance a scope rings for an order: derived, so the scope needs no lookup table. */
export const instanceIdFor = (scope, orderId) => `flow-${scope}-${orderId}`;

export class ScopeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    for (const s of SCHEMA) ctx.storage.sql.exec(s);
  }

  /**
   * One operation, the kernel's shape: with a key, a first call runs and records its result in the
   * same transaction; a second call under the key returns the record without running; a second
   * call with a different input is refused.
   */
  async invoke(op, input, { idempotencyKey, actor, via }) {
    const sql = this.ctx.storage.sql;
    const code = this.env.CODE_VERSION;
    const inputText = JSON.stringify({ op, input });
    const outcome = this.ctx.storage.transactionSync(() => {
      if (idempotencyKey) {
        const prior = sql.exec('SELECT input, result FROM idem WHERE key = ?', idempotencyKey).toArray()[0];
        if (prior) {
          if (prior.input !== inputText) throw new Error(`idempotency key ${idempotencyKey} reused with a different input`);
          return { ...JSON.parse(prior.result), replayed: true };
        }
      }
      let result;
      switch (op) {
        case 'open-order':
        case 'close-order':
        case 'note':
          sql.exec('INSERT INTO facts (kind, ref, actor, via, code) VALUES (?, ?, ?, ?, ?)', op, input.orderId, actor, via, code);
          result = { op, orderId: input.orderId, code };
          break;
        case 'approve':
          sql.exec('INSERT INTO facts (kind, ref, actor, via, code) VALUES (?, ?, ?, ?, ?)', op, input.orderId, actor, via, code);
          sql.exec('INSERT INTO outbox (type, ref) VALUES (?, ?)', 'orders.approved', input.orderId);
          result = { op, orderId: input.orderId, code };
          break;
        case 'request-effect': {
          // The #2005 gate, in one line: a copy records the effect as held, never as sent.
          const state = this.env.PRIMARY === '1' ? 'sent' : 'held';
          sql.exec('INSERT INTO effects (ref, state) VALUES (?, ?)', input.orderId, state);
          result = { op, state };
          break;
        }
        default:
          throw new Error(`unknown operation ${op}`);
      }
      if (idempotencyKey) sql.exec('INSERT INTO idem (key, input, result) VALUES (?, ?, ?)', idempotencyKey, inputText, JSON.stringify(result));
      return { ...result, replayed: false };
    });
    // After the commit, never inside it (K-62): ring the instance waiting on this order. The bell
    // carries no payload. The instance reads the fact from the scope, which stays the only copy.
    if (op === 'approve' && !outcome.replayed && input.ring !== false) await this.ring(input.scope, input.orderId);
    return outcome;
  }

  async ring(scope, orderId) {
    try {
      const instance = await this.env.FLOW.get(instanceIdFor(scope, orderId));
      await instance.sendEvent({ type: 'doorbell', payload: { orderId } });
      this.bump('rings-sent');
    } catch (err) {
      this.bump('rings-failed');
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO counters (name, n) VALUES (?, 0)', `ring-error:${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  /** The scope's outbox since a watermark, the read a waiting instance makes after a bell. */
  eventsSince(after, type) {
    return this.ctx.storage.sql.exec('SELECT seq, type, ref FROM outbox WHERE seq > ? AND type = ? ORDER BY seq', after, type).toArray();
  }

  bump(name) {
    const sql = this.ctx.storage.sql;
    sql.exec('INSERT INTO counters (name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1', name);
    return sql.exec('SELECT n FROM counters WHERE name = ?', name).one().n;
  }

  dump() {
    const sql = this.ctx.storage.sql;
    return {
      facts: sql.exec('SELECT kind, ref, actor, via, code FROM facts ORDER BY seq').toArray(),
      outbox: sql.exec('SELECT seq, type, ref FROM outbox ORDER BY seq').toArray(),
      effects: sql.exec('SELECT ref, state FROM effects ORDER BY seq').toArray(),
      counters: Object.fromEntries(sql.exec('SELECT name, n FROM counters').toArray().map((r) => [r.name, r.n])),
    };
  }
}

const scopeOf = (env, scope) => env.SCOPE.get(env.SCOPE.idFromName(scope));

/**
 * The process engine's candidate shape (RFC §7.6): an instance holds how far a flow has got, every
 * step is one scope operation under a key made from the instance and the step, a wait on a person
 * is a wait for an event.
 */
export class OrderFlow extends WorkflowEntrypoint {
  async run(event, step) {
    const { scope, orderId, mode = 'doorbell', failFirstAttempt = false, fetchUrl, nap = false } = event.payload;
    const id = event.instanceId;
    const plan = this.env.STEP_PLAN ?? 'v1';
    const op = (name, operation, extra = {}) =>
      step.do(name, { retries: { limit: 2, delay: '200 milliseconds' } }, async () => {
        const result = await scopeOf(this.env, scope).invoke(
          operation,
          { orderId, ...extra },
          { idempotencyKey: `${id}:${name}`, actor: 'app', via: 'workflow' },
        );
        // A step that dies after its operation committed, before its result is recorded: the
        // retry must not run the operation twice.
        if (failFirstAttempt && name === 'open' && (await scopeOf(this.env, scope).bump(`attempt:${id}`)) === 1) {
          throw new Error('step died after its operation committed');
        }
        return result;
      });

    if (plan === 'renamed') await op('open-order', 'open-order');
    else await op('open', 'open-order');
    if (plan === 'inserted') await op('note-inserted', 'note');

    if (fetchUrl) {
      // A step that reaches the network itself instead of through a scope operation. What happened
      // is counted in the scope: an outbound worker answers with a body starting `outbound-saw`.
      await step.do('direct-fetch', async () => {
        let outcome;
        try {
          const res = await fetch(fetchUrl);
          outcome = (await res.text()).startsWith('outbound-saw') ? 'outbound' : 'reached';
        } catch {
          outcome = 'refused';
        }
        await scopeOf(this.env, scope).bump(`direct-fetch:${outcome}`);
        return outcome;
      });
    }
    await op('effect', 'request-effect');
    // A wait on a time: long enough for the harness to ring or restart during it.
    if (nap) await step.sleep('nap', typeof nap === 'string' ? nap : '2 seconds');

    if (mode === 'payload') {
      // The event IS the fact: a second delivery is a second fact.
      const first = await step.waitForEvent('wait-approved', { type: 'doorbell', timeout: '1 hour' });
      const second = await step.waitForEvent('wait-approved-again', { type: 'doorbell', timeout: '2 seconds' }).catch(() => null);
      return { mode, first: first.payload, second: second?.payload ?? null };
    }

    // The bell is a hint, the scope is the truth: after each bell, read the outbox; ring again
    // until the order's event is there. A repeated bell finds the same row; an early bell is
    // buffered by the engine (or, at worst, the read finds the row anyway).
    let found = null;
    for (let n = 1; n <= 5 && !found; n++) {
      await step.waitForEvent(`bell-${n}`, { type: 'doorbell', timeout: '1 hour' });
      found = await step.do(`check-${n}`, async () => {
        const rows = await scopeOf(this.env, scope).eventsSince(0, 'orders.approved');
        return rows.find((r) => r.ref === orderId) ?? null;
      });
    }
    await op('close', 'close-order');
    return { mode, found, closedBy: this.env.CODE_VERSION };
  }
}

/** The vertical's own routes. In a deployed vertical these sit behind the platform entry. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = Object.fromEntries(url.searchParams);
    const via = request.headers.get('x-spike-gate') === 'passed' ? 'gate' : 'ungated';
    const json = (v) => Response.json(v);
    try {
      switch (url.pathname) {
        case '/start': {
          const instance = await env.FLOW.create({ id: instanceIdFor(q.scope, q.orderId), params: JSON.parse(q.params ?? '{}') });
          return json({ id: instance.id });
        }
        case '/status':
          return json(await (await env.FLOW.get(q.id)).status());
        case '/bell':
          await (await env.FLOW.get(q.id)).sendEvent({ type: 'doorbell', payload: { n: q.n } });
          return json({ sent: true });
        case '/approve':
          return json(await scopeOf(env, q.scope).invoke('approve', { scope: q.scope, orderId: q.orderId, ring: q.ring !== '0' }, { actor: 'person', via }));
        case '/dump':
          return json(await scopeOf(env, q.scope).dump());
        case '/terminate':
          await (await env.FLOW.get(q.id)).terminate();
          return json({ terminated: true });
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      return json({ error: String(err?.message ?? err) });
    }
  },
};
