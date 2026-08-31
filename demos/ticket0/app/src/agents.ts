/**
 * The staff directory, fetched once — the contact directory's twin, for the same
 * reason and with the same shape.
 *
 * A conversation carries an `assignee` principal and every screen that shows an owner
 * shows a ULID unless something resolves it. So the app resolves staff in one place,
 * and a caller who may not read the desk gets the honest fallback rather than an error
 * on a screen that is otherwise fine.
 *
 * It is also the source the assignee pickers offer: the same rows `ticket0/assign`
 * validates against, so the app cannot offer a choice the handler would refuse.
 */
import { api, type AgentProfile } from './api.js';

let cache: Promise<Map<string, AgentProfile>> | null = null;

export function agents(): Promise<Map<string, AgentProfile>> {
  cache ??= api
    .listAgents()
    .then((p) => new Map(p.entries.map((a) => [a.principal, a])))
    .catch(() => new Map<string, AgentProfile>());
  return cache;
}

/**
 * What to call somebody on the staff. A principal nobody has a profile for is shown as
 * the tail of its id — short enough to read, and never dressed up as a name.
 */
export function agentName(
  staff: Map<string, AgentProfile>,
  principal: string | null,
): string | null {
  if (!principal) return null;
  return staff.get(principal)?.display_name ?? principal.slice(-8);
}
