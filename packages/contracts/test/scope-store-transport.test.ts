import { describe, expect, it } from 'vitest';
import { scopeId } from '../src/ids.js';
import {
  isStoreCallHost,
  rememberStoreObjectName,
  storeAudienceAllows,
  storeCallRequest,
  STORE_CALL_HOST,
} from '../src/scope-store-transport.js';

const SCOPE = scopeId.parse('01J00000000000000000000S01');

describe('scope store transport', () => {
  it('recognises only the reserved host', () => {
    expect(isStoreCallHost(STORE_CALL_HOST)).toBe(true);
    expect(isStoreCallHost('store.substrat.internal.evil.test')).toBe(false);
    expect(isStoreCallHost('peer.substrat.internal')).toBe(false);
  });

  it('a request takes a fixed operation label and refuses an address, a scheme or whitespace', () => {
    const ok = (operation: string) => storeCallRequest.safeParse({ scopeId: SCOPE, binding: 'GRAPH', operation }).success;
    expect(ok('read')).toBe(true);
    expect(ok('substrat.erase')).toBe(true);
    expect(ok('a'.repeat(64))).toBe(true);
    expect(ok('a'.repeat(65))).toBe(false);
    expect(ok('user@example.com')).toBe(false);
    expect(ok('has space')).toBe(false);
    expect(ok('has\ttab')).toBe(false);
    expect(ok('https://store')).toBe(false);
  });

  it('a request names a scope, a binding and an operation, and nothing else', () => {
    expect(storeCallRequest.safeParse({ scopeId: SCOPE, binding: 'GRAPH', operation: 'read' }).success).toBe(true);
    expect(storeCallRequest.safeParse({ scopeId: SCOPE, binding: 'GRAPH', operation: 'read', mac: 'x' }).success).toBe(false);
    expect(storeCallRequest.safeParse({ scopeId: SCOPE, binding: 'graph', operation: 'read' }).success).toBe(false);
  });

  it('a reserved operation accepts only the platform signature', () => {
    expect(storeAudienceAllows('substrat.wipe', 'caller')).toBe(false);
    expect(storeAudienceAllows('substrat.wipe', 'platform')).toBe(true);
    expect(storeAudienceAllows('read', 'caller')).toBe(true);
    expect(storeAudienceAllows('read', 'platform')).toBe(false);
  });

  it('an object keeps the first name it accepted and refuses another', () => {
    const first = rememberStoreObjectName(null, 'tenant-1/docs/scope-1/GRAPH');
    expect(first).toBe('tenant-1/docs/scope-1/GRAPH');
    expect(rememberStoreObjectName(first!, 'tenant-1/docs/scope-1/GRAPH')).toBe(first);
    expect(rememberStoreObjectName(first!, 'tenant-2/docs/scope-2/GRAPH')).toBeUndefined();
  });
});
