/**
 * The fleet walk's one write (RFC wire-signing follow-on 4), against a fake of the namespace's
 * script-settings endpoint that records every call: only the four `SUBSTRAT_WIRE_*` settings change,
 * every other binding goes back as read, a secret is never sent or echoed, a dry run only reads, and
 * a change between reads, a moved serve and a read-after that differs are each caught.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIRE_AUDIENCE_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_ROUTER_KEYS_VAR, WIRE_STATE_VAR } from '@substrat-run/contracts/wire-signing';
import {
  applyWireSettings,
  CONCURRENT_RETRIES,
  createWfpWireSettingsApi,
  SECRET_BINDING_TYPES,
  VERSION_ID_VAR,
  wireSettingsChanges,
  type ScriptBinding,
  type WireSettingsApi,
} from '../src/wire-settings.js';

const SCRIPT = 'acme-crm';
/** A value no output may carry: the fake answers it for the secret, which the real endpoint never would. */
const SECRET_VALUE = 'sk_live_must_never_leave';

const wanted = [
  { name: WIRE_ROUTER_KEYS_VAR, text: 'r1,r2' },
  { name: WIRE_PLATFORM_KEYS_VAR, text: 'p1,p2' },
  { name: WIRE_AUDIENCE_VAR, text: SCRIPT },
  { name: WIRE_STATE_VAR, text: 'dual' },
];
const asBindings = (w: typeof wanted): ScriptBinding[] => w.map((x) => ({ type: 'plain_text', name: x.name, text: x.text }));

