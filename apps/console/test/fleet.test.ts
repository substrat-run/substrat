import { describe, expect, it } from 'vitest';
import { availableActions, type EffectiveStatus } from '../src/lib/fleet';

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
