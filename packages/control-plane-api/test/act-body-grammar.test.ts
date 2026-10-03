import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * The body of a route whose default is an ACT (#1724 review).
 *
 * A reap and the bulk adoption used to read their body with `await c.req.json().catch(() => ({}))`,
 * which turns a body that does not parse into the defaults. So `{"backup": true` (cut short on
 * the wire) reaped a scope with no backup, and `{"acknowledge": {"exportBreak": true` started a
 * bulk run. All three now read it through `readJsonBody`: an empty body is the documented
 * defaults, JSON that does not parse is a 400, and a schema refuses a wrong type or a key it does
 * not know. Each case below runs on a scope that WOULD be acted on, and reads the scope back.
 */
describe('a route whose default is an act reads its body strictly (#1724)', () => {
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const slug = 'grammar-vert';
  const SERVING = 'grammar-vert-serving';

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const calls: string[] = [];
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const storeOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  const deployment = (ref: string): VerticalClient =>
    ({
      exportScope: async (sid: string) => {
        calls.push(`export ${ref} ${sid}`);
        return storeOf(ref).get(sid) ?? [];
      },
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[]) => {
        calls.push(`restore ${ref} ${sid}`);
        storeOf(ref).set(sid, tables);
        return { tables: tables.length };
      },
    }) as unknown as VerticalClient;

  const post = (path: string, body?: string) => app.request(path, { method: 'POST', headers: auth, body });
  // Cut short on the wire, not JSON at all, JSON that is not an object, and the wrong types.
  // Whitespace-only and BOM-only bodies are bodies that did not arrive intact, NOT "no body": only a
  // zero-length one takes the defaults.
  const unreadable = ['{', '{"backup": true', 'backup=true', '[]', 'null', '"x"', '5', ' ', '\n', ' \t\n ', '\uFEFF', '\uFEFF \n'];
  const statusOf = async (tenant: string, sid: string) => (await host.admin.getScopeRecord(staff, tenant as typeof t, scopeId.parse(sid)))?.status;

  const archived = async (tenant: typeof t) => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s });
    await host.admin.activateScope(staff, tenant, s);
    await host.admin.archiveScope(staff, tenant, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-act-body-grammar-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      resolveVerticalVersion: async (s, versionId) => (s === slug ? deployment(`${slug}-${versionId.toLowerCase()}`) : undefined),
      resolveVerticalRef: async (ref) => deployment(ref),
    });
    await host.admin.createTenant(staff, { id: t, slug: 'grammar-co', name: 'Grammar Co' });
    await host.admin.registerVertical(staff, { slug, name: 'Grammar Vert', source: 'cli', ownerTenant: t });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('POST /tenants/:tenantId/scopes/:scopeId/reap', () => {
    it('refuses a body it cannot read, and the archived scope is still there', async () => {
      const s = await archived(t);
      for (const raw of unreadable) expect((await post(`/tenants/${t}/scopes/${s}/reap`, raw)).status, raw).toBe(400);
      for (const body of [{ backup: 'yes' }, { backup: 1 }, { backups: false }, { backup: false, extra: 1 }]) {
        expect((await post(`/tenants/${t}/scopes/${s}/reap`, JSON.stringify(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(await statusOf(t, s)).toBe('archived');
    });

    it('an empty body, or a valid one, still reaps', async () => {
      const bare = await archived(t);
      expect((await post(`/tenants/${t}/scopes/${bare}/reap`)).status).toBe(200);
      expect(await statusOf(t, bare)).toBe('reaped');
      const explicit = await archived(t);
      expect((await post(`/tenants/${t}/scopes/${explicit}/reap`, '{"backup": false}')).status).toBe(200);
      expect(await statusOf(t, explicit)).toBe('reaped');
    });
  });

  describe('POST /tenants/:tenantId/reap', () => {
    it('refuses a body it cannot read, and nothing of the deleting tenant is reaped', async () => {
      const doomed = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: doomed, slug: 'doomed-co', name: 'Doomed Co' });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: doomed, scopeId: s });
      await host.admin.activateScope(staff, doomed, s);
      await host.admin.setTenantStatus(staff, doomed, 'deleting');
      for (const raw of unreadable) expect((await post(`/tenants/${doomed}/reap`, raw)).status, raw).toBe(400);
      for (const body of [{ backup: 'yes' }, { backups: true }, { backup: true, extra: 1 }]) {
        expect((await post(`/tenants/${doomed}/reap`, JSON.stringify(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(await statusOf(doomed, s)).toBe('active');
      expect((await host.admin.getTenant(staff, doomed))?.status).toBe('deleting');

      // The empty body is the documented default: the tenant is reaped.
      expect((await post(`/tenants/${doomed}/reap`)).status).toBe(200);
      expect(await statusOf(doomed, s)).toBe('reaped');
    });
  });

  describe('POST /verticals/:slug/adopt-serving (the bulk run)', () => {
    let legacy: string;
    beforeAll(async () => {
      const mk = async (version: string) => {
        const id = ulid();
        await host.admin.publishVersion(staff, {
          id, verticalSlug: slug, version, manifestDigest: `m-${version}`, permissionDigest: 'p',
          migrationDigest: 'g', deploymentRef: `${slug}-${id.toLowerCase()}`,
        });
        return id;
      };
      const v1 = await mk('1.0.0');
      const v2 = await mk('1.0.1');
      legacy = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: legacy, vertical: slug });
      await host.admin.activateScope(staff, t, legacy);
      await host.admin.bindScopeVersion(staff, t, legacy, v1);
      // Serving is set AFTER the install exists, or it would be born on the serving script.
      await host.admin.setVerticalServing(staff, slug, { ref: SERVING, versionId: v2, doClasses: ['ScopeDO'], migrationTag: 'v1' });
    });

    it('refuses a body it cannot read, and no scope is exported, restored or re-pointed', async () => {
      calls.length = 0;
      for (const raw of ['{', '{"acknowledge": {"exportBreak": true', '[]', 'null', '5', ' ', ' \t\n ', '\uFEFF']) {
        expect((await post(`/verticals/${slug}/adopt-serving`, raw)).status, raw).toBe(400);
      }
      for (const body of [{ acknowledge: true }, { acknowledge: 'yes' }, { acknowledged: { exportBreak: true } }, { extra: 1 }]) {
        expect((await post(`/verticals/${slug}/adopt-serving`, JSON.stringify(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
      expect((await host.admin.getScopeRecord(staff, t, scopeId.parse(legacy)))?.servingRef ?? null).toBeNull();
    });

    it('an empty body is the defaults: the legacy scope is adopted', async () => {
      calls.length = 0;
      const res = await post(`/verticals/${slug}/adopt-serving`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ vertical: slug, adopted: [legacy] });
      expect(calls.length).toBeGreaterThan(0);
      expect((await host.admin.getScopeRecord(staff, t, scopeId.parse(legacy)))?.servingRef).toBe(SERVING);
    });
  });
});
