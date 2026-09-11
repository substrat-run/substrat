import type { DeclaredEventSurface } from '@substrat-run/contracts';
import type { ObservedType } from './flow-graph.js';

/**
 * Declared-vs-observed findings (#1234) — the half of a flow map that no
 * observability vendor can produce.
 *
 * Datadog's service map *infers* topology from sampled traffic, so an edge exists
 * only once a request crossed it and silence is invisible. Substrat **declares**
 * the map and observes it separately, which makes the gap between the two a
 * finding in its own right: an event type an app promised to emit and never has,
 * a consumer that would run if anything produced its type, a provider an app
 * declares and nobody has connected.
 *
 * Every finding is a statement about DECLARATIONS against a bounded window of
 * observation — never "this is broken". The copy is written to say which.
 */
export type FlowFindingKind =
  | 'unemitted'
  | 'unconsumed'
  | 'stale'
  | 'unconnected-provider'
  | 'unhealthy-provider';

export interface FlowFinding {
  kind: FlowFindingKind;
  /** The declared thing the finding is about — an event type, or a provider slug. */
  subject: string;
  /** The module that declared it; null for a provider, which the vertical declares. */
  moduleId: string | null;
  /** One sentence a reader can act on. */
  detail: string;
}

export interface FlowFindingsView {
  /**
   * False when the running version predates the declared-event surface (#1234) — the
   * manifest field ABSENT, which is the only thing that means this.
   *
   * An empty surface is `[]` and is available: "these modules declare no events" is a
   * fact the reader can act on, and conflating it with "pushed too long ago" cost the
   * provider findings too, which need no declared events at all. The CLI therefore
   * always sends the field, `[]` included, exactly as it always sends `outbound`.
   *
   * THE load-bearing flag: with no declarations there is nothing to compare, and a
   * view that rendered anyway would report the app as declaring nothing at all.
   *
   * Provider findings do not depend on it — `requires` has ridden the manifest
   * since #427 — but they are withheld too, because a card that renders half its
   * findings and silently omits the other half is worse than one that says why.
   */
  available: boolean;
  /**
   * False when the observed side was cut short — more distinct event types exist
   * than the facet returned.
   *
   * What it withholds is the ABSENCE findings only. A type missing from a truncated
   * result may never have been recorded or may have fallen off the tail, and nothing
   * here can tell which, so `unemitted` / `unconsumed` are not reported. A bucket the
   * facet DID return is not ambiguous — its count and its recency are real — so
   * staleness is still reported, as are the provider findings, which never depended
   * on the events at all.
   */
  observedComplete: boolean;
  /**
   * False when the DECLARED side was cut at the manifest's cap, so `declaredTypes` is a
   * sample rather than the whole surface.
   *
   * Findings still render — a declared type that was never observed is a genuine finding
   * whether or not other declarations were omitted — but the count line stops being a
   * completeness claim, because a view may not say it checked what it never saw.
   */
  declaredComplete: boolean;
  findings: FlowFinding[];
  /** Distinct declared event types checked, for the "N of M" line. */
  declaredTypes: number;
  /**
   * Distinct event types actually observed in the window.
   *
   * When `observedComplete` is false this is the number the facet RETURNED, not the
   * number the app recorded — there are more, and how many more is a fact nothing here
   * has. The copy has to say so rather than print it as a total.
   */
  observedTypes: number;
}

/** A connection as the findings need it: which provider, and whether it is usable. */
export interface ConnectionState {
  provider: string;
  /** `'active'` is the only usable one; `expired` / `revoked` / `error` are not. */
  status: string;
}

/**
 * Join what a version declares against what its scope has actually carried.
 *
 * `observedTypes` comes from faceting the outbox by `type` (#1239), which sees only
 * what is still IN the outbox — a window, not all of history. That is why a finding
 * says "not seen in this app's recorded events" rather than "never happened": the
 * spine is not pruned today, and nothing here should depend on that staying true.
 */
