import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, tenantId } from '@substrat-run/contracts';
import { runConnectorSweep, ulid, webCryptoSecretBox, type FetchLike } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #3324, through a real directory: the `connector-attempt` row a sweep writes before its work is
 * stored and read back by kind, and a connection whose attempt has no outcome after it (the pass
 * died inside the sweep) is waited out rather than swept again.
 */
describe('a connector attempt with no outcome after it, in the directory (#3324)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is waited out on the next pass, and swept once the wait has passed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connector-attempt-'));
    const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)) });
    try {
      const staff = platformActorId.parse(ulid());
      const t = tenantId.parse(ulid());
      const id = connectionId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
      await host.admin.createConnection(staff, {
        id,
        tenantId: t,
        vertical: 'docs',
        provider: 'drive',
        label: 'drive',
        externalAccountRef: 'acct-1',
        scopes: [],
        secret: { apiToken: 'tok' },
      });
      // What a pass that died in the sweep leaves behind.
      await host.admin.recordSweepRun({ kind: 'connector-attempt', unit: id, outcome: 'started', tenantId: null, connectionId: id });
      const [attempt] = await host.admin.listSweepRuns(staff, { kind: 'connector-attempt', unit: id });
      expect(attempt).toMatchObject({ outcome: 'started', tenantId: null });

      let polls = 0;
      let now = Date.parse(attempt!.at);
      const pass = () =>
        runConnectorSweep(host, {
          actor: staff,
          fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
          sweepers: { drive: async () => { polls += 1; } },
          clock: () => now,
          recordSweepRun: (e) => void host.admin.recordSweepRun(e),
          recordSweepAttempt: (e) => host.admin.recordSweepRun(e),
        });

      now += 5 * 60_000;
      expect((await pass()).connectionsBackingOff).toBe(1);
      expect(polls).toBe(0);

      now += 60 * 60_000;
      expect((await pass()).connectionsBackingOff).toBe(0);
      expect(polls).toBe(1);
    } finally {
      await host.close();
    }
  });
});
