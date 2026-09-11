/**
 * Every entity check Tock DECLARES, driven against the handler that serves it.
 *
 * `test/conformance.ts` has always named seven operations that narrow onto a run and nine
 * that cannot. Nothing executed it: there was no suite calling the kit, so the file was a
 * claim about coverage rather than coverage, and the package's green run was the scenario
 * alone. This is the half that makes the claim answerable.
 *
 * What it catches is specific. `permission: { key: 'run:manage', entity: 'run', idFrom:
 * 'runId' }` is a declaration; nothing in the type system makes a handler honour it, and
 * `ctx.check(perm)` without the entity compiles perfectly while letting every principal in
 * the workspace reach every run. The kit generates the behavioural pair that separates them.
 *
 * The probe holds **no role**, which matters more here than in a record app: every one of
 * Tock's keys is held workspace-wide, so a probe who was an analyst would pass each check
 * without the grant under test doing anything at all.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, principalId, type EntityRef } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { conformance } from './conformance.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
/** No role, no grants — everything it can reach, this suite gave it. */
const probe = principalId.parse(ulid());
/** The source every probe run is opened against; declared once, on first use. */
const SOURCE = 'conformance-cdn';
let made = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tock-entity-checks-'));
  host = buildHost(dir);
  world = await seed(host);
  const ines = await host.getScope(world.ines.principal, world.tenant, world.scope);
  await ines.invoke('tock/declare-source', {
    key: SOURCE,
    title: 'Conformance CDN logs',
    expectedCadence: 'daily',
  });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

entityCheckConformanceSuite(
  conformance.subject,
  conformance.operations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'run') throw new Error(`no factory for '${entityType}'`);
      made += 1;
      // Through the operation that opens a run, never a raw INSERT — a run made behind the
      // module's back would prove the check against a row the module never agreed to.
      const tomas = await host.getScope(world.tomas.principal, world.tenant, world.scope);
      const run = await tomas.invoke<{ id: string }>('tock/receive-run', {
        sourceKey: SOURCE,
        filename: `conformance-${made}.log`,
        byteSize: 64,
        contentHash: `sha256:conformance-${made}`,
        storageKey: `runs/conformance-${made}.log`,
        // The structural mapping a run now records. Literals here rather than derived from
        // the model: the fixture stands for a file, and which column carries the instant is
        // a fact about a file that no schema implies.
        format: 'csv',
        delimiter: ',',
        timeField: 'occurred_at',
        subjectField: 'subject',
        periodFrom: '2026-03-14T00:00:00.000Z',
        periodTo: '2026-03-15T00:00:00.000Z',
      });
      return run.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant. Setting this up through one of Tock's own operations would make
      // each case prove only that the operation agrees with itself.
      await host.admin.grant(world.staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: world.tenant, scopeId: world.scope },
        entity,
        grantedBy: world.ines.principal,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, world.tenant, world.scope);
      return stub.invoke(operation, input);
    },
  }),
  conformance,
);
