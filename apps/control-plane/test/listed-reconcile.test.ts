import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ControlPlaneError, VerticalClient } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import { parseReconcileBatch, reconcileOrUnsupported } from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1653 — a LISTED vertical's promote reaches its installs' provision, against the REAL
 * directory: the control plane's Durable Object, in workerd.
 *
 * A listed vertical's promote re-serves its stable script in place (#286) and moves no
 * install's version pointer, so the #1172 phase — comparing against the pointer — never
 * saw those installs. It now compares against the version each scope RUNS. What only the
 * real directory can show:
 *
 *   - an install born while the vertical serves in place carries the serving ref from its
 *     directory row's insert (`control-plane-do.ts`), which is what the comparison reads;
 *   - a FORK of that install inherits the same serving ref at insert — it is on the same
 *     script, on the same versions, and behind in exactly the same way. The only thing
 *     keeping it off the reconcile is the fork predicate, so this is where that predicate
 *     is proven load-bearing rather than merely present;
 *   - a clean-room preview inherits no serving ref (#527) and has no lineage either, so it
 *     is `kind` alone that excludes it.
 *
 * The directory persists across this pool's test files, so the sweep sees other files'
 * scopes too. Everything here asserts on this file's own scopes, and answers every other
 * scope `unsupported` — which writes nothing — so this suite changes no one else's rows.
 */
describe('provision reconcile follows the served version (#1653)', () => {
  const staff = platformActorId.parse(ulid());
  const suffix = ulid().toLowerCase();
  const LISTED = `listed-${suffix}`;
  const LISTED_REF = `listed-${suffix}-serving`;
  const PRIVATE = `own-${suffix}`;
  const PRIVATE_REF = `own-${suffix}-serving`;
  const A = tenantId.parse(ulid());
  const B = tenantId.parse(ulid());
  const OWNER = tenantId.parse(ulid());
  let v1: string;
  let v2: string;
  const s = {
    installA: scopeId.parse(ulid()),
    installB: scopeId.parse(ulid()),
    forkOfA: scopeId.parse(ulid()),
    cleanRoom: scopeId.parse(ulid()),
    ownScope: scopeId.parse(ulid()),
  };
  const mine = new Set<string>(Object.values(s));

  const hostOf = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });

  const publish = async (host: CloudflareScopeHost, slug: string, version: string): Promise<string> => {
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: slug,
      version,
      manifestDigest: `m-${version}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `${slug}-${version.replaceAll('.', '-')}`,
    });
    await host.admin.admitVersion(staff, id).catch(() => undefined); // a private one self-admits
    return id;
  };

  const scopeAt = async (
    host: CloudflareScopeHost,
    t: TenantId,
    id: ScopeId,
    vertical: string,
    version: string,
    extra: { forkedFrom?: ScopeId; kind?: string } = {},
  ) => {
    await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical, ...extra });
    await host.admin.activateScope(staff, t, id);
    await host.admin.bindScopeVersion(staff, t, id, version);
  };

  /** One sweep pass over the real directory, recording which of OUR scopes it reconciled. */
  const pass = async (host: CloudflareScopeHost): Promise<string[]> => {
    const reached: string[] = [];
    await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      drainRetries: false,
      runSchedules: false,
      reconcileMigrations: false,
      gcSnapshots: false,
      // Past whatever else this pool's directory holds, so the window is not the variable.
      provisionReconcileBatch: 10_000,
      reconcileScopeFn: async (_t, id) => {
        if (!mine.has(id)) return 'unsupported';
        reached.push(id);
      },
    });
    return reached.sort();
  };

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostOf();
    for (const [id, slug] of [[A, `a-${suffix}`], [B, `b-${suffix}`], [OWNER, `o-${suffix}`]] as const) {
      await host.admin.createTenant(staff, { id, slug, name: slug });
    }

    // A listed, platform-owned vertical, served in place at v1.
    await host.admin.registerVertical(staff, { slug: LISTED, name: 'Listed', source: 'cli', ownerTenant: null, listed: true });
    v1 = await publish(host, LISTED, '1.0.0');
    v2 = await publish(host, LISTED, '2.0.0');
    await host.admin.setVerticalServing(staff, LISTED, { ref: LISTED_REF, versionId: v1, doClasses: ['ScopeDO'], migrationTag: 'v1' });

    // Two tenants install it (born ON the serving script), and each provision ran at v1.
    await scopeAt(host, A, s.installA, LISTED, v1);
    await scopeAt(host, B, s.installB, LISTED, v1);
    // A restored copy of A's install, as a PR preview makes one, and a clean-room preview.
    await scopeAt(host, A, s.forkOfA, LISTED, v1, { forkedFrom: s.installA });
    await scopeAt(host, A, s.cleanRoom, LISTED, v2, { kind: 'preview' });
    for (const [t, id] of [[A, s.installA], [B, s.installB], [A, s.forkOfA]] as const) {
      await host.admin.markScopeProvisioned(staff, t, id, v1);
    }

    // A private vertical whose promote already moved its scope along, as it does today.
    await host.admin.registerVertical(staff, { slug: PRIVATE, name: 'Own', source: 'cli', ownerTenant: OWNER });
    const p1 = await publish(host, PRIVATE, '1.0.0');
    await host.admin.setVerticalServing(staff, PRIVATE, { ref: PRIVATE_REF, versionId: p1, doClasses: ['ScopeDO'], migrationTag: 'v1' });
    await scopeAt(host, OWNER, s.ownScope, PRIVATE, p1);
    await host.admin.markScopeProvisioned(staff, OWNER, s.ownScope, p1);
    await host.close();
  });

  it('reads the directory the way the comparison needs: installs AND their fork on the serving script, the preview not', async () => {
    const host = hostOf();
    const rec = (t: TenantId, id: ScopeId) => host.admin.getScopeRecord(staff, t, id);
    expect((await rec(A, s.installA))?.servingRef).toBe(LISTED_REF);
    expect((await rec(B, s.installB))?.servingRef).toBe(LISTED_REF);
    // The fork is indistinguishable by script and version — only its lineage says copy.
    const fork = await rec(A, s.forkOfA);
    expect(fork?.servingRef).toBe(LISTED_REF);
    expect(fork?.forkedFrom).toBe(s.installA);
    // The clean-room preview inherits no serving script (#527) and has no lineage at all.
    const preview = await rec(A, s.cleanRoom);
    expect(preview?.servingRef ?? null).toBeNull();
    expect(preview?.forkedFrom).toBeNull();
    expect(preview?.kind).toBe('preview');
    await host.close();
  });

  it('before the promote, nothing of ours is behind', async () => {
    const host = hostOf();
    expect(await pass(host)).toEqual([]);
    await host.close();
  });

  it("after the promote, reconciles every install — both tenants' — and never the fork, the preview, or the private scope", async () => {
    const host = hostOf();
    // The promote's in-place serve. No install's pointer moves: they are each tenant's.
    await host.admin.setVerticalServing(staff, LISTED, { ref: LISTED_REF, versionId: v2, doClasses: ['ScopeDO'], migrationTag: 'v1' });

    expect(await pass(host)).toEqual([s.installA, s.installB].sort());

    for (const [t, id] of [[A, s.installA], [B, s.installB]] as const) {
      const r = await host.admin.getScopeRecord(staff, t, id);
      expect(r?.provisionedVersionId).toBe(v2); // what the hook ran as
      expect(r?.verticalVersionId).toBe(v1); // the tenant's pointer, untouched
    }
    // The fork's receipt is where it was: nothing ran on the copy.
    expect((await host.admin.getScopeRecord(staff, A, s.forkOfA))?.provisionedVersionId).toBe(v1);
    expect((await host.admin.getScopeRecord(staff, A, s.cleanRoom))?.provisionedVersionId).toBeNull();

    // Idempotent: the receipts now match what runs, so the next pass reaches none of ours.
    expect(await pass(host)).toEqual([]);
    await host.close();
  });
});

/**
 * The sweep counts a vertical that implements no reconcile as `unsupported`, apart from its
 * failures (#1653). The mapping is decided here, on the vertical's real answer as the
 * platform's own client reads it — the two 501s a vertical can give today are the routes
 * `mountPlatformSurface` answers without an owner-of-record, and a hand-mounted surface's
 * `/internal/*` catch-all (auth-server's).
 */
describe('reconcileOrUnsupported (#1653)', () => {
  const T = tenantId.parse(ulid());
  const S = scopeId.parse(ulid());
  const clientAnswering = (res: () => Response | Promise<Response>) =>
    new VerticalClient({ fetch: (async () => res()) as unknown as typeof fetch, platformSecret: 'x' });
  const call = (client: VerticalClient) => () =>
    client.reconcileInstance({ tenantId: T, scopeId: S } as Parameters<VerticalClient['reconcileInstance']>[0]);
  const answer = (status: number, error: string) => () =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

  it('is unsupported for either 501 a vertical gives today', async () => {
    await expect(
      reconcileOrUnsupported(call(clientAnswering(answer(501, 'this vertical keeps no owner-of-record to reconcile from')))),
    ).resolves.toBe('unsupported');
    await expect(
      reconcileOrUnsupported(call(clientAnswering(answer(501, 'auth-server does not implement POST /internal/reconcile')))),
    ).resolves.toBe('unsupported');
  });

  it('is a success for a 2xx, and still a failure for every other refusal', async () => {
    const ok = () =>
      new Response(JSON.stringify({ tenantId: T, scopeId: S, owner: principalId.parse(ulid()) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(reconcileOrUnsupported(call(clientAnswering(ok)))).resolves.toBeUndefined();
    for (const [status, error] of [
      [409, 'no owner of record for scope — cannot reconcile; re-run the full install'],
      [500, 'the vertical broke'],
      [403, 'platform secret mismatch'],
    ] as const) {
      const refused = reconcileOrUnsupported(call(clientAnswering(answer(status, error))));
      await expect(refused).rejects.toBeInstanceOf(ControlPlaneError);
      await expect(refused).rejects.toMatchObject({ status });
    }
    // A transport failure is not the vertical's answer at all.
    const unreachable = new VerticalClient({
      fetch: (async () => {
        throw new Error('Worker not found.');
      }) as unknown as typeof fetch,
      platformSecret: 'x',
    });
    await expect(reconcileOrUnsupported(call(unreachable))).rejects.toMatchObject({ status: 502 });
  });
});

describe('PROVISION_RECONCILE_BATCH (#1653)', () => {
  it('is a non-negative integer or the default — 0 is the pause, and a typo is neither extreme', () => {
    expect(parseReconcileBatch(undefined)).toBeUndefined();
    expect(parseReconcileBatch('')).toBeUndefined();
    expect(parseReconcileBatch('200')).toBe(200);
    expect(parseReconcileBatch('0')).toBe(0);
    expect(parseReconcileBatch('-1')).toBeUndefined();
    expect(parseReconcileBatch('2.5')).toBeUndefined();
    expect(parseReconcileBatch('lots')).toBeUndefined();
  });
});
