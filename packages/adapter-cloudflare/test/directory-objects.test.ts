import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { directoryCrossingContractSuite } from '@substrat-run/contract-tests';
import { runCrossing, ulid, type CrossingLedgerPort, type DirectoryClaimsPort } from '@substrat-run/kernel';
import { durableDirectoryObjects, tenantDirectoryStub } from '../src/directory-objects.js';
import { DIRECTORY_PLACEMENT, directoryTables, withoutCrossObjectReferences, type DirectoryObjectKind } from '../src/directory-placement.js';

/**
 * K-68 (directory split), step 3a: the registry and the tenant directory object, built beside
 * `ControlPlaneDO` and carrying no traffic. What has to hold before anything writes them:
 *
 * - every table the directory builds has a placement, and nothing else does;
 * - a table placed in a new object is built EXACTLY as a fresh directory builds it (statement and
 *   indexes), so steps 3b and 3c copy a row by column name with nothing to translate. The columns
 *   `ensureDirectoryColumns` adds are a copy in `directory-placement.ts`; this is what keeps it true;
 * - an object built for one owner refuses another's call;
 * - a crash between two objects' commits leaves an intent a retry finishes (rfc §11's
 *   fault-injection suite; the end state on both adapters is `directoryCrossingContractSuite`).
 */
type Schema = Map<string, { sql: string; indexes: string[] }>;

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

function schemaOf(state: DurableObjectState): Schema {
  const rows = state.storage.sql
    .exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'`)
    .toArray() as { type: string; name: string; tbl_name: string; sql: string }[];
  const out: Schema = new Map();
  for (const r of rows.filter((r) => r.type === 'table')) out.set(r.name, { sql: norm(r.sql), indexes: [] });
  for (const r of rows.filter((r) => r.type === 'index')) out.get(r.tbl_name)?.indexes.push(norm(r.sql));
  for (const t of out.values()) t.indexes.sort();
  return out;
}

async function directorySchema(): Promise<Schema> {
  const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`shape-${ulid()}`));
  return runInDurableObject(stub, (_instance, state) => schemaOf(state));
}

async function objectSchema(kind: DirectoryObjectKind): Promise<Schema> {
  const ns = kind === 'registry' ? env.DIRECTORY_REGISTRY : env.TENANT_DIRECTORY;
  const stub = ns.get(ns.idFromName(`shape-${ulid()}`));
  return runInDurableObject(stub, (_instance, state) => schemaOf(state));
}

/** The tables each new object adds of its own: the crossing ledger, its owner, and the registry's claims. */
const OWN_TABLES: Record<DirectoryObjectKind, string[]> = {
  registry: ['_substrat_directory_claims', '_substrat_directory_crossings', '_substrat_directory_self', 'directory_mirror_parked', 'directory_mirror_rows'],
  tenant: ['_substrat_directory_crossings', '_substrat_directory_self', 'directory_mirror_parked', 'directory_mirror_rows'],
};

describe('directory placement (K-68)', () => {
  it('places every table the directory builds, and only those', async () => {
    const built = [...(await directorySchema()).keys()].sort();
    expect(directoryTables().sort()).toEqual(built);
    expect(Object.keys(DIRECTORY_PLACEMENT).sort()).toEqual(built);
  });

  for (const kind of ['registry', 'tenant'] as const) {
    it(`the ${kind} object builds each of its tables as a fresh directory does, and no other table`, async () => {
      const [directory, object] = await Promise.all([directorySchema(), objectSchema(kind)]);
      const placed = Object.entries(DIRECTORY_PLACEMENT)
        .filter(([, p]) => p.to === kind || p.to === 'both')
        .map(([table]) => table);
      expect([...object.keys()].sort()).toEqual([...placed, ...OWN_TABLES[kind]].sort());
      // A reference into another object is the one difference allowed (`CROSS_OBJECT_REFERENCES`).
      for (const table of placed) {
        const built = directory.get(table)!;
        const expected = { ...built, sql: norm(withoutCrossObjectReferences(kind, table, built.sql)) };
        expect({ table, ...object.get(table) }).toEqual({ table, ...expected });
      }
    });
  }
});