/** What a script carries apart from the four: its own bindings, its version, a store, and a secret. */
const others = (version = 'V1'): ScriptBinding[] => [
  { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
  { type: 'plain_text', name: VERSION_ID_VAR, text: version },
  { type: 'plain_text', name: 'SUBSTRAT_MIGRATIONS_DIGEST', text: 'digest-1' },
  { type: 'd1', name: 'STORE_T1', id: 'd1-id' },
  { type: 'secret_text', name: 'PLATFORM_HELD', text: SECRET_VALUE },
];

/**
 * A fake endpoint holding one script's bindings. `write` applies the body the way the endpoint is
 * documented to: the bindings sent replace the set, and the types in `keep_bindings` are kept from
 * before. `beforeRead` runs before each read, to change the script under the walk.
 */
function fakeApi(initial: ScriptBinding[], hooks: { beforeRead?: (n: number, state: ScriptBinding[]) => ScriptBinding[]; onWrite?: (next: ScriptBinding[]) => ScriptBinding[] } = {}) {
  let state = initial.map((b) => ({ ...b }));
  const calls: { kind: 'read' | 'write'; body?: unknown }[] = [];
  let reads = 0;
  const api: WireSettingsApi = {
    async read() {
      reads += 1;
      if (hooks.beforeRead) state = hooks.beforeRead(reads, state);
      calls.push({ kind: 'read' });
      return state.map((b) => ({ ...b }));
    },
    async write(_script, body) {
      calls.push({ kind: 'write', body: JSON.parse(JSON.stringify(body)) });
      const kept = state.filter((b) => body.keep_bindings.includes(b.type));
      const next = [...body.bindings.map((b) => ({ ...b })), ...kept];
      state = hooks.onWrite ? hooks.onWrite(next) : next;
    },
  };
  return { api, calls, state: () => state };
}

describe('applyWireSettings', () => {
  it('writes nothing when the four already match: one read, no write', async () => {
    const fake = fakeApi([...others(), ...asBindings(wanted)]);
    expect(await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true })).toEqual({ outcome: 'unchanged' });
    expect(fake.calls.map((c) => c.kind)).toEqual(['read']);
  });

  it('a dry run only reads, whatever would change: the write is unreachable', async () => {
    for (const start of [others(), [...others(), ...asBindings(wanted).map((b) => ({ ...b, text: 'old' }))]]) {
      const fake = fakeApi(start);
      const write = vi.spyOn(fake.api, 'write');
      const out = await applyWireSettings(fake.api, SCRIPT, wanted, { apply: false });
      expect(out).toEqual({ outcome: 'would-change', changes: [WIRE_ROUTER_KEYS_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_AUDIENCE_VAR, WIRE_STATE_VAR] });
      expect(fake.calls.every((c) => c.kind === 'read')).toBe(true);
      expect(write).not.toHaveBeenCalled();
      // A withdrawal, dry, likewise.
      expect((await applyWireSettings(fakeApi([...others(), ...asBindings(wanted)]).api, SCRIPT, [], { apply: false })).outcome).toBe('would-change');
    }
  });

  it('changes only the four: every other binding goes back as read, a secret rides keep_bindings and is never sent', async () => {
    const fake = fakeApi([...others(), ...asBindings(wanted).map((b) => ({ ...b, text: 'old' }))]);
    const out = await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true });
    expect(out).toEqual({ outcome: 'updated', changes: [WIRE_ROUTER_KEYS_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_AUDIENCE_VAR, WIRE_STATE_VAR] });
    const writes = fake.calls.filter((c) => c.kind === 'write');
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body as { bindings: ScriptBinding[]; keep_bindings: string[] };
    expect(body.keep_bindings).toEqual([...SECRET_BINDING_TYPES]);
    expect(body.bindings).toEqual([...others().filter((b) => b.type !== 'secret_text'), ...asBindings(wanted)]);
    expect(JSON.stringify(fake.calls)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
    // After the write the script holds the four as wanted, everything else as it was, the secret kept.
    expect(new Set(fake.state().map((b) => JSON.stringify(b)))).toEqual(new Set([...others(), ...asBindings(wanted)].map((b) => JSON.stringify(b))));
  });

  it('withdraws the four when nothing is wanted, and touches nothing else', async () => {
    const fake = fakeApi([...others(), ...asBindings(wanted)]);
    expect(await applyWireSettings(fake.api, SCRIPT, [], { apply: true })).toMatchObject({ outcome: 'updated' });
    expect(fake.state().filter((b) => b.name.startsWith('SUBSTRAT_WIRE_'))).toEqual([]);
    expect(new Set(fake.state().map((b) => JSON.stringify(b)))).toEqual(new Set(others().map((b) => JSON.stringify(b))));
    expect(wireSettingsChanges(fake.state(), [])).toEqual([]);
  });

  it('a binding added between the first read and the write is carried: the write starts again from the newer read', async () => {
    const added: ScriptBinding = { type: 'd1', name: 'STORE_T2', id: 'd1-new' };
    const fake = fakeApi(others(), { beforeRead: (n, state) => (n === 2 ? [...state, added] : state) });
    expect(await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true })).toMatchObject({ outcome: 'updated' });
    const body = fake.calls.find((c) => c.kind === 'write')!.body as { bindings: ScriptBinding[] };
    expect(body.bindings).toContainEqual(added);
    expect(fake.state()).toContainEqual(added);
    // read, read (changed), read (same as the newer one), write, read after.
    expect(fake.calls.map((c) => c.kind)).toEqual(['read', 'read', 'read', 'write', 'read']);
  });

  it('a script that keeps changing between reads is left alone: `concurrent-change`, nothing written', async () => {
    const fake = fakeApi(others(), { beforeRead: (n, state) => [...state.filter((b) => b.name !== 'CHURN'), { type: 'plain_text', name: 'CHURN', text: String(n) }] });
    expect(await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true })).toEqual({ outcome: 'concurrent-change' });
    expect(fake.calls.filter((c) => c.kind === 'write')).toEqual([]);
    expect(fake.calls).toHaveLength(1 + CONCURRENT_RETRIES);
  });

  it('a serving script that does not run the served version is not written: before, and caught after', async () => {
    // Before: the script runs another version than the directory serves (a promote under way).
    const moving = fakeApi(others('V2'));
    expect(await applyWireSettings(moving.api, SCRIPT, wanted, { apply: true, servedVersion: 'V1' })).toEqual({ outcome: 'serve-in-flight', written: false });
    expect(moving.calls.filter((c) => c.kind === 'write')).toEqual([]);
    // Its positive twin: the served version, written.
    expect((await applyWireSettings(fakeApi(others('V1')).api, SCRIPT, wanted, { apply: true, servedVersion: 'V1' })).outcome).toBe('updated');
    // After: the directory moved while it was written.
    const after = fakeApi(others('V1'));
    expect(await applyWireSettings(after.api, SCRIPT, wanted, { apply: true, servedVersion: 'V1', servedVersionAfter: async () => 'V2' })).toEqual({
      outcome: 'serve-in-flight',
      written: true,
    });
    // Moved between the two reads: caught before the write.
    const between = fakeApi(others('V1'), { beforeRead: (n, state) => (n === 2 ? [...others('V2')] : state) });
    expect(await applyWireSettings(between.api, SCRIPT, wanted, { apply: true, servedVersion: 'V1' })).toEqual({ outcome: 'serve-in-flight', written: false });
    expect(between.calls.filter((c) => c.kind === 'write')).toEqual([]);
  });

  it('a read after the write that differs is `verify`, naming the bindings, never a value', async () => {
    // The endpoint drops a store binding on the write, and rewrites one of the four.
    const fake = fakeApi(others(), {
      onWrite: (next) => next.filter((b) => b.name !== 'STORE_T1').map((b) => (b.name === WIRE_STATE_VAR ? { ...b, text: 'surprise-value' } : b)),
    });
    const out = await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true });
    expect(out).toEqual({ outcome: 'verify', bindings: ['STORE_T1', WIRE_STATE_VAR].sort() });
    expect(JSON.stringify(out)).not.toMatch(/surprise-value|d1-id|digest-1|r1,r2/);
  });

  it('a secret dropped by the write is a verify failure too, named, its value nowhere', async () => {
    const fake = fakeApi(others(), { onWrite: (next) => next.filter((b) => b.type !== 'secret_text') });
    const out = await applyWireSettings(fake.api, SCRIPT, wanted, { apply: true });
    expect(out).toEqual({ outcome: 'verify', bindings: ['PLATFORM_HELD'] });
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
  });
});

