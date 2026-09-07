/**
 * The signals `version` dimension on the outbox (#1242, the deferred half of #1231's
 * outbox stamp), Cloudflare half: the ScopeDO reads `env.SUBSTRAT_VERSION_ID` — in
 * production a `plain_text` binding the deploy injects (control-plane-api/src/wfp.ts),
 * here a wrangler var — and stamps it into every emitted row's `version` column.
 * Env is script-wide, so the NULL-when-unconfigured half of the behaviour is pinned
 * by adapter-sqlite/test/version-stamp.test.ts, where the option can simply be absent.
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

interface OutboxRow {
  type: string;
  operation: string | null;
  version: string | null;
}

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('the outbox version stamp (#1242)', () => {
  it('every emitted row carries the script’s SUBSTRAT_VERSION_ID', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    try {
      const staff = platformActorId.parse(ulid());
      const t1 = tenantId.parse(ulid());
      const s1 = scopeId.parse(ulid());
      await host.admin.createTenant(staff, {
        id: t1,
        slug: `version-${ulid().toLowerCase()}`,
        name: 'Version',
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'version-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      const stub = await host.getScope(principalId.parse(ulid()), t1, s1);
      await stub.invoke('test/emit-event');
      const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
      expect(rows.length).toBeGreaterThan(0);
      // The wrangler var stands in for the deploy-injected plain_text binding; the
      // value below is pinned in wrangler.jsonc.
      for (const row of rows) expect(row.version).toBe(env.SUBSTRAT_VERSION_ID);
      expect(env.SUBSTRAT_VERSION_ID).toBe('01JTESTVRSN0000000000000AA');
    } finally {
      await host.close();
    }
  });
});
