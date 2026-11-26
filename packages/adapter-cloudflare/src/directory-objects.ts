/**
 * The two kinds of directory object the Cloudflare adapter's directory splits into (K-68, directory
 * split; rfc/tenant-scale.md §7.1): one global REGISTRY, and one DIRECTORY OBJECT PER TENANT.
 *
 * Step 3a of the migration order (rfc §12): both classes exist, are bound and build their tables,
 * and carry NO traffic. Nothing in the platform addresses them yet. `ControlPlaneDO` stays the one
 * directory every read and write goes to, and its storage is untouched. What they serve today is the
 * intent-first crossing (`@substrat-run/kernel`'s `directory-crossing`): the registry's claims and
 * each object's crossing ledger, so steps 3b on have the mechanism to wire onto.
 *
 * Addressing:
 * - the registry is `idFromName('registry')`, with no jurisdiction. It holds ids, slugs, hostname
 *   claims and the platform's own state (verticals, versions, store drivers), none of it a tenant's
 *   residency-bound data (K-36).
 * - a tenant's object is `idFromName('tenant:' + tenantId)` in its jurisdiction's namespace (K-7):
 *   a `global` tenant in the plain namespace, an `eu` or `us` one in `namespace.jurisdiction(…)`. A
 *   jurisdiction is fixed when the object is created and never changes, and the same name in another
 *   jurisdiction is another object, so the jurisdiction is part of the address. It is recorded on the
 *   registry's `tenant-id` claim, which is where host code will read it from (steps 3b on).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Jurisdiction } from '@substrat-run/contracts';
import {
  claimIn,
  confirmClaimIn,
  crossingIn,
  markCrossingClaimedIn,
  openCrossingsIn,
  readClaimIn,
  recordCrossingIn,
  REGISTRY_OWNER,
  releaseClaimIn,
  runCrossing,
  settleCrossingIn,
  tenantOwnerOf,
  type ClaimInput,
  type ClaimNamespace,
  type ClaimOutcome,
  type ClaimRow,
  type ConfirmInput,
  type ConfirmOutcome,
  type CrossingInput,
  type CrossingLedgerPort,
  type CrossingRow,
  type DirectoryClaimsPort,
  type DirectoryObjects,
  type ReleaseInput,
  type SettleInput,
  type SwitchSql,
} from '@substrat-run/kernel';
import { directoryObjectSchema, type DirectoryObjectKind } from './directory-placement.js';
import { switchSqlOver } from './scope-do.js';

/** The registry's object name. */
export const REGISTRY_OBJECT_NAME = 'registry';
/** A tenant directory object's name (rfc §7.1). */
export const tenantDirectoryNameOf = (tenantId: string): string => `tenant:${tenantId}`;

/**
 * Which owner an object belongs to, bound on its first ledger write and refused for any other after
 * (a call that reached the wrong object writes nothing). One row; the registry's owner is fixed.
 */
const DIRECTORY_SELF_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_directory_self (
    id           INTEGER PRIMARY KEY,
    owner        TEXT NOT NULL,
    jurisdiction TEXT NOT NULL,
    bound_at     TEXT NOT NULL
  );