describe('directory objects', () => {
  it('a tenant object bound to one tenant refuses a call for another, or under another jurisdiction', async () => {
    const tenant = ulid();
    const stub = tenantDirectoryStub(env.TENANT_DIRECTORY, tenant, 'global');
    const input = { crossingId: ulid(), kind: 'hostname-bind', namespace: 'hostname' as const, key: `${ulid().toLowerCase()}.test`, holder: tenant };
    await stub.recordCrossing(`tenant:${tenant}`, 'global', input);
    await expect(() => stub.recordCrossing(`tenant:${ulid()}`, 'global', { ...input, crossingId: ulid() })).rejects.toThrow(/this directory object is tenant:/);
    await expect(() => stub.crossing(`tenant:${tenant}`, 'eu', input.crossingId)).rejects.toThrow(/\(global\), not/);
  });

  // workerd does not implement jurisdictions ("Jurisdiction restrictions are not implemented"), so
  // the address is asserted on the namespace calls it makes.
  it('addresses a pinned tenant in its jurisdiction’s namespace (K-7), and a global one in the plain namespace', () => {
    const calls: string[] = [];
    const fake = (label: string): DurableObjectNamespace => ({
      idFromName: (name: string) => { calls.push(`${label}.idFromName(${name})`); return name as never; },
      get: (id: unknown) => id as never,
      jurisdiction: (j: string) => { calls.push(`${label}.jurisdiction(${j})`); return fake(j); },
    }) as unknown as DurableObjectNamespace;
    tenantDirectoryStub(fake('ns') as never, 'T1', 'global');
    tenantDirectoryStub(fake('ns') as never, 'T2', 'eu');
    tenantDirectoryStub(fake('ns') as never, 'T3', 'us');
    expect(calls).toEqual([
      'ns.idFromName(tenant:T1)',
      'ns.jurisdiction(eu)', 'eu.idFromName(tenant:T2)',
      'ns.jurisdiction(us)', 'us.idFromName(tenant:T3)',
    ]);
  });

  /** Commit the wrapped call, then die: the host crashing between two objects' commits. */
  function crashingAfter<T extends object>(port: T, method: keyof T): T {
    return new Proxy(port, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== method || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          throw new Error(`crashed after ${String(prop)}`);
        };
      },
    });
  }

  const steps: [string, (l: CrossingLedgerPort, r: DirectoryClaimsPort) => [CrossingLedgerPort, DirectoryClaimsPort]][] = [
    ['the registry claimed', (l, r) => [l, crashingAfter(r, 'claim')]],
    ['the tenant object marked it claimed', (l, r) => [crashingAfter(l, 'markCrossingClaimed'), r]],
    ['the registry confirmed', (l, r) => [l, crashingAfter(r, 'confirmClaim')]],
  ];
  for (const [label, crash] of steps) {
    it(`a crash after ${label} leaves an open crossing that the next run finishes`, async () => {
      const objects = durableDirectoryObjects({ registry: env.DIRECTORY_REGISTRY, tenants: env.TENANT_DIRECTORY });
      const tenant = ulid();
      const ledger = objects.tenant(tenant);
      const registry = objects.registry();
      const input = { crossingId: ulid(), kind: 'hostname-bind', namespace: 'hostname' as const, key: `${ulid().toLowerCase()}.test`, holder: tenant };
      await ledger.recordCrossing(input);
      const [dyingLedger, dyingRegistry] = crash(ledger, registry);
      await expect(runCrossing(dyingLedger, dyingRegistry, input.crossingId)).rejects.toThrow(/crashed after/);
      expect((await ledger.openCrossings({ updatedBefore: '9999', limit: 10 })).map((c) => c.crossingId)).toEqual([input.crossingId]);

      expect(await objects.complete(ledger, input.crossingId)).toMatchObject({ state: 'done' });
      expect(await registry.readClaim('hostname', input.key)).toMatchObject({ claimId: input.crossingId, holder: tenant, state: 'confirmed' });
    });
  }
});

directoryCrossingContractSuite('adapter-cloudflare', async () => ({
  objects: durableDirectoryObjects({ registry: env.DIRECTORY_REGISTRY, tenants: env.TENANT_DIRECTORY }),
}));
