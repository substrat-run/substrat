import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type TenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1899: every directory binding in this worker is its own directory. Every host addresses
 * the directory as `idFromName('control-plane')`, so two bindings to one class are one
 * object — which is how one file's scopes landed in another file's exact counts. A binding
 * pointed back at `ControlPlaneDO` in wrangler.jsonc turns this red; the diagonal is the
 * twin that proves the read would see the tenant at all.
 *
 * And each harness's SCOPES read that same directory: a ScopeDO reads tenant tuples and
 * roles through its own `env.CONTROL_PLANE`, so a scope class left on the worker's binding
 * checks permissions against a directory its tenant is not in (`onDirectory`, test/worker.ts).
 */
const DIRECTORIES = ['CONTROL_PLANE', 'SCHED_CONTROL_PLANE', 'SWEEP_CONTROL_PLANE', 'VE_CONTROL_PLANE', 'PC_CONTROL_PLANE'] as const;
type Directory = (typeof DIRECTORIES)[number];

type TenantReader = { getTenant(id: string): Promise<unknown> };
const readerOf = (ns: DurableObjectNamespace) => ns.get(ns.idFromName('control-plane')) as unknown as TenantReader;
const directory = (name: Directory) => readerOf(env[name]);

/** Every scope binding, and the directory its harness hands its host. */
const SCOPES = [
  ['SCOPE', 'CONTROL_PLANE'],
  ['SCHED_SCOPE', 'SCHED_CONTROL_PLANE'],
  ['SWEEP_SCOPE', 'SWEEP_CONTROL_PLANE'],
  ['CRM_SCOPE', 'VE_CONTROL_PLANE'],
  ['BOARD_SCOPE', 'VE_CONTROL_PLANE'],
  ['PC_SCOPE', 'PC_CONTROL_PLANE'],
  ['PC_V1_SCOPE', 'PC_CONTROL_PLANE'],
  ['PC_V2_SCOPE', 'PC_CONTROL_PLANE'],
  ['PC_V3_SCOPE', 'PC_CONTROL_PLANE'],
] as const;

describe('each directory binding is its own directory (#1899)', () => {
  const staff = platformActorId.parse(ulid());
  const created = new Map<Directory, TenantId>();

  beforeAll(async () => {
    for (const name of DIRECTORIES) {
      await warmControlPlane(env[name]);
      const host = new CloudflareScopeHost({
        scope: env.SCOPE,
        controlPlane: env[name],
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
      const t = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `iso-${t.toLowerCase()}`, name: name });
      created.set(name, t);
      await host.close();
    }
  });

  for (const writer of DIRECTORIES) {
    it(`a tenant created through ${writer} is in ${writer} and in no other directory`, async () => {
      const t = created.get(writer)!;
      for (const reader of DIRECTORIES) {
        const seen = (await directory(reader).getTenant(t)) !== undefined;
        expect({ reader, seen }).toEqual({ reader, seen: reader === writer });
      }
    });
  }

  for (const [scope, own] of SCOPES) {
    it(`a ${scope} scope reads ${own} as its CONTROL_PLANE, and no other directory`, async () => {
      const ns = env[scope];
      const seen = await runInDurableObject(ns.get(ns.newUniqueId()), async (instance) => {
        const cp = (instance as unknown as { env: { CONTROL_PLANE: DurableObjectNamespace } }).env.CONTROL_PLANE;
        const out: Partial<Record<Directory, boolean>> = {};
        for (const name of DIRECTORIES) out[name] = (await readerOf(cp).getTenant(created.get(name)!)) !== undefined;
        return out;
      });
      expect(seen).toEqual(Object.fromEntries(DIRECTORIES.map((name) => [name, name === own])));
    });
  }
});
