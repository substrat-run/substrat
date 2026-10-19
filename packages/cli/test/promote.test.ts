import { afterEach, describe, expect, it } from 'vitest';
import type { MigrationDiff, PermissionRegistry } from '@substrat-run/contracts';
import { formatMigrationDiff, formatRegistryDiff, parseReviewToken, promote, reviewToken } from '../src/promote.js';

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

function plane(o: {
  refusal: string | null;
  migrations: MigrationDiff | null;
  serving?: string | null;
  failRegistry?: boolean;
  /** The two registries the plane serves (serving v1, incoming v2), when not the default pair. */
  registries?: { v1: PermissionRegistry; v2: PermissionRegistry };
  /** #1705 PR 3: the listing an export-break refusal carries in its body. */
  exportBreaks?: { affected: { scopeId: string; vertical: string; type: string; schemaVersion: number; incoming: number | null }[] };
  /** #2333: the problem's `reason`, answered as a 412 the way the gate's review refusals are. */
  reason?: string;
  /** #2333: the binding the migrations read answers beside its diff. */
  review?: { base: string | null; digest: string };
  /** The promote bodies sent. */
  bodies?: unknown[];
}) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/promote')) {
      o.bodies?.push(JSON.parse(String(init?.body)));
      return o.refusal
        ? Response.json(
            { error: o.refusal, ...(o.exportBreaks ? { exportBreaks: o.exportBreaks } : {}), ...(o.reason ? { reason: o.reason } : {}) },
            { status: o.reason ? 412 : 409 },
          )
        : Response.json({ channel: 'prod', versionId: 'v2' });
    }
    if (url.pathname.endsWith('/channels')) {
      return Response.json({ entries: o.serving === null ? [] : [{ channel: 'prod', versionId: o.serving ?? 'v1' }], nextCursor: null });
    }
    if (url.pathname.endsWith('/registry')) {
      if (o.failRegistry) return Response.json({ error: 'boom' }, { status: 500 });
      if (o.registries) return Response.json({ registry: url.pathname.includes('/v1/') ? o.registries.v1 : o.registries.v2 });
      return Response.json({ registry: url.pathname.includes('/v1/') ? reg() : reg([{ key: 'desk:admin', description: 'Administer' }], ['desk:admin']) });
    }
    if (url.pathname.endsWith('/migrations')) return Response.json({ migrations: o.migrations, ...(o.review ? { review: o.review } : {}) });
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return seen;
}

