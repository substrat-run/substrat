/**
 * Every entity check this engine DECLARES, driven against the handler serving it.
 *
 * Seven of the seventeen operations declare `permission: { key, entity:
 * 'reservation', idFrom: 'reservationId' }`. Nothing in the type system makes a
 * handler honour that — `ctx.check(PERM.cancel)` without the ref typechecks and
 * lets anyone holding `booking:cancel` anywhere in the scope cancel anyone's
 * booking. On the engine behind a club's court schedule, where a member's whole
 * access to a reservation IS a grant on that one row, that is the check worth
 * having a machine verify.
 *
 * The probe holds **nothing scope-wide**: `mintPrincipal()` with no permissions
 * gets no role at all, so the only authority it ever has is the grant this suite
 * makes on one reservation. A pass therefore means the grant is what let it in.
 *
 * The other ten operations are out of scope here and deliberately not reported as
 * gaps. Four check the node while still taking a `reservationId`, which
 * `operations.ts` explains rather than leaves to be inferred: `booking/expire`
 * sweeps a lapsed hold, and `booking/start` / `booking/complete` /
 * `booking/no-show` are service-desk verbs over whatever reservation is in front
 * of the desk. The other six never name a reservation at all.
 */
import { afterAll, beforeAll } from 'vitest';
import { permissionKey, type EntityRef, type PrincipalId } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import type { ScopeStub } from '@substrat-run/kernel';
import { PERM, bookingModule, type Reservation } from '../src/index.js';
import { bookingOperations } from '../src/operations.js';

let h: EngineHarness;
let staff: ScopeStub;
let probe: { principal: PrincipalId; stub: ScopeStub };
let court: string;
let n = 0;

beforeAll(async () => {
  h = await engineHarness({ modules: [bookingModule] });
  staff = await h.as([PERM.manageResources, PERM.hold, PERM.read]);
  // No permissions at all — no role, no tuples. Everything this principal can
  // ever do arrives as a grant on one reservation.
  probe = await h.mintPrincipal();
  const resource = await staff.invoke<{ id: string }>('booking/create-resource', {
    kind: 'court',
    name: 'Bana 1',
    // Roomy on purpose: every case books a fresh reservation, and a capacity of
    // one would refuse the second overlapping hold for an allocation reason that
    // has nothing to do with the permission under test.
    capacity: 99,
  });
  court = resource.id;
});

afterAll(async () => {
  await h.close();
});

entityCheckConformanceSuite(
  'engine-booking',
  bookingOperations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'reservation') throw new Error(`no factory for '${entityType}'`);
      // A distinct hour per reservation, so two of them never contend for the
      // same slot — the suite creates several and the engine's allocation
      // invariant is not what is under test here.
      const hour = String(n++ % 24).padStart(2, '0');
      const day = String(1 + Math.floor(n / 24)).padStart(2, '0');
      const held = await staff.invoke<Reservation>('booking/hold', {
        resourceId: court,
        startsAt: `2031-03-${day}T${hour}:00:00Z`,
        endsAt: `2031-03-${day}T${hour}:45:00Z`,
        expiresAt: `2031-03-${day}T${hour}:30:00Z`,
      });
      return held.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      await h.grantOn(probe.principal, permissionKey.parse(permission), entity);
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      return probe.stub.invoke(operation, input);
    },
  }),
  {
    // Only what each schema REQUIRES beyond `reservationId`. These need to be
    // plausible, not domain-valid: case 1 asserts "was not denied", and a
    // business refusal on a fresh hold is not a permission answer.
    inputs: {
      'booking/join': { partyRef: '01JPARTY0000000000000000000' },
      'booking/leave': { participantId: '01JPARTICIPANT00000000000000' },
      'booking/open': { fillTarget: 4 },
    },
  },
);
