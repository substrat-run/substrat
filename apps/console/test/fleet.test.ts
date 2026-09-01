import { describe, expect, it } from 'vitest';
import { AUTO_ADMISSION_NOTE } from '@substrat-run/contracts';
import type { VerticalVersion } from '@substrat-run/contracts';
import {
  admissionLabel,
  admissionTone,
  availableActions,
  awaitingStaffVouch,
  canReprovision,
  effectiveAdmission,
  type EffectiveStatus,
} from '../src/lib/fleet';

/**
 * The lifecycle levers the console offers per scope status. Only *legal* transitions
 * may appear: the graph is enforced below the seam (host.ts `transitionScope`), so an
 * offered-but-illegal action is a button whose only outcome is a 409. Conversely, a
 * legal transition the console hides is a dead-end — a scope stuck with no way forward
 * (#500). This suite pins both directions.
 */

// The server's own transition graph (host.ts scope lifecycle handlers), transcribed as
// action → the statuses it is legal FROM. The console's offering must be a subset of the
// action being legal from the scope's status, so a rendered button never 409s.
const SERVER_LEGAL_FROM: Record<string, EffectiveStatus[]> = {
  suspend: ['active'],
  unsuspend: ['suspended'],
  archive: ['provisioning', 'active', 'suspended'],
  unarchive: ['archived'],
  reap: ['archived'],
};

const ALL_STATUSES: EffectiveStatus[] = [
  'provisioning',
  'active',
  'suspended',
  'archiving',
  'archived',
  'reaped',
  'suspended-via-tenant',
];

/**
 * Re-running a provision is a REPAIR, not a transition — the lever for a scope that is
 * stuck rather than in the wrong state. Two shapes of stuck: the #332 lockout (roles
 * projected, zero tuples, every login denied) and an install that predates something its
 * vertical now mints for itself at provision, which no other path can deliver because
 * provision runs at install and never again.
 */
describe('canReprovision', () => {
  const withVertical = { vertical: 'ticket0' };

  it('is offered wherever there is live storage to provision into', () => {
    for (const status of ['provisioning', 'active', 'suspended', 'suspended-via-tenant'] as const) {
      expect(canReprovision(withVertical, status)).toBe(true);
    }
  });

  /**
   * An archived scope's DO is dormant and a reaped one's is gone; `archiving` is
   * mid-flight. Repairing any of them means restoring first, so offering the button
   * there would be offering a failure.
   */
  it('is not offered where there is nothing to provision into', () => {
    for (const status of ['archived', 'reaped', 'archiving'] as const) {
      expect(canReprovision(withVertical, status)).toBe(false);
    }
  });

  it('is never offered for a scope with no vertical — there is no hook to re-run', () => {
    for (const status of ALL_STATUSES) {
      expect(canReprovision({ vertical: null }, status)).toBe(false);
    }
  });

  /** It changes no status, so it is not on the ladder — and must not drift onto it. */
  it('is not one of the lifecycle transitions', () => {
    for (const status of ALL_STATUSES) {
      expect(availableActions(status)).not.toContain('reprovision');
    }
  });
});

describe('availableActions', () => {
  it('only offers transitions the server would accept from that status', () => {
    for (const status of ALL_STATUSES) {
      for (const action of availableActions(status)) {
        // 'suspended-via-tenant' is a console-only projection of a stored `active` row;
        // the server never sees it, so an action offered there would be checked against
        // `active`. We offer nothing there, so this loop simply never runs for it.
        const legalFrom = SERVER_LEGAL_FROM[action] ?? [];
        expect(legalFrom).toContain(status);
      }
    }
  });

  it('gives a stuck provisioning scope an escape hatch (archive → then reap)', () => {
    // The dead-end #500 was filed for: a scope stranded in `provisioning` used to offer
    // nothing, so the console could not retire it even though the server allows archive.
    expect(availableActions('provisioning')).toEqual(['archive']);
  });

  it('offers restore or reap on an archived scope', () => {
    expect(availableActions('archived')).toEqual(['unarchive', 'reap']);
  });

  it('never offers a per-scope lever for a cascade suspension (the tenant is the lever)', () => {
    expect(availableActions('suspended-via-tenant')).toEqual([]);
  });

  it('offers nothing terminal or mid-flight', () => {
    expect(availableActions('reaped')).toEqual([]);
    expect(availableActions('archiving')).toEqual([]);
  });
});

/**
 * The publish seam's console half (marketplace-publish.md §5). A private vertical's push
 * self-admits, so `admission` alone reports every such version as `admitted` — while
 * `setVerticalListed` refuses exactly those, because the note records that no human ever
 * read the code that listing would expose to every tenant.
 *
 * Both halves of that gap are pinned here: the badge must not claim a vouch that does not
 * exist, and the action that creates one must be offered precisely when it would work.
 * The live case this was filed for: substrat-9yjbbn/auth-server sat admitted + promoted +
 * unlistable, and the console rendered a green badge, no button, and — on List — a bare
 * `internal error`.
 */
describe('admission — admitted is not the same as vouched for', () => {
  const version = (
    admission: VerticalVersion['admission'],
    admissionNote: string | null = null,
  ): Pick<VerticalVersion, 'admission' | 'admissionNote'> => ({ admission, admissionNote });

  it('separates an auto-admission from a staff one', () => {
    expect(effectiveAdmission(version('admitted', AUTO_ADMISSION_NOTE))).toBe('auto-admitted');
    // A staff admit CLEARS the note — that cleared note is the whole record of the vouch.
    expect(effectiveAdmission(version('admitted', null))).toBe('admitted');
  });

  it('leaves pending and rejected alone, note or no note', () => {
    // Only `admitted` is ambiguous. A rejected version carries its reason in the same
    // field, and must never be read as an auto-admission.
    expect(effectiveAdmission(version('pending'))).toBe('pending');
    expect(effectiveAdmission(version('rejected', 'digest looked wrong'))).toBe('rejected');
    expect(effectiveAdmission(version('rejected', AUTO_ADMISSION_NOTE))).toBe('rejected');
  });

  it('offers the vouch exactly when a staff admit would change something', () => {
    // The console's rule for rendering the button. `admitVersion` is a no-op on an
    // already-vouched version and refuses a rejected one, so offering it there would be a
    // button whose only outcome is nothing or a 409 — the same defect fleet's
    // `availableActions` suite exists to prevent.
    expect(awaitingStaffVouch(version('admitted', AUTO_ADMISSION_NOTE))).toBe(true);
    expect(awaitingStaffVouch(version('admitted', null))).toBe(false);
    expect(awaitingStaffVouch(version('pending'))).toBe(false);
    expect(awaitingStaffVouch(version('rejected', 'no'))).toBe(false);
  });

  it('reads as a state, not a problem', () => {
    // An auto-admitted version serves its own tenant fine; only publication is withheld.
    // Warning tone would put it beside `pending`, which IS blocking someone.
    expect(admissionTone('auto-admitted')).toBe('info');
    expect(admissionTone('pending')).toBe('warning');
    expect(admissionTone('admitted')).toBe('success');
    expect(admissionTone('rejected')).toBe('danger');
  });

  it('never labels an auto-admission plain "Admitted"', () => {
    // The regression that started this: the operator read "admitted" and had no reason to
    // expect List to fail.
    expect(admissionLabel('auto-admitted')).toBe('Auto-admitted');
    expect(admissionLabel('admitted')).toBe('Admitted');
    expect(admissionLabel('pending')).toBe('Pending');
  });
});
