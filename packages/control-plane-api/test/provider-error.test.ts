import { describe, it, expect } from 'vitest';
import {
  isTerminalDispatchFailure,
  isTerminalProviderError,
  providerErrorStatus,
} from '../src/provider-error.js';
import { substratError } from '@substrat-run/contracts';

/**
 * #618. Three signature requests sat in `pending_signature` for a fortnight because the drain
 * treated a permanent `409 requires valid personal number field` exactly like a provider
 * outage: 100 identical retries over two days, then silence. The rule these tests pin is the
 * one that would have made it a same-day fix — a 4xx is about the REQUEST, everything else is
 * about the world.
 */
describe('isTerminalProviderError — is another attempt worth anything?', () => {
  /** How every connector's error type carries its status (`ScriveApiError` and any successor). */
  const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  it('treats a provider 4xx as terminal — the identical request will be refused identically', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect({ status, terminal: isTerminalProviderError(withStatus(status)) }).toEqual({
        status,
        terminal: true,
      });
    }
  });

  it('keeps 5xx retryable — that is the provider failing, and it says nothing about the request', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTerminalProviderError(withStatus(status))).toBe(false);
    }
  });

  it('keeps the 4xx that mean "not right now" retryable — a rate limit IS an instruction to retry', () => {
    for (const status of [408, 423, 425, 429]) {
      expect(isTerminalProviderError(withStatus(status))).toBe(false);
    }
  });

  it('never settles what it could not classify: no status means keep trying', () => {
    // A network failure, a timeout raised as a bare Error, a bug in our own code. Calling any
    // of these terminal would drop a delivery the provider never even saw.
    expect(isTerminalProviderError(new Error('fetch failed'))).toBe(false);
    expect(isTerminalProviderError('a thrown string')).toBe(false);
    expect(isTerminalProviderError(null)).toBe(false);
    expect(isTerminalProviderError(undefined)).toBe(false);
    // A non-numeric or nonsense `status` is not a status.
    expect(isTerminalProviderError({ status: '409' })).toBe(false);
    expect(isTerminalProviderError({ status: NaN })).toBe(false);
  });

  it('reads the status structurally, so no host has to import a provider error class', () => {
    expect(providerErrorStatus(withStatus(409))).toBe(409);
    expect(providerErrorStatus({ status: 404 })).toBe(404); // duck-typed on purpose
    expect(providerErrorStatus(new Error('nope'))).toBeUndefined();
  });
});

/**
 * #841. The predicate above reads a bare numeric `status`, and every `SubstratError` carries
 * one from the problem catalog — so our OWN `permission denied: protocol:read` answered "yes,
 * the provider refused this", and the drain journaled it as such under a delivery the provider
 * never received. Splitting the question is the fix: terminality is about the status, and
 * attribution is about who threw.
 */
describe('the two questions #618 conflated — is it over, and whose answer is it', () => {
  const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  it('keeps our own 4xx TERMINAL — that part was never wrong', () => {
    // A refusal we raised is as final as the provider's: the retry re-runs the same check.
    expect(isTerminalDispatchFailure(substratError('permission_denied', 'permission denied: protocol:read'))).toBe(
      true,
    );
    expect(isTerminalDispatchFailure(substratError('validation_failed', 'bad payload'))).toBe(true);
    // …and a provider 4xx too, so no delivery changed its retry behaviour with this split.
    expect(isTerminalDispatchFailure(withStatus(409))).toBe(true);
    expect(isTerminalDispatchFailure(withStatus(503))).toBe(false);
  });

  it('stops calling our own refusal the PROVIDER\'s — the regression itself', () => {
    expect(isTerminalProviderError(substratError('permission_denied', 'permission denied: protocol:read'))).toBe(
      false,
    );
    expect(isTerminalProviderError(substratError('validation_failed', 'bad payload'))).toBe(false);
    // Our 5xx was never the provider's either, and still is not.
    expect(isTerminalProviderError(substratError('unavailable', 'secret box unconfigured'))).toBe(false);
  });

  it('still recognises a real provider refusal, which is the only thing it may now name', () => {
    expect(isTerminalProviderError(withStatus(409))).toBe(true);
    expect(isTerminalProviderError(withStatus(422))).toBe(true);
  });
});
