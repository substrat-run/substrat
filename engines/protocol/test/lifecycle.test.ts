import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityRef, StateDef } from '@substrat-run/contracts';
import { toProblem, transitionFor } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PROTOCOL_PERM as PERM,
  countersignProtocol,
  defineTemplate,
  fillProtocol,
  instantiateProtocol,
  protocolLifecycle,
  protocolModule,
  signProtocol,
  voidProtocol,
} from '../src/index.js';
import { protocolEntities } from '../src/entities.js';

/**
 * The declared lifecycle, doing the refusing (#844).
 *
 * Before this, the machine was `instance.status !== 'open'` at five call sites
 * plus an `already_voided` throw, and the `status` enum in `entities.ts` held it
 * to nothing: widening it was a one-line change to an `if`, invisible in review.
 *
 * These tests pin the two halves of the adoption:
 *
 * 1. **The declaration is what decides.** Every refusal below is raised because
 *    `transitionFor` found no edge, not because a hand-written comparison did.
 *    The assertions pair the refusal with the declaration that produced it, so a
 *    widened edge cannot pass by silently deleting a test's premise.
 * 2. **The vocabulary did not move.** `assertTransition` would answer every one
 *    of these `invalid_transition`; this engine keeps `wrong_status`,
 *    `content_frozen` and `already_voided`, which are three different answers a
 *    consumer already branches on. That is the `transitionFor` shape
 *    `apps/docs/concepts/lifecycle.md` prescribes, and it is a published surface
 *    kept additive rather than a style choice.
 */

const ORDER: EntityRef = { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' };

const CONTENT = {
  sections: [
    {
      title: 'Broms',
      items: [{ key: 'front-brake', label: 'Frambroms', type: 'check' as const }],
    },
  ],
};

async function thrownBy(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a refusal, got none');
}

describe('engine-protocol — the lifecycle is declared, and the declaration refuses', () => {
  let h: EngineHarness;

  beforeEach(async () => {
    h = await engineHarness({
      modules: [protocolModule],
      entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
    });
    await h.as([PERM.create, PERM.fill, PERM.sign, PERM.countersign, PERM.read, PERM.void]);
  });
  afterEach(async () => {
    await h.close();
  });

  const openInstance = async () => {
    await h.run((ctx) =>
      defineTemplate(ctx, { key: 'self-inspection', title: 'Self-inspection', content: CONTENT }),
    );
    return h.run((ctx) => instantiateProtocol(ctx, { templateKey: 'self-inspection', entity: ORDER }));
  };

  // -- the declaration itself ---------------------------------------------------

  it('declares a state for every value the column can hold, and no other', () => {
    // `defineLifecycles` already threw at import time if these disagreed. This
    // reads the enum back so the pairing is visible rather than implied.
    const enumValues = (protocolEntities.protocol.fields.shape.status as { options: string[] }).options;
    expect(Object.keys(protocolLifecycle.states).sort()).toEqual([...enumValues].sort());
    expect(protocolLifecycle.field).toBe('status');
    expect(protocolLifecycle.initial).toBe('open');
  });

  it('a fresh instance starts in the declared initial state', async () => {
    const inst = await openInstance();
    expect(inst.status).toBe(protocolLifecycle.initial);
  });

  it('voided is terminal — the one state no verb leaves', () => {
    expect(protocolLifecycle.states.voided?.terminal).toBe(true);
    for (const op of ['protocol/sign', 'protocol/void', 'protocol/fill', 'protocol/request-signatures']) {
      expect(transitionFor(protocolLifecycle, 'voided', op)).toBeNull();
    }
  });

  it('open is the only state that admits vertical substates (K-17)', () => {
    expect(protocolLifecycle.states.open?.extensible).toBe(true);
    // Widened to the declared shape: `states` is a union of four literal types,
    // so an absent optional is absent from the TYPE too — which is exactly the
    // thing this asserts is still true.
    const states: Record<string, StateDef> = protocolLifecycle.states;
    for (const state of ['pending_signature', 'signed', 'voided']) {
      expect(states[state]?.extensible).toBeUndefined();
    }
  });

  // -- an illegal transition is refused, by the declaration ----------------------

  it('signing a signed protocol is refused, and the declaration is why', async () => {
    const inst = await openInstance();
    await h.run((ctx) => signProtocol(ctx, { instanceId: inst.id }));

    // The premise: no `protocol/sign` edge out of `signed`.
    expect(transitionFor(protocolLifecycle, 'signed', 'protocol/sign')).toBeNull();

    const err = await thrownBy(() => h.run((ctx) => signProtocol(ctx, { instanceId: inst.id })));
    expect(toProblem(err).status).toBe(409);
    expect(toProblem(err).reason).toBe('wrong_status');
    expect(err.message).toMatch(/only an open protocol can be signed/);
  });

  it('counter-signing an open protocol is refused — countersign is `allow` in signed only', async () => {
    const inst = await openInstance();
    expect(transitionFor(protocolLifecycle, 'open', 'protocol/countersign')).toBeNull();
    // …and where it IS legal it moves nothing, which is what `allow` says.
    expect(transitionFor(protocolLifecycle, 'signed', 'protocol/countersign')).toEqual({ kind: 'allowed' });

    const err = await thrownBy(() => h.run((ctx) => countersignProtocol(ctx, { instanceId: inst.id })));
    expect(toProblem(err).reason).toBe('wrong_status');
  });

  it('filling a signed protocol is refused as content_frozen, not as a bad transition', async () => {
    const inst = await openInstance();
    await h.run((ctx) => signProtocol(ctx, { instanceId: inst.id }));
    expect(transitionFor(protocolLifecycle, 'signed', 'protocol/fill')).toBeNull();

    const err = await thrownBy(() =>
      h.run((ctx) => fillProtocol(ctx, { instanceId: inst.id, itemKey: 'front-brake', value: true })),
    );
    // The verb is fine; the content is not. `assertTransition` could not have
    // said that, which is the whole reason this engine kept its own vocabulary.
    expect(toProblem(err).reason).toBe('content_frozen');
  });

  it('voiding twice is refused as already_voided — the same fact, in this engine words', async () => {
    const inst = await openInstance();
    await h.run((ctx) => voidProtocol(ctx, { instanceId: inst.id, reason: 'fel cykel' }));
    expect(transitionFor(protocolLifecycle, 'voided', 'protocol/void')).toBeNull();

    const err = await thrownBy(() =>
      h.run((ctx) => voidProtocol(ctx, { instanceId: inst.id, reason: 'igen' })),
    );
    expect(toProblem(err).reason).toBe('already_voided');
    expect(err.message).toMatch(/already voided/);
  });

  it('void is declared out of every state that is not already voided', () => {
    for (const state of ['open', 'pending_signature', 'signed'] as const) {
      expect(transitionFor(protocolLifecycle, state, 'protocol/void')).toEqual({
        kind: 'transition',
        to: 'voided',
      });
    }
  });
});
