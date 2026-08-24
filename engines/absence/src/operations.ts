import { defineOperations } from '@substrat-run/contracts';
import { absenceEntities } from './entities.js';
import {
  absenceEntry,
  absenceRequest,
  availabilityAnswer,
  availabilityInput,
  balanceAnswer,
  balanceInput,
  cancelAbsenceInput,
  cancelAnswer,
  configureLeaveTypeInput,
  decideAbsenceInput,
  decideAnswer,
  expiredAnswer,
  leaveType,
  listEntriesInput,
  listRequestsInput,
  recordEntryInput,
  requestAbsenceInput,
} from './schemas.js';

/**
 * engine-absence' declared operation surface (#707/#865/#891/#896).
 *
 * ## Why this file exists now
 *
 * Six of this engine's checks narrow to an entity, and until #896 they were
 * **undeclarable rather than merely undeclared** — the two halves of that being
 * separate problems:
 *
 * 1. There was no declaration to put them in. `index.ts` carried a map of
 *    handlers, so `ctx.check(PERM.read, ref)` and `ctx.check(PERM.read)` looked
 *    the same to every tool in the repo, and `entityCheckConformanceSuite`
 *    derives its behavioural pair from `permission` (#891).
 * 2. The format could not hold them. A narrowed check named `entity: '<a type
 *    from a declared registry>'`, and this engine narrows to a subject whose type
 *    is the VERTICAL's — Meridian's `employee`, which appears in no registry
 *    absence can see. #890's `entityFrom` did not reach it either: it changes
 *    where the type name comes from, not that it has to be a name someone
 *    declared. `refFrom` names the field carrying the whole ref, so the type
 *    travels with it and needs no name here at all (#896).
 *
 * What is deliberately NOT here is `http`: an engine owns no URL shape. Meridian
 * composes this engine by CALL — importing `requestAbsence`, `balanceAsOf` and
 * the rest into its own operations — so these bindings are the engine's default
 * surface rather than the path any vertical serves.
 *
 * ## Four narrow, two say node, and the two are the interesting ones
 *
 * `request`, `balance`, `availability` and `list-entries` declare `refFrom` and
 * the kit drives all four. The other two checks are real and are **not** declared
 * as narrowed, each for a reason worth stating rather than leaving to be
 * inferred:
 *
 * - **`cancel` has two authorities and the narrowed one is resolved.** An
 *   approver cancels anything cancellable (node); a subject may withdraw their
 *   own still-`requested` row through the same grant they requested with — but
 *   that ref is read off the stored request, not the input, so there is no field
 *   to name. Declaring the node key alone would say a subject needs
 *   `absence:approve` to withdraw, which is false. It declares the gate it opens
 *   with and states the second path here.
 * - **`list-requests` narrows only when the caller supplies a subject.** An
 *   `optional` field behind `refFrom` would claim a narrowing that a caller
 *   omitting it never gets — the unsafe direction for a review artifact to be
 *   wrong in, and the same call Meridian's `hr/list-leave-types` and Shop's
 *   `catalog` made (#892).
 *
 * ## Paging, and why no `over`
 *
 * Three reads answer lists, and #811 refuses a bare array. None is
 * kernel-composed: the ledger and the request book are ROWS this engine owns, not
 * registry entities — `absenceEntities` declares exactly one, `leave-type` — so
 * `paged.over` has nothing to name for two of the three, and the third answers a
 * projection (`active` as a boolean) rather than the stored row. So all three
 * page over their own fold, and **this change provisions no list index and adds
 * no migration.**
 */
export const ABSENCE_PERMISSIONS = [
  'absence:read',
  'absence:request',
  'absence:approve',
  'absence:configure',
] as const;

