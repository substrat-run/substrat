import { describe, expect, it } from 'vitest';
import type { PeerGrantsStatusEntry } from '@substrat-run/contracts';
import { ApiError } from '../src/lib/api';
import { peerBadgeStatus, peerStateLabel, peersCardState, switchedOffLine } from '../src/lib/peers';

/**
 * The Peers card (#1706) maps one status read into four card states and one position into
 * what an operator actually reads. The console has no component-test harness
 * (`apps/console/test/` is pure `lib/*.ts` unit tests throughout), so these test the pure
 * mapping functions the component calls rather than rendered output.
 *
 * The property worth holding here is the same one the server holds: **a failure is never
 * rendered as `on`**. A peer wrongly shown as switched off is a support ticket; a peer
 * wrongly shown as able to call in is a tenant believing it cut off access it did not.
 */

const onEntry = {
  vertical: 'acme/board-room',
  calls: 'on',
  switchedOff: null,
} as unknown as PeerGrantsStatusEntry;

const offEntry = {
  vertical: 'acme/crm',
  calls: 'off',
  switchedOff: {
    actor: '01J00000000000000000000000',
    reason: 'the CRM is leaking',
    at: '2026-09-22T19:00:00.000Z',
  },
} as unknown as PeerGrantsStatusEntry;

const ungrantedEntry = {
  vertical: 'acme/ledger',
  calls: 'ungranted',
  switchedOff: null,
} as unknown as PeerGrantsStatusEntry;

describe('peersCardState', () => {
  it('a read that has not returned is loading, not empty', () => {
    // The distinction matters: an empty array is "no app may call in here", which is a real
    // answer, and showing it while the read is still in flight is a wrong one.
    expect(peersCardState(null, null)).toEqual({ kind: 'loading' });
    expect(peersCardState([], null)).toEqual({ kind: 'ready', entries: [] });
  });

  it('entries render when the read succeeded', () => {
    expect(peersCardState([onEntry, offEntry], null)).toEqual({
      kind: 'ready',
      entries: [onEntry, offEntry],
    });
  });

  it('a 501 is its own state — the deployment predates the route, which is not an error', () => {
    expect(peersCardState(null, new ApiError(501, 'predates the peer kill switch'))).toEqual({
      kind: 'predates',
    });
  });

  it('every other failure is an error, and none of them is ever ready', () => {
    for (const error of [
      new ApiError(503, 'no delegation configured for hosted scope'),
      new ApiError(403, 'forbidden'),
      new ApiError(502, 'vertical answered peer-grants with an unexpected shape'),
      new Error('network'),
      'a string nobody typed as an Error',
    ]) {
      const state = peersCardState(null, error);
      expect(state.kind).toBe('error');
    }
  });

  it('an error wins over stale entries — a card that cannot vouch for a position shows none', () => {
    // The component clears entries on an unconfirmed switch; this makes the mapping refuse
    // the combination too, so neither half can leave a stale "may call in" on screen.
    expect(peersCardState([onEntry], new ApiError(503, 'gone')).kind).toBe('error');
  });
});

describe('peerBadgeStatus', () => {
  it('is the three-way split the kernel enumerates, and nothing else is success', () => {
    expect(peerBadgeStatus('on')).toBe('success');
    expect(peerBadgeStatus('off')).toBe('danger');
    expect(peerBadgeStatus('ungranted')).toBe('neutral');
  });
});

describe('peerStateLabel', () => {
  it('says what a position means in a tenant’s words', () => {
    expect(peerStateLabel('on')).toBe('Grants active');
    expect(peerStateLabel('off')).toBe('Switched off');
  });

  it('ungranted reads as holding nothing, never as switched off', () => {
    // These are different facts: `off` was done by someone and is undone by restoring;
    // `ungranted` is a scope that simply holds nothing live for that peer. Rendering the
    // second as the first would send an operator to restore a switch nobody pulled.
    expect(peerStateLabel('ungranted')).toBe('Holds nothing here');
    expect(peerStateLabel('ungranted')).not.toBe(peerStateLabel('off'));
  });
});

describe('switchedOffLine', () => {
  it('names who, when and why for a peer that is off', () => {
    expect(switchedOffLine(offEntry)).toBe(
      'Switched off by 01J00000000000000000000000 on 2026-09-22T19:00:00.000Z — the CRM is leaking',
    );
  });

  it('is null for a peer that is not off', () => {
    expect(switchedOffLine(onEntry)).toBeNull();
    expect(switchedOffLine(ungrantedEntry)).toBeNull();
  });

  it('the POSITION decides, not the presence of an explanation — a restored peer shows no reason', () => {
    // Today's server cannot produce this row: `peerGrantsStatusOf` joins an explanation only
    // for peers whose position is `off`, and clears it with the position on restore. The
    // guard is therefore defence in depth against that join ever widening — and it was
    // silently untested until a break-check removed it and nothing went red, because every
    // other fixture here pairs an explanation with `off`. This is the case that pins it.
    const restoredButStillExplained = {
      vertical: 'acme/crm',
      calls: 'on',
      switchedOff: { actor: '01J00000000000000000000000', reason: 'stale', at: '2026-09-22T19:00:00.000Z' },
    } as unknown as PeerGrantsStatusEntry;
    expect(switchedOffLine(restoredButStillExplained)).toBeNull();
  });

  it('is null for a peer that is off with no explanation in force — not an empty quote', () => {
    // A real state: a grant removed by something other than the switch, or a switch whose
    // `applied` row the log never paired. Rendering `— ` with nothing after it would look
    // like a reason someone left blank.
    const orphan = { vertical: 'acme/crm', calls: 'off', switchedOff: null } as unknown as PeerGrantsStatusEntry;
    expect(switchedOffLine(orphan)).toBeNull();
  });
});
