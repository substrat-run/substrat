import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECTION_EXPIRY_WARNING_DAYS,
  connectionId,
  deriveExpiryWarning,
  platformActorId,
  tenantId,
  toConnectionHealthEntry,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * #1690 — Scrive holds OAuth1 personal access credentials (api.ts): no refresh token, so
 * no horizon. A connection created the way the connect flows create one records none,
 * and the fleet health row says "not reported" — which is true, not a gap.
 */
describe('scrive connection expiry', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function connect(expiresAt?: string) {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-expiry-'));
    const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)) });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'Scrive',
      ...(expiresAt ? { expiresAt } : {}),
      secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    });
    const [row] = await host.admin.listConnections(staff, { tenantId: t });
    return row!;
  }

  it('records no expiry and warns nothing', async () => {
    const row = await connect();
    expect(row.expiresAt).toBeNull();
    const entry = toConnectionHealthEntry(row, new Date());
    expect(entry.expiresAt).toBeNull();
    expect(entry.expiryWarning).toBeNull();
    expect(deriveExpiryWarning(null, new Date())).toBeNull();
  });

  it('the warning is live for a connection that does carry a horizon (soon / outside twin)', async () => {
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
    const soon = await connect(at(CONNECTION_EXPIRY_WARNING_DAYS - 1));
    expect(toConnectionHealthEntry(soon, now).expiryWarning).toBe('soon');
    rmSync(dir, { recursive: true, force: true });
    const far = await connect(at(CONNECTION_EXPIRY_WARNING_DAYS + 1));
    expect(toConnectionHealthEntry(far, now).expiryWarning).toBeNull();
  });
});
