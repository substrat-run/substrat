import { moduleManifest } from '@substrat-run/contracts';
import type { ConsumerHandler, ModuleRegistration, OperationContext, OperationHandler } from '@substrat-run/kernel';

/**
 * #2055: a consumer that can be held mid-handler, for `scopeCausedByContractSuite`.
 *
 * `causedby/start` emits `causedby.requested`; its consumer waits while the hold is shut, then
 * emits `causedby.effected`. `causedby/other` emits `causedby.other` and nothing consumes it.
 *
 * The hold is a flag on `globalThis`, polled on a timer, because a Durable Object closes over
 * its modules at code time, so the suite cannot hand one in — the test and the object share an
 * isolate, but not a request: a promise one side resolves for the other hangs in workerd.
 *
 * Inert unless a suite shuts the hold: with none, the consumer runs straight through.
 */
export const CAUSED_BY_HOLD = '__substratCausedByHold';

/** The hold's state: `shut` while the consumer must wait, `entered` once it has started waiting. */
export interface CausedByHold {
  shut: boolean;
  entered: boolean;
}

/** One poll of the hold. */
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const manifest = moduleManifest.parse({
  id: '@test/caused-by',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [],
  events: {
    emits: [
      { type: 'causedby.requested', schemaVersion: 1 },
      { type: 'causedby.effected', schemaVersion: 1 },
      { type: 'causedby.other', schemaVersion: 1 },
    ],
    consumes: [{ type: 'causedby.requested', schemaVersion: 1 }],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'causedby',
});

const emitTagged = (ctx: OperationContext, type: string, tag: string): void => {
  ctx.emit({ type, schemaVersion: 1, entity: { entityType: 'tag', entityId: tag }, piiClass: 'none', payload: { tag } });
};

export const causedByMod: ModuleRegistration = {
  manifest,
  migrations: [],
  operations: {
    'causedby/start': ((ctx: OperationContext, input: { tag: string }) =>
      emitTagged(ctx, 'causedby.requested', input.tag)) as unknown as OperationHandler<never, unknown>,
    'causedby/other': ((ctx: OperationContext, input: { tag: string }) =>
      emitTagged(ctx, 'causedby.other', input.tag)) as unknown as OperationHandler<never, unknown>,
  },
  consumers: {
    'causedby.requested': (async (ctx, event) => {
      const hold = (globalThis as Record<string, unknown>)[CAUSED_BY_HOLD] as CausedByHold | undefined;
      if (hold) {
        hold.entered = true;
        while (hold.shut) await tick();
      }
      emitTagged(ctx, 'causedby.effected', (event.payload as { tag: string }).tag);
    }) as ConsumerHandler,
  },
};
