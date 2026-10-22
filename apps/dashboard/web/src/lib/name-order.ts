/** Fixed locale and ID tie-breaker keep named lists stable across refreshes. */
const names = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareNamed(
  a: { name: string; scopeId: string },
  b: { name: string; scopeId: string },
): number {
  return names.compare(a.name, b.name) || (a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0);
}

export function sortApps<T extends { name: string; app_scope_id: string }>(apps: readonly T[]): T[] {
  return [...apps].sort((a, b) => compareNamed(
    { name: a.name, scopeId: a.app_scope_id },
    { name: b.name, scopeId: b.app_scope_id },
  ));
}
