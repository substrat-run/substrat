import { describe, expect, it } from 'vitest';
import { scopeId } from '../src/ids.js';
import {
  isStoreCallHost,
  isStoreOperationName,
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

  it('accepts a fixed operation label and refuses an address or a scheme', () => {
    expect(isStoreOperationName('read')).toBe(true);
    expect(isStoreOperationName('substrat.erase')).toBe(true);
    expect(isStoreOperationName('a'.repeat(64))).toBe(true);
    expect(isStoreOperationName('a'.repeat(65))).toBe(false);
    expect(isStoreOperationName('user@example.com')).toBe(false);
    expect(isStoreOperationName('has space')).toBe(false);
    expect(isStoreOperationName('https://store')).toBe(false);
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
