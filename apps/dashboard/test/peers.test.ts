import { describe, expect, it } from 'vitest';
import type { PeerGrantsStatusEntry, Scope, TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  declaredCallLine,
  declaredCallNeedsAttention,
  declaredCallState,
  targetScopeOf,
} from '../src/peers.js';

/**
 * The install disclosure's rule (#1706), tested where it is pure.
 *
 * Two properties carry the feature. **A target the tenant has not installed is never an
 * error** — declaring a call on an app you do not run is the ordinary state of a freshly
 * installed vertical, and a panel that cries about it is a panel nobody believes when it
 * later says "switched off". And **a position nobody could read is never `allowed`** — the
 * same rule the server and the console hold, for the same reason.
 */

const TENANT = ulid() as TenantId;
const CALLER = 'acme/board-room';

const scope = (over: Partial<Scope> = {}): Scope =>
  ({
    id: ulid(),
    tenantId: TENANT,
    vertical: 'acme/crm',
    status: 'active',
    kind: 'primary',
    forkedFrom: null,
    ...over,
  }) as unknown as Scope;

const entry = (over: Partial<PeerGrantsStatusEntry> = {}): PeerGrantsStatusEntry =>
  ({ vertical: CALLER, calls: 'on', switchedOff: null, ...over }) as unknown as PeerGrantsStatusEntry;

describe('targetScopeOf', () => {
  it('resolves the tenant’s one live primary instance', () => {
    const s = scope();
    expect(targetScopeOf([s], TENANT, 'acme/crm')).toEqual({ scopeId: s.id });
  });

  it('is null when the tenant runs none of that vertical', () => {
    expect(targetScopeOf([], TENANT, 'acme/crm')).toBeNull();
    expect(targetScopeOf([scope({ vertical: 'acme/ledger' })], TENANT, 'acme/crm')).toBeNull();
  });

  it('never resolves a preview, a fork or a suspended instance — the panel cannot claim a target a call would not reach', () => {
    expect(targetScopeOf([scope({ kind: 'preview' })], TENANT, 'acme/crm')).toBeNull();
    expect(targetScopeOf([scope({ status: 'suspended' })], TENANT, 'acme/crm')).toBeNull();
  });

  it('two live instances are ambiguous, not a pick', () => {
    expect(targetScopeOf([scope(), scope()], TENANT, 'acme/crm')).toEqual({ ambiguous: true, count: 2 });
  });

  it('another tenant’s scope is not this tenant’s instance', () => {
    expect(targetScopeOf([scope({ tenantId: ulid() as TenantId })], TENANT, 'acme/crm')).toBeNull();
  });
});

describe('declaredCallState', () => {
  const s = scope();
  const target = { scopeId: s.id };

  it('a target the tenant does not run reads as not installed, plainly', () => {
    const state = declaredCallState({ vertical: 'acme/crm', caller: CALLER, target: null, entries: [] });
    expect(state).toEqual({ state: 'not-installed', vertical: 'acme/crm' });
    // The sentence a tenant reads, and the thing this whole rule is for: it must not sound
    // like a fault, and it must not be flagged for action.
    expect(declaredCallLine(state)).toBe(
      'Not installed here — this app declares it calls acme/crm, and you do not run one.',
    );
    expect(declaredCallNeedsAttention(state)).toBe(false);
  });

  it('two live instances are disclosed as ambiguous, never as absent', () => {
    const state = declaredCallState({
      vertical: 'acme/crm',
      caller: CALLER,
      target: { ambiguous: true, count: 2 },
      entries: [],
    });
    expect(state).toEqual({ state: 'ambiguous', vertical: 'acme/crm', count: 2 });
    expect(declaredCallLine(state)).toMatch(/2 active instances/);
    expect(declaredCallNeedsAttention(state)).toBe(true);
  });

  it('installed and admitted reads as allowed', () => {
    const state = declaredCallState({ vertical: 'acme/crm', caller: CALLER, target, entries: [entry()] });
    expect(state).toEqual({ state: 'allowed', vertical: 'acme/crm', scopeId: s.id });
    expect(declaredCallNeedsAttention(state)).toBe(false);
  });

  it('switched off carries who, when and why — the lever was pulled on purpose', () => {
    const switchedOff = { actor: ulid(), reason: 'leaking', at: '2026-09-22T19:00:00.000Z' };
    const state = declaredCallState({
      vertical: 'acme/crm',
      caller: CALLER,
      target,
      entries: [entry({ calls: 'off', switchedOff } as Partial<PeerGrantsStatusEntry>)],
    });
    expect(state).toMatchObject({ state: 'switched-off', scopeId: s.id, switchedOff });
    expect(declaredCallLine(state)).toMatch(/refuses this app's calls until you let it back in/);
  });

  it('a target that grants this app nothing is its own state, not "switched off"', () => {
    // Different facts: `off` somebody did and restoring undoes; `ungranted`/absent means the
    // target's manifest never declared this peer. Showing the second as the first sends a
    // tenant to restore a switch nobody pulled.
    for (const entries of [[], [entry({ calls: 'ungranted' } as Partial<PeerGrantsStatusEntry>)]]) {
      const state = declaredCallState({ vertical: 'acme/crm', caller: CALLER, target, entries });
      expect(state.state).toBe('no-grant');
      expect(declaredCallNeedsAttention(state)).toBe(true);
    }
  });

  it('a position that could not be read is never allowed', () => {
    for (const input of [
      { entries: null, readError: null },
      { entries: [entry()], readError: 'the deployment predates the peer switch (#1706)' },
    ]) {
      const state = declaredCallState({ vertical: 'acme/crm', caller: CALLER, target, ...input });
      expect(state.state).toBe('unreadable');
      expect(declaredCallNeedsAttention(state)).toBe(true);
    }
  });

  it('the read is matched by CALLER, so another app’s position is never borrowed', () => {
    const state = declaredCallState({
      vertical: 'acme/crm',
      caller: CALLER,
      target,
      entries: [entry({ vertical: 'acme/somebody-else' } as Partial<PeerGrantsStatusEntry>)],
    });
    expect(state.state).toBe('no-grant');
  });
});
