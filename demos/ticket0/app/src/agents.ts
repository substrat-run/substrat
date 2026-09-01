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

/**
 * The WHOLE directory, not its first page.
 *
 * A picker is the one read where a truncated answer is invisible: it does not look
 * short, it looks like the person you wanted does not work here. So this follows
 * `page.next` to the end rather than mapping the first response, which is also the
 * only way the app's options stay the same set the handler validates against.
 */
async function everyAgent(): Promise<Map<string, AgentProfile>> {
  const all = new Map<string, AgentProfile>();
  let page = await api.listAgents();
  for (;;) {
    for (const a of page.entries) all.set(a.principal, a);
    if (!page.next) return all;
    page = await api.follow<AgentProfile>(page.next);
  }
}

/**
 * Forget the directory, so the next `agents()` reads it again.
 *
 * The cache lives for the tab, which is right for a hundred inbox rows resolving one
 * name each and wrong the moment somebody changes who is IN it. Saving a profile is
 * exactly that: without this, returning to the inbox still shows "nobody can hand you
 * work" and the picker still omits the person who just joined the directory.
 */
export function forgetAgents(): void {
  cache = null;
}

export function agents(): Promise<Map<string, AgentProfile>> {
  cache ??= everyAgent().catch(() => {
    // A caller who may not read the desk gets the empty map — but the failure is not
    // remembered. Caching it would turn one bad response into a picker that stays
    // empty for the life of the tab, and a 403 and a dropped connection look the
    // same from here.
    cache = null;
    return new Map<string, AgentProfile>();
  });
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
