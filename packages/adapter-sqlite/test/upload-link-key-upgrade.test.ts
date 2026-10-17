import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type MintedUploadLink,
} from '@substrat-run/contracts';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from '@substrat-run/contract-tests';
import { UPLOAD_LINK_GONE, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

it('a scope DB from before #2315 gains redeemed_key_hash on reopen, keeps its links, and a second reopen is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-upl-key-'));
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const entity: EntityRef = { entityType: 'udoc', entityId: 'legacy' };
  const open = () => {
    const h = new SqliteScopeHost({ dir, secretBox });
    h.registerModule(uploadLinkMod);
    return h;
  };
  const columns = () => {
    const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
    try {
      return db.prepare("SELECT name FROM pragma_table_info('_substrat_upload_links')").all();
    } finally {
      db.close();
    }
  };
  let host = open();
  const mint = async (): Promise<MintedUploadLink> => (await host.getScope(alice, t, s)).invoke<MintedUploadLink>('upl/mint', { entity });
  const redeem = (m: MintedUploadLink, idempotencyKey?: string) =>
    host.redeemUploadLink(t, s, m.secret, {
      entity,
      filename: 'a.txt',
      contentType: 'text/plain',
      body: bytes('hello'),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  try {
    await host.admin.createTenant(staff, { id: t, slug: `upl-key-${ulid().toLowerCase()}`, name: 'Upload key upgrade' });
    await host.admin.grantEntitlement(staff, t, 'upl');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'upl-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'upl-vertical', binding: 'ATTACHMENTS' });
    await host.admin.defineRole(staff, t, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    // One link spent and one pending, then the table put back to its pre-#2315 shape.
    const spent = await mint();
    await redeem(spent);
    const pending = await mint();
    await host.close();
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try {
      db.exec('ALTER TABLE _substrat_upload_links DROP COLUMN redeemed_key_hash');
    } finally {
      db.close();
    }
    expect(columns()).not.toContainEqual({ name: 'redeemed_key_hash' });

    host = open();
    // The link spent before the column carries no key: a key never replays it.
    const legacy = await redeem(spent, `key-${ulid()}`).then(() => undefined, (e: unknown) => e);
    expect((legacy as { extensions?: { reason?: unknown } }).extensions?.reason).toBe(UPLOAD_LINK_GONE);
    expect(columns()).toContainEqual({ name: 'redeemed_key_hash' });
    const k = `key-${ulid()}`;
    const first = await redeem(pending, k);
    await host.close();
    host = open();
    expect(await redeem(pending, k)).toEqual({ ...first, replayed: true });
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
