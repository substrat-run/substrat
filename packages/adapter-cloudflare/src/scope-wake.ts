import type { ScopeId, TenantId } from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';

/**
 * A scope that has work for the platform wakes itself (K-69, no scheduled walk over tenants;
 * rfc/tenant-scale.md §7.4, step 4).
 *
 * Two kinds of work leave a scope only when the platform comes for them: its pending platform
 * intents (`_substrat_platform_requests`) and its outbox rows not yet shipped to the lake
 * (`_substrat_outbox.drained_at IS NULL`). Until now the control plane's `*\/15` pass walked every
 * active scope to look, 96 times a day, whether the scope had any. Here the scope asks instead: after
 * a commit leaves work of either kind, it arms its alarm, and the alarm asks the control plane to
 * drain it (`/internal/drain-scope`, the router's kick, #3388's per-scope drain object). While the
 * work stays, the alarm stays armed, backing off to the pass's own cadence. A scope with nothing
 * pending arms nothing, so an idle scope costs no request at all (D-79, idle tenant costs storage only).
 *
 * The control plane's answer says, per phase, who owns the work right now: `scope` (its switch,
 * `SCOPE_WAKE_PHASES`, hands the phase to the scopes and its pass only checks) or `pass` (the pass
 * still drains it, as it always has). A phase the pass owns gets the commit's kick and no retries:
 * an intent's attempt ceiling is counted in drains and calibrated to the pass's cadence, and two
 * drivers would spend it twice as fast. A control plane that predates the answer is read as `pass`.
 *
 * This module is the decision, with no I/O of its own: the scope object hands it what it found
 * (`WakeWork`) and how to reach the control plane (`kick`), and stores what it returns.
 */

/** How long after a commit that enqueued an intent the scope asks for a drain. */
export const SCOPE_WAKE_INTENTS_DELAY_MS = 2_000;

/**
 * How long after a commit that left undrained events the scope asks for the lake drain. Shipping
 * coalesces within it: a busy scope ships at most once per window, and an event reaches the lake
 * within it, where the pass took up to 15 minutes. Proposed default; the owner's choice.
 */
export const SCOPE_WAKE_EVENTS_DELAY_MS = 5 * 60_000;

/**
 * The gaps between a scope's looks while its work stays, once the control plane owns nothing for it
 * or a kick was lost: one, two, four and eight minutes, then the pass's 15 for as long as it lasts.
 * Each look checks first and asks only if the work is still there.
 */
export const SCOPE_WAKE_BACKOFF_MS: readonly number[] = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];

/** How long a scope leaves its lake shipping to the pass once the control plane says the pass owns it. */
export const SCOPE_WAKE_PASS_HOLD_MS = 60 * 60_000;

export type WakePhase = 'intents' | 'events';

/**
 * What the scope found after a commit: two reads by index, a row or two each. Every commit pays
 * them, so neither scans: the intent table has no index on its status, and the newest id by primary
 * key says whether anything was enqueued since the scope last asked.
 */
export interface CommitWork {
  /** The newest intent's id, whatever its status, or null when the scope has none. */
  newestIntent: string | null;
  /** Any outbox row this scope emitted that has not been shipped. */
  undrainedEvents: boolean;
}

/** What the scope found at its alarm, which also asks whether any intent is still pending. */
export interface WakeWork extends CommitWork {
  pendingIntents: boolean;
}

/** Who owns a phase's work, as the control plane answered (`scope`), or the pass still does. */
export type WakeOwner = 'scope' | 'pass';

/** The control plane's answer to a scope's kick. Null: the kick did not land. */
export interface WakeAnswer {
  platformRequests?: WakeOwner;
  events?: WakeOwner;
}

/** The body a scope's kick carries — the router kick's, with `events` and its source. */
export interface WakeKick {
  tenantId: TenantId;
  scopeId: ScopeId;
  platformRequests: boolean;
  events: boolean;
  source: 'scope';
}

/** What a scope keeps between its wakes, in its own storage (`SCOPE_WAKE_KEY`). */
export interface ScopeWakeState {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Epoch ms each phase is next looked at. Absent: nothing due. */
  due: Partial<Record<WakePhase, number>>;
  /** Looks that found the phase's work still there, for the back-off. */
  retries: Partial<Record<WakePhase, number>>;
  /** The newest intent the scope's alarm has already looked at: a commit adding none newer asks nothing. */
  intentsMark?: string;
  /** Epoch ms until which lake shipping is left to the pass (`SCOPE_WAKE_PASS_HOLD_MS`). */
  eventsHeldUntil?: number;
}

