/**
 * K-69, step 4: the switch that hands the intent and lake drains to the scopes' own wakes, and what
 * a scope's kick is answered (`src/scope-wake.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { intentCheckTally, scopeWakeAnswerOf, scopeWakeCheckLogOf, scopeWakePhasesOf } from '../src/scope-wake.js';

describe('SCOPE_WAKE_PHASES', () => {
  it('names nothing by default, and a word it does not know leaves that phase with the pass', () => {
    expect(scopeWakePhasesOf(undefined)).toEqual({ platformRequests: false, events: false });
    expect(scopeWakePhasesOf(' platform-requests , events ')).toEqual({ platformRequests: true, events: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(scopeWakePhasesOf('event,platform-requests')).toEqual({ platformRequests: true, events: false });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('hands a phase to the scope only when this deployment can run it from the drain object', () => {
    const both = { platformRequests: true, events: true };
    expect(scopeWakeAnswerOf(both, { kick: true, ship: true })).toEqual({ platformRequests: 'scope', events: 'scope' });
    expect(scopeWakeAnswerOf(both, { kick: true, ship: false })).toEqual({ platformRequests: 'scope', events: 'pass' });
    expect(scopeWakeAnswerOf(both, { kick: false, ship: true })).toEqual({ platformRequests: 'pass', events: 'pass' });
    expect(scopeWakeAnswerOf({ platformRequests: false, events: false }, { kick: true, ship: true })).toEqual({
      platformRequests: 'pass',
      events: 'pass',
    });
  });
});

describe('the pass check', () => {
  it('counts held and rescued scopes, and logs only the phases it checked, zeros included', () => {
    const tally = intentCheckTally();
    tally.add({ drained: 0 });
    tally.add({ drained: 0, leftToScope: 2 });
    tally.add({ drained: 1, leftToScope: 1 });
    expect(scopeWakeCheckLogOf(tally, null)).toEqual({ platformRequests: { held: 2, heldIntents: 3, rescued: 1, rescuedIntents: 1 } });
    expect(scopeWakeCheckLogOf(null, { held: 0, heldEvents: 0, rescued: 0 })).toEqual({ events: { held: 0, heldEvents: 0, rescued: 0 } });
    expect(scopeWakeCheckLogOf(null, undefined)).toBeNull();
  });
});