describe('createWfpWireSettingsApi', () => {
  afterEach(() => vi.unstubAllGlobals());
  const api = () => createWfpWireSettingsApi({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });

  it('reads and writes the script-settings endpoint, the settings as a JSON part', async () => {
    const seen: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        const body = init?.body instanceof FormData ? JSON.parse(await (init.body.get('settings') as File).text()) : undefined;
        seen.push({ method: init?.method ?? 'GET', url, body });
        return new Response(JSON.stringify({ result: { bindings: others() } }), { status: 200 });
      }),
    );
    expect(await api().read('a/b')).toEqual(others());
    await api().write('a/b', { bindings: asBindings(wanted), keep_bindings: SECRET_BINDING_TYPES });
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', 'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/a%2Fb/settings'],
      ['PATCH', 'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/a%2Fb/settings'],
    ]);
    expect(seen[1]!.body).toEqual({ bindings: asBindings(wanted), keep_bindings: SECRET_BINDING_TYPES });
  });

  it('a failure names the script and the status, never the body, which holds binding values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: `bad ${SECRET_VALUE}` }] }), { status: 500 })));
    await expect(api().read(SCRIPT)).rejects.toThrow(/^the settings of 'acme-crm' could not be read \(500\)$/);
    await expect(api().write(SCRIPT, { bindings: [], keep_bindings: [] })).rejects.toThrow(/^the settings of 'acme-crm' could not be written \(500\)$/);
    // An answer that is not a list of bindings is refused, again without echoing it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { bindings: SECRET_VALUE } }), { status: 200 })));
    const error = await api().read(SCRIPT).catch((e: unknown) => e);
    expect(String(error)).not.toContain(SECRET_VALUE);
  });
});
