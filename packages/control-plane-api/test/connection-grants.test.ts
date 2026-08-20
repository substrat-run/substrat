import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  connectionId,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { reconcileConnectionGrants } from '../src/index.js';

/**
 * Healing a connection's grants toward what its connector declares (#726 gap 2).
 *
 * The failure this exists to end is on the record: `protocol:attach` was missing from a
 * live Scrive connection for months, failing the sealed-copy landing into a field nobody
 * reads. Nothing could see it (until the read-back), and the only way to add it was to
 * re-submit a working credential — on a rotation path that, done wrong, replaces one.
 *
 * The properties under test are the ones that make this a DECLARATION being materialized
 * rather than an authority decision: it heals to a floor and never prunes, it reaches
 * installs that do not exist yet, it is idempotent, and it touches nothing outside the
 * (tenant, vertical, provider) the declaration names.
 */
describe('reconcileConnectionGrants — a declared grant repairs itself', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const conn = connectionId.parse(ulid());

  const RECORD = permissionKey.parse('protocol:record-signature');
  const ATTACH = permissionKey.parse('protocol:attach');
  const DECLARED = { scrive: [RECORD, ATTACH] } as const;

  const heal = (declared: Readonly<Record<string, readonly string[]>> = DECLARED) =>
    reconcileConnectionGrants({ admin: host.admin, actor: staff, declared }, t, 'egeryds-crm');

  /** What the DIRECTORY holds live for our connection — the source the gather reads. */
  const held = async (): Promise<string[]> =>
    (await host.admin.listConnectionGrants(staff, t))
      .filter((g) => g.connectionId === conn && g.revokedAt === null)
      .map((g) => g.permission)
      .sort();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-conn-grants-'));
    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(9)),
    });
    await host.admin.createTenant(staff, { id: t, slug: 'egeryds', name: 'Egeryds' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'egeryds-crm' });
    await host.admin.activateScope(staff, t, s);
    // The live connection as the dashboard's connect flow would have left it BEFORE the
    // connector declared `attach` — one grant, and a working credential nobody should
    // have to re-type to add the other.
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'egeryds-crm',
      provider: 'scrive',
      label: 'Scrive',
      secret: { accessToken: 'a-working-credential' },
    });
    await host.admin.grantToConnection(staff, {
      connectionId: conn,
      permission: RECORD,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants the declared key the connection is missing, without touching the credential', async () => {
    expect(await held()).toEqual([RECORD]);

    const report = await heal();

    expect(report.granted).toEqual([{ connectionId: conn, permission: ATTACH }]);
    expect(await held()).toEqual([ATTACH, RECORD]);
    // The credential is untouched: still openable, still the same bytes. This is the
    // whole point — the repair no longer runs through a rotation path.
    const open = await host.admin.openConnection(t, 'egeryds-crm', 'scrive');
    expect(open?.secret).toEqual({ accessToken: 'a-working-credential' });
  });

  it('is enforced, not merely recorded — the scope answers with the healed grant', async () => {
    // A directory row nobody delivers is the #592 failure mode in reverse, so this
    // asserts against the SCOPE's own read-back rather than the directory's list.
    await heal();
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'egeryds-crm' });

    const inScope = (await host.connectionGrantsInScope(t, s))
      .filter((g) => g.connectionId === conn)
      .map((g) => g.permission)
      .sort();
    expect(inScope).toEqual([ATTACH, RECORD]);
  });

  it('reaches an install that did not exist when the grant was healed', async () => {
    // Granted tenant-wide precisely for this: #592 materializes tenant-wide rows per
    // scope, so a second install provisioned later holds it without replaying anything.
    await heal();
    const later = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: later, vertical: 'egeryds-crm' });
    await host.admin.activateScope(staff, t, later);

    const inScope = (await host.connectionGrantsInScope(t, later))
      .filter((g) => g.connectionId === conn)
      .map((g) => g.permission);
    expect(inScope).toContain(ATTACH);
  });

  it('is idempotent — a second pass grants nothing and changes nothing', async () => {
    await heal();
    const before = await held();
    const second = await heal();
    expect(second.granted).toEqual([]);
    expect(await held()).toEqual(before);
  });

  it('never prunes: a key the declaration does not name survives', async () => {
    // A floor, not a ceiling. A connection may legitimately hold more than its connector
    // declares, and a reconcile that pruned to the declaration would revoke authority
    // nobody asked it to touch — including, on the day a declaration shrinks, every
    // tenant's at once.
    const EXTRA = permissionKey.parse('protocol:read');
    await host.admin.grantToConnection(staff, {
      connectionId: conn,
      permission: EXTRA,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });
    await heal({ scrive: [RECORD] }); // a declaration naming neither ATTACH nor EXTRA
    expect(await held()).toEqual([EXTRA, RECORD]);
  });

  it('leaves a working scope-targeted grant alone rather than layering a second row', async () => {
    // RECORD is already held, scope-targeted. Healing must not add a tenant-wide twin:
    // two rows saying one thing is how they later come to disagree.
    await heal();
    const rows = (await host.admin.listConnectionGrants(staff, t)).filter(
      (g) => g.connectionId === conn && g.permission === RECORD && g.revokedAt === null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeId).toBe(s);
  });

  it('touches no connection outside the declaration', async () => {
    // Another provider, another vertical, and a revoked connection — none of them the
    // declaration's business, and a heal that reached any of them would be granting
    // authority on the strength of a list that never mentioned it.
    const otherProvider = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: otherProvider,
      tenantId: t,
      vertical: 'egeryds-crm',
      provider: 'fortnox',
      label: 'Fortnox',
      secret: { accessToken: 'x' },
    });
    const otherVertical = connectionId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: scopeId.parse(ulid()), vertical: 'other' });
    await host.admin.createConnection(staff, {
      id: otherVertical,
      tenantId: t,
      vertical: 'other',
      provider: 'scrive',
      label: 'Scrive elsewhere',
      secret: { accessToken: 'x' },
    });
    const revoked = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: revoked,
      tenantId: t,
      vertical: 'egeryds-crm',
      provider: 'scrive',
      label: 'Scrive (old)',
      secret: { accessToken: 'x' },
      externalAccountRef: 'old-account',
    });
    await host.admin.revokeConnection(staff, revoked);

    const report = await heal();

    expect(report.granted.map((g) => g.connectionId)).toEqual([conn]);
    const rows = await host.admin.listConnectionGrants(staff, t);
    for (const other of [otherProvider, otherVertical, revoked]) {
      expect(rows.filter((g) => g.connectionId === other && g.revokedAt === null)).toEqual([]);
    }
  });

  it('does nothing at all for a host that declares no connectors', async () => {
    const report = await reconcileConnectionGrants(
      { admin: host.admin, actor: staff, declared: {} },
      t,
      'egeryds-crm',
    );
    expect(report.granted).toEqual([]);
    expect(await held()).toEqual([RECORD]);
  });
});
