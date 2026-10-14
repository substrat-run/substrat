import type { ScopeStoreHostOptions, ScopeStoreRunner } from '@substrat-run/kernel';

/**
 * The `scopeStores.runners` a dev harness hands `SqliteScopeHost` (#2213), read from the
 * vertical's own declaration (`runtimeNeeds.scopeStores`) so local bindings cannot drift
 * from the ones a push declares. One runner per kind: two bindings of one kind share it,
 * and the host starts it once.
 *
 * Refused: a declared kind with no runner, and a runner whose `kind` is not the key it
 * was given under, since a dump records the runner's kind and a restore checks it.
 */
export function scopeStoreRunnersFor(
  declared: readonly { readonly binding: string; readonly kind: string }[],
  runners: Readonly<Record<string, ScopeStoreRunner>>,
): NonNullable<ScopeStoreHostOptions['runners']> {
  for (const [kind, runner] of Object.entries(runners)) {
    if (runner.kind !== kind) {
      throw new Error(`the runner given for scope-store kind '${kind}' is kind '${runner.kind}'`);
    }
  }
  return declared.map(({ binding, kind }) => {
    const runner = Object.hasOwn(runners, kind) ? runners[kind] : undefined;
    if (!runner) {
      throw new Error(`scope store '${binding}' is declared as kind '${kind}', and no runner is given for it`);
    }
    return { binding, runner };
  });
}
