/**
 * The per-response field walk (#1331): which DECLARED output fields a response carried,
 * written onto the invocation record — and nothing at all while the switch is off.
 *
 * Driven through `mountOperations` on a real Hono app, and end to end through the
 * platform's own entry (`withInvocationLog`) for the line, because the record is only worth
 * what reaches the line.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  z,
  DECLARED_OUTPUT_FIELDS_MAX,
  encodeInvocationRecord,
  FIELD_COVERAGE_HEADER,
  INVOCATION_RECORD_HEADER,
} from '@substrat-run/contracts';
import { withInvocationLog, type InvocationRecord } from '../src/invocation-log.js';
import { ARMED, DISPATCH, ENV, quietly, ROUTER_SECRET as SECRET_ROUTER, routed, stampInto } from './routed.js';
import { mountOperations } from '../src/operations-routes.js';
import { observeOutputFields, outputWalkOf } from '../src/field-coverage.js';

/** A value no record may ever contain. */
const SECRET = 'value-4c1d-never-recorded@example.com';

const card = z.object({ id: z.string(), title: z.string(), note: z.string().optional(), owner_email: z.string() });

type Respond = (c: unknown, result: unknown) => Response | Promise<Response>;

/** One declared operation, a stub answering `result`, and the record the middleware hands down. */
function harness(decl: Record<string, unknown>, result: () => unknown, opts: { respond?: Respond } = {}) {
  const record: InvocationRecord = {};
  const app = new Hono<{ Bindings: typeof ENV }>();
  stampInto(app, record);
  mountOperations(
    app,
    { 'acme/op': { ...decl, http: { method: 'GET', path: '/op' } } },
    async () =>
      ({
        invoke: async () => result(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    { mcp: false, ...(opts.respond ? { respond: opts.respond as never } : {}) },
  );
  const call = (headers: Record<string, string> = {}) => quietly(async () => app.request('/api/op', { headers }, ENV));
  return { record, call };
}

/**
 * A result that counts every way it is looked at. The walk may ask about declared names;
 * it must never enumerate the result (`ownKeys`), which is what keeps it O(declared).
 */
function spied<T extends object>(target: T) {
  const touched: string[] = [];
  const proxy = new Proxy(target, {
    get(t, k, r) {
      // An async stub resolving to this reads `then` — the promise machinery, not the host.
      if (k !== 'then') touched.push(`get:${String(k)}`);
      return Reflect.get(t, k, r);
    },
    getOwnPropertyDescriptor(t, k) {
      touched.push(`has:${String(k)}`);
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    has(t, k) {
      touched.push(`in:${String(k)}`);
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      touched.push('ownKeys');
      return Reflect.ownKeys(t);
    },
  });
  return { proxy, touched };
}

/** A `respond` that answers without reading the result, so only the walk can touch it. */
const blind: Respond = () => new Response('ok');

describe('the field walk (#1331)', () => {
  it('records which declared fields the response carried, and which it did not', async () => {
    const { record, call } = harness({ output: card }, () => ({ id: 'c1', title: 'T', owner_email: SECRET }));
    expect((await call(ARMED)).status).toBe(200);
    expect(record.outputFields).toEqual({ present: ['id', 'title', 'owner_email'], empty: [], absent: ['note'] });
  });

  it('counts an undefined value as absent, as the wire does, and null as empty — never as returned', async () => {
    const { record, call } = harness({ output: card }, () => ({ id: 'c1', title: null, note: undefined, owner_email: 'x' }));
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id', 'owner_email'], empty: ['title'], absent: ['note'] });
  });

  /**
   * The PII posture. A value is never copied into the record, and neither is a key the
   * declaration does not name — a key can be data.
   */
  it('never records a value, nor a key the declaration does not name', async () => {
    const { record, call } = harness({ output: card }, () => ({
      id: SECRET,
      title: SECRET,
      owner_email: SECRET,
      [SECRET]: 'undeclared, and a key that is itself data',
    }));
    await call(ARMED);
    const written = JSON.stringify(record);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('value-4c1d');
    expect(record.outputFields).toEqual({ present: ['id', 'title', 'owner_email'], empty: [], absent: ['note'] });
  });

  it('reads own properties only: an inherited field is absent, and an inherited getter never runs', async () => {
    const ran: string[] = [];
    const proto = {
      title: 'inherited',
      get owner_email() {
        ran.push('owner_email');
        return 'from a getter';
      },
    };
    const row = Object.create(proto) as Record<string, unknown>;
    row['id'] = 'c1';
    Object.defineProperty(row, 'note', { value: 'hidden', enumerable: false });
    const { record, call } = harness({ output: card }, () => row, { respond: blind });
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id'], empty: [], absent: ['title', 'note', 'owner_email'] });
    expect(ran).toEqual([]);
  });

  it('counts an own accessor as present without calling it', async () => {
    const ran: string[] = [];
    const row = {
      id: 'c1',
      get title() {
        ran.push('title');
        return 'computed';
      },
    };
    const { record, call } = harness({ output: card }, () => row, { respond: blind });
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id', 'title'], empty: [], absent: ['note', 'owner_email'] });
    expect(ran).toEqual([]);
  });

  it('asks about declared names only — it never enumerates the response', async () => {
    const huge: Record<string, unknown> = { id: 'c1' };
    for (let i = 0; i < 100_000; i++) huge[`k${i}`] = i;
    const { proxy, touched } = spied(huge);
    const { record, call } = harness({ output: card }, () => proxy, { respond: blind });
    await call(ARMED);
    expect(touched).not.toContain('ownKeys');
    // Not even a Proxy's `get`: the walk reads descriptors, never values through the trap.
    expect(touched.filter((t) => t.startsWith('get:'))).toEqual([]);
    const asked = new Set(touched.map((t) => t.split(':')[1]));
    expect([...asked].sort()).toEqual(['id', 'note', 'owner_email', 'title']);
    expect(record.outputFields).toEqual({ present: ['id'], empty: [], absent: ['title', 'note', 'owner_email'] });
  });

  it('observes a vertical that owns its envelope — `respond` cannot skip it', async () => {
    const { record, call } = harness({ output: card }, () => ({ id: 'c1', title: 'T', owner_email: 'x' }), {
      respond: (_c, result) => new Response(JSON.stringify({ ok: true, result })),
    });
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id', 'title', 'owner_email'], empty: [], absent: ['note'] });
  });

  it('walks the first entry of a paged read, and only the first', async () => {
    const second = spied({ id: 'c2', title: 'B', note: 'only here', owner_email: 'x' });
    const { record, call } = harness(
      { output: card, input: z.object({ limit: z.number().optional() }), paged: { sortKey: 'id' } },
      () => ({ entries: [{ id: 'c1', title: 'A', owner_email: 'x' }, second.proxy], nextCursor: null }),
      { respond: blind },
    );
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id', 'title', 'owner_email'], empty: [], absent: ['note'] });
    expect(second.touched).toEqual([]);
  });

  it('leaves an accessor-backed page unobserved, and never calls its getter', async () => {
    const ran: string[] = [];
    const page = {
      get entries() {
        ran.push('entries');
        return [{ id: 'c1', title: 'A', owner_email: 'x' }];
      },
      nextCursor: null,
    };
    const { record, call } = harness(
      { output: card, input: z.object({ limit: z.number().optional() }), paged: { sortKey: 'id' } },
      () => page,
      { respond: blind },
    );
    await call(ARMED);
    expect(record).not.toHaveProperty('outputFields');
    expect(ran).toEqual([]);
  });

  it('a getter answering a different array each read cannot skew the record', async () => {
    // What the walk would see first versus what the response would serialise next.
    let reads = 0;
    const page = {
      get entries() {
        reads++;
        return reads === 1 ? [{ id: 'c1', title: 'A', note: 'n', owner_email: 'x' }] : [{ id: 'c2' }];
      },
      nextCursor: null,
    };
    const { record, call } = harness(
      { output: card, input: z.object({ limit: z.number().optional() }), paged: { sortKey: 'id' } },
      () => page,
      { respond: blind },
    );
    await call(ARMED);
    expect(reads).toBe(0);
    expect(record).not.toHaveProperty('outputFields');
  });

  it('never runs a getter on a list entry index', async () => {
    const ran: string[] = [];
    const list: unknown[] = [];
    Object.defineProperty(list, '0', {
      get() {
        ran.push('0');
        return { id: 'c1' };
      },
      enumerable: true,
    });
    const { record, call } = harness({ output: z.array(card) }, () => list, { respond: blind });
    await call(ARMED);
    expect(record).not.toHaveProperty('outputFields');
    expect(ran).toEqual([]);
  });

  it('walks a paged read whose handler still answers a bare array', async () => {
    const { record, call } = harness(
      { output: card, input: z.object({ limit: z.number().optional() }), paged: { sortKey: 'id' } },
      () => [{ id: 'c1', title: 'A', note: 'n', owner_email: 'x' }],
    );
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id', 'title', 'note', 'owner_email'], empty: [], absent: [] });
  });

  it('walks the first element of an array output', async () => {
    const { record, call } = harness({ output: z.array(card) }, () => [{ id: 'c1' }, { id: 'c2', title: 'B' }]);
    await call(ARMED);
    expect(record.outputFields).toEqual({ present: ['id'], empty: [], absent: ['title', 'note', 'owner_email'] });
  });

  it('records nothing for an empty list — an unobserved field is not an absent one', async () => {
    const { record, call } = harness(
      { output: card, input: z.object({ limit: z.number().optional() }), paged: { sortKey: 'id' } },
      () => ({ entries: [], nextCursor: null }),
    );
    await call(ARMED);
    expect(record).not.toHaveProperty('outputFields');
  });

  it('records nothing for a result that is not an object, or a declaration that names no fields', async () => {
    const scalar = harness({ output: card }, () => 'just a string');
    await scalar.call(ARMED);
    expect(scalar.record).not.toHaveProperty('outputFields');

    const undeclared = harness({}, () => ({ id: 'c1' }));
    await undeclared.call(ARMED);
    expect(undeclared.record).not.toHaveProperty('outputFields');
  });

  it('records nothing for a call that failed — there was no response to walk', async () => {
    const { record, call } = harness({ output: card }, () => {
      throw new Error('boom');
    });
    await Promise.resolve(call(ARMED)).catch(() => undefined);
    expect(record).not.toHaveProperty('outputFields');
  });

  it('records nothing when the response itself fails after the walk — respond or the serialisation', async () => {
    const throwing = harness({ output: card }, () => ({ id: 'c1', title: 'T', owner_email: 'x' }), {
      respond: () => {
        throw new Error('respond broke');
      },
    });
    await Promise.resolve(throwing.call(ARMED)).catch(() => undefined);
    expect(throwing.record).not.toHaveProperty('outputFields');

    // The default path: `c.json` cannot serialise a BigInt.
    const unserialisable = harness({ output: card }, () => ({ id: 1n, title: 'T', owner_email: 'x' }));
    await Promise.resolve(unserialisable.call(ARMED)).catch(() => undefined);
    expect(unserialisable.record).not.toHaveProperty('outputFields');
  });

  it('cannot fail a request: a result that throws when read is simply not observed', async () => {
    const hostile = new Proxy({}, {
      get(_t, k) {
        // `then` is read by the promise the stub resolves with, before the host sees it.
        if (k === 'then') return undefined;
        throw new Error('hostile');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile');
      },
    });
    const { record, call } = harness({ output: card }, () => hostile, { respond: blind });
    expect((await call(ARMED)).status).toBe(200);
    expect(record).not.toHaveProperty('outputFields');
  });
});

describe('the switch (#1331)', () => {
  /**
   * OFF means off: no record field, and the result is not so much as looked at by the
   * host — the walk is not run and thrown away, it is not run.
   */
  it('unarmed, the walk never touches the result and the record is exactly as before', async () => {
    const { 'x-substrat-router': _signature, ...unsigned } = ARMED;
    for (const headers of [
      undefined,
      routed,
      { ...routed, [FIELD_COVERAGE_HEADER]: 'true' },
      { ...routed, [FIELD_COVERAGE_HEADER]: 'ON' },
      // #1923: the header without the router's signature, or with a guessed one, is a claim.
      unsigned,
      { ...ARMED, 'x-substrat-router': 'i-guessed' },
      { [FIELD_COVERAGE_HEADER]: DISPATCH },
      // A signed request whose header is not a dispatch id.
      { ...routed, [FIELD_COVERAGE_HEADER]: 'on' },
    ]) {
      const { proxy, touched } = spied({ id: 'c1', title: 'T', owner_email: 'x' });
      const { record, call } = harness({ output: card }, () => proxy, { respond: blind });
      expect((await call(headers)).status).toBe(200);
      expect(touched).toEqual([]);
      expect(record).toEqual({ operation: 'acme/op' });
    }
  });

  it('armed, the same route is walked — the positive twin of the above', async () => {
    const { proxy, touched } = spied({ id: 'c1', title: 'T', owner_email: 'x' });
    const { record, call } = harness({ output: card }, () => proxy, { respond: blind });
    await call(ARMED);
    expect(touched.length).toBeGreaterThan(0);
    expect(record.outputFields).toBeDefined();
  });
});

/**
 * End to end through the platform's entry: the line a reader filters on, and the header the
 * router meters from. Unarmed, both are byte-for-byte what they were before the walk existed.
 */
describe('what reaches the line and the router (#1331)', () => {
  function worker(decl: Record<string, unknown>) {
    const app = new Hono();
    mountOperations(
      app,
      { 'acme/op': { ...decl, http: { method: 'GET', path: '/op' } } },
      async () =>
        ({
          subjectKind: 'principal',
          invoke: async () => ({ id: 'c1', title: SECRET, owner_email: SECRET }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      { mcp: false },
    );
    return withInvocationLog<Record<string, unknown>>(app as never, {
      routerSecret: (env) => env['ROUTER_SECRET'] as string,
    });
  }

  /** The response and the line one request produced, with the per-request noise normalised. */
  async function run(decl: Record<string, unknown>, headers: Record<string, string> = routed) {
    const lines: string[] = [];
    const original = console.log;
    console.log = (first: unknown) => {
      if (typeof first === 'string' && first.includes('"substrat":"invocation"')) lines.push(first);
    };
    try {
      const res = (await worker(decl).fetch!(
        new Request('https://acme.example/api/op', { headers }),
        { ROUTER_SECRET: SECRET_ROUTER },
        {},
      )) as Response;
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!) as Record<string, unknown>;
      const normalised = JSON.stringify({ ...line, invocationId: '-', durationMs: 0 });
      return { res, body: await res.text(), line, normalised };
    } finally {
      console.log = original;
    }
  }

  it('unarmed: the line, the router header and the body match a route with no declared output', async () => {
    const before = await run({});
    const after = await run({ output: card });
    expect(after.normalised).toBe(before.normalised);
    expect(after.line).not.toHaveProperty('outputFields');
    expect(after.res.headers.get(INVOCATION_RECORD_HEADER)).toBe(before.res.headers.get(INVOCATION_RECORD_HEADER));
    expect(after.body).toBe(before.body);
  });

  it('armed: the line carries the field names and no value; the router header is unchanged', async () => {
    const unarmed = await run({ output: card });
    const armed = await run({ output: card }, ARMED);
    expect(armed.line['outputFields']).toEqual({ present: ['id', 'title', 'owner_email'], empty: [], absent: ['note'] });
    expect(armed.line['fieldCoverageId']).toBe(DISPATCH);
    expect(JSON.stringify(armed.line)).not.toContain(SECRET);
    // The router's datapoint carries three named fields and nothing else; the walk adds none.
    expect(armed.res.headers.get(INVOCATION_RECORD_HEADER)).toBe(unarmed.res.headers.get(INVOCATION_RECORD_HEADER));
    expect(encodeInvocationRecord({ operation: 'acme/op', principalKind: 'principal' })).toBe(
      armed.res.headers.get(INVOCATION_RECORD_HEADER),
    );
    expect(armed.body).toBe(unarmed.body);
    // #1923: the walk observes only. The caller gets the same status, headers and body.
    expect(armed.res.status).toBe(unarmed.res.status);
    expect([...armed.res.headers]).toEqual([...unarmed.res.headers]);
  });

  it('a forged arming header is never walked, and files no line under any tenant (#1923)', async () => {
    const { 'x-substrat-router': _signature, ...unsigned } = ARMED;
    for (const headers of [{ ...ARMED, 'x-substrat-router': 'i-guessed' }, unsigned]) {
      const { proxy, touched } = spied({ id: 'c1', title: 'T', owner_email: 'x' });
      const app = new Hono();
      mountOperations(
        app,
        { 'acme/op': { output: card, http: { method: 'GET', path: '/op' } } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async () => ({ invoke: async () => proxy }) as any,
        { mcp: false, respond: blind as never },
      );
      const lines: string[] = [];
      const original = console.log;
      console.log = (first: unknown) => void (typeof first === 'string' && lines.push(first));
      try {
        const res = (await withInvocationLog<Record<string, unknown>>(app as never, {
          routerSecret: (env) => env['ROUTER_SECRET'] as string,
        }).fetch!(new Request('https://acme.example/api/op', { headers }), { ROUTER_SECRET: SECRET_ROUTER }, {})) as Response;
        expect(res.status).toBe(200);
      } finally {
        console.log = original;
      }
      expect(touched).toEqual([]);
      expect(lines.filter((l) => l.includes('"substrat":"invocation"'))).toEqual([]);
    }
  });
});

describe('outputWalkOf — the declared fields, read once at mount', () => {
  it('looks through the wrappers a declaration may put around its object', () => {
    expect(outputWalkOf(card.optional().nullable(), false)).toEqual({ fields: ['id', 'title', 'note', 'owner_email'], list: false, paged: false });
    expect(outputWalkOf(z.array(card), false)?.list).toBe(true);
    expect(outputWalkOf(card, true)?.list).toBe(true);
  });

  it('declares nothing for a scalar, a union, a list of lists, a pipe or no output at all', () => {
    expect(outputWalkOf(undefined, false)).toBeUndefined();
    expect(outputWalkOf(z.string(), false)).toBeUndefined();
    expect(outputWalkOf(z.union([card, z.object({ other: z.string() })]), false)).toBeUndefined();
    expect(outputWalkOf(z.array(z.array(card)), false)).toBeUndefined();
    expect(outputWalkOf(z.object({}), false)).toBeUndefined();
    // A pipe: what the handler returns and what the declaration describes can differ.
    expect(outputWalkOf(card.transform((c) => ({ renamed: c.id })), false)).toBeUndefined();
    expect(outputWalkOf(z.unknown().pipe(card), false)).toBeUndefined();
    expect(outputWalkOf(card.transform((c) => c).optional(), false)).toBeUndefined();
  });

  it('caps the declared names at the declared half’s own cap', () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, z.string()])));
    const walk = outputWalkOf(wide, false)!;
    expect(walk.fields).toHaveLength(DECLARED_OUTPUT_FIELDS_MAX);
    const report = observeOutputFields(Object.fromEntries(walk.fields.map((f) => [f, 'x'])), walk)!;
    expect(report.present.length + report.empty.length + report.absent.length).toBe(DECLARED_OUTPUT_FIELDS_MAX);
  });
});
