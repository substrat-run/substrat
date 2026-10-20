import type { z } from 'zod';
import type { HandlerInput, Page, PagedInput } from '@substrat-run/contracts';
import { walkPages } from '@substrat-run/control-plane-client';
import type { ScopeStub } from '@substrat-run/kernel';
import type { dashboardOperations } from './module.js';

type Operations = typeof dashboardOperations;

/** The dashboard's paged list reads, by name. */
type PagedRead = { [N in keyof Operations]: Operations[N] extends { paged: object } ? N : never }[keyof Operations];

/** What a paged read is narrowed by, beside the page itself. */
type FiltersOf<N extends PagedRead> = Omit<HandlerInput<Operations[N]>, keyof PagedInput>;

/** One row of a paged read, as its declared output types it. */
type EntryOf<N extends PagedRead> = z.infer<Operations[N]['output']>;

/**
 * Every row of one of the dashboard's paged list reads (#2426), for a caller that needs the whole
 * set rather than a screen of it: a lookup by scope id, a team-wide pass, a list a route answers
 * unpaged. Each read answers one page, a default-sized one when the call names none, so a caller
 * that wants all of it follows the cursor, at the ceiling page size, until it runs out.
 */
export function walkAll<N extends PagedRead>(
  scope: Pick<ScopeStub, 'invoke'>,
  operation: N,
  ...[filters]: {} extends FiltersOf<N> ? [filters?: FiltersOf<N>] : [filters: FiltersOf<N>]
): Promise<EntryOf<N>[]> {
  return walkPages(({ limit, cursor }) =>
    scope.invoke<Page<EntryOf<N>>>(operation, { ...filters, limit, ...(cursor === null ? {} : { cursor }) }),
  );
}

/** Every one of the team's apps. */
export const allApps = (scope: Pick<ScopeStub, 'invoke'>) => walkAll(scope, 'dashboard/list-apps');

/**
 * The team's app running under `appScopeId`, or `undefined` when it has none (#2437). One read
 * with the filter `list-apps` takes, never the walk to it — a lookup by scope id costs the same
 * for a team of three apps and a team of three hundred. A scope id that is empty or missing asks
 * for no app rather than for every app, since the filter's absence is the unfiltered list.
 */
export async function appByScopeId(scope: Pick<ScopeStub, 'invoke'>, appScopeId: string | undefined) {
  if (!appScopeId) return undefined;
  const page = await scope.invoke<Page<EntryOf<'dashboard/list-apps'>>>('dashboard/list-apps', { appScopeId, limit: 1 });
  return page.entries.find((a) => a.app_scope_id === appScopeId);
}
