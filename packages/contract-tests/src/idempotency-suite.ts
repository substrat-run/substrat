/**
 * Contract suite for request idempotency — `Idempotency-Key` (#116).
 *
 * What it pins: **a retry does not do the work twice, and the host is what makes
 * that true.** Everything else about this feature is a projection — the header
 * name is a wire detail `vertical-host` owns, the opt-out is a model detail
 * `contracts` owns, and neither is what makes a retry free. This is: a recording
 * written in the same transaction as the work, and a second request answered
 * from it without running anything.
 *
 * **Every case counts executions rather than comparing responses.** A suite that
 * asserted only on the returned value would pass against a host that re-ran the
 * operation and produced the same answer again — which is exactly the bug, since
 * a duplicated work order looks a great deal like the original. So the fixture
 * appends a row per invocation and `idem/runs` reports the count, and that count
 * is the assertion.
 *
 * The cases that matter are not the happy path:
 *
 * - **A failed request leaves no recording.** The row is written inside the
 *   operation's transaction, so a throw takes it with the writes it describes and
 *   the retry executes — correctly, because nothing happened the first time.
 * - **A key belongs to the subject that sent it.** Two principals choosing `1`
 *   must each get their own execution; a lookup that crossed that boundary would
 *   replay one caller's response to another.
 * - **A reused key is refused, never served.** Same key, different request means
 *   the client's assertion is false, and answering with the earlier response
 *   would be a lie it acts on.
 * - **An unrecordable response fails closed.** A replay that cannot be answered
 *   is a 409, not a second execution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  IDEMPOTENCY_REPLAY_UNAVAILABLE,
  IDEMPOTENCY_REUSED,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { idempotencyMod } from './modules.js';

const IDEM_USE = permissionKey.parse('idem:use');

/** The `reason` slug a refusal carried, or undefined — read off the thrown error. */
function reasonOf(err: unknown): unknown {
  return (err as { extensions?: Record<string, unknown> })?.extensions?.['reason'];
}

