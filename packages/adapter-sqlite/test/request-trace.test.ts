/**
 * The scope host's half of a request trace (#2358): what `SqliteScopeHost` hands a sink.
 *
 * Driven through the real host and the contract suite's own permission module, so a check is
 * the checker's, a statement is the driver's and an event is the outbox's. The sink here is a
 * collector installed on the `globalThis` slot a host reads — which is also how `substrat dev`
 * installs one, so the install path is what is under test, not a test-only seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TRACE_SINK_KEY,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type TraceHeadPatch,
  type TraceSink,
  type TraceStep,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { parseMod, permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

interface Collected {
  heads: Record<string, TraceHeadPatch>;
  steps: Record<string, TraceStep[]>;
}

function collector(capture?: TraceSink['capture']): { sink: TraceSink; got: Collected } {
  const got: Collected = { heads: {}, steps: {} };
  const sink: TraceSink = {
    ...(capture ? { capture } : {}),
    head: (id, patch) => void (got.heads[id] = { ...got.heads[id], ...patch }),
    step: (id, step) => void (got.steps[id] = [...(got.steps[id] ?? []), step]),
    end: () => {},
  };
  return { sink, got };
}

const slots = globalThis as Record<symbol, unknown>;
const STARTS = Symbol.for('substrat.trace-starts');
const install = (sink: TraceSink) => void (slots[TRACE_SINK_KEY] = sink);

describe('what the scope host records for a trace (#2358)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-trace-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const viewer = principalId.parse(ulid());
  const finance = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const READ = permissionKey.parse('perm:read');
  const s2 = scopeId.parse(ulid());
  const parser = principalId.parse(ulid());

  beforeAll(async () => {
    host.registerModule(permMod);
    host.registerModule(parseMod);
    await host.admin.createTenant(staff, { id: t1, slug: `trace-${ulid().toLowerCase()}`, name: 'Trace' });
    await host.admin.grantEntitlement(staff, t1, 'perm');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.admin.defineRole(staff, t1, { key: 'finance', permissions: [USE, READ], source: 'vertical' });
    await host.admin.defineRole(staff, t1, { key: 'viewer', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: finance, roleKey: 'finance', node: { tenantId: t1, scopeId: s1 } });
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: t1, scopeId: s1 } });
    // A second scope for the module that declares an input, so a refused input can be driven.
    await host.admin.grantEntitlement(staff, t1, 'parse');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical: 'parse-vertical' });
    await host.admin.activateScope(staff, t1, s2);
    await host.admin.defineRole(staff, t1, { key: 'parser', permissions: [permissionKey.parse('parse:use')], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: parser, roleKey: 'parser', node: { tenantId: t1, scopeId: s2 } });
  });

  afterEach(() => {
    delete slots[TRACE_SINK_KEY];
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says why a call was refused: the key, who would have been allowed, and what the caller holds', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(viewer, t1, s1);
    await expect(stub.invoke('perm/authorized-read', { permission: USE }, { invocationId: id })).rejects.toThrow(/permission denied/);

    const check = got.steps[id]!.find((s) => s.type === 'check');
    expect(check).toMatchObject({ allowed: false, permission: 'perm:use', requires: ['finance'], callerHas: ['viewer'], decidedBy: null });
    expect(got.steps[id]!.at(-1)).toMatchObject({ type: 'error', code: 'permission_denied' });
    expect(got.heads[id]).toMatchObject({ operation: 'perm/authorized-read', principalKind: 'principal', tenantId: t1, scopeId: s1 });
  });

  it('names the role an allowed check went through, and records the emitted event without its payload', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/authorized-emit', { permission: USE }, { invocationId: id });

    const steps = got.steps[id]!;
    const check = steps.find((s) => s.type === 'check');
    expect(check).toMatchObject({ allowed: true, permission: 'perm:use', requires: [], callerHas: [] });
    expect((check as { decidedBy: string | null }).decidedBy).toMatch(/finance/);
    expect(steps.find((s) => s.type === 'emit')).toEqual(
      expect.objectContaining({ eventType: 'perm.acted', entity: 'test-thing:x1' }),
    );
    expect(JSON.stringify(steps)).not.toContain('payload');
  });

  it('times each statement with the rows it read or wrote, parameters included when the sink asks', async () => {
    const { sink, got } = collector({ sqlParams: true });
    install(sink);
    const id = ulid();
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/write-note', { note: 'hello' }, { invocationId: id });
    const readId = ulid();
    await stub.invoke('perm/read-notes', undefined, { invocationId: readId });

    const writes = got.steps[id]!.filter((s) => s.type === 'sql');
    expect(writes.find((s) => s.type === 'sql' && s.statement.startsWith('INSERT'))).toMatchObject({
      operation: 'exec',
      params: ['hello'],
      rowsWritten: 1,
    });
    const read = got.steps[readId]!.find((s) => s.type === 'sql' && s.operation === 'query');
    expect(read).toMatchObject({ statement: expect.stringContaining('SELECT note FROM perm_notes'), rowsRead: 1 });
    for (const s of [...writes, read!]) expect((s as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends no bound values unless the sink asked for them', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/write-note', { note: 'a-person-s-name' }, { invocationId: id });
    const sql = got.steps[id]!.filter((s) => s.type === 'sql');
    expect(sql.length).toBeGreaterThan(0);
    expect(JSON.stringify(sql)).not.toContain('a-person-s-name');
    expect(sql.every((s) => !('params' in s))).toBe(true);
  });

  it('on an entity check, says an entity grant would also have allowed it', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(viewer, t1, s1);
    await expect(
      stub.invoke('perm/authorized-emit', { permission: USE, entity: { entityType: 'box', entityId: 'b1' } }, { invocationId: id }),
    ).rejects.toThrow(/permission denied/);
    const check = got.steps[id]!.find((s) => s.type === 'check');
    expect(check).toMatchObject({ allowed: false, entity: 'box:b1' });
    expect((check as { requires: string[] }).requires).toEqual(['finance', 'grant:perm:use@box:b1']);
  });

  it('records a refused input once, as its issues, and does not repeat them in the error step', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(parser, t1, s2);
    await expect(stub.invoke('parse/echo', { name: 42 }, { invocationId: id })).rejects.toThrow();
    const steps = got.steps[id]!;
    expect(steps.filter((s) => s.type === 'validation')).toHaveLength(1);
    expect(steps.find((s) => s.type === 'validation')).toMatchObject({ issues: [expect.objectContaining({ path: 'name' })] });
    const error = steps.find((s) => s.type === 'error') as { code: string; message: string; stack?: string };
    expect(error).toMatchObject({ code: 'validation_failed', message: 'input failed validation' });
    expect(error.stack).toBeUndefined();
  });

  it('stamps steps on the axis the request layer started, so the two halves agree on zero', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    // The request layer marked the start 80 ms ago; the scope host's first step must not restart at 0.
    (slots[STARTS] ??= new Map<string, number>());
    (slots[STARTS] as Map<string, number>).set(id, performance.now() - 80);
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/authorized-emit', { permission: USE }, { invocationId: id });
    expect(got.steps[id]![0]!.atMs).toBeGreaterThanOrEqual(80);
  });

  it('leaves no start behind: a finished call and the consumers it ran releases its time axis', async () => {
    const { sink } = collector();
    install(sink);
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/request-check', { permission: USE }, { invocationId: ulid() });
    const map = (slots[STARTS] as Map<string, number> | undefined) ?? new Map();
    expect([...map.keys()]).toEqual([]);
  });

  it('puts every step on one time axis, in the order it happened', async () => {
    const { sink, got } = collector();
    install(sink);
    const id = ulid();
    const stub = await host.getScope(finance, t1, s1);
    await stub.invoke('perm/authorized-emit', { permission: USE }, { invocationId: id });
    const at = got.steps[id]!.map((s) => s.atMs);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('records nothing for a call with no invocation id, and with no sink installed', async () => {
    const stub = await host.getScope(finance, t1, s1);
    await expect(stub.invoke('perm/authorized-emit', { permission: USE }, {})).resolves.toBeUndefined();
    const { sink, got } = collector();
    install(sink);
    await stub.invoke('perm/authorized-emit', { permission: USE }, {});
    expect(got).toEqual({ heads: {}, steps: {} });
  });

  it('never lets a sink that throws fail the request it describes', async () => {
    install({
      head() {
        throw new Error('boom');
      },
      step() {
        throw new Error('boom');
      },
      end() {},
    });
    const stub = await host.getScope(finance, t1, s1);
    await expect(stub.invoke('perm/authorized-emit', { permission: USE }, { invocationId: ulid() })).resolves.toBeUndefined();
  });
});
