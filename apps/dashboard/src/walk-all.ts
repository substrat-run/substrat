import type { Page } from '@substrat-run/contracts';
import { walkPages } from '@substrat-run/control-plane-client';
import type { ScopeStub } from '@substrat-run/kernel';
import type { DashboardAppRow } from './module.js';

/**
 * Every row of one of the dashboard's paged list reads (#2426), for a caller that needs the whole
 * set rather than a screen of it: a lookup by scope id, a team-wide pass, a list a route answers
 * unpaged. Each read answers one page, a default-sized one when the call names none, so a caller
 * that wants all of it follows the cursor, at the ceiling page size, until it runs out.
 */
export function walkAll<T>(
  scope: Pick<ScopeStub, 'invoke'>,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T[]> {
  return walkPages(({ limit, cursor }) =>
    scope.invoke<Page<T>>(operation, { ...input, limit, ...(cursor === null ? {} : { cursor }) }),
  );
}

/** Every one of the team's apps. */
export const allApps = (scope: Pick<ScopeStub, 'invoke'>): Promise<DashboardAppRow[]> =>
  walkAll<DashboardAppRow>(scope, 'dashboard/list-apps');