const withExportsRow = (type: string) =>
  ({ ...reg(), exports: [{ type, schemaVersion: 1, readPermission: 'desk:read', declaredBy: ['desk'] }] }) as unknown as PermissionRegistry;

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
    // #1754 is fixed (#1949): the registry refuses a SQL-only change, so no note says otherwise.
    expect(text).not.toContain('does not yet require');
    // The diff was taken against what prod SERVES, over the owner routes.
    expect(seen).toContain('GET /api/verticals/desk/versions/v2/migrations?base=v1');
  });

  it('a permission refusal for an EXPORTS-only change prints what moved, and never "none"', async () => {
    plane({ refusal: PERM_REFUSAL, migrations: diff(), registries: { v1: withExportsRow('desk.a'), v2: withExportsRow('desk.b') } });
    const text = await refusalOf();
    expect(text).toMatch(/permission changes:\n {2}changed, not itemised here: exports/);
    expect(text).not.toMatch(/permission changes:\n {2}none/);
  });

  it('a migration refusal with no SQL carried says so, naming the digest', async () => {
    plane({ refusal: MIG_REFUSAL, migrations: null });
    const text = await refusalOf();
    expect(text).toContain('SQL not available for this version — the migration digest changed');
    expect(text).toMatch(/pushed by a CLI older than migrations in the manifest, or its migrations were over the size/);
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

describe('substrat promote — both refusal kinds survive together (#1677 × #1705 PR 3)', () => {
  const EXPORT_REFUSAL =
    'promotion drops or re-versions 1 exported event type(s) that 1 installed app(s) in 1 tenant(s) import — their edges would stop delivering it. Acknowledge it explicitly (exportBreak) to promote';
  const exportBreaks = { affected: [{ scopeId: 's1', vertical: 'acme/board', type: 'crm.a', schemaVersion: 1, incoming: null }] };

  it('an export-break refusal prints its listing, and reads no digest diff', async () => {
    const seen = plane({ refusal: EXPORT_REFUSAL, migrations: diff(), exportBreaks });
    const text = await refusalOf();
    expect(text).toContain('acme/board (scope s1) imports crm.a v1 — this version no longer exports it');
    expect(text).toContain('--ack-export-break');
    expect(text).not.toContain('permission changes:');
    expect(seen).toEqual(['POST /api/verticals/desk/channels/prod/promote']);
  });

  it('a digest refusal whose body also lists breaks prints the listing AND both diffs', async () => {
    plane({ refusal: PERM_REFUSAL, migrations: diff(), exportBreaks });
    const text = await refusalOf();
    expect(text).toContain('acme/board (scope s1) imports crm.a v1');
    expect(text).toContain('permission changes:');
    expect(text).toMatch(/migration changes:\n {2}\+ desk 0002-priority/);
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
    expect(formatRegistryDiff(from, to, true)).toEqual([
      '+ desk:new  New',
      '~ desk:read  “Read tickets” → “Read every ticket”',
      '- desk:old  Old',
      'grant shape ticket (removed): -desk:read',
    ]);
    expect(formatRegistryDiff(reg(), reg(), false)).toEqual(['none']);
    expect(formatRegistryDiff(null, reg(), true)[0]).toMatch(/serving version carries no permission registry/);
  });

  it('formatRegistryDiff: a lifted reservation and a role holder move are lines of their own, beside any other change (#2430)', () => {
    const at = (reserved: boolean, holder?: 'system') =>
      ({
        ...reg(),
        permissions: [
          { key: 'desk:run', description: 'Run', declaredBy: ['desk'], ...(reserved ? { holder: 'system' } : {}) },
          { key: 'desk:read', description: 'Read tickets', declaredBy: ['desk'] },
        ],
        roles: [{ key: 'host', permissions: ['desk:run'], source: 'vertical', ...(holder ? { holder } : {}) }],
      }) as unknown as PermissionRegistry;
    expect(formatRegistryDiff(at(true, 'system'), at(false), true)).toEqual([
      '! desk:run is no longer reserved to a system principal: a person\'s role may now hold it',
      'role host:',
      '  now a role a person can hold, no longer held by a system principal',
    ]);
  });

  it('formatRegistryDiff: a retired shape key says who loses it, a direct grant on the entity included (#2082)', () => {
    const shaped = (permissions: string[], retired?: string[]) =>
      ({ ...reg(), entityGrants: [{ entityType: 'ticket', permissions, bootstrap: true, ...(retired ? { retired } : {}) }] }) as unknown as PermissionRegistry;
    expect(formatRegistryDiff(shaped(['desk:read', 'desk:write']), shaped(['desk:read'], ['desk:write']), true)).toEqual([
      'grant shape ticket: -desk:write',
      '  existing holders lose desk:write, including any direct grant of desk:write on the same entity',
    ]);
  });

  // Copilot on #1766: the digest hashes the whole registry, the diff itemises keys, roles and
  // grant shapes. A change in anything else must never print as "none".
  const withExports = (type: string) =>
    ({ ...reg(), exports: [{ type, schemaVersion: 1, readPermission: 'desk:read', declaredBy: ['desk'] }] }) as unknown as PermissionRegistry;

  it('an exports-only change is named, never "none"', () => {
    expect(formatRegistryDiff(withExports('desk.a'), withExports('desk.b'), true)).toEqual([
      "changed, not itemised here: exports — compare the two versions' registries",
    ]);
    // Named even when the permission digest is not what refused (it may have been acknowledged).
    expect(formatRegistryDiff(reg(), withExports('desk.a'), false)).toEqual([
      "changed, not itemised here: exports — compare the two versions' registries",
    ]);
  });

  it('which module declares a key, and a role\'s source, are named too', () => {
    const moved = { ...reg(), permissions: [{ key: 'desk:read', description: 'Read tickets', declaredBy: ['other'] }] } as unknown as PermissionRegistry;
    expect(formatRegistryDiff(reg(), moved, true)).toEqual(["changed, not itemised here: permissions — compare the two versions' registries"]);
    const sourced = { ...reg(), roles: [{ key: 'agent', permissions: ['desk:read'], source: 'engine' }] } as unknown as PermissionRegistry;
    expect(formatRegistryDiff(reg(), sourced, true)).toEqual(["changed, not itemised here: roles — compare the two versions' registries"]);
  });

  it('a permission-digest refusal with nothing to tell apart still says the digest changed', () => {
    expect(formatRegistryDiff(reg(), reg(), true)[0]).toMatch(/the permission digest changed/);
    expect(formatRegistryDiff(reg(), reg(), true)).not.toContain('none');
  });

  it('formatMigrationDiff: edited ones first and marked, the unavailable baseline and a cut list said plainly', () => {
    const out = formatMigrationDiff(
      diff({ baseline: 'unavailable', changed: [{ moduleId: 'desk', version: '0001', sql: null }], total: 9, truncated: true }),
      true,
    );
    // A cut list cannot say whether an entry left out of it discards data, so it says so first.
    expect(out[0]).toMatch(/^! this list is cut, so it cannot show whether/);
    expect(out[1]).toMatch(/predates carried migrations/);
    expect(out[2]).toMatch(/^~ \(edited after shipping.*\) desk 0001$/);
    expect(out[3]).toMatch(/SQL left out/);
    expect(out.at(-1)).toBe('(2 of 9 shown; read the rest in the repository)');
    expect(formatMigrationDiff(diff({ added: [], total: 0 }), false)).toEqual(['no SQL migration added or edited']);
  });

  it('formatMigrationDiff: each declared move and discard under its migration, counted first, every pusher string quoted (#2322)', () => {
    const out = formatMigrationDiff(
      diff({
        added: [
          { moduleId: 'desk', version: '0002', sql: 'DROP TABLE legacy;', discards: { legacy: 'unused since 2024\n+ desk 0003\u001b[2J\u202Ekeep' }, moves: { 'a.b': 'c.d' } },
          { moduleId: 'desk', version: '0003', sql: 'SELECT 1;' },
        ],
        changed: [{ moduleId: 'desk', version: '0001', sql: 'SELECT 0;', edited: 'declarations', discards: { t: 'why' } }],
        total: 3,
      }),
      false,
    );
    expect(out[0]).toBe("! this promote deliberately discards data in 2 places; each reason is the migration author's own");
    expect(out[1]).toMatch(/^~ \(declarations edited after shipping; .*\) desk 0001$/);
    expect(out[2]).toBe('    discards "t": "why"');
    const i = out.indexOf('+ desk 0002');
    // The newline, the ESC and the override are escapes on ONE line: nothing forges "+ desk 0003".
    expect(out[i + 1]).toBe('    discards "legacy": "unused since 2024\\n+ desk 0003<U+001B>[2J<U+202E>keep"');
    expect(out[i + 2]).toBe('    moves "a.b" → "c.d" (verified at apply)');
    expect(out[i + 3]).toBe('    DROP TABLE legacy;');
    expect(out.filter((l) => l === '+ desk 0003')).toHaveLength(1);
    // A migration declaring nothing prints no declaration line, and a set with no discard no count.
    expect(out[out.indexOf('+ desk 0003') + 1]).toBe('    SELECT 1;');
    expect(formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: 's', moves: { a: 'b' } }], total: 1 }), false)[0]).toBe('+ d 1');
    const leftOut = formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: null, declarationsLeftOut: true }], total: 1, truncated: true }), false);
    expect(leftOut[0]).toMatch(/^! this list is cut, so it cannot show whether a migration left out of it discards data/);
    expect(leftOut[2]).toMatch(/declares moves or discards, left out/);
  });

  it('formatMigrationDiff: no pusher string reaches the terminal raw — reason, target, id and SQL alike (#2322 r1)', () => {
    const c = (...p: number[]) => String.fromCodePoint(...p);
    // ESC, CR, BEL, DEL, CSI (C1), a bidi override, a zero-width space and a line separator.
    const hostile = c(0x1b) + '[2J' + c(0x0d, 0x07, 0x7f, 0x9b, 0x202e, 0x200b, 0x2028);
    const shown = '<U+001B>[2J<U+000D><U+0007><U+007F><U+009B><U+202E><U+200B><U+2028>';
    const out = formatMigrationDiff(
      diff({
        added: [{ moduleId: `desk${hostile}`, version: `0002${hostile}`, sql: `SELECT 1;${hostile}\nSELECT 2;`, discards: { [`t${hostile}`]: `why${hostile}` }, moves: { [`a${hostile}`]: `b${hostile}` } }],
        total: 1,
      }),
      false,
    );
    expect(out).toContain(`+ "desk${shown}" "0002${shown}"`);
    expect(out).toContain(`    discards "t${shown}": "why${shown}"`);
    expect(out).toContain(`    moves "a${shown}" → "b${shown}" (verified at apply)`);
    expect(out).toContain(`    SELECT 1;${shown}`);
    expect(out).toContain('    SELECT 2;');
    for (const line of out) expect(line, line).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });

  it('formatMigrationDiff: a version with a newline cannot forge an entry above the real one (#2322 r2)', () => {
    const version = '0007\n+ helpdesk 0008-harmless\n    SELECT 1;\nfake';
    const out = formatMigrationDiff(
      diff({ added: [{ moduleId: 'helpdesk', version, sql: 'DROP TABLE x;', discards: { x: 'why' } }], total: 1 }),
      false,
    );
    const at = out.findIndex((l) => l.startsWith('+ '));
    expect(out[at]).toBe('+ helpdesk "0007\\n+ helpdesk 0008-harmless\\n    SELECT 1;\\nfake"');
    expect(out.slice(at + 1)).toEqual(['    discards "x": "why"', '    DROP TABLE x;']);
    expect(out.filter((l) => l.startsWith('+ '))).toHaveLength(1);
    // Tab, zero-width and bidi too, all inside the one quoted header token (#2322 r3).
    const odd = `0007\n+ x\t${String.fromCodePoint(0x200b, 0x202e)}y`;
    const oddOut = formatMigrationDiff(diff({ added: [{ moduleId: 'helpdesk', version: odd, sql: 's' }], total: 1 }), false);
    expect(oddOut[0]).toBe('+ helpdesk "0007\\n+ x\\t<U+200B><U+202E>y"');
    expect(oddOut).toHaveLength(2);
    // A plain id prints bare, as before.
    expect(formatMigrationDiff(diff({ added: [{ moduleId: '@acme/desk', version: '0001-init', sql: 's' }], total: 1 }), false)[0]).toBe('+ @acme/desk 0001-init');
  });

  it('formatMigrationDiff: CRLF SQL prints its lines, and a lone CR still shows (#2322 r2)', () => {
    const out = formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: 'SELECT 1;\r\nSELECT 2;\rX' }], total: 1 }), false);
    expect(out).toEqual(['+ d 1', '    SELECT 1;', '    SELECT 2;<U+000D>X']);
  });

  it('formatMigrationDiff: a long or many-line reason is cut where the review cuts it, saying where the rest is (#2322 r1)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const out = formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: 's', discards: { t: many } }], total: 1 }), false);
    const line = out.find((l) => l.startsWith('    discards'))!;
    expect(line).toContain('line 5"…');
    expect(line).not.toContain('line 6');
    expect(line).toMatch(/\(cut; the whole reason is in the dashboard.s promote dialog and the migration.s source\)$/);
    const short = formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: 's', discards: { t: 'why' } }], total: 1 }), false);
    expect(short).toContain('    discards "t": "why"');
  });

  it('formatMigrationDiff: says "at least" when the answer is cut (#2322 r1)', () => {
    const out = formatMigrationDiff(diff({ added: [{ moduleId: 'd', version: '1', sql: 's', discards: { t: 'why' } }], total: 300, truncated: true }), false);
    expect(out[0]).toBe("! this promote deliberately discards data in at least 1 place; each reason is the migration author's own");
  });
});