`;

/** Attempt-and-tolerate ALTER, as `ControlPlaneDO.addColumn` does: DO SQLite restricts PRAGMA. */
function addColumn(sql: SqlStorage, table: string, column: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  } catch (err) {
    if (!/duplicate column name/i.test((err as Error).message)) throw err;
  }
}

abstract class DirectoryObjectBase extends DurableObject {
  protected readonly sql: SqlStorage;
  protected readonly kernelSql: SwitchSql;

  constructor(ctx: DurableObjectState, env: unknown, kind: DirectoryObjectKind) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.kernelSql = switchSqlOver(this.sql);
    // Every statement is `IF NOT EXISTS` and every column tolerated, so a construction after the
    // first runs the same list and changes nothing. One transaction: a construction that fails
    // half-way leaves the object as it was, never a table without its later columns.
    ctx.storage.transactionSync(() => {
      for (const step of directoryObjectSchema(kind)) {
        if ('exec' in step) this.sql.exec(step.exec);
        else addColumn(this.sql, step.addColumn[0], step.addColumn[1]);
      }
      this.sql.exec(DIRECTORY_SELF_DDL);
    });
  }

  /** Refuse a call meant for another object; bind this one to its owner on the first write. */
  protected assertOwner(owner: string, jurisdiction: Jurisdiction, bind: boolean): void {
    const [self] = this.sql.exec('SELECT owner, jurisdiction FROM _substrat_directory_self WHERE id = 1').toArray() as { owner: string; jurisdiction: string }[];
    if (self) {
      if (self.owner !== owner || self.jurisdiction !== jurisdiction) {
        throw new Error(`this directory object is ${self.owner} (${self.jurisdiction}), not ${owner} (${jurisdiction})`);
      }
      return;
    }
    if (bind) {
      this.sql.exec(
        'INSERT INTO _substrat_directory_self (id, owner, jurisdiction, bound_at) VALUES (1, ?, ?, ?)',
        owner, jurisdiction, new Date().toISOString(),
      );
    }
  }

  recordCrossing(owner: string, jurisdiction: Jurisdiction, input: CrossingInput): CrossingRow {
    return this.ctx.storage.transactionSync(() => {
      this.assertOwner(owner, jurisdiction, true);
      return recordCrossingIn(this.kernelSql, owner, { ...input, nowMs: Date.now() });
    });
  }

  crossing(owner: string, jurisdiction: Jurisdiction, crossingId: string): CrossingRow | null {
    this.assertOwner(owner, jurisdiction, false);
    return crossingIn(this.kernelSql, owner, crossingId);
  }

  markCrossingClaimed(owner: string, jurisdiction: Jurisdiction, crossingId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.assertOwner(owner, jurisdiction, false);
      return markCrossingClaimedIn(this.kernelSql, owner, crossingId, Date.now());
    });
  }

  settleCrossing(owner: string, jurisdiction: Jurisdiction, crossingId: string, settle: SettleInput): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.assertOwner(owner, jurisdiction, false);
      return settleCrossingIn(this.kernelSql, owner, crossingId, { ...settle, nowMs: Date.now() });
    });
  }

  openCrossings(owner: string, jurisdiction: Jurisdiction, query: { updatedBefore: string; limit: number }): CrossingRow[] {
    this.assertOwner(owner, jurisdiction, false);
    return openCrossingsIn(this.kernelSql, owner, query);
  }
}

/** The one global registry (rfc §7.1). */
export class DirectoryRegistryDO extends DirectoryObjectBase {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, 'registry');
  }

  claim(input: ClaimInput): ClaimOutcome {
    return this.ctx.storage.transactionSync(() => claimIn(this.kernelSql, { ...input, nowMs: Date.now() }));
  }

  confirmClaim(input: ConfirmInput): ConfirmOutcome {
    return this.ctx.storage.transactionSync(() => confirmClaimIn(this.kernelSql, { ...input, nowMs: Date.now() }));
  }

  releaseClaim(input: ReleaseInput): { released: boolean } {
    return this.ctx.storage.transactionSync(() => releaseClaimIn(this.kernelSql, input));
  }

  readClaim(namespace: ClaimNamespace, key: string): ClaimRow | null {
    return readClaimIn(this.kernelSql, namespace, key);
  }
}

/** One per tenant (rfc §7.1): everything that is the tenant's. */
export class TenantDirectoryDO extends DirectoryObjectBase {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, 'tenant');
  }
}

/** The registry's stub. */
export function registryStub(ns: DurableObjectNamespace<DirectoryRegistryDO>): DurableObjectStub<DirectoryRegistryDO> {
  return ns.get(ns.idFromName(REGISTRY_OBJECT_NAME));
}

/** A tenant's directory object, in its jurisdiction's namespace (K-7). */
export function tenantDirectoryStub(
  ns: DurableObjectNamespace<TenantDirectoryDO>,
  tenantId: string,
  jurisdiction: Jurisdiction,
): DurableObjectStub<TenantDirectoryDO> {
  const scoped = jurisdiction === 'global' ? ns : ns.jurisdiction(jurisdiction);
  return scoped.get(scoped.idFromName(tenantDirectoryNameOf(tenantId)));
}

type LedgerRpc = Pick<DirectoryObjectBase, 'recordCrossing' | 'crossing' | 'markCrossingClaimed' | 'settleCrossing' | 'openCrossings'>;

function ledgerPort(stub: LedgerRpc, owner: string, jurisdiction: Jurisdiction): CrossingLedgerPort {
  return {
    owner,
    recordCrossing: async (input) => stub.recordCrossing(owner, jurisdiction, input),
    crossing: async (id) => stub.crossing(owner, jurisdiction, id),
    markCrossingClaimed: async (id) => stub.markCrossingClaimed(owner, jurisdiction, id),
    settleCrossing: async (id, settle) => stub.settleCrossing(owner, jurisdiction, id, settle),
    openCrossings: async (query) => stub.openCrossings(owner, jurisdiction, query),
  };
}

/**
 * The seam (`DirectoryObjects`) over the two namespaces: the registry's ports and each tenant's
 * ledger as RPC stubs, and `complete` as `runCrossing` across them. `jurisdictionOf` answers a
 * tenant's jurisdiction; until something records one, every tenant is `global` (the only value the
 * provisioning boundary accepts, `provisionableJurisdiction`).
 */
export function durableDirectoryObjects(options: {
  registry: DurableObjectNamespace<DirectoryRegistryDO>;
  tenants: DurableObjectNamespace<TenantDirectoryDO>;
  jurisdictionOf?: (tenantId: string) => Jurisdiction;
}): DirectoryObjects {
  const registry = registryStub(options.registry);
  const claims: DirectoryClaimsPort = {
    claim: async (input) => registry.claim(input),
    confirmClaim: async (input) => registry.confirmClaim(input),
    releaseClaim: async (input) => registry.releaseClaim(input),
    readClaim: async (namespace, key) => registry.readClaim(namespace, key),
  };
  const registryPorts = { ...ledgerPort(registry as unknown as LedgerRpc, REGISTRY_OWNER, 'global'), ...claims };
  return {
    registry: () => registryPorts,
    tenant: (tenantId) => {
      const jurisdiction = options.jurisdictionOf?.(tenantId) ?? 'global';
      const stub = tenantDirectoryStub(options.tenants, tenantId, jurisdiction);
      return ledgerPort(stub as unknown as LedgerRpc, tenantOwnerOf(tenantId), jurisdiction);
    },
    complete: (ledger, crossingId) => runCrossing(ledger, claims, crossingId),
  };
}
