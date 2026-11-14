import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type ScopeDumpTable, type ScopeMember } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';

/**
 * Who may fork an app's production data into a preview (#3108). The copy is read by code the
 * caller chose, so a credential that names a person is judged as that person IN THE APP'S OWN
 * SCOPE: its owner of record, or a principal holding every role the owner holds. The roster is
 * the deployment's, so a fake vertical answers it; a credential naming nobody keeps the rule it had.
 */
describe('a fork of production data is judged as the person the credential names', () => {
  const SECRET = 'test-tenant-token-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const staffHeaders = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const prod = scopeId.parse(ulid());
  const [owner, coOwner, agent, stranger] = [ulid(), ulid(), ulid(), ulid()].map((p) => principalId.parse(p));
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let versionId: string;
  let exports = 0;
  let membersAnswer: () => ScopeMember[] = () => [];

  const member = (principal: string, roles: string[], isOwner = false): ScopeMember =>
    ({ principal: principalId.parse(principal), roles, logins: 1, email: null, owner: isOwner });
  const roster = (): ScopeMember[] => [
    member(owner, ['owner', 'agent'], true),
    member(coOwner, ['owner', 'agent']),
    member(agent, ['agent']),
  ];

  const fakeVertical = {
    listMembers: async () => ({ roles: ['agent'], members: membersAnswer(), invites: [] }),
    exportScope: async (): Promise<ScopeDumpTable[]> => {
      exports += 1;
      return [{ name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] }];
    },
    restoreScope: async (_t: string, _s: string, tables: ScopeDumpTable[]) => ({ tables: tables.length }),
    deleteScope: async () => undefined,
  } as unknown as VerticalClient;

  const as = async (principal?: string): Promise<Record<string, string>> => {
    const res = await app.request('/tenant-tokens', {
      method: 'POST', headers: staffHeaders, body: JSON.stringify(principal ? { tenantId: t, principal } : { tenantId: t }),
    });
    const { token } = (await res.json()) as { token: string };
    return { [SERVICE_TOKEN_HEADER]: token, 'content-type': 'application/json' };
  };
  const check = async (slug: string, headers: Record<string, string>) =>
    (await app.request(`/verticals/${slug}/previews/fork-check`, { headers })).json();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-fork-gate-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      tenantTokenSecret: SECRET,
      verticals: { desk: fakeVertical, fresh: fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'acme' });
    for (const slug of ['desk', 'fresh']) {
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli', ownerTenant: t });
    }
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

  it.each([
    ['the owner of record', owner, { ok: true, sourceScopeId: prod }],
    ['a principal holding every role the owner holds', coOwner, { ok: true, sourceScopeId: prod }],
    ['a member holding only some of them', agent, { ok: false, code: 'not-owner' }],
    ['a team member the app does not know', stranger, { ok: false, code: 'not-owner' }],
  ])('judges %s', async (_who, principal, expected) => {
    membersAnswer = roster;
    expect(await check('desk', await as(principal))).toMatchObject(expected);
  });

  it('refuses when the deployment cannot say who owns the scope, without calling the person no owner', async () => {
    membersAnswer = () => {
      throw new ControlPlaneError(404, 'no such route');
    };
    expect(await check('desk', await as(owner))).toMatchObject({ ok: false, code: 'owner-unknown', reason: expect.stringMatching(/cannot read who owns/) });
  });

  it('keeps the old rule for a credential that names nobody', async () => {
    membersAnswer = () => {
      throw new Error('a credential naming nobody must not ask the roster');
    };
    expect(await check('desk', await as())).toEqual({ ok: true, sourceScopeId: prod });
  });

  it('says a vertical with nothing installed has nothing to copy', async () => {
    expect(await check('fresh', await as(owner))).toMatchObject({ ok: false, code: 'not-installed' });
  });

  it('creates the fork for the owner, and rebinds it for nobody else, whatever the body says', async () => {
    membersAnswer = roster;
    exports = 0;
    const create = async (principal: string, extra: Record<string, unknown> = {}) =>
      app.request('/verticals/desk/previews', {
        method: 'POST', headers: await as(principal), body: JSON.stringify({ tag: 'studio-data', versionId, ...extra }),
      });
    const refused = await create(agent);
    expect(refused.status).toBe(403);
    expect(exports).toBe(0);
    const created = await create(owner);
    expect(created.status).toBe(201);
    expect(exports).toBe(1);
    // A clean-room create under the same tag would rebind the fork, carrying its data.
    expect((await create(agent, { empty: true })).status).toBe(403);
  });
});
