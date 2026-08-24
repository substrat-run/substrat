/**
 * Every entity check this engine DECLARES, driven against the handler serving it.
 *
 * Four operations declare `permission: { key, refFrom }` — the shape #896 added,
 * for a check narrowed to a ref the CALLER supplies whole. Nothing in the type
 * system makes a handler honour it: `ctx.check(PERM.read)` without the ref
 * typechecks and lets anyone holding `absence:read` anywhere in the scope read
 * anyone's ledger and balance. On an absence engine that is the whole of the
 * privacy story, and it fails in the direction nobody files a bug about.
 *
 * ## The harness plays the vertical, which is the point
 *
 * This engine narrows to a subject whose type it does not know and cannot name:
 *
 * > It knows NOTHING about who a subject is (the vertical owns the directory).
 *
 * So there is no entity for the kit to create out of this engine's own registry,
 * and `refEntityType` is where the harness supplies one. It names `employee` —
 * Meridian's noun, not absence's — and `createEntity` mints a bare ULID for it
 * without writing a row anywhere, because a subject ref is exactly that: an
 * opaque pointer the vertical owns. A grant resolves against the ref whether or
 * not any table on this side has heard of it, which is what makes the engine's
 * indifference to the noun testable rather than merely stated.
 *
 * The probe holds **nothing scope-wide**: `mintPrincipal()` with no permissions
 * gets no role at all, so its only authority is the grant this suite makes on one
 * subject. A pass therefore means the grant is what let it in.
 *
 * ## What is not driven, and why it is not a gap
 *
 * `absence/cancel` and `absence/list-requests` hold the other two narrowed checks
 * and declare node keys, each for a reason `operations.ts` states: cancel's
 * narrowed path reads its ref off the STORED request rather than the input, and
 * list-requests narrows only when the caller supplies a subject. Both are real
 * checks that this kit cannot reach; neither is an entity check the declaration
 * claims and fails to honour, which is what this suite is about.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataSubjectId,
  permissionKey,
  type EntityRef,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { PERM, absenceModule, absenceOperations, type AbsenceEntry } from '../src/index.js';

let h: EngineHarness;
let staff: ScopeStub;
let probe: { principal: PrincipalId; stub: ScopeStub };

beforeAll(async () => {
  h = await engineHarness({ modules: [absenceModule] });
  staff = await h.as([PERM.configure, PERM.read, PERM.approve, PERM.request]);
  probe = await h.mintPrincipal();
  // One leave type, so `absence/request` and `absence/balance` name something
  // real. Which subject it is asked about is the suite's business, not the
  // engine's.
  await staff.invoke('absence/configure-leave-type', { key: 'vacation', floor: '-5' });
});

afterAll(async () => {
  await h.close();
});

entityCheckConformanceSuite(
  conformance.subject,
  conformance.operations,
  async () => ({
    // The vertical's noun, minted rather than stored — see the header.
    async createEntity(entityType: string) {
      if (entityType !== 'employee') throw new Error(`no factory for '${entityType}'`);
      return ulid();
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      await h.grantOn(probe.principal, permissionKey.parse(permission), entity);
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      return probe.stub.invoke(operation, input);
    },
  }),
  conformance,
);

/**
 * The three list reads answer a PAGE now (#811), and a string assertion over the
 * declaration would not have caught a walk that never advances. So the walk is
 * driven: two entries, a limit of one, and the cursor has to reach the second.
 */
describe('the paged reads walk', () => {
  it('advances the ledger walk by its (effectiveDate, id) cursor', async () => {
    const subject = {
      ref: { entityType: 'employee', entityId: ulid() },
      dataSubjectId: dataSubjectId.parse(ulid()),
    };
    for (const effectiveDate of ['2031-01-01', '2031-02-01']) {
      await staff.invoke('absence/record-entry', {
        subject,
        leaveTypeKey: 'vacation',
        entryKind: 'accrual',
        delta: '10',
        effectiveDate,
      });
    }

    const first = await staff.invoke<Page<AbsenceEntry>>('absence/list-entries', {
      subject: subject.ref,
      limit: 1,
    });
    expect(first.entries.map((e) => e.effectiveDate)).toEqual(['2031-01-01']);
    expect(first.nextCursor).not.toBeNull();

    const second = await staff.invoke<Page<AbsenceEntry>>('absence/list-entries', {
      subject: subject.ref,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.entries.map((e) => e.effectiveDate)).toEqual(['2031-02-01']);
    // A FULL page always carries a cursor — `pageOf` cannot know it read the last
    // row — so the walk ends on the empty fetch after it, not here.
    expect(second.nextCursor).not.toBeNull();

    const third = await staff.invoke<Page<AbsenceEntry>>('absence/list-entries', {
      subject: subject.ref,
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(third.entries).toEqual([]);
    expect(third.nextCursor).toBeNull();
  });
});
