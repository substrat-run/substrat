import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type TenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1899 (the why is in test/worker.ts): every directory binding is its own directory, and
 * each harness's scopes read theirs. A binding pointed back at `ControlPlaneDO`, or a scope
 * class left off `onDirectory`, turns a row red; the diagonal is the twin that proves the
 * read would see the tenant at all. `SCOPES` restates worker.ts's pairing on purpose: it is
 * the oracle, not a copy.
 */
const DIRECTORIES = ['CONTROL_PLANE', 'SCHED_CONTROL_PLANE', 'SWEEP_CONTROL_PLANE', 'VE_CONTROL_PLANE', 'PC_CONTROL_PLANE'] as const;
type Directory = (typeof DIRECTORIES)[number];

type TenantReader = { getTenant(id: string): Promise<unknown> };
const readerOf = (ns: DurableObjectNamespace) => ns.get(ns.idFromName('control-plane')) as unknown as TenantReader;

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

/**
 * The scope bindings that read the worker's own `CONTROL_PLANE`, on purpose: no harness hands
 * them a directory of their own. A new scope binding must land in `SCOPES` or here — the
 * completeness test below refuses one in neither, so a harness cannot slip past this file.
 */
const SHARED_SCOPES = ['BROKEN_SCOPE', 'LIVE_SCOPE', 'LOCAL_SWEEP_SCOPE', 'OWN_PARENT_SCOPE', 'SPINE_PARENT_SCOPE'] as const;

/** Every binding in the worker's env whose name matches, read from env rather than typed out. */
const bindingsNamed = (pattern: RegExp) => Object.keys(env).filter((name) => pattern.test(name)).sort();

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

  it('every scope binding in the worker is paired with a directory here, or declared shared', () => {
    const accounted = [...SCOPES.map(([scope]) => scope), ...SHARED_SCOPES].sort();
    expect(bindingsNamed(/(^|_)SCOPE$/)).toEqual(accounted);
  });

  it('every directory binding in the worker is one this file checks', () => {
    expect(bindingsNamed(/(^|_)CONTROL_PLANE$/)).toEqual([...DIRECTORIES].sort());
  });

  for (const writer of DIRECTORIES) {
    it(`a tenant created through ${writer} is in ${writer} and in no other directory`, async () => {
      const t = created.get(writer)!;
      for (const reader of DIRECTORIES) {
        const seen = (await readerOf(env[reader]).getTenant(t)) !== undefined;
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
