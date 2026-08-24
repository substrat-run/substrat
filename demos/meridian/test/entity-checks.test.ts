/**
 * Every entity check Meridian DECLARES, driven against the handler serving it.
 *
 * Meridian is the largest narrowed surface in the fleet: nine keys granted per
 * employee (§4 of its `PERMISSIONS.md`), and an employee's entire access to their
 * own balance, timesheet and expenses IS that grant. Nothing in the type system
 * makes a handler honour it — `ctx.check(HR_PERM.timeRead)` without the ref
 * typechecks and lets anyone holding `time:read` read every employee's hours.
 *
 * The probe is a principal with NO role and NO grant — minted here, absent from
 * the seed's cast. That is what makes a pass mean something: the narrowed grant
 * this suite makes is the only authority the probe ever holds, so case 1 cannot
 * be satisfied by a scope-wide key it happened to have.
 *
 * Two of Meridian's thirteen narrowed checks are deliberately NOT here, and
 * `operations.ts` says why rather than leaving it to be inferred:
 * `hr/list-leave-types` and `hr/list-projects` narrow only when the caller
 * supplies the optional `employeeId` and check the node otherwise, which
 * `{ key, entity, idFrom }` cannot state. They declare the bare key — the safe
 * understatement — so they claim no entity check for this suite to honour. The
 * two `protocol:*` checks inside `hr/issue-employment-contract` are `resolved`:
 * the instance is minted inside the handler and is not in the input.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  permissionKey,
  platformActorId,
  principalId,
  type EntityRef,
} from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import { meridianOperations } from '../src/operations.js';

let dir: string;
let host: SqliteScopeHost;
let w: DemoWorld;
let n = 0;

/** No role, no grant, not in the cast — see the header. */
const probe = principalId.parse(ulid());
/** The control-plane dev actor every admin mutation is stamped with (seed.ts). */
const staff = platformActorId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'meridian-entity-checks-'));
  host = buildDemoHost(dir);
  w = await seedDemo(host, dir);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

entityCheckConformanceSuite(
  'meridian',
  meridianOperations,
  async () => ({
    async createEntity(entityType: string) {
      // Everything is created by HR admin in the Swedish scope, which is where
      // the seed puts the onboarding template these instances need.
      const hedda = await host.getScope(w.hedda, w.t1, w.sSe);
      const employee = await hedda.invoke<{ id: string }>('hr/create-employee', {
        number: `C-${String(n++).padStart(4, '0')}`,
        name: 'Conformance Probe',
      });
      if (entityType === 'employee') return employee.id;
      if (entityType === 'protocol') {
        // A protocol instance has to hang off an employee, so each one gets a
        // fresh record of its own rather than sharing the seed's cast.
        const instance = await hedda.invoke<{ id: string }>('hr/start-onboarding', {
          templateKey: 'onboarding-se',
          employeeId: employee.id,
        });
        return instance.id;
      }
      throw new Error(`no factory for '${entityType}'`);
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant. Meridian's own employee-self grants are minted by
      // `hr/create-employee` through the server's `grantEmployeeSelf`; using that
      // path would prove the bootstrap works, not that the handler narrows.
      await host.admin.grant(staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: w.t1, scopeId: w.sSe },
        entity,
        grantedBy: w.hedda,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, w.t1, w.sSe);
      return stub.invoke(operation, input);
    },
  }),
  {
    // Only what each schema REQUIRES beyond the id the kit supplies. These need
    // to be plausible, not domain-valid: case 1 asserts "was not denied", and a
    // business refusal on a fresh employee is not a permission answer.
    inputs: {
      'hr/request-leave': {
        leaveTypeKey: 'vacation',
        startDate: '2031-06-01',
        endDate: '2031-06-05',
        days: '5',
      },
      'hr/log-time': { workDate: '2031-06-01', hours: '8' },
      'hr/submit-expense': {
        description: 'Conformance',
        amount: '100',
        currency: 'SEK',
        category: 'travel',
      },
    },
  },
);
