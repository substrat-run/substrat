import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { connectionId, platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, SecretBoxUnconfiguredError } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The two connection-store properties the shared contract suite cannot express:
 * one needs a host built WITHOUT a SecretBox, and the other needs to read the
 * directory file directly — neither of which the Cloudflare adapter can do.
 */
describe('connection store (pure adapter)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const world = async (secretBox?: ReturnType<typeof webCryptoSecretBox>) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-conn-'));
    const host = secretBox ? new SqliteScopeHost({ dir, secretBox }) : new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'conn', name: 'Conn' });
    return { host, staff, t };
  };

  it('refuses to store a credential when no SecretBox is configured', async () => {
    // Fails closed. Degrading to plaintext would make the misconfiguration
    // invisible until the credential leaked.
    const { host, staff, t } = await world();
    await expect(
      host.admin.createConnection(staff, {
        id: connectionId.parse(ulid()),
        tenantId: t,
        vertical: 'callout',
        provider: 'scrive',
        label: 'no box',
        secret: { accessToken: 'tok' },
      }),
    ).rejects.toThrow(/no SecretBox configured/);
    await host.close();
  });

  it('says so up front, and refuses with a TYPED error (#603)', async () => {
    // Two halves of one fact. The flag is what a caller reads BEFORE doing work whose only
    // purpose is to produce something to store — the connection relay's 503 rests on it,
    // ahead of its outbound probe. The typed throw is what a transport recognises when some
    // other consumer of the box reaches the store anyway, so a deployment fact stops
    // surfacing as an unexplained 500.
    const { host, staff, t } = await world();
    expect(host.admin.canStoreSecrets).toBe(false);
    await expect(
      host.admin.createConnection(staff, {
        id: connectionId.parse(ulid()),
        tenantId: t,
        vertical: 'callout',
        provider: 'scrive',
        label: 'no box',
        secret: { accessToken: 'tok' },
      }),
    ).rejects.toBeInstanceOf(SecretBoxUnconfiguredError);
    await host.close();
  });

  it('writes no plaintext credential to the directory file', async () => {
    // The contract suite proves the token never comes back out of an API. This
    // proves it never went in — the check that survives someone adding a new
    // read path later.
    const { host, staff, t } = await world(
      webCryptoSecretBox('k', new Uint8Array(32).fill(1)),
    );
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'callout',
      provider: 'scrive',
      label: 'sealed',
      secret: { accessToken: 'plaintext-canary-value' },
    });
    await host.close();

    const db = new Database(join(dir!, '_directory.sqlite'), { readonly: true });
    const rows = db
      .prepare('SELECT key_id, ciphertext FROM _substrat_connection_secrets')
      .all() as { key_id: string; ciphertext: string }[];
    const admin = db.prepare('SELECT before, after FROM _substrat_admin_log').all();
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_id).toBe('k');
    expect(rows[0]!.ciphertext).not.toContain('plaintext-canary-value');
    expect(JSON.stringify(admin)).not.toContain('plaintext-canary-value');
  });

  it('attributes createdBy to the authorizing principal when supplied, else the actor', async () => {
    // B (connections.md §3.5.1): a self-serve connect is a tenant admin's in-scope act,
    // effected by the host with platform authority — so the connection must record the
    // *principal* who authorized it, never the effecting STAFF actor (the D-31 laundering).
    const { host, staff, t } = await world(webCryptoSecretBox('k', new Uint8Array(32).fill(1)));
    const principal = ulid(); // stands in for the tenant admin from the signed OAuth state

    const selfServe = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: selfServe,
      tenantId: t,
      vertical: 'dashboard',
      provider: 'github',
      label: 'GitHub — acme',
      secret: { installationId: '42' },
      createdBy: principal,
    });

    const platformDriven = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: platformDriven,
      tenantId: t,
      vertical: 'callout',
      provider: 'scrive',
      label: 'staff-connected',
      secret: { accessToken: 'tok' },
    });

    const conns = await host.admin.listConnections(staff, { tenantId: t });
    const byId = new Map(conns.map((c) => [c.id, c.createdBy]));
    expect(byId.get(selfServe)).toBe(principal); // attributed to the admin, not STAFF
    expect(byId.get(platformDriven)).toBe(staff); // omitted ⇒ the effecting actor, unchanged
    await host.close();
  });
});
