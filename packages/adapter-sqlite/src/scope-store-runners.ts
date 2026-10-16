import type { ScopeStoreHostOptions, ScopeStoreRunner } from '@substrat-run/kernel';

/**
 * The `scopeStores.runners` a dev harness hands `SqliteScopeHost` (#2213), read from the
 * vertical's own declaration (`runtimeNeeds.scopeStores`) so local bindings cannot drift
 * from the ones a push declares. One runner per driver: two bindings of one driver share it,
 * and the host starts it once.
 *
 * Refused: a declared driver with no runner, and a runner whose `driver` is not the key it
 * was given under, since a dump records the runner's driver and a restore checks it.
 */
export function scopeStoreRunnersFor(
  declared: readonly { readonly binding: string; readonly driver: string }[],
  runners: Readonly<Record<string, ScopeStoreRunner>>,
): NonNullable<ScopeStoreHostOptions['runners']> {
  for (const [driver, runner] of Object.entries(runners)) {
    if (runner.driver !== driver) {
      throw new Error(`the runner given for scope-store driver '${driver}' is driver '${runner.driver}'`);
    }
  }
  return declared.map(({ binding, driver }) => {
    const runner = Object.hasOwn(runners, driver) ? runners[driver] : undefined;
    if (!runner) {
      throw new Error(`scope store '${binding}' is declared as driver '${driver}', and no runner is given for it`);
    }
    return { binding, runner };
  });
}