export const absenceOperations = defineOperations(absenceEntities, ABSENCE_PERMISSIONS)({
  'absence/configure-leave-type': {
    summary: 'Create or update a leave type and its balance floor',
    permission: 'absence:configure',
    input: configureLeaveTypeInput,
    output: leaveType,
  },

  'absence/list-leave-types': {
    summary: 'The configured leave types, by key',
    permission: 'absence:read',
    output: leaveType,
    // Handler-composed: what is answered is the PROJECTION of the row (`active`
    // as a boolean), so the page is taken off the fold. `key` is the primary key,
    // so it is both the order and a unique cursor.
    paged: { sortKey: 'key' },
  },

  'absence/record-entry': {
    summary: 'Write an accrual, correction or carryover to the ledger',
    // Node, deliberately: the one write that bypasses the request flow is an
    // administrator's, over whichever subject needs correcting.
    permission: 'absence:configure',
    input: recordEntryInput,
    output: absenceEntry,
  },

  'absence/request': {
    summary: 'Request absence for a subject',
    /**
     * The shape #896 exists for. A subject requests for THEMSELVES through a
     * grant on their own ref while holding no role at all, so a node check here
     * would let anyone holding `absence:request` anywhere in the scope file
     * absence against anyone — with every test still green, because the engine's
     * own suite grants scope-wide.
     *
     * `subject.ref` reaches one level in: the erasure key travels beside the ref
     * (`{ ref, dataSubjectId }`) and only the ref is checked.
     */
    permission: { key: 'absence:request', refFrom: 'subject.ref' },
    input: requestAbsenceInput,
    output: absenceRequest,
  },

  'absence/decide': {
    summary: 'Approve or reject a requested absence',
    // Node: deciding is the approver's authority over the whole scope. The
    // 'booking' entry this mints is why approval is the only path into the
    // ledger.
    permission: 'absence:approve',
    input: decideAbsenceInput,
    output: decideAnswer,
  },

  'absence/cancel': {
    summary: 'Cancel an approved absence, or withdraw a requested one',
    // The gate it OPENS with. The second authority — the subject withdrawing
    // their own still-requested row, narrowed to a ref read off the stored
    // request — is undeclarable here and is described in the header.
    permission: 'absence:approve',
    input: cancelAbsenceInput,
    output: cancelAnswer,
  },

  'absence/expire-stale': {
    summary: 'Expire requests left undecided past their window',
    // Node: a sweep acts on whatever has lapsed. Bound to the schedule this
    // engine's own manifest declares (#383).
    permission: 'absence:approve',
    output: expiredAnswer,
  },

  'absence/balance': {
    summary: 'Balance for one subject and leave type, as of a date',
    permission: { key: 'absence:read', refFrom: 'subject' },
    input: balanceInput,
    output: balanceAnswer,
  },

  'absence/availability': {
    summary: 'Which calendar days an approved absence covers, for one subject',
    permission: { key: 'absence:read', refFrom: 'subject' },
    input: availabilityInput,
    output: availabilityAnswer,
  },

  'absence/list-requests': {
    summary: 'Requests, optionally for one subject or one status',
    // Node — see the header. This is the conditional narrow, and declaring it
    // would claim something a caller omitting `subject` does not pass.
    permission: 'absence:read',
    input: listRequestsInput,
    inputOptional: true,
    output: absenceRequest,
    // Newest first, which is the order this read shipped with. The cursor is the
    // id: it is a ULID, so it is unique and it descends with `created_at`.
    paged: { sortKey: 'id' },
  },

  'absence/list-entries': {
    summary: "One subject's ledger entries, oldest first",
    permission: { key: 'absence:read', refFrom: 'subject' },
    input: listEntriesInput,
    output: absenceEntry,
    // `effectiveDate` is the order and is NOT unique — it is caller-supplied, so
    // an accrual dated last year may be written today. The cursor is therefore
    // the (effectiveDate, id) pair, the same pair the SQL orders by; `sortKey`
    // names the field a reader sorts by, as Callout's timeline does over a rowid.
    paged: { sortKey: 'effectiveDate' },
  },
});
