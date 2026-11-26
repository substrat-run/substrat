/**
 * K-69 (no scheduled walk over tenants), step 4, first phase (rfc/tenant-scale.md §7.4, §12): the
 * platform-intent drain and the lake drain are driven by each scope's own wake
 * (`scope-wake.ts` in adapter-cloudflare), and the `*\/15` pass only checks that nothing was left.
 *
 * One switch, `SCOPE_WAKE_PHASES`, names the phases the scopes own: `platform-requests`, `events`,
 * or both, comma-separated. Unset (the default) names none, and everything runs as before: the pass
 * drains both phases for every scope, and a scope's kick gets one drain of its intents (as the
 * router's kick always did) and no lake shipping. Each phase reverts alone, by leaving its word out.
 *
 * A phase the scopes own:
 * - a scope's kick is answered `scope`, so the scope keeps looking on its back-off while the work
 *   stays, and its per-scope drain object (`PlatformDrainKickDO`) drains the phase;
 * - the pass's phase runs in check mode: work younger than `SCOPE_WAKE_CHECK_GRACE_MS` is left to
 *   its scope and counted `held`; older work is drained here as before and counted `rescued`, since
 *   that scope's wake did not come (a vertical on an older adapter, a lost alarm). What the check
 *   found is the `scope-wake-check` log line of every pass.
 *
 * The pass's walk is unchanged in this phase: replacing it with the safety net's query over a due
 * index is the next PR, once the `rescued` counts have been watched.
 */

/** The phases `SCOPE_WAKE_PHASES` can hand to the scopes. */
export interface ScopeWakePhases {
  platformRequests: boolean;
  events: boolean;
}

/**
 * How old work must be before the pass, in check mode, takes it from its scope: an hour, the
 * overdue bound K-69 proposes for the safety net. A scope's own wake looks again within 15 minutes at
 * the most (its back-off's cap), so an hour is several missed looks, not one slow one.
 */
export const SCOPE_WAKE_CHECK_GRACE_MS = 60 * 60_000;

/** Events one kicked lake drain ships for a scope; a full batch runs again at the window's end. */
export const SCOPE_WAKE_EVENT_BATCH = 200;

const WORDS: Record<string, keyof ScopeWakePhases> = { 'platform-requests': 'platformRequests', events: 'events' };

/**
 * `SCOPE_WAKE_PHASES` → the phases the scopes own. A word it does not know is warned about and
 * ignored, so a typo leaves that phase with the pass, which is the safe side.
 */
export function scopeWakePhasesOf(raw: string | undefined): ScopeWakePhases {
  const phases: ScopeWakePhases = { platformRequests: false, events: false };
  for (const word of (raw ?? '').split(',').map((w) => w.trim()).filter(Boolean)) {
    const phase = WORDS[word];
    if (phase) phases[phase] = true;
    else console.warn(`SCOPE_WAKE_PHASES: '${word}' is not platform-requests or events; ignored, its phase stays with the pass`);
  }
  return phases;
}

/** Who owns each phase, as a scope's kick is answered (`WakeAnswer` in adapter-cloudflare). */
export interface ScopeWakeAnswer {
  platformRequests: 'scope' | 'pass';
  events: 'scope' | 'pass';
}

/**
 * The answer to a scope's kick. A phase is the scope's only when the switch names it AND this
 * deployment can run it from the scope's drain object: the object bound, and for events the lake
 * sink bound and a vertical reachable. Otherwise the pass keeps it, and the scope asks no more.
 */
export function scopeWakeAnswerOf(phases: ScopeWakePhases, can: { kick: boolean; ship: boolean }): ScopeWakeAnswer {
  return {
    platformRequests: phases.platformRequests && can.kick ? 'scope' : 'pass',
    events: phases.events && can.kick && can.ship ? 'scope' : 'pass',
  };
}

/** What the intent phase's check found across one pass (K-69). */
export interface IntentCheckTally {
  /** Scopes with intents younger than the grace, left to their own wake. */
  held: number;
  heldIntents: number;
  /** Scopes whose older intents the pass ran, because their wake did not. */
  rescued: number;
  rescuedIntents: number;
}

/** A counter the pass's intent drain adds each scope's answer to. */
export function intentCheckTally(): IntentCheckTally & { add(r: { drained: number; leftToScope?: number }): void } {
  const tally = {
    held: 0,
    heldIntents: 0,
    rescued: 0,
    rescuedIntents: 0,
    add(r: { drained: number; leftToScope?: number }) {
      if (r.leftToScope) {
        tally.held += 1;
        tally.heldIntents += r.leftToScope;
      }
      if (r.drained > 0) {
        tally.rescued += 1;
        tally.rescuedIntents += r.drained;
      }
    },
  };
  return tally;
}

/**
 * The `scope-wake-check` log line's fields, or null when no phase is in check mode. Written on every
 * pass a phase is checked, zeros included: a run of zeros is the evidence the safety net can replace
 * the phase, and a missing line would read as no evidence.
 */
export function scopeWakeCheckLogOf(
  intents: IntentCheckTally | null,
  events: { held: number; heldEvents: number; rescued: number } | null | undefined,
): Record<string, unknown> | null {
  if (!intents && !events) return null;
  return {
    ...(intents
      ? { platformRequests: { held: intents.held, heldIntents: intents.heldIntents, rescued: intents.rescued, rescuedIntents: intents.rescuedIntents } }
      : {}),
    ...(events ? { events } : {}),
  };
}
