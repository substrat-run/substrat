import { describe, expect, it } from 'vitest';
import { substratError, type PlatformRequestFailure } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { permissionKey, principalId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { attributeFailure, terminalFailureNote } from '../src/failure-attribution.js';
import { ControlPlaneError } from '../src/client.js';

/** A connector's own error: a real provider response, recognised only by its numeric status. */
class ScriveApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ScriveApiError';
  }
}

describe('attributeFailure — who refused this delivery (#841)', () => {
  /**
   * The regression itself. This exact error, on this exact path, was journaled as "a client
   * error the provider will refuse identically on retry" — for a request the provider never
   * received. The vertical refuses the platform's `/internal` call with 403 and it arrives as
   * a `ControlPlaneError`, which is why the fix does not depend on the vertical being
   * redeployed to say anything new.
   */
  it('attributes the vertical refusing our own /internal call to the platform, not the provider', () => {
    const e = new ControlPlaneError(403, 'permission denied: protocol:read');
    expect(attributeFailure(e)).toEqual<PlatformRequestFailure>({
      origin: 'platform',
      code: null,
      permission: 'protocol:read',
    });
  });

  it('never quotes a platform refusal as the provider — the sentence names us and clears the credential', () => {
    const note = terminalFailureNote(attributeFailure(new ControlPlaneError(403, 'permission denied: protocol:read')), 'scrive');
    expect(note).toContain('refused by this platform');
    expect(note).toContain('scrive never saw this request');
    // The sentence that cost an afternoon must not be reachable from a platform refusal.
    expect(note).not.toContain('will refuse identically');
  });

  it('reads the permission from the structured field when it survived the hop', () => {
    const denied = new PermissionDenied('permission denied: protocol:read', {
      permission: permissionKey.parse('protocol:read'),
      node: { tenantId: tenantId.parse(ulid()), scopeId: null },
    });
    expect(attributeFailure(denied)).toEqual<PlatformRequestFailure>({
      origin: 'platform',
      code: 'permission_denied',
      permission: 'protocol:read',
    });
  });

  it('attributes any taxonomy-coded throw to the platform, permission or not', () => {
    expect(attributeFailure(substratError('validation_failed', 'bad payload'))).toEqual<PlatformRequestFailure>({
      origin: 'platform',
      code: 'validation_failed',
      permission: null,
    });
  });

  it("attributes a connector's real provider response to the provider", () => {
    const e = new ScriveApiError(409, 'Authentication to sign for participant #1 requires valid personal number field.');
    expect(attributeFailure(e)).toEqual<PlatformRequestFailure>({
      origin: 'provider',
      code: null,
      permission: null,
    });
    expect(terminalFailureNote(attributeFailure(e), 'scrive')).toContain('scrive will refuse identically');
  });

  /**
   * "We could not tell" must never be printed as somebody's words. A socket that never opened
   * carries no status and no code, and calling that the provider's refusal is the same class
   * of lie this issue is about — just pointed at a different victim.
   */
  it('refuses to attribute what it cannot classify', () => {
    for (const e of [new Error('fetch failed'), 'a thrown string', null, undefined]) {
      expect(attributeFailure(e)).toEqual<PlatformRequestFailure>({
        origin: 'unknown',
        code: null,
        permission: null,
      });
    }
    expect(terminalFailureNote(attributeFailure(new Error('fetch failed')), 'scrive')).not.toContain('scrive will');
  });

  /**
   * A provider is free to use the words "permission denied" in its own refusal. The message
   * read is a fallback for recovering a KEY from a failure already attributed to us — it must
   * never be able to re-attribute one.
   */
  it('does not let a provider message mentioning a permission masquerade as our refusal', () => {
    const e = new ScriveApiError(403, 'permission denied: protocol:read (as the provider phrased it)');
    expect(attributeFailure(e)).toEqual<PlatformRequestFailure>({
      origin: 'provider',
      code: null,
      permission: null,
    });
  });

  it('ignores a message fragment that is not a well-formed permission key', () => {
    expect(attributeFailure(new ControlPlaneError(403, 'permission denied: Not A Key'))).toEqual<PlatformRequestFailure>({
      origin: 'platform',
      code: null,
      permission: null,
    });
  });
});
