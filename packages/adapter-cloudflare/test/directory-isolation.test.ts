import { env } from 'cloudflare:test';
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
 */
const DIRECTORIES = ['CONTROL_PLANE', 'SCHED_CONTROL_PLANE', 'SWEEP_CONTROL_PLANE', 'VE_CONTROL_PLANE', 'PC_CONTROL_PLANE'] as const;
type Directory = (typeof DIRECTORIES)[number];

const directory = (name: Directory) => {
  const ns = env[name];
  return ns.get(ns.idFromName('control-plane')) as unknown as { getTenant(id: string): Promise<unknown> };
};

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
});
