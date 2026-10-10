/**
 * #1978: the platform-minted consent round's signed state moved here from the kernel. The
 * control plane mints it and the dashboard verifies it, both from this package's root. That
 * the kernel no longer exports it is held by the kernel's own `wire-headers-move.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as api from '../src/index.js';

const MOVED = ['signConnectState', 'verifyConnectState', 'ConnectStateError'];

describe('connect-state, moved here from the kernel (#1978)', () => {
  it.each(MOVED)('exports %s, and the kernel does not', (name) => {
    expect((api as Record<string, unknown>)[name], name).toBeDefined();
    expect((kernel as Record<string, unknown>)[name], name).toBeUndefined();
  });

  it('verifies, from the package root, a state the package root minted', async () => {
    const claim: api.ConnectStateClaim = {
      tenantId: 't',
      scopeId: 's',
      vertical: 'v',
      provider: 'fortnox',
      principal: 'p',
      exp: Date.now() + 60_000,
    };
    const token = await api.signConnectState('a-platform-secret-value', claim);
    expect(await api.verifyConnectState('a-platform-secret-value', token, Date.now())).toEqual(claim);
  });
});
