import { describe, expect, it } from 'vitest';
import { operationChecksOf } from '../src/index.js';

/**
 * #2384 — what each operation declares it checks, copied for the permission checkpoint. Read off
 * the declaration and nothing else: an operation that declares no check is absent, so a reader
 * says "not declared" rather than guessing a key.
 */
describe('operationChecksOf', () => {
  it('copies each declared shape as plain strings, and nothing it does not know', () => {
    expect(
      operationChecksOf({
        'a/scope': { permission: 'doc:write', input: {} },
        'a/one': { permission: { key: 'doc:write', entity: 'doc', idFrom: 'docId', extra: { not: 'copied' } } },
        'a/many': { permission: { key: 'doc:read', entityFrom: 'type', idFrom: 'id' } },
        'a/ref': { permission: { key: 'doc:read', refFrom: 'subject.ref' } },
        'a/walk': { narrows: { reason: 'per row', checks: ['doc:read'] } },
        'a/open': { narrows: { reason: 'the invite is the authority', checks: [], unchecked: true } },
      }),
    ).toEqual({
      'a/scope': { permission: 'doc:write' },
      'a/one': { permission: { key: 'doc:write', entity: 'doc', idFrom: 'docId' } },
      'a/many': { permission: { key: 'doc:read', entityFrom: 'type', idFrom: 'id' } },
      'a/ref': { permission: { key: 'doc:read', refFrom: 'subject.ref' } },
      'a/walk': { narrows: { reason: 'per row', checks: ['doc:read'] } },
      'a/open': { narrows: { reason: 'the invite is the authority', checks: [], unchecked: true } },
    });
  });

  it('its twin: an operation declaring no check, or a malformed one, is absent — never given a key', () => {
    expect(
      operationChecksOf({
        'a/none': { input: {} },
        'a/keyless': { permission: { entity: 'doc', idFrom: 'docId' } },
        'a/reasonless': { narrows: { checks: ['doc:read'] } },
      }),
    ).toEqual({});
  });
});
