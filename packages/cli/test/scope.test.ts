import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDumpIdentifiers } from '@substrat-run/contracts';
import { bindScopeVersion, pullScope, restoreScope } from '../src/scope.js';

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
    ).rejects.toThrow(/refusing this dump/);
    expect(called).toBe(0); // refused locally — the dump never left the machine
  });

  it('restore refuses a .dump.json whose DDL carries a second statement, plain names and all', async () => {
    // The counterpart of the pull case below, on the path a builder actually hands an
    // untrusted file to: every NAME here is a plain identifier, so a name-only check
    // passes the file straight to the control plane. The server refuses it there —
    // but "the dump never left the machine" is the property this end claims.
    const file = join(dir, 'appended.dump.json');
    writeFileSync(
      file,
      JSON.stringify({
        tables: [
          {
            name: 'crm_vendors',
            ddl: 'CREATE TABLE crm_vendors (id TEXT PRIMARY KEY); CREATE TABLE smuggled (id TEXT);',
            columns: ['id'],
            rows: [['v1']],
          },
        ],
      }),
    );
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      restoreScope({ controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', file }),
    ).rejects.toThrow(/more than one statement/);
    expect(called).toBe(0);
  });

  it('a second statement appended to a table DDL is refused, not silently dropped', async () => {
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

    // Refused rather than half-loaded. `prepare` compiling only the first statement
    // made the appended one inert HERE, but there is no prepare step on a Durable
    // Object — so the rule that has to hold on the hosted path is that the text is
    // one statement, and a dump carrying two is not loaded at all.
    await expect(
      pullScope({
        controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-2', full: false, outDir,
      }),
    ).rejects.toThrow(/more than one statement/);
    expect(existsSync(join(outDir, 'acme__s-2.sqlite'))).toBe(false);
    // Nor as the JSON fallback: the check runs before EITHER writer, so a node
    // without `node:sqlite` — where `writeSqlite` returns before its own check —
    // does not get to leave the refused dump on disk instead.
    expect(existsSync(join(outDir, 'acme__s-2.dump.json'))).toBe(false);
  });

  /** A pull whose response is exactly these tables. */
  const pullOf = (scopeId: string, tables: unknown[], outDir: string) => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ tenantId: 'acme', scopeId, capturedAt: '2026-09-01T00:00:00.000Z', masked: true, tables }),
        { status: 200 },
      )) as unknown as typeof fetch;
    return pullScope({ controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId, full: false, outDir });
  };

  it('refuses a DDL that creates something other than the table it is declared for', async () => {
    await expect(
      pullOf(
        's-3',
        [{ name: 'crm_vendors', ddl: 'CREATE TABLE something_else (id TEXT)', columns: ['id'], rows: [] }],
        join(dir, 'wrong'),
      ),
    ).rejects.toThrow(/does not begin with/);
  });

  it('refuses a DDL whose FIRST statement is the hostile one — before it runs', async () => {
    const attached = join(dir, 'attached.db');
    await expect(
      pullOf(
        's-4',
        [
          {
            name: 'crm_vendors',
            ddl: `ATTACH DATABASE '${attached}' AS e; CREATE TABLE crm_vendors (id TEXT);`,
            columns: ['id'],
            rows: [],
          },
        ],
        join(dir, 'attach'),
      ),
    ).rejects.toThrow(/does not begin with/);
    // The check sits BEFORE the execution, so the ATTACH never happened — a check
    // that ran afterwards would have let it through and then complained.
    expect(existsSync(attached)).toBe(false);
  });

  it('refuses a table listed twice — the repeat is how a payload hides behind an honest entry', async () => {
    await expect(
      pullOf(
        's-5',
        [
          { name: 'crm_vendors', ddl: 'CREATE TABLE crm_vendors (id TEXT)', columns: ['id'], rows: [] },
          { name: 'crm_vendors', ddl: `ATTACH DATABASE '${join(dir, 'dup.db')}' AS e`, columns: ['id'], rows: [] },
        ],
        join(dir, 'dup'),
      ),
    ).rejects.toThrow(/is listed twice/);
  });

  it('refuses two names that differ only in case — SQLite reads those as one table', async () => {
    await expect(
      pullOf(
        's-6',
        [
          { name: 'crm_vendors', ddl: 'CREATE TABLE crm_vendors (id TEXT)', columns: ['id'], rows: [['v1']] },
          {
            name: 'CRM_Vendors',
            ddl: 'CREATE TABLE IF NOT EXISTS CRM_Vendors (id TEXT)',
            columns: ['id'],
            rows: [['smuggled']],
          },
        ],
        join(dir, 'case'),
      ),
    ).rejects.toThrow(/is listed twice/);
  });

  it('a refused dump does not delete the file the previous pull wrote', async () => {
    const outDir = join(dir, 'keep');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await pullOf('s-7', [{ name: 'crm_vendors', ddl: 'CREATE TABLE crm_vendors (id TEXT)', columns: ['id'], rows: [['v1']] }], outDir);
    const file = join(outDir, 'acme__s-7.sqlite');
    expect(existsSync(file)).toBe(true);

    // Same scope, so the same destination path — a hostile response must not cost
    // the builder the good pull sitting there.
    await expect(
      pullOf('s-7', [{ name: 'crm_vendors', ddl: 'ATTACH DATABASE \'/tmp/x.db\' AS e', columns: ['id'], rows: [] }], outDir),
    ).rejects.toThrow(/does not begin with/);
    expect(existsSync(file)).toBe(true);
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
    ).rejects.toThrow(/refusing this dump/);
    expect(existsSync(join(outDir, 'acme__s-1.sqlite'))).toBe(false);
    expect(existsSync(join(outDir, 'acme__s-1.dump.json'))).toBe(false);
  });
});