describe('substrat promote — the acknowledgement answers the review it printed (#2333)', () => {
  const D1 = 'a'.repeat(64);
  const D2 = 'b'.repeat(64);
  const STALE = 'the promote review is stale: it was read against version v0, and prod now points at version v1. Read the review again and acknowledge what it shows now';
  const UNBOUND = "acknowledging a migration change needs the review it answers: send acknowledge.review (…). From the command line, upgrade to a CLI release whose 'substrat promote' supports --review, and run it without --ack-migrations: it prints the migrations and the --review token to acknowledge them with (https://substrat.net/guide/deploying#acknowledgement-answers-one-review)";

  it('a digest refusal prints the token the migrations read answered beside the diff it prints', async () => {
    const seen = plane({ refusal: MIG_REFUSAL, migrations: diff(), review: { base: 'v1', digest: D1 } });
    const text = await refusalOf();
    expect(text).toMatch(/migration changes:\n {2}\+ desk 0002-priority/);
    expect(text).toContain(`--review v1:${D1}`);
    // One read gave both: there is no second migrations read the token could have come from.
    expect(seen.filter((l) => l.includes('/migrations'))).toEqual(['GET /api/verticals/desk/versions/v2/migrations?base=v1']);
  });

  it('a stale review is answered by the diffs as they stand now, and the new token', async () => {
    plane({ refusal: STALE, reason: 'promote_review_stale', migrations: diff(), review: { base: 'v1', digest: D2 } });
    const text = await refusalOf();
    expect(text).toContain('the promote review is stale');
    expect(text).toContain('prod serves v1; promoting v2.');
    expect(text).toContain('permission changes:');
    expect(text).toContain(`--review v1:${D2}`);
  });

  it('a migration acknowledgement sent without a token is answered with the migrations and one', async () => {
    plane({ refusal: UNBOUND, reason: 'promote_review_unbound', migrations: diff(), review: { base: 'v1', digest: D1 } });
    const text = await refusalOf();
    expect(text).toContain('supports --review');
    expect(text).toMatch(/migration changes:\n {2}\+ desk 0002-priority/);
    expect(text).toContain(`--review v1:${D1}`);
  });

  it('a review sentence with no reason is any other failure — no diff reads', async () => {
    const seen = plane({ refusal: STALE, migrations: diff() });
    await refusalOf();
    expect(seen).toEqual(['POST /api/verticals/desk/channels/prod/promote']);
  });

  it('a control plane that hands out no token is said so, never printed as one', async () => {
    plane({ refusal: MIG_REFUSAL, migrations: diff() });
    const text = await refusalOf();
    expect(text).toContain('hands out no review token');
    expect(text).not.toContain('--review v1');
  });

  it('a base id that is not plain is quoted, so it cannot forge a line', async () => {
    plane({ refusal: MIG_REFUSAL, migrations: diff(), serving: 'v1\n+ forged', review: { base: 'v1\n+ forged', digest: D1 } });
    const text = await refusalOf();
    expect(text).toContain(`--review "v1\\n+ forged:${D1}"`);
    expect(text).not.toMatch(/^\+ forged/m);
  });

  it('sends the binding it was given', async () => {
    const bodies: unknown[] = [];
    plane({ refusal: null, migrations: diff(), bodies });
    const review = { base: 'v1', digest: D1 };
    await promote({ controlPlaneUrl: 'http://cp/api', header: {}, slug: 'desk', channel: 'prod', versionId: 'v2', acknowledge: { migrationChange: true, review } });
    expect(bodies).toEqual([{ versionId: 'v2', acknowledge: { migrationChange: true, review } }]);
  });

  it('the token round-trips, a first promote included, and anything else is refused', () => {
    for (const review of [{ base: 'v1', digest: D1 }, { base: null, digest: D2 }, { base: 'a:b', digest: D1 }]) {
      expect(parseReviewToken(reviewToken(review))).toEqual(review);
    }
    for (const bad of ['', D1, `v1:${D1.slice(1)}`, `v1:${D1.toUpperCase()}`, `:${D1}`, 'v1:']) {
      expect(parseReviewToken(bad)).toBeNull();
    }
  });
});
