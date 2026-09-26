import { runInDurableObject } from 'cloudflare:test';
import type { ScopeDumpTable } from '@substrat-run/contracts';
import { SWITCH_HOLDS_NAME } from '../src/host.js';

/**
 * #1819: a PITR rewind, as close to the real one as workerd allows.
 *
 * workerd implements no point-in-time recovery: `onNextSessionRestoreBookmark` exists and
 * throws "This Durable Object's storage back-end does not implement point-in-time recovery".
 * So the rewind here is EMULATED, in two halves:
 *
 *   1. `armRewind` replaces that one call on the live instance with one that accepts the
 *      bookmark. Everything else is the real path: the host's `rewindScopeLocal`, the DO's
 *      `rewindToBookmark` with its refusals, and the `ctx.abort()` that restarts the object.
 *   2. `landRewind` waits for that restart, then writes the rewound bytes (a dump taken at the
 *      "bookmark") straight into the restarted object, with no host code in between. That is
 *      what PITR's restore does at the restart.
 *
 * What it cannot show is Cloudflare's own restore. It shows the part this repo owns: that a
 * scope whose storage was replaced by pre-switch bytes, behind a real restart, is still held.
 */

const RESTART_MARK = '__substratPitrEmulationArmed';

type Instance = Record<string, unknown>;

/** Arm the next `rewindToBookmark` on this scope's live instance to accept any bookmark. */
export async function armRewind(ns: DurableObjectNamespace, scopeId: string): Promise<void> {
  await runInDurableObject(ns.get(ns.idFromName(scopeId)), (instance, state) => {
    (state.storage as unknown as { onNextSessionRestoreBookmark: (b: string) => Promise<string> })
      .onNextSessionRestoreBookmark = async (bookmark) => bookmark;
    // Set on THIS instance only, so a restarted one is told apart from it.
    (instance as unknown as Instance)[RESTART_MARK] = true;
  });
}

/** Wait for the restart the rewind causes; answers once a fresh instance serves the scope. */
export async function awaitRestart(ns: DurableObjectNamespace, scopeId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const restarted = await runInDurableObject(
      ns.get(ns.idFromName(scopeId)),
      (instance) => (instance as unknown as Instance)[RESTART_MARK] !== true,
    ).catch(() => false); // "Application called abort()" while the old instance goes
    if (restarted) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`scope ${scopeId} never restarted after the rewind`);
}

/** The restore half: the restarted object's storage becomes the bookmark's bytes. */
export async function landRewind(
  ns: DurableObjectNamespace,
  scopeId: string,
  atBookmark: ScopeDumpTable[],
): Promise<void> {
  await awaitRestart(ns, scopeId);
  const stub = ns.get(ns.idFromName(scopeId)) as unknown as {
    importDump(tables: ScopeDumpTable[], scopeId: string): Promise<unknown>;
  };
  await stub.importDump(atBookmark, scopeId);
}

/** The deployment's hold object (`SWITCH_HOLDS_NAME`) in this namespace, typed for the tests. */
export function holdsStub(ns: DurableObjectNamespace): {
  switchHoldsAll(): Promise<{ scopeId: string; moduleId: string }[]>;
  switchHoldAdd(scopeId: string, moduleIds: string[], at: string): Promise<string[]>;
  switchHoldRelease(scopeId: string, moduleIds: string[] | null): Promise<void>;
} {
  return ns.get(ns.idFromName(SWITCH_HOLDS_NAME)) as unknown as ReturnType<typeof holdsStub>;
}
