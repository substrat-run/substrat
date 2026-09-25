import { describe, expect, it } from 'vitest';
import { REPLAY_EFFECT, SKIP_EFFECT, importCursorMove, type EdgeHealth } from '@substrat-run/contracts';
import { EDGE_STATE, LEVER_EFFECT, lagText, leverOffered, leverRequest } from '../web/src/lib/edge-health.js';

const APP = '01J0000000000000000000APP0';
const edge = (over: Partial<EdgeHealth>): EdgeHealth =>
  ({
    tenantId: '01J0000000000000000000TNT0',
    consumer: { scopeId: APP, vertical: 'acme/board' },
    producer: { vertical: 'acme/crm', scopeId: '01J0000000000000000000PRD0' },
    state: 'caught-up',
    reason: null,
    watermark: null,
    oldestPending: null,
    lagMs: null,
    unexported: [],
    lastDelivered: null,
    lastProblem: null,
    ...over,
  }) as EdgeHealth;

describe('cross-app event health on the dashboard (#1705 PR 3)', () => {
  it('never renders an edge nobody could read as healthy', () => {
    expect(EDGE_STATE.unavailable.kind).not.toBe('success');
    // Only a caught-up edge is green.
    const green = Object.entries(EDGE_STATE).filter(([, v]) => v.kind === 'success').map(([k]) => k);
    expect(green).toEqual(['caught-up']);
  });

  it('offers the lever only on a resolved edge INTO this app', () => {
    expect(leverOffered(edge({}), APP)).toBe(true);
    expect(leverOffered(edge({ consumer: { scopeId: '01J0000000000000000000OTH0' as EdgeHealth['consumer']['scopeId'], vertical: 'acme/x' } }), APP)).toBe(false);
    expect(leverOffered(edge({ state: 'unresolved', producer: { vertical: 'acme/crm', scopeId: null } }), APP)).toBe(false);
    expect(leverOffered(edge({ state: 'unavailable' }), APP)).toBe(false);
  });

  it('says what a replay and a skip do in the platform\'s own words, and sends the matching acknowledgement', () => {
    expect(LEVER_EFFECT.replay).toBe(REPLAY_EFFECT);
    expect(LEVER_EFFECT.replay).toContain('anything they send or call outside this app happens again');
    expect(LEVER_EFFECT.skip).toBe(SKIP_EFFECT);
    expect(importCursorMove.parse(leverRequest('replay', 'acme/crm', ' lost a day '))).toMatchObject({
      mode: 'replay',
      acknowledge: 'rerun-handlers',
      reason: 'lost a day',
    });
    expect(importCursorMove.parse(leverRequest('skip', 'acme/crm', 'start today'))).toMatchObject({
      mode: 'skip',
      through: 'now',
      acknowledge: 'skip-events',
    });
  });

  it('writes a lag a person can read', () => {
    expect(lagText(null)).toBeNull();
    expect(lagText(12_000)).toBe('12s');
    expect(lagText(5 * 60_000)).toBe('5 min');
    expect(lagText(3 * 3_600_000)).toBe('3 h');
    expect(lagText(3 * 86_400_000)).toBe('3 days');
  });
});