export function idempotencyContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`request idempotency (Idempotency-Key): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    /** A second principal, for the case that a key is one caller's and not another's. */
    let otherStub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const bob: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /** Whether each invocation was answered from a recording, newest last. */
    let replays: boolean[] = [];
    const sink = () => {
      let replayed = false;
      return {
        options: {
          onIdempotentReplay: () => {
            replayed = true;
          },
        },
        done: () => replays.push(replayed),
      };
    };

    const create = async (
      thingId: string,
      key?: string,
      label?: string,
      as: () => ScopeStub = () => stub,
    ) => {
      const probe = sink();
      try {
        return await as().invoke(
          'idem/create',
          { thingId, ...(label === undefined ? {} : { label }) },
          { ...probe.options, ...(key === undefined ? {} : { idempotencyKey: key }) },
        );
      } finally {
        probe.done();
      }
    };

    /** How many times a handler in this module has actually run. */
    const runs = async (): Promise<number> =>
      ((await stub.invoke('idem/runs', {})) as { count: number }).count;

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(idempotencyMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'idem-tenant', name: 'Idem Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'idem');
      await host.admin.defineRole(staff, t1, {
        key: 'idem-admin',
        permissions: [IDEM_USE],
        source: 'vertical',
      });
      for (const principal of [alice, bob]) {
        await host.admin.assignRole(staff, {
          principalId: principal,
          roleKey: 'idem-admin',
          node: { tenantId: t1, scopeId: null },
        });
      }
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'idem-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
      otherStub = await host.getScope(bob, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('runs twice for two identical requests carrying no key', async () => {
      const before = await runs();
      await create('baseline');
      await create('baseline');
      // The baseline the whole feature is measured against: without a key there is
      // no dedupe, and identical requests are two requests. A suite that skipped
      // this could not tell a working replay from an operation that happens to be
      // naturally idempotent.
      expect(await runs()).toBe(before + 2);
    });

    it('runs once for a repeated request under one key, and replays the response', async () => {
      const key = `k-${ulid()}`;
      const before = await runs();
      replays = [];

      const first = await create('once', key, 'hello');
      const second = await create('once', key, 'hello');

      // The assertion that matters is the count, not the equality below it.
      expect(await runs()).toBe(before + 1);
      // `run` is a fresh ULID per execution, so identical values here mean the
      // second response came from the recording rather than from a second run
      // that agreed by luck.
      expect(second).toEqual(first);
      expect(replays).toEqual([false, true]);
    });

    it('scopes a key to the subject that sent it', async () => {
      const key = `shared-${ulid()}`;
      const before = await runs();
      replays = [];

      const mine = await create('theirs', key, 'a', () => stub);
      const theirs = await create('theirs', key, 'a', () => otherStub);

      // Two principals will choose the same key — `1` is a key someone sends. A
      // lookup that found the other's row would replay a response across a
      // principal boundary, which is a disclosure and not a convenience.
      expect(await runs()).toBe(before + 2);
      expect(theirs).not.toEqual(mine);
      expect(replays).toEqual([false, false]);
    });

    it('refuses a key reused for a different request, and runs nothing', async () => {
      const key = `reuse-${ulid()}`;
      await create('reused', key, 'original');
      const before = await runs();

      await expect(create('reused', key, 'CHANGED')).rejects.toSatisfy((err: unknown) => {
        return errorCodeOf(err) === 'conflict' && reasonOf(err) === IDEMPOTENCY_REUSED;
      });

      // Refused, and refused BEFORE anything ran. Serving the first request's
      // response would be worse — the client would act on an answer to a question
      // it did not ask.
      expect(await runs()).toBe(before);
    });

    it('treats a different key as a different request', async () => {
      const before = await runs();
      await create('twice', `k-${ulid()}`, 'same input');
      await create('twice', `k-${ulid()}`, 'same input');
      // Dedupe is by KEY, never by content: two deliberate identical writes are
      // two writes, and a client that wanted one sends one key.
      expect(await runs()).toBe(before + 2);
    });

    it('retries — does not replay — a request that failed', async () => {
      const key = `fail-${ulid()}`;
      const before = await runs();

      await expect(
        stub.invoke('idem/fails', { thingId: 'nope' }, { idempotencyKey: key }),
      ).rejects.toThrow();
      // The handler wrote a row before throwing and the transaction rolled it
      // back, so the count has not moved — which is also why there is nothing to
      // replay.
      expect(await runs()).toBe(before);

      await expect(
        stub.invoke('idem/fails', { thingId: 'nope' }, { idempotencyKey: key }),
      ).rejects.toThrow();
      // Executed again rather than replaying the failure. Recording failures would
      // have meant deciding which are permanent, and a retry after a 500 is the
      // most ordinary thing a client does.
      expect(await runs()).toBe(before);

      // The same key is still free for the request that eventually succeeds: the
      // first two attempts left no row, so this is a first request.
      const ok = await stub.invoke(
        'idem/create',
        { thingId: 'recovered' },
        { idempotencyKey: key },
      );
      expect(ok).toMatchObject({ id: 'recovered' });
    });

    it('refuses a replay it cannot answer rather than executing again', async () => {
      const key = `big-${ulid()}`;
      const before = await runs();
      await stub.invoke('idem/big', { thingId: 'large' }, { idempotencyKey: key });
      expect(await runs()).toBe(before + 1);

      await expect(
        stub.invoke('idem/big', { thingId: 'large' }, { idempotencyKey: key }),
      ).rejects.toSatisfy((err: unknown) => {
        return errorCodeOf(err) === 'conflict' && reasonOf(err) === IDEMPOTENCY_REPLAY_UNAVAILABLE;
      });

      // Fail closed. An error the caller can act on beats the duplicate execution
      // the key was sent to prevent — and the original did complete, so re-running
      // is the one answer that is certainly wrong.
      expect(await runs()).toBe(before + 1);
    });

    it('refuses a key on an operation that declared `idempotency: false`', async () => {
      const before = await runs();
      await expect(
        stub.invoke('idem/secret', { thingId: 's1' }, { idempotencyKey: `s-${ulid()}` }),
      ).rejects.toThrow(/idempotency: false|cannot honour an Idempotency-Key/i);
      // Refused rather than ignored: a caller who sent a key and got a 200 would
      // believe the retry is safe, and here the response was never recorded — the
      // second request would mint a second secret.
      expect(await runs()).toBe(before);

      // The operation itself still works; it is the header it refuses.
      await expect(stub.invoke('idem/secret', { thingId: 's1' })).resolves.toMatchObject({
        id: 's1',
      });
    });

    it('refuses a malformed key', async () => {
      const before = await runs();
      for (const bad of ['', 'has space', 'x'.repeat(256)]) {
        await expect(
          stub.invoke('idem/create', { thingId: 'bad' }, { idempotencyKey: bad }),
        ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === 'validation_failed');
      }
      expect(await runs()).toBe(before);
    });

    it('replays the entity version alongside the body', async () => {
      const key = `guard-${ulid()}`;
      const tags: (string | null)[] = [];
      const options = {
        idempotencyKey: key,
        onEntityVersion: (v: string | null) => tags.push(v),
      };
      const first = await stub.invoke('idem/create-guarded', { thingId: 'g1' }, options);
      const second = await stub.invoke('idem/create-guarded', { thingId: 'g1' }, options);

      expect(second).toEqual(first);
      // The two seams compose or neither works: a replayed response with no `ETag`
      // leaves the client holding no validator, so its next conditional write has
      // nothing to send and the lost-update protection quietly switches off.
      expect(tags).toHaveLength(2);
      expect(tags[1]).toBe(tags[0]);
      expect(tags[0]).not.toBeNull();
    });

    it('does not report a version for a replay of an unguarded operation', async () => {
      const key = `plain-${ulid()}`;
      const tags: (string | null)[] = [];
      const options = {
        idempotencyKey: key,
        onEntityVersion: (v: string | null) => tags.push(v),
      };
      await stub.invoke('idem/create', { thingId: 'p1' }, options);
      await stub.invoke('idem/create', { thingId: 'p1' }, options);
      // #129's rule survives the replay path: an operation that declared no
      // `concurrency` never reports a tag, and a recording must not become the
      // route by which one appears.
      expect(tags).toEqual([]);
    });
  });
}
