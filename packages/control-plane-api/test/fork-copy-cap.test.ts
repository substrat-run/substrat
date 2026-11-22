import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeCopyEstimate, type ScopeDumpPage, type ScopeDumpSample, type ScopeDumpTable } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * #3232: a fresh fork estimates the rows it would copy before it copies anything. Over `maxRows` it
 * is refused with the estimate in the refusal, or, with `sampleOverCap`, copies that sample instead.
 */
describe('the cost cap in front of a preview fork (#3232)', () => {
  const staff = platformActorId.parse(ulid());
  const headers = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const prod = scopeId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let versionId: string;
  const pagesAsked: (ScopeDumpSample | undefined)[] = [];

  const table: ScopeDumpTable = { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] };
  const fakeVertical = {
    listMembers: async () => ({ roles: [], members: [], invites: [] }),
    estimateScopeCopy: async (_s: string, opts: { sample?: number } = {}): Promise<ScopeCopyEstimate> =>
      opts.sample === undefined
        ? { rows: 1_000, tables: [{ name: '_substrat_outbox', rows: 700 }, { name: 'desk_messages', rows: 250 }, { name: 'desk_threads', rows: 50 }] }
        : { rows: 4 * opts.sample, tables: [{ name: 'desk_messages', rows: 4 * opts.sample }] },
    exportScopePage: async (_s: string, _cursor: string | null, opts: { sample?: ScopeDumpSample } = {}): Promise<ScopeDumpPage> => {
      pagesAsked.push(opts.sample);
      return { tables: [table], next: null, loadStamp: null, revision: 'r1', ...(opts.sample ? { sample: { ...opts.sample, floors: {} } } : {}) };
    },
    exportScope: async () => [table],
    restoreScope: async (_t: string, _s: string, tables: ScopeDumpTable[]) => ({ tables: tables.length }),
    deleteScope: async () => undefined,
  } as unknown as VerticalClient;

  const create = (tag: string, extra: Record<string, unknown>) =>
    app.request('/verticals/desk/previews', { method: 'POST', headers, body: JSON.stringify({ tag, versionId, ...extra }) });
  const previews = async () => (await host.admin.listScopes(staff, { tenantId: t, vertical: 'desk' })).filter((s) => s.kind === 'preview');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-fork-cap-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { desk: fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'acme' });
    await host.admin.registerVertical(staff, { slug: 'desk', name: 'desk', source: 'cli', ownerTenant: t });
    versionId = ulid();
    await host.admin.publishVersion(staff, {
      id: versionId, verticalSlug: 'desk', version: '1.0.0',
      manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
    });
    await host.admin.admitVersion(staff, versionId);
    await host.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: 'desk' });
    await host.admin.activateScope(staff, t, prod);
    await host.admin.bindScopeVersion(staff, t, prod, versionId);
    await host.admin.bindHostname(staff, {
      hostname: 'desk-acme.global.substrat.run', tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a fork over the cap with the estimate and its largest tables, before anything is copied or created', async () => {
    const refused = await create('pr-1', { maxRows: 500 });
    expect(refused.status).toBe(413);
    const body = (await refused.json()) as { detail?: string; error?: string };
    expect(body.detail ?? body.error).toEqual(expect.stringContaining('would move about 1000 rows, over the cap of 500 rows (--max-rows). Largest tables: _substrat_outbox 700, desk_messages 250, desk_threads 50'));
    expect(pagesAsked).toEqual([]);
    expect(await previews()).toEqual([]);
  });

  it('over the cap with sampleOverCap, copies that sample, and says so', async () => {
    const created = await create('pr-2', { maxRows: 500, sampleOverCap: 20 });
    expect(created.status).toBe(201);
    expect(pagesAsked).toEqual([{ rows: 20 }]);
    const { notes } = (await created.json()) as { notes: string[] };
    expect(notes[0]).toBe(
      'Data: a sample of production, the newest 20 rows of each table and what they reference (about 80 rows), not a whole copy. ' +
        'A whole copy would move about 1000 rows, over the cap of 500.',
    );
  });

  it.each([
    ['a clean room', { empty: true, sample: 10 }],
    ['sampleOverCap without maxRows', { sampleOverCap: 10 }],
    ['sampleOverCap beside sample', { maxRows: 10, sample: 10, sampleOverCap: 10 }],
    ['a sample over the largest', { sample: 100_001 }],
  ])('refuses %s', async (_what, extra) => {
    expect((await create('pr-3', extra)).status).toBe(400);
  });
});
