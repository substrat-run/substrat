import type { ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * Which scopes the event drain found its deployment does not hold, and which of those are NEW (#2544).
 * An active scope in that state fails the same way on every tick, so it is not a digest entry
 * (`EventDrainReport.notHeld`); it is filed as ONE ops-failure when it appears, and again only after
 * a pass in which it was held again. `recorded` is the isolate's memory of what was filed: a fresh
 * isolate files it once more, which the issue's fingerprint folds into the same issue.
 */
export function newlyNotHeld(
  recorded: Set<string>,
  notHeld: readonly { tenantId: TenantId; scopeId: ScopeId }[] | undefined,
): { tenantId: TenantId; scopeId: ScopeId }[] {
  const now = new Set((notHeld ?? []).map((s) => s.scopeId as string));
  for (const id of recorded) if (!now.has(id)) recorded.delete(id);
  const fresh = (notHeld ?? []).filter((s) => !recorded.has(s.scopeId));
  for (const s of fresh) recorded.add(s.scopeId);
  return fresh;
}
