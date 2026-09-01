import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDumpIdentifiers, bindScopeVersion, pullScope, restoreScope } from '../src/scope.js';

describe('bindScopeVersion — the per-scope rollout primitive (#509 (c))', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
    vi.restoreAllMocks();
  });

  it('POSTs versionId to the scope version route and reports the new version', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ verticalVersionId: 'v-9', vertical: 'crm', servingRef: 's1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await bindScopeVersion({
      controlPlaneUrl: 'http://cp',
      header: { authorization: 'Bearer t' },
      tenantId: 'acme',
      scopeId: 's-1',
      versionId: 'v-9',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://cp/tenants/acme/scopes/s-1/version');
    expect(calls[0]!.init.method).toBe('POST');
    // `snapshot` omitted (not opted in) — never sent as an explicit false.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ versionId: 'v-9' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('now runs version v-9'));
  });

  it('sends snapshot:true when --snapshot is passed', async () => {
    let sent: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ verticalVersionId: 'v-9', vertical: 'crm' }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await bindScopeVersion({
      controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', versionId: 'v-9', snapshot: true,
    });
    expect(sent).toEqual({ versionId: 'v-9', snapshot: true });
  });

  it('surfaces the control plane refusal (e.g. a pending version on a serving scope)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'version v-9 is pending, not admitted — it cannot be bound to a scope' }), {
        status: 409,
      })) as unknown as typeof fetch;

    await expect(
      bindScopeVersion({ controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', versionId: 'v-9' }),
    ).rejects.toThrow(/pending, not admitted/);
  });
});

describe('a backup names its own tables — and those names reach SQL (#1143)', () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'substrat-dump-'));
  afterEach(() => {
    globalThis.fetch = orig;
    vi.restoreAllMocks();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // What a crafted dump would carry: the quote closes and a second statement runs.
  const HOSTILE = 'x") ; ATTACH DATABASE \'/tmp/pwned.db\' AS e; --';

  it('accepts the names a real scope actually holds', () => {
    expect(() =>
      assertDumpIdentifiers([
        { name: '_substrat_outbox', columns: ['id', 'payload_json', 'emitted_at'] },
        { name: 'crm_vendors', columns: ['id'] },
      ]),
    ).not.toThrow();
  });

  it('refuses a table name that escapes its quoting, naming the offender', () => {
    expect(() => assertDumpIdentifiers([{ name: HOSTILE, columns: ['id'] }])).toThrow(/table name .*ATTACH DATABASE/s);
  });

  it('refuses a crafted COLUMN name too — the INSERT interpolates those as well', () => {
    expect(() => assertDumpIdentifiers([{ name: 'crm_vendors', columns: ['id', 'a") , ("b'] }])).toThrow(
      /column name in table "crm_vendors"/,
    );
  });

  it('restore refuses a crafted .dump.json instead of forwarding it to the control plane', async () => {
    const file = join(dir, 'hostile.dump.json');
    writeFileSync(
      file,
      JSON.stringify({ tables: [{ name: HOSTILE, ddl: 'CREATE TABLE x (id TEXT)', columns: ['id'], rows: [['1']] }] }),
    );
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      restoreScope({ controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', file }),
    ).rejects.toThrow(/refusing this backup/);
    expect(called).toBe(0); // refused locally — the dump never left the machine
  });

  it('a second statement appended to a table DDL never executes', async () => {
    // The names here are all plain — this is the hole `assertDumpIdentifiers` does
    // NOT cover: the DDL text itself, which `exec` would have run in full.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tenantId: 'acme',
          scopeId: 's-2',
          capturedAt: '2026-09-01T00:00:00.000Z',
          masked: true,
          tables: [
            {
              name: 'crm_vendors',
              ddl: 'CREATE TABLE crm_vendors (id TEXT PRIMARY KEY); CREATE TABLE smuggled (id TEXT);',
              columns: ['id'],
              rows: [['v1']],
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outDir = join(dir, 'compound');

    await pullScope({
      controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-2', full: false, outDir,
    });

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(outDir, 'acme__s-2.sqlite'), { readOnly: true });
    try {
      const names = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]
      ).map((t) => t.name);
      expect(names).toEqual(['crm_vendors']); // 'smuggled' was compiled away, not run
      expect(db.prepare('SELECT id FROM crm_vendors').all()).toEqual([{ id: 'v1' }]);
    } finally {
      db.close();
    }
  });

  it('refuses a DDL that creates something other than the table it is declared for', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tenantId: 'acme',
          scopeId: 's-3',
          capturedAt: '2026-09-01T00:00:00.000Z',
          masked: true,
          tables: [{ name: 'crm_vendors', ddl: 'CREATE TABLE something_else (id TEXT)', columns: ['id'], rows: [] }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      pullScope({
        controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-3', full: false, outDir: join(dir, 'wrong'),
      }),
    ).rejects.toThrow(/does not create that table/);
  });

  it('pull refuses a crafted dump instead of writing it to disk', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tenantId: 'acme',
          scopeId: 's-1',
          capturedAt: '2026-09-01T00:00:00.000Z',
          masked: true,
          tables: [{ name: HOSTILE, ddl: 'CREATE TABLE x (id TEXT)', columns: ['id'], rows: [['1']] }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const outDir = join(dir, 'pull');

    await expect(
      pullScope({
        controlPlaneUrl: 'http://cp',
        header: {},
        tenantId: 'acme',
        scopeId: 's-1',
        full: false,
        outDir,
      }),
    ).rejects.toThrow(/refusing this backup/);
    expect(existsSync(join(outDir, 'acme__s-1.sqlite'))).toBe(false);
    expect(existsSync(join(outDir, 'acme__s-1.dump.json'))).toBe(false);
  });
});