export function deriveFlowFindings(input: {
  /** Null = the running version predates the declared-event surface. */
  declaredEvents: DeclaredEventSurface[] | null;
  /** Capabilities the version requires (`manifest.requires`). */
  requires: readonly string[];
  /**
   * The provider slugs the dashboard actually knows how to connect. A `requires`
   * entry outside this set is NOT a provider — `oidc-issuer` is bound by the
   * platform at install, not from the Integrations tab — and reporting it as
   * unconnected would put a false finding on every app that declares one.
   */
  knownProviders: readonly string[];
  /**
   * What the scope's outbox actually carries: each type, and when it was last seen.
   *
   * Recency is the half a count cannot supply, and the finding #1234 asks for — "a
   * consumer that hasn't fired in 30 days" — is unreachable without it. A type with
   * a large count that stopped months ago is precisely the failure volume hides.
   */
  observed: readonly ObservedType[];
  /** Now, as the caller reads it — so staleness is judged against one instant. */
  now: string;
  /** How long without an event makes a declared type stale. */
  staleAfterDays: number;
  /** False when the facet was truncated, so absence from `observedTypes` proves nothing. */
  observedComplete: boolean;
  /** False when the manifest says its declared surface was cut at the cap. */
  declaredComplete: boolean;
  /** This app's provider connections, live and lapsed alike. */
  connections: readonly ConnectionState[];
}): FlowFindingsView {
  const {
    declaredEvents,
    requires,
    knownProviders,
    observed,
    now,
    staleAfterDays,
    observedComplete,
    declaredComplete,
    connections,
  } = input;
  if (declaredEvents === null) {
    return {
      available: false,
      observedComplete,
      declaredComplete,
      findings: [],
      declaredTypes: 0,
      observedTypes: new Set(observed.map((o) => o.type)).size,
    };
  }

  const seen = new Map(observed.map((o) => [o.type, o]));
  // One cutoff for the whole pass, from the caller's instant: deriving it per finding
  // would let two findings in the same render disagree about where the line is.
  const staleBefore = new Date(Date.parse(now) - staleAfterDays * 86_400_000).toISOString();
  const known = new Set(knownProviders);
  const findings: FlowFinding[] = [];

  // ABSENCE findings, one per declaration. Emits and consumes are kept apart because
  // they mean different things, and the star topology means the two are declared by
  // different modules that never import each other.
  const declaredTypes = new Set<string>();
  for (const d of declaredEvents) {
    declaredTypes.add(d.type);
    if (seen.has(d.type)) continue;
    // A type the facet did not return is ambiguous under truncation — never recorded,
    // or recorded and cut from the tail — so absence is reported only when the
    // observation was complete. Presence is not ambiguous, which is why the staleness
    // pass below is NOT gated the same way.
    if (!observedComplete) continue;
    findings.push(
      d.direction === 'emits'
        ? {
            kind: 'unemitted',
            subject: d.type,
            moduleId: d.moduleId,
            detail: `${d.moduleId} declares this event, and none has been recorded — a path that never runs, or one nobody has exercised yet.`,
          }
        : {
            kind: 'unconsumed',
            subject: d.type,
            moduleId: d.moduleId,
            detail: `${d.moduleId} handles this event, and nothing in this app has produced one — the handler has never had anything to do.`,
          },
    );
  }

  // STALENESS, one per TYPE — never per declaration, because the fact is not a
  // module's. The facet groups by event type alone, so its count and its recency
  // belong to the type across the whole scope; attributing them to a declaring module
  // would claim that module emitted every one of those events and the newest of them.
  // Two modules may declare the same type, and one module may declare it in BOTH
  // directions (`@test/flow` does), so per-declaration findings would also have said
  // the same thing two or three times under one identity.
  //
  // It is reported under a truncated observation, unlike the absences above: a bucket
  // the facet DID return carries a real count and a real timestamp, and withholding
  // that would be caution about a fact rather than about a gap.
  for (const type of [...declaredTypes].sort()) {
    const hit = seen.get(type);
    if (hit?.lastSeen == null || hit.lastSeen >= staleBefore) continue;
    const days = Math.floor((Date.parse(now) - Date.parse(hit.lastSeen)) / 86_400_000);
    const declarers = declaredEvents.filter((d) => d.type === type);
    const emitters = [...new Set(declarers.filter((d) => d.direction === 'emits').map((d) => d.moduleId))];
    const handlers = [...new Set(declarers.filter((d) => d.direction === 'consumes').map((d) => d.moduleId))];
    const by = [
      emitters.length > 0 ? `emitted by ${emitters.join(', ')}` : null,
      handlers.length > 0 ? `handled by ${handlers.join(', ')}` : null,
    ]
      .filter((x): x is string => x !== null)
      .join(' and ');
    findings.push({
      kind: 'stale',
      subject: type,
      // Null because the recency is not any one module's: the modules are named in the
      // sentence as DECLARERS, which is all the manifest actually says.
      moduleId: null,
      detail: `Last recorded ${days} days ago, after ${hit.count.toLocaleString()} in all — ${by}. It ran and stopped, which is a different thing from never having run.`,
    });
  }

  for (const provider of new Set(requires)) {
    if (!known.has(provider)) continue;
    const forProvider = connections.filter((c) => c.provider === provider);
    if (forProvider.length === 0) {
      findings.push({
        kind: 'unconnected-provider',
        subject: provider,
        moduleId: null,
        // Deliberately not "fails closed": a connector dispatch with no live
        // connection settles pending and retries, so connecting later heals every
        // queued delivery. Saying otherwise would send someone hunting a fault.
        detail: `This app is set up to use ${provider}, and nobody has connected it. Work that needs it waits rather than failing, and connecting it releases whatever has queued up.`,
      });
      continue;
    }
    if (forProvider.some((c) => c.status === 'active')) continue;
    // A connection that EXISTS and cannot be used is a different fix from one that
    // was never made: reconnect the one you have, rather than go looking for it.
    const statuses = [...new Set(forProvider.map((c) => c.status))].sort().join(', ');
    findings.push({
      kind: 'unhealthy-provider',
      subject: provider,
      moduleId: null,
      detail: `${provider} is connected but not usable (${statuses}). Reconnecting it releases whatever has queued up behind it.`,
    });
  }

  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));

  return {
    available: true,
    observedComplete,
    declaredComplete,
    findings,
    declaredTypes: declaredTypes.size,
    observedTypes: seen.size,
  };
}
