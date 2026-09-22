import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dataSubjectId, errorCodeOf, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1600 review: a coordinator that meets a ScopeDO from before the intent redaction.
 *
 * `redactSubject` answered with a bare outbox count until #1600 and now answers with a
 * count per spine table. This interface's own `recordScheduleRun` note spells out that
 * skew between the coordinator and the DO is a real condition in both directions — an
 * old DO drops a trailing argument, a new DO meets an old coordinator — and a RETURN
 * type carries it the same way an argument list does.
 *
 * What makes this worth a test of its own rather than a type: the failure is silent and
 * lands on the irreversible half. Destructuring a number yields two `undefined`s, the key
 * is destroyed next, and only THEN does the receipt's `.parse` throw — so the subject's
 * platform-retained copies become permanently unreadable while their name is still in
 * `_substrat_platform_requests`, with no admin-log row to say any of it happened.
 *
 * The fake namespace below is the whole apparatus: a real `env.SCOPE` stub with one
 * method swapped for its pre-#1600 answer.
 */
describe('a ScopeDO from before the intent redaction (#1600)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = '01JZ0000000000000000STAFF1' as never;

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostFor();
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'erasure' });
    await host.close();
  });

  /**
   * The real host, optionally with `redactSubject` answering the way it used to: `true` is
   * the pre-#1600 bare count, `'pre-1632'` the `{ events, intents }` a DO answered after
   * #1600 and before the job-run tables were reached.
   */
  const hostFor = (legacy: boolean | 'pre-1632' = false) =>
    new CloudflareScopeHost({
      scope: legacy
        ? ({
            idFromName: (n: string) => env.SCOPE.idFromName(n),
            get: (id: never) => {
              const real = env.SCOPE.get(id);
              // Everything else is the live DO; only this one reply is rolled back to
              // the shape it had before #1600 — the outbox count, and nothing about the
              // intent journal, because that DO never touched it.
              return new Proxy(real, {
                get: (target, prop, receiver) =>
                  prop === 'redactSubject'
                    ? async () => (legacy === 'pre-1632' ? { events: 1, intents: 0 } : 1)
                    : Reflect.get(target, prop, receiver),
              });
            },
          } as unknown as typeof env.SCOPE)
        : env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });

  it('refuses the erasure, and does NOT destroy the subject key doing it', async () => {
    const subject = dataSubjectId.parse(ulid());
    // A sealed platform-retained copy, so the key's survival is observable rather than
    // inferred: after a shred it would be unopenable for ever.
    const [sealed] = await hostFor().admin.sealSubjectPayloads(staff, t, s, [
      { subjectId: subject, plaintext: 'in the backup' },
    ]);
    expect(sealed).not.toBeNull();

    const legacy = hostFor(true);
    await expect(legacy.admin.shredSubject(staff, t, s, subject)).rejects.toThrow(/before #1600/);
    // Refused as unavailable — a transient condition an operator fixes by redeploying —
    // rather than as an opaque parse failure from two undefined counts.
    await expect(legacy.admin.shredSubject(staff, t, s, subject)).rejects.toSatisfy(
      (e: unknown) => errorCodeOf(e) === 'unavailable',
    );

    // THE property. The irreversible half did not run, so the erasure is still available
    // to be performed properly once the scope is redeployed.
    const [opened] = await hostFor().admin.openSubjectPayloads(staff, t, s, [
      { subjectId: subject, sealed: sealed! },
    ]);
    expect(opened).toBe('in the backup');
    await hostFor().close();
    await legacy.close();
  });

  it('refuses a DO from before #1632 the same way — its job-run tables were never read', async () => {
    // The same skew one release later. Reading `{ events, intents }` as `jobRuns: 0` would
    // destroy the key and receipt an erasure that left the person in a step's memo.
    const subject = dataSubjectId.parse(ulid());
    const [sealed] = await hostFor().admin.sealSubjectPayloads(staff, t, s, [
      { subjectId: subject, plaintext: 'in the backup' },
    ]);
    const legacy = hostFor('pre-1632');
    await expect(legacy.admin.shredSubject(staff, t, s, subject)).rejects.toSatisfy(
      (e: unknown) => errorCodeOf(e) === 'unavailable' && /before #1632/.test((e as Error).message),
    );
    const [opened] = await hostFor().admin.openSubjectPayloads(staff, t, s, [
      { subjectId: subject, sealed: sealed! },
    ]);
    expect(opened).toBe('in the backup');
    await hostFor().close();
    await legacy.close();
  });

  it('a migrated DO on the same scope erases normally', async () => {
    // The positive twin: the guard must refuse the legacy reply and nothing else.
    const subject = dataSubjectId.parse(ulid());
    const host = hostFor();
    const receipt = await host.admin.shredSubject(staff, t, s, subject);
    expect(receipt.tombstoned).toBe(true);
    expect(receipt.intentsRedacted).toBe(0);
    expect(receipt.jobRunsRedacted).toBe(0);
    await host.close();
  });
});
