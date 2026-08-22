import { describe, expect, it } from 'vitest';
import { AUTO_ADMISSION_NOTE } from '@substrat-run/contracts';
import { mapError } from '../src/errors.js';

/**
 * The message→status table is this package's weakest seam (errors.ts says so itself), and
 * its failure mode is silent: an unmatched refusal does not throw, it becomes a generic
 * 500 with the reason stripped off. #828 is the recorded cost of that — four hours of
 * `internal error` hiding a throw that named its own fix in full.
 *
 * So the patterns that carry a WAY OUT get pinned here, directly against `mapError`,
 * rather than only through whichever route happens to reach them.
 */
describe('mapError — a refusal that names its fix must survive as itself', () => {
  // The exact text both adapters throw (adapter-sqlite `setVerticalListed`,
  // adapter-cloudflare `host.ts` — identical strings, pinned by the contract suite as
  // /auto-admitted.*staff admit/).
  const autoAdmitRefusal = new Error(
    `vertical 'substrat-9yjbbn/auth-server' prod version 01KZN76M38AWJ9KHE6RWVFSC8W is auto-admitted ` +
      `(private self-serve) — a staff admit must vouch for it before listing`,
  );

  it('answers the publish-seam refusal 409, with its text intact', () => {
    const { status, body } = mapError(autoAdmitRefusal);
    // 409: the request is well-formed and conflicts with the version's admission state —
    // the same class as the registry's other admission refusals.
    expect(status).toBe(409);
    // The whole point: the operator must be able to READ what to do next. A 409 whose
    // body said `internal error` would be no better than the 500 it replaced.
    expect(body.error).toBe(autoAdmitRefusal.message);
    expect(body.error).toMatch(/auto-admitted.*staff admit/);
  });

  it('is not swallowed by a neighbouring admission pattern (order is significant)', () => {
    // `/is already admitted/` and `/not admitted/` sit beside it and describe DIFFERENT
    // states. Were either to match this message, the operator would be told the version
    // is already admitted — which is true, and precisely the confusion that hid the real
    // requirement: admitted is not the same as vouched for.
    expect(mapError(autoAdmitRefusal).body.error).not.toMatch(/^unknown /);
    expect(mapError(new Error('version 01J is already admitted')).status).toBe(409);
    expect(mapError(new Error('version 01J is not admitted')).status).toBe(409);
  });

  it('keeps the note itself out of the matching — the text is the contract, not the constant', () => {
    // A version merely CARRYING the auto note is not a refusal; only `setVerticalListed`
    // throwing about it is. Guards against someone "simplifying" the pattern to the
    // constant, which appears in payloads the API returns on success.
    expect(mapError(new Error(AUTO_ADMISSION_NOTE)).status).toBe(500);
  });

  it('still refuses to disclose an unreviewed throw', () => {
    // The posture errors.ts commits to: unmatched means unreviewed, and this surface has
    // cross-tenant reach. Adding patterns must never erode the generic fallback.
    const leaky = new Error('SQLITE_CONSTRAINT: tenant_secrets.value must be unique');
    expect(mapError(leaky)).toEqual({ status: 500, body: { error: 'internal error' } });
  });
});
