/**
 * Every entity check RallyPoint DECLARES, driven against the handler serving it.
 *
 * Rally's isolation IS its narrowed grants. A player's `booking:read` is granted
 * per member record and per reservation — never at the scope — precisely so a
 * player cannot read the club's book: who holds which court, and who they play
 * with. `ctx.check(BK.read)` without the ref typechecks and hands them all of it,
 * which is the bug this suite exists to make impossible to ship quietly (#865).
 *
 * The probe is a principal with NO role and NO grant — minted here, absent from
 * the seed's cast. That is what makes a pass mean something: the narrowed grant
 * this suite makes is the only authority the probe ever holds, so case 1 cannot
 * be satisfied by a scope-wide key it happened to have.
 *
 * Six of rally's eight narrowed checks are driven here. The other two are stated
 * in `operations.ts` rather than left to be inferred:
 *
 * - **`rally/cancel-subscription`** declares `resolved` — it narrows to the
 *   member the SUBSCRIPTION row names, and the input carries only a subscription
 *   id, so the harness has no way to reach the entity. It is reported as
 *   uncovered below rather than skipped quietly.
 * - **`rally/portal-bookings`** declares `narrows` — a per-row proof walk, not
 *   one entity check. The scenario's portal-isolation beat is what proves it.
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
import { buildRallyHost, seedRally, type RallyWorld } from '../src/index.js';
import { rallyOperations } from '../src/operations.js';

let dir: string;
let host: SqliteScopeHost;
let w: RallyWorld;
/**
 * A member the reservation-facing cases can add to a booking.
 *
 * Held in the object the kit is handed rather than passed by value: `inputs` is
 * read when the suite is COLLECTED, which is before `beforeAll` has run, so a
 * plain string would still be empty. The kit spreads this object per case, at
 * run time, by which point the id is in it.
 */
const spareMember: Record<string, unknown> = { memberId: '' };
let n = 0;

/** No role, no grant, not in the cast — see the header. */
const probe = principalId.parse(ulid());
/** The control-plane dev actor every admin mutation is stamped with (seed.ts). */
const staff = platformActorId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rally-entity-checks-'));
  host = buildRallyHost(dir);
  w = await seedRally(host, dir);
  const astrid = await host.getScope(w.astrid, w.t1, w.s1);
  const member = await astrid.invoke<{ id: string }>('rally/create-member', {
    // A data-subject id, not a label: `create-member` parses it as one, because
    // it is what crypto-shredding keys off.
    partyRef: ulid(),
    name: 'Spare Player',
  });
  spareMember.memberId = member.id;
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

entityCheckConformanceSuite(
  'rally',
  rallyOperations,
  async () => ({
    async createEntity(entityType: string) {
      const astrid = await host.getScope(w.astrid, w.t1, w.s1);
      if (entityType === 'member') {
        const member = await astrid.invoke<{ id: string }>('rally/create-member', {
          partyRef: ulid(),
          name: 'Conformance Probe',
        });
        return member.id;
      }
      if (entityType === 'reservation') {
        // A distinct hour per booking: two of them must never contend for the
        // same slot, since the engine's allocation invariant is not under test.
        const hour = 7 + (n++ % 14);
        const held = await astrid.invoke<{ reservation: { id: string } }>('rally/book-court', {
          resourceId: w.court1,
          memberId: String(spareMember.memberId),
          date: '2031-04-08',
          time: `${String(hour).padStart(2, '0')}:00`,
          duration: 60,
        });
        return held.reservation.id;
      }
      throw new Error(`no factory for '${entityType}'`);
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant. Rally's own player grants are minted by the portal
      // bootstrap; using that path would prove the bootstrap works, not that the
      // handler narrows.
      await host.admin.grant(staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: w.t1, scopeId: w.s1 },
        entity,
        grantedBy: w.astrid,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, w.t1, w.s1);
      return stub.invoke(operation, input);
    },
  }),
  {
    // Only what each schema REQUIRES beyond the id the kit supplies. These need
    // to be plausible, not domain-valid: case 1 asserts "was not denied", and a
    // business refusal on a fresh hold is not a permission answer.
    inputs: {
      'rally/add-player': spareMember,
      'rally/open-up': { spots: 2, levelMin: 'C', levelMax: 'B' },
      // The handler is entity-agnostic and the declaration cannot yet say so
      // (#890), so the type it is driven with is supplied here — the same
      // constant every call site passes.
      'rally/timeline': { entityType: 'member' },
    },
    uncovered: {
      'rally/cancel-subscription':
        "declares 'resolved' (the member is read off the subscription row) — the entity id is not in the input, so the harness cannot reach the entity",
    },
  },
);