/** The storage key a scope keeps its wake under. Storage KV, never SQL: dumps and module SQL cannot see it. */
export const SCOPE_WAKE_KEY = 'scope-wake';

const backoff = (retries: number): number =>
  SCOPE_WAKE_BACKOFF_MS[Math.min(Math.max(retries, 1), SCOPE_WAKE_BACKOFF_MS.length) - 1]!;

const blank = (ids: { tenantId: TenantId; scopeId: ScopeId }): ScopeWakeState => ({
  tenantId: ids.tenantId,
  scopeId: ids.scopeId,
  due: {},
  retries: {},
});

/**
 * After a commit: what to arm. Returns the new state, or `null` when nothing changes (the common
 * case on a busy scope: its wake is already armed, or it has nothing pending).
 *
 * An intent wakes the scope only when it is NEWER than what a kick already asked for. A pending
 * intent that keeps failing is the back-off's to retry, never every commit's: the drain spends one
 * of its attempts each time it runs it.
 */
export function wakeAfterCommit(
  prior: ScopeWakeState | null,
  ids: { tenantId: TenantId; scopeId: ScopeId },
  work: CommitWork,
  now: number,
): ScopeWakeState | null {
  const freshIntent =
    work.newestIntent !== null && (prior?.intentsMark === undefined || work.newestIntent > prior.intentsMark);
  const intentsAt = now + SCOPE_WAKE_INTENTS_DELAY_MS;
  const wantsIntents = freshIntent && !(prior?.due.intents !== undefined && prior.due.intents <= intentsAt);
  const held = prior?.eventsHeldUntil !== undefined && prior.eventsHeldUntil > now;
  const wantsEvents = work.undrainedEvents && prior?.due.events === undefined && !held;
  if (!wantsIntents && !wantsEvents) return null;
  const next: ScopeWakeState = prior
    ? { ...prior, due: { ...prior.due }, retries: { ...prior.retries } }
    : blank(ids);
  if (wantsIntents) {
    next.due.intents = intentsAt;
    delete next.retries.intents;
  }
  if (wantsEvents) next.due.events = now + SCOPE_WAKE_EVENTS_DELAY_MS;
  return next;
}

/** The instant the scope's alarm should fire for its wake, or null when nothing is due. */
export function wakeDueAt(state: ScopeWakeState | null): number | null {
  if (!state) return null;
  const times = Object.values(state.due).filter((t): t is number => typeof t === 'number');
  return times.length ? Math.min(...times) : null;
}

/**
 * The alarm: look at each due phase, ask for what is still there, and say when to look again.
 * Returns the state to keep, or `null` when nothing is left to keep (delete it).
 *
 * `probe` runs only when a phase is due, and `kick` only when a due phase still has work.
 */
export async function runWake(
  state: ScopeWakeState,
  now: number,
  probe: () => WakeWork,
  kick: (body: WakeKick) => Promise<WakeAnswer | null>,
): Promise<ScopeWakeState | null> {
  const next: ScopeWakeState = { ...state, due: { ...state.due }, retries: { ...state.retries } };
  const due = (p: WakePhase) => next.due[p] !== undefined && next.due[p]! <= now;
  if (!due('intents') && !due('events')) return settled(next, now);
  const work = probe();
  const asks = {
    intents: due('intents') && work.pendingIntents,
    events: due('events') && work.undrainedEvents,
  };
  // Looked at: a later commit wakes the scope only for an intent newer than this, settled or not.
  // Advanced whatever the kick's fate, since a pending intent's retries are the back-off's, not a commit's.
  if (due('intents') && work.newestIntent !== null) next.intentsMark = work.newestIntent;
  // A due phase whose work is gone is done: a drain from elsewhere (the router's kick, the pass) took it.
  for (const p of ['intents', 'events'] as const) {
    if (due(p) && !asks[p]) {
      delete next.due[p];
      delete next.retries[p];
    }
  }
  if (!asks.intents && !asks.events) return settled(next, now);
  const answer = await kick({
    tenantId: state.tenantId,
    scopeId: state.scopeId,
    platformRequests: asks.intents,
    events: asks.events,
    source: 'scope',
  }).catch(() => null);
  const owner = (p: WakePhase): WakeOwner | 'lost' =>
    answer === null ? 'lost' : ((p === 'intents' ? answer.platformRequests : answer.events) ?? 'pass');
  for (const p of ['intents', 'events'] as const) {
    if (!asks[p]) continue;
    const o = owner(p);
    if (o === 'pass') {
      // The pass drains it, as it always has. No retries from here, which would spend an intent's
      // attempts twice as fast or ship an event the pass is shipping too.
      delete next.due[p];
      delete next.retries[p];
      if (p === 'events') next.eventsHeldUntil = now + SCOPE_WAKE_PASS_HOLD_MS;
      continue;
    }
    // `scope`: the drain is on its way; look again later and ask once more if the work is still
    // there. `lost`: the kick never landed, so nothing was spent; ask again on the same back-off.
    const retries = (next.retries[p] ?? 0) + 1;
    next.retries[p] = retries;
    next.due[p] = now + backoff(retries);
    if (p === 'events' && o === 'scope') delete next.eventsHeldUntil;
  }
  return settled(next, now);
}

