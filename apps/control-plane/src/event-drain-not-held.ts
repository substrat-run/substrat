import type { PlatformActorId, Scope, ScopeId, TenantId } from '@substrat-run/contracts';
import { ScopeNotHeld, type HostAdmin, type UndrainedEvents } from '@substrat-run/kernel';
import { isScopeNotHeld, notHeldIsBenign } from '@substrat-run/control-plane-api';

/**
 * The Tier-2 drain's read of one ACTIVE scope, when its deployment may answer that it does not hold
 * it (#2544). The drain reads a scope listed `active`, so what a refusal means is judged against the
 * directory NOW, with the rule the storage gauge uses (`notHeldIsBenign`):
 *
 * - reaped or archived since the listing, or no record: nothing to ship, no fault (empty answer);
 * - the scope routes somewhere else than the script this read reached (a carry's bind landed, and
 *   the copy it left behind was wiped under the read): the next tick reads the new home (empty answer);
 * - otherwise it is a standing condition, `ScopeNotHeld`, which the sweep counts and files once.
 *
 * Any other failure, and a directory read that fails, propagate: they stay errors.
 */
export async function undrainedOrNotHeld(input: {
  scopeId: ScopeId;
  read: () => Promise<UndrainedEvents>;
  /** The directory's record of the scope, read now. */
  record: () => Promise<Scope | undefined>;
  /** Where the scope routed when the read was addressed. */
  routeAtRead: string;
  routeOf: (scope: Scope) => string;
}): Promise<UndrainedEvents> {
  try {
    return await input.read();
  } catch (err) {
    if (!isScopeNotHeld(err, input.scopeId)) throw err;
    const now = await input.record();
    if (await notHeldIsBenign(async () => now)) return [];
    if (now && input.routeOf(now) !== input.routeAtRead) return [];
    throw new ScopeNotHeld(err instanceof Error ? err.message : String(err));
  }
}

/** How far back an existing row for the scope counts as "already filed". */
export const NOT_HELD_REFILE_MS = 7 * 24 * 60 * 60_000;

/**
 * File the scopes the drain found its deployment does not hold (#2544) as ONE staff ops-failure each,
 * not one per tick and not one per isolate. The digest mails every ledger row since its watermark, so
 * a row per sighting would put a standing condition in the digest again and again. The ledger is the
 * memory: a scope is filed only when it has no `sweep.event-drain` row in the last `NOT_HELD_REFILE_MS`
 * (so a condition that lasts is said again weekly, not every fifteen minutes). `recorded` is only a
 * cache of what the ledger was found to hold, to spare the read on later ticks of the same isolate;
 * a scope joins it after the ledger answered, never before, so a write that failed is tried again.
 *
 * The row has NO tenant: a tenant-attributed row is readable by that tenant (#2540), and what it says
 * is the platform's to act on. It never throws; the sweep is not sunk by its reporter.
 */
export async function fileNotHeld(input: {
  admin: Pick<HostAdmin, 'listOpsFailures' | 'recordOpsFailure'>;
  actor: PlatformActorId;
  recorded: Set<string>;
  notHeld: readonly { tenantId: TenantId; scopeId: ScopeId }[] | undefined;
  now?: () => Date;
}): Promise<void> {
  const now = input.now ?? (() => new Date());
  const current = new Set((input.notHeld ?? []).map((s) => s.scopeId as string));
  for (const id of input.recorded) if (!current.has(id)) input.recorded.delete(id);
  const since = new Date(now().getTime() - NOT_HELD_REFILE_MS).toISOString();
  for (const gone of input.notHeld ?? []) {
    if (input.recorded.has(gone.scopeId)) continue;
    try {
      const filed = await input.admin.listOpsFailures(input.actor, {
        scopeId: gone.scopeId,
        operation: 'sweep.event-drain',
        since,
        limit: 1,
      });
      if (filed.length === 0) {
        await input.admin.recordOpsFailure({
          actor: input.actor,
          operation: 'sweep.event-drain',
          stage: 'not-held',
          tenantId: null,
          scopeId: gone.scopeId,
          code: 'conflict',
          message: 'the deployment serving this active scope does not hold it, so its events cannot be drained',
        });
      }
      input.recorded.add(gone.scopeId);
    } catch {
      // deliberately swallowed: the scope is not remembered, so the next pass files it
    }
  }
}
