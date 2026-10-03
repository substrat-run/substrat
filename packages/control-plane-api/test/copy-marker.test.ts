import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { isPrimaryScope, ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  tenantTokenAuth,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';

/**
 * #2005: a CP-less hosted vertical has no directory, so it reads a scope's own copy-origin row to
 * hold a preview's or a fork's executors inert. A copy made before every copy carried that row
 * holds none, and the platform closes that two ways, both pinned here against a fake deployment
 * that records what it was asked:
 *
 * - every carry onto a scope the directory says is not primary asks the vertical to mark it
 *   (preview REUSE is a same-scope carry, which never seeds the row by itself);
 * - a one-time staff repair walks every existing non-primary scope and marks it, paged,
 *   resumable, admin-logged, with a dry run.
 *
 * The twin, throughout: an install is never marked.
 */
describe('marking copies as copies, in their own storage (#2005)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const slug = 'mark-vert';
  const MARK = '/scopes/mark-copies';

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asTenant: Record<string, string>;
  let v1: string;
  let v2: string;
  let install: ScopeId;
  let snapshot: ScopeId;
  let cleanRoom: ScopeId;

  const refOf = new Map<string, string>();
  const stores = new Map<string, Map<string, ScopeDumpTable[]>>();
  const storeOf = (ref: string) => {
    if (!stores.has(ref)) stores.set(ref, new Map());
    return stores.get(ref)!;
  };
  /** Every restore's options, and every mark, as the deployment saw them. */
  const restores: { scopeId: string; markCopy: boolean }[] = [];
  const markedIn = new Set<string>();
  type Lineage = { kind: string; forkedFrom: string | null };
  const markCalls: string[] = [];
  const clearCalls: string[] = [];
  let refuseMark: string | null = null;
  const deployment = (ref: string): VerticalClient =>
    ({
      exportScope: async (sid: string) => storeOf(ref).get(sid) ?? [],
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[], opts?: { markCopy?: Lineage }) => {
        // The vertical's own guard: a classification of a primary is refused, as the host does.
        if (opts?.markCopy && isPrimaryScope(opts.markCopy)) throw new ControlPlaneError(409, 'mark-copy refused: primary');
        restores.push({ scopeId: sid, markCopy: opts?.markCopy !== undefined });
        if (opts?.markCopy) markedIn.add(sid);
        storeOf(ref).set(sid, tables);
        return { tables: tables.length };
      },
      markCopy: async (sid: string, lineage: Lineage) => {
        markCalls.push(sid);
        if (isPrimaryScope(lineage)) throw new ControlPlaneError(409, 'mark-copy refused: primary');
        if (refuseMark === sid) throw new ControlPlaneError(404, 'this vertical predates /internal/mark-copy');
        const fresh = !markedIn.has(sid);
        markedIn.add(sid);
        return { marked: fresh };
      },
      clearCopyMark: async (sid: string, lineage: Lineage) => {
        clearCalls.push(sid);
        if (!isPrimaryScope(lineage)) throw new ControlPlaneError(409, 'clear-copy-mark refused: a copy');
        const had = markedIn.delete(sid);
        return { cleared: had };
      },
      snapshotScope: async (input: { sourceScopeId: string; newScopeId: string }) => {
        storeOf(ref).set(input.newScopeId, storeOf(ref).get(input.sourceScopeId) ?? []);
        return { tables: 1 };
      },
      deleteScope: async () => undefined,
    }) as unknown as VerticalClient;
  const table = (...ids: string[]): ScopeDumpTable[] => [
    { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: ids.map((id) => [id]) },
  ];
  const publish = async (version: string): Promise<string> => {
    const id = ulid();
    const ref = `${slug}-${id.toLowerCase()}`;
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version, manifestDigest: `m-${version}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
    });
    refOf.set(id, ref);
    return id;
  };
  const provision = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug, ...extra });
    await host.admin.activateScope(staff, t, s);
    await host.admin.bindScopeVersion(staff, t, s, v1);
    storeOf(refOf.get(v1)!).set(s, table('row'));
    return s;
  };
  type Pass = {
    dryRun: boolean;
    marked: { scopeId: string }[];
    already: { scopeId: string }[];
    candidates: { scopeId: string }[];
    skipped: { scopeId: string; reason: string }[];
    failed: { scopeId: string; status: number }[];
    nextCursor: string | null;
  };
  const pass = async (body: object = {}, headers = asStaff): Promise<{ status: number; body: Pass }> => {
    const res = await app.request(MARK, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Pass };
  };
  /** Only this test's scopes: the directory is the whole fleet's. */
  const ours = (rows: { scopeId: string }[]) => rows.map((r) => r.scopeId).filter((s) => mine.has(s)).sort();
  const mine = new Set<string>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-copy-marker-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      tenantTokenSecret: TENANT_SECRET,
      platformBaseDomains: ['global.substrat.run'],
      provisionRetryDelaysMs: [1],
      resolveVerticalVersion: async (s: string, versionId: string) => {
        const ref = s === slug ? refOf.get(versionId) : undefined;
        return ref ? deployment(ref) : undefined;
      },
      resolveVerticalRef: async (ref: string) => deployment(ref),
    });
    await host.admin.createTenant(staff, { id: t, slug: 'mark-co', name: 'Mark Co' });
    await host.admin.registerVertical(staff, { slug, name: 'Mark Vert', source: 'cli', ownerTenant: t });
    v1 = await publish('1.0.0');
    v2 = await publish('1.0.1');
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: t }) });
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    install = await provision();
    await host.admin.bindHostname(staff, {
      hostname: 'mark-acme.global.substrat.run', tenantId: t, scopeId: install, surface: 'app', region: null, canonical: true,
    });
    // Copies made "before the marker": in the directory, never marked in their own storage.
    snapshot = await provision({ forkedFrom: install, forkedAt: new Date().toISOString() });
    cleanRoom = await provision({ kind: 'preview' });
    for (const s of [install, snapshot, cleanRoom]) mine.add(s);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('every carry onto a non-primary scope marks it', () => {
    it('a preview REUSED by a second push — a same-scope carry — is marked', async () => {
      const push = (versionId: string) =>
        app.request(`/verticals/${slug}/previews`, {
          method: 'POST', headers: asStaff, body: JSON.stringify({ tag: 'reuse', versionId, ttlHours: null, sourceScopeId: install }),
        });
      const first = await push(v1);
      expect(first.status, await first.clone().text()).toBe(201);
      const preview = ((await first.json()) as { scopeId: string }).scopeId;
      mine.add(preview);
      restores.length = 0;
      const again = await push(v2);
      expect(again.status, await again.clone().text()).toBe(200);
      expect(((await again.json()) as { scopeId: string }).scopeId).toBe(preview);
      const carried = restores.filter((r) => r.scopeId === preview);
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.every((r) => r.markCopy)).toBe(true);
    });

    it('twin: a governed restore onto the INSTALL never asks for a mark', async () => {
      restores.length = 0;
      const dump = await host.admin.exportScope(staff, t, install);
      const res = await app.request(`/tenants/${t}/scopes/${install}/restore`, {
        method: 'POST', headers: asStaff, body: JSON.stringify(dump),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(restores.filter((r) => r.scopeId === install)).toEqual([{ scopeId: install, markCopy: false }]);
      expect(markedIn.has(install)).toBe(false);
    });

    it('the same governed restore onto a snapshot does', async () => {
      restores.length = 0;
      const dump = await host.admin.exportScope(staff, t, snapshot);
      const res = await app.request(`/tenants/${t}/scopes/${snapshot}/restore`, {
        method: 'POST', headers: asStaff, body: JSON.stringify(dump),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(restores.filter((r) => r.scopeId === snapshot)).toEqual([{ scopeId: snapshot, markCopy: true }]);
      // Reset, so the repair below meets it unmarked, as a copy from before the marker is.
      markedIn.delete(snapshot);
    });
  });

  describe('the one-time repair over existing copies', () => {
    it('is staff only: a tenant credential is refused before the handler runs', async () => {
      const { status } = await pass({ dryRun: true }, asTenant);
      expect(status).toBe(403);
      expect(markCalls).toEqual([]);
    });

    it('lists the non-primary scopes on a dry run, the install never, and touches nothing', async () => {
      const { status, body } = await pass({ dryRun: true, limit: 200 });
      expect(status).toBe(200);
      expect(body.dryRun).toBe(true);
      expect(ours(body.candidates)).toEqual([...mine].filter((s) => s !== install).sort());
      expect(ours(body.candidates)).not.toContain(install);
      expect(markCalls).toEqual([]);
    });

    it('marks each copy once, logs it, refuses nothing it cannot reach silently, and never marks the install', async () => {
      refuseMark = cleanRoom; // a vertical too old to have the verb
      const { body } = await pass({ limit: 200 });
      expect(ours(body.marked)).toEqual([snapshot]);
      expect(body.failed.filter((f) => f.scopeId === cleanRoom)).toEqual([
        expect.objectContaining({ scopeId: cleanRoom, status: 404 }),
      ]);
      expect(markCalls).not.toContain(install);
      const log = await host.admin.auditLog(staff, { tenantId: t, action: 'markScopeCopy' });
      expect(log.find((e) => e.scopeId === snapshot)?.after).toMatchObject({ outcome: 'marked' });
      expect(log.find((e) => e.scopeId === cleanRoom)).toBeUndefined();
    });

    it('resumes: the next pass marks what failed, and answers already for what is marked', async () => {
      refuseMark = null;
      const { body } = await pass({ limit: 200 });
      expect(ours(body.marked)).toEqual([cleanRoom]);
      expect(ours(body.already)).toContain(snapshot);
      expect(markCalls).not.toContain(install);
    });

    it('pages: a limit of one hands back a cursor, and walking it visits every copy once', async () => {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let i = 0; i < 1000; i += 1) {
        const { body } = await pass({ limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...ours([...body.marked, ...body.already, ...body.failed, ...body.skipped]));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect([...seen].sort()).toEqual([...mine].filter((s) => s !== install).sort());
    });

    it('refuses a body it cannot parse rather than running a real pass', async () => {
      const res = await app.request(MARK, { method: 'POST', headers: asStaff, body: JSON.stringify({ dryrun: true }) });
      expect(res.status).toBe(400);
    });
  });

  describe('suspended and archived copies, and reactivation (round 3)', () => {
    let parked: ScopeId;
    let archived: ScopeId;

    it('the repair visits a suspended and an archived copy too', async () => {
      parked = await provision({ kind: 'preview' });
      archived = await provision({ forkedFrom: install, forkedAt: new Date().toISOString() });
      mine.add(parked);
      mine.add(archived);
      await host.admin.suspendScope(staff, t, parked);
      await host.admin.archiveScope(staff, t, archived);
      const { body } = await pass({ dryRun: true, limit: 200 });
      expect(ours(body.candidates)).toEqual(expect.arrayContaining([parked, archived]));
    });

    it('a reactivation marks a copy BEFORE it comes back to life', async () => {
      markedIn.delete(parked);
      markCalls.length = 0;
      const res = await app.request(`/tenants/${t}/scopes/${parked}/unsuspend`, { method: 'POST', headers: asStaff });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(markCalls).toEqual([parked]);
      expect(markedIn.has(parked)).toBe(true);
      const log = await host.admin.auditLog(staff, { tenantId: t, scopeId: parked, action: 'markScopeCopy' });
      expect(log.at(-1)?.after).toMatchObject({ outcome: 'marked' });
    });

    it('a hosted copy whose marker cannot be written is refused reactivation, and stays parked', async () => {
      markedIn.delete(archived);
      refOf.delete(v1); // the bound version's script no longer resolves
      try {
        const res = await app.request(`/tenants/${t}/scopes/${archived}/unarchive`, { method: 'POST', headers: asStaff });
        expect(res.status).toBe(503);
        expect((await host.admin.getScopeRecord(staff, t, archived))?.status).toBe('archived');
      } finally {
        refOf.set(v1, `${slug}-${v1.toLowerCase()}`);
      }
    });

    // An older vertical has no /internal/mark-copy and answers 404. That must not pass through as
    // "no such scope": every reactivation refuses 503 with what to do, logs an ops failure, and
    // leaves the directory exactly where it was.
    for (const [action, park, expected] of [
      ['activate', async (_s: ScopeId) => undefined, 'provisioning'],
      ['unsuspend', async (s: ScopeId) => host.admin.suspendScope(staff, t, s), 'suspended'],
      ['unarchive', async (s: ScopeId) => host.admin.archiveScope(staff, t, s), 'archived'],
    ] as const) {
      it(`${action}: an older vertical's 404 is a 503 with an ops failure, and the copy stays ${expected}`, async () => {
        const s = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug, kind: 'preview' });
        await host.admin.bindScopeVersion(staff, t, s, v1);
        if (action !== 'activate') await host.admin.activateScope(staff, t, s);
        await park(s);
        mine.add(s);
        refuseMark = s;
        try {
          const res = await app.request(`/tenants/${t}/scopes/${s}/${action}`, { method: 'POST', headers: asStaff });
          expect(res.status).toBe(503);
          expect(((await res.json()) as { error: string }).error).toMatch(/could not be marked.*redeploy the vertical/);
          expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe(expected);
          const failures = await host.admin.listOpsFailures(staff, { scopeId: s });
          expect(failures).toEqual([
            expect.objectContaining({ operation: `scope.${action}`, stage: 'mark-copy', status: 503, tenantId: t, scopeId: s }),
          ]);
        } finally {
          refuseMark = null;
        }
      });
    }

    it('twin: reactivating an install marks nothing', async () => {
      await host.admin.suspendScope(staff, t, install);
      markCalls.length = 0;
      const res = await app.request(`/tenants/${t}/scopes/${install}/unsuspend`, { method: 'POST', headers: asStaff });
      expect(res.status).toBe(200);
      expect(markCalls).toEqual([]);
    });
  });

  describe('a hosted copy that does not resolve is failed work; a co-located one is skipped', () => {
    it('reports an unresolvable hosted copy as failed, never skipped', async () => {
      const lost = await provision({ kind: 'preview' });
      mine.add(lost);
      markedIn.delete(lost);
      refOf.delete(v1);
      try {
        const { body } = await pass({ limit: 200 });
        expect(body.failed.filter((f) => f.scopeId === lost)).toEqual([expect.objectContaining({ scopeId: lost, status: 503 })]);
        expect(body.skipped.map((s) => s.scopeId)).not.toContain(lost);
      } finally {
        refOf.set(v1, `${slug}-${v1.toLowerCase()}`);
      }
    });

    it('skips a co-located copy (no script of its own), saying why', async () => {
      const colo = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: colo, vertical: 'embedded-vert', kind: 'preview' });
      await host.admin.activateScope(staff, t, colo);
      mine.add(colo);
      const { body } = await pass({ limit: 200 });
      expect(body.skipped.find((s) => s.scopeId === colo)?.reason).toMatch(/^co-located/);
      expect(body.failed.map((f) => f.scopeId)).not.toContain(colo);
    });
  });

  describe("clearing a mistaken mark (round 3)", () => {
    const clear = (s: string) => app.request(`/tenants/${t}/scopes/${s}/clear-copy-mark`, { method: 'POST', headers: asStaff });

    it("clears a primary's mistaken mark, and logs it", async () => {
      markedIn.add(install); // a misclassification, a race, an operator
      const res = await clear(install);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ cleared: true });
      expect(markedIn.has(install)).toBe(false);
      const log = await host.admin.auditLog(staff, { tenantId: t, scopeId: install, action: 'clearScopeCopyMark' });
      expect(log.at(-1)?.after).toMatchObject({ outcome: 'cleared' });
    });

    it('refuses to clear a real copy, before the vertical is asked', async () => {
      clearCalls.length = 0;
      const res = await clear(snapshot);
      expect(res.status).toBe(409);
      expect(markedIn.has(snapshot)).toBe(true);
      expect(clearCalls).toEqual([]);
    });

    it('is staff only', async () => {
      const res = await app.request(`/tenants/${t}/scopes/${install}/clear-copy-mark`, { method: 'POST', headers: asTenant });
      expect(res.status).toBe(403);
    });
  });
});