/**
 * What the alarm stores after its kick, keeping what a commit registered while the kick was out.
 *
 * The alarm reads the state (`read`), awaits the control plane, and builds `next` from that read.
 * The object takes other calls during the await, so a commit may have stored a phase in the
 * meantime (`fresh`). Writing `next` as it stands would drop it, and the wake it asked for with it.
 * So a phase whose due time in `fresh` differs from the one the alarm read was set meanwhile, and is
 * kept: the earlier of it and `next`'s. A newer intent mark is kept too.
 */
export function keepRegisteredMeanwhile(
  read: ScopeWakeState,
  next: ScopeWakeState | null,
  fresh: ScopeWakeState | null,
): ScopeWakeState | null {
  if (!fresh) return next;
  const meanwhile = (['intents', 'events'] as const).filter((p) => fresh.due[p] !== undefined && fresh.due[p] !== read.due[p]);
  const newerMark = fresh.intentsMark !== undefined && (next?.intentsMark === undefined || fresh.intentsMark > next.intentsMark);
  if (meanwhile.length === 0 && !newerMark) return next;
  const merged: ScopeWakeState = next
    ? { ...next, due: { ...next.due }, retries: { ...next.retries } }
    : { tenantId: fresh.tenantId, scopeId: fresh.scopeId, due: {}, retries: {} };
  for (const p of meanwhile) {
    const theirs = fresh.due[p]!;
    merged.due[p] = merged.due[p] === undefined ? theirs : Math.min(merged.due[p]!, theirs);
  }
  if (newerMark) merged.intentsMark = fresh.intentsMark;
  return merged;
}

/** Drop what no longer says anything; null when the whole state says nothing. */
function settled(state: ScopeWakeState, now: number): ScopeWakeState | null {
  if (state.eventsHeldUntil !== undefined && state.eventsHeldUntil <= now) delete state.eventsHeldUntil;
  const keeps = wakeDueAt(state) !== null || state.eventsHeldUntil !== undefined || state.intentsMark !== undefined;
  if (!keeps) return null;
  // A mark with nothing armed is still worth keeping: without it the next commit would ask again for
  // an intent a kick already covered. It is one short string.
  return state;
}

/**
 * The kick, over the control plane's origin and the platform secret the upload injects into every
 * pushed vertical (`CONTROL_PLANE_URL`, `PLATFORM_SECRET`), as the scope sweeper's kick goes. Null
 * when the call did not land or the answer was not a 2xx; an answer without `wake` (a control plane
 * that predates it) reads as `{}`, which `runWake` takes as the pass owning both phases.
 */
export async function kickControlPlane(
  platform: { controlPlaneUrl: string; secret: string },
  body: WakeKick,
): Promise<WakeAnswer | null> {
  const res = await fetch(new URL('/internal/drain-scope', platform.controlPlaneUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: platform.secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const answer = (await res.json().catch(() => ({}))) as { wake?: { platformRequests?: unknown; events?: unknown } };
  const ownerOf = (v: unknown): WakeOwner | undefined => (v === 'scope' || v === 'pass' ? v : undefined);
  const wake = answer.wake ?? {};
  const platformRequests = ownerOf(wake.platformRequests);
  const events = ownerOf(wake.events);
  return { ...(platformRequests ? { platformRequests } : {}), ...(events ? { events } : {}) };
}
