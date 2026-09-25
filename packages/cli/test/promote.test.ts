import { afterEach, describe, expect, it } from 'vitest';
import type { MigrationDiff, PermissionRegistry } from '@substrat-run/contracts';
import { formatMigrationDiff, formatRegistryDiff, promote } from '../src/promote.js';

/**
 * `substrat promote` refusing with the two diffs (#1677), not only the digests. The plane is
 * a fetch stub answering the four routes the CLI reads; the refusal texts are the adapters'
 * own, verbatim.
 */

const PERM_REFUSAL = 'promotion changes the permission surface (aaa111 → bbb222) — acknowledge it explicitly to promote';
const MIG_REFUSAL = 'promotion changes migrations (ccc333 → ddd444) — acknowledge it explicitly to promote';

const reg = (extra: { key: string; description: string }[] = [], roleExtra: string[] = []): PermissionRegistry => ({
  permissions: [{ key: 'desk:read', description: 'Read tickets', declaredBy: ['desk'] }, ...extra.map((p) => ({ ...p, declaredBy: ['desk'] }))],
  roles: [{ key: 'agent', permissions: ['desk:read', ...roleExtra], source: 'vertical' }],
  entityGrants: [],
}) as unknown as PermissionRegistry;

const ADD = { moduleId: 'desk', version: '0002-priority', sql: 'ALTER TABLE ticket\nADD COLUMN priority TEXT;' };
const diff = (over: Partial<MigrationDiff> = {}): MigrationDiff => ({
  baseline: 'version',
  added: [ADD],
  changed: [],
  total: 1,
  truncated: false,
  ...over,
});

const orig = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = orig;
});

function plane(o: { refusal: string | null; migrations: MigrationDiff | null; serving?: string | null; failRegistry?: boolean }) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/promote')) {
      return o.refusal
        ? Response.json({ error: o.refusal }, { status: 409 })
        : Response.json({ channel: 'prod', versionId: 'v2' });
    }
    if (url.pathname.endsWith('/channels')) {
      return Response.json({ entries: o.serving === null ? [] : [{ channel: 'prod', versionId: o.serving ?? 'v1' }], nextCursor: null });
    }
    if (url.pathname.endsWith('/registry')) {
      if (o.failRegistry) return Response.json({ error: 'boom' }, { status: 500 });
      return Response.json({ registry: url.pathname.includes('/v1/') ? reg() : reg([{ key: 'desk:admin', description: 'Administer' }], ['desk:admin']) });
    }
    if (url.pathname.endsWith('/migrations')) return Response.json({ migrations: o.migrations });
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return seen;
}

const run = () => promote({ controlPlaneUrl: 'http://cp/api', header: {}, slug: 'desk', channel: 'prod', versionId: 'v2' });
const refusalOf = async () => (await run().then(() => null, (e: Error) => e))!.message;

describe('substrat promote — a refusal prints both diffs (#1677)', () => {
  it('a permission refusal: the digest line, then the permission diff and the migrations with their SQL', async () => {
    const seen = plane({ refusal: PERM_REFUSAL, migrations: diff() });
    const text = await refusalOf();
    expect(text).toContain('aaa111 → bbb222');
    expect(text).toContain('prod serves v1; promoting v2.');
    expect(text).toMatch(/permission changes:\n {2}\+ desk:admin {2}Administer\n {2}role agent: \+desk:admin/);
    expect(text).toMatch(/migration changes:\n {2}\+ desk 0002-priority\n {6}ALTER TABLE ticket\n {6}ADD COLUMN priority TEXT;/);
    expect(text).toContain('#1754');
    // The diff was taken against what prod SERVES, over the owner routes.
    expect(seen).toContain('GET /api/verticals/desk/versions/v2/migrations?base=v1');
  });

  it('a migration refusal with no SQL carried says so, naming the digest', async () => {
    plane({ refusal: MIG_REFUSAL, migrations: null });
    expect(await refusalOf()).toContain('SQL not available for this version — the migration digest changed');
  });

  it('a diff that cannot be read is said so, and the refusal is still what is thrown', async () => {
    plane({ refusal: PERM_REFUSAL, migrations: diff(), failRegistry: true });
    const text = await refusalOf();
    expect(text).toContain('aaa111 → bbb222');
    expect(text).toContain('the diffs could not be read');
  });

  it('any other failure is left as it was — no diff reads', async () => {
    const seen = plane({ refusal: 'version v2 is pending, not admitted — it cannot be promoted', migrations: diff() });
    const text = await refusalOf();
    expect(text).not.toContain('permission changes:');
    expect(seen).toEqual(['POST /api/verticals/desk/channels/prod/promote']);
  });

  it('a promote that succeeds reads nothing else', async () => {
    const seen = plane({ refusal: null, migrations: diff() });
    await expect(run()).resolves.toMatchObject({ versionId: 'v2' });
    expect(seen).toHaveLength(1);
  });
});

describe('the diff formatters', () => {
  it('formatRegistryDiff: added, removed, re-worded, role and grant shapes; "none" when equal', () => {
    const from = { ...reg([{ key: 'desk:old', description: 'Old' }]), entityGrants: [{ entityType: 'ticket', permissions: ['desk:read'] }] } as unknown as PermissionRegistry;
    const to = {
      ...reg([{ key: 'desk:new', description: 'New' }]),
      permissions: [
        { key: 'desk:read', description: 'Read every ticket', declaredBy: ['desk'] },
        { key: 'desk:new', description: 'New', declaredBy: ['desk'] },
      ],
      entityGrants: [],
    } as unknown as PermissionRegistry;
    expect(formatRegistryDiff(from, to)).toEqual([
      '~ desk:read  “Read tickets” → “Read every ticket”',
      '+ desk:new  New',
      '- desk:old  Old',
      'grant shape ticket (removed): -desk:read',
    ]);
    expect(formatRegistryDiff(reg(), reg())).toEqual(['none']);
    expect(formatRegistryDiff(null, reg())[0]).toMatch(/serving version carries no permission registry/);
  });

  it('formatMigrationDiff: edited ones first and marked, the unavailable baseline and a cut list said plainly', () => {
    const out = formatMigrationDiff(
      diff({ baseline: 'unavailable', changed: [{ moduleId: 'desk', version: '0001', sql: null }], total: 9, truncated: true }),
      true,
    );
    expect(out[0]).toMatch(/predates carried migrations/);
    expect(out[1]).toMatch(/^~ \(edited after shipping.*\) desk 0001$/);
    expect(out[2]).toMatch(/SQL left out/);
    expect(out.at(-1)).toBe('(2 of 9 shown; read the rest in the repository)');
    expect(formatMigrationDiff(diff({ added: [], total: 0 }), false)).toEqual(['no SQL migration added or edited']);
  });
});
