import { describe, it, expect } from 'vitest';
import {
  errorCodeOf,
  IMPERSONATION_DEFAULT_TTL_SECONDS,
  IMPERSONATION_MAX_TTL_SECONDS,
  instant,
  platformActorId,
  principalId,
  type Impersonation,
} from '@substrat-run/contracts';
import {
  assertImpersonationLive,
  assertImpersonationWritable,
  stampImpersonation,
  ulid,
} from '../src/index.js';

/**
 * The pure half of K-42 (#868). The adapters' shared behaviour is the contract suite's
 * job; what is here is the arithmetic and the boundaries neither adapter can make
 * interesting — an exactly-at-expiry instant, a `writes` flag inverted into `readOnly`,
 * and the codes the two refusals carry across a boundary that strips their prototypes.
 */

const ACTOR = platformActorId.parse(ulid());
const WHO = principalId.parse(ulid());
const REASON = 'SUP-4711 investigating a missing row';
const T0 = instant.parse('2026-08-27T10:00:00.000Z');

const at = (isoMillis: number) => instant.parse(new Date(isoMillis).toISOString());

describe('stampImpersonation', () => {
  it('computes the window from the request, defaulting the TTL', () => {
    const session = stampImpersonation({ actor: ACTOR, principal: WHO, reason: REASON }, T0);
    expect(session.startedAt).toBe(T0);
    expect(Date.parse(session.expiresAt) - Date.parse(T0)).toBe(
      IMPERSONATION_DEFAULT_TTL_SECONDS * 1000,
    );
  });

  it('inverts `writes` into `readOnly`, so a forgotten flag is the safe one', () => {
    const bare = stampImpersonation({ actor: ACTOR, principal: WHO, reason: REASON }, T0);
    expect(bare.readOnly).toBe(true);
    const explicitFalse = stampImpersonation(
      { actor: ACTOR, principal: WHO, reason: REASON, writes: false },
      T0,
    );
    expect(explicitFalse.readOnly).toBe(true);
    const opted = stampImpersonation(
      { actor: ACTOR, principal: WHO, reason: REASON, writes: true },
      T0,
    );
    expect(opted.readOnly).toBe(false);
  });

  it('refuses a reason that is not one', () => {
    expect(() =>
      stampImpersonation({ actor: ACTOR, principal: WHO, reason: '' }, T0),
    ).toThrow();
    // Whitespace does not buy length: the schema trims before it measures.
    expect(() =>
      stampImpersonation({ actor: ACTOR, principal: WHO, reason: '   why   ' }, T0),
    ).toThrow();
  });

  it('refuses a window past the ceiling, and admits one exactly at it', () => {
    expect(() =>
      stampImpersonation(
        { actor: ACTOR, principal: WHO, reason: REASON, ttlSeconds: IMPERSONATION_MAX_TTL_SECONDS + 1 },
        T0,
      ),
    ).toThrow();
    const edge = stampImpersonation(
      { actor: ACTOR, principal: WHO, reason: REASON, ttlSeconds: IMPERSONATION_MAX_TTL_SECONDS },
      T0,
    );
    expect(Date.parse(edge.expiresAt) - Date.parse(T0)).toBe(IMPERSONATION_MAX_TTL_SECONDS * 1000);
  });
});

describe('assertImpersonationLive', () => {
  const session = stampImpersonation(
    { actor: ACTOR, principal: WHO, reason: REASON, ttlSeconds: 60 },
    T0,
  );

  it('admits an instant inside the window', () => {
    expect(() => assertImpersonationLive(session, at(Date.parse(T0) + 59_999))).not.toThrow();
  });

  it('refuses the instant of expiry itself — the bound is exclusive', () => {
    // Not a nicety: `ctx.now()` is stable for a whole invocation (#812), so an inclusive
    // bound would admit an entire operation that began exactly at expiry.
    expect(() => assertImpersonationLive(session, session.expiresAt)).toThrow(/expired/);
  });

  it('refuses an instant past it, and says when it ended', () => {
    try {
      assertImpersonationLive(session, at(Date.parse(T0) + 120_000));
      expect.unreachable('an expired session must not be admitted');
    } catch (err) {
      // `unavailable`, not `permission_denied`: nothing about the caller's authority
      // changed — the window closed, and the answer is to open a new session.
      expect(errorCodeOf(err)).toBe('unavailable');
      expect((err as Error).message).toContain(session.expiresAt);
    }
  });
});

describe('assertImpersonationWritable', () => {
  const readOnly: Impersonation = stampImpersonation(
    { actor: ACTOR, principal: WHO, reason: REASON },
    T0,
  );
  const writable: Impersonation = stampImpersonation(
    { actor: ACTOR, principal: WHO, reason: REASON, writes: true },
    T0,
  );

  it('lets an ordinary (non-impersonated) invocation through', () => {
    expect(() => assertImpersonationWritable(null, 'ctx.emit')).not.toThrow();
  });

  it('lets a write-enabled session through', () => {
    expect(() => assertImpersonationWritable(writable, 'ctx.emit')).not.toThrow();
  });

  it('refuses a read-only session, naming the verb and both parties', () => {
    try {
      assertImpersonationWritable(readOnly, 'ctx.emit');
      expect.unreachable('a read-only session must not write');
    } catch (err) {
      expect(errorCodeOf(err)).toBe('permission_denied');
      const message = (err as Error).message;
      expect(message).toContain('ctx.emit');
      expect(message).toContain(ACTOR);
      expect(message).toContain(WHO);
    }
  });
});
