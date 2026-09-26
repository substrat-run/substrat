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
const REAL_ABORT = '__substratPitrEmulationRealAbort';

type Instance = Record<string, unknown>;

/**
 * Arm the next `rewindToBookmark` on this scope's live instance to accept any bookmark. With
 * `throwing`, the restore call throws that message instead: a raw transport-style failure with
 * no refusal prefix, after the DO got as far as arming, which the host cannot read as a refusal.
 * With `holdAbort`, the DO's own restart is held back, so the armed (doomed) instance keeps
 * serving until `restartNow` stands in for it — the abort, or an idle eviction.
 */
export async function armRewind(
  ns: DurableObjectNamespace,
  scopeId: string,
  opts?: { throwing?: string; holdAbort?: boolean },
): Promise<void> {
  await runInDurableObject(ns.get(ns.idFromName(scopeId)), (instance, state) => {
    if (opts?.holdAbort) {
      const real = state.abort.bind(state);
      (instance as unknown as Instance)[REAL_ABORT] = real;
      (state as unknown as { abort: () => void }).abort = () => undefined;
    }
    (state.storage as unknown as { onNextSessionRestoreBookmark: (b: string) => Promise<string> })
      .onNextSessionRestoreBookmark = async (bookmark) => {
      if (opts?.throwing) throw new Error(opts.throwing);
      return bookmark;
    };
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

/** Restart the scope's instance now: the held abort, or an eviction of the armed instance. */
export async function restartNow(ns: DurableObjectNamespace, scopeId: string): Promise<void> {
  await runInDurableObject(ns.get(ns.idFromName(scopeId)), (instance, state) => {
    const real = (instance as unknown as Instance)[REAL_ABORT] as ((reason?: string) => void) | undefined;
    (real ?? state.abort.bind(state))('restart');
  }).catch(() => undefined);
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
  switchHoldClaim(scopeId: string, moduleIds: string[], claimId: string, at: string): Promise<void>;
  switchHoldArm(scopeId: string, claimId: string, doomed: string | null): Promise<void>;
  switchHoldClaims(
    scopeId: string,
    moduleId: string,
  ): Promise<{ claimId: string; state: 'pending' | 'armed'; doomed: string | null; heldAt: string }[]>;
  switchHoldRelease(scopeId: string, moduleId: string | null, claimIds: string[] | null): Promise<void>;
} {
  return ns.get(ns.idFromName(SWITCH_HOLDS_NAME)) as unknown as ReturnType<typeof holdsStub>;
}
