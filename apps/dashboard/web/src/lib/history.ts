import type { Actor, EmittedEntity, EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';

/**
 * How a record's history reads on screen (#1235) — the presentation decisions of
 * `EntityTimeline`, pulled out so they can be asserted rather than eyeballed.
 *
 * Every function here exists because the value it formats is a UNION or a FACT
 * that a renderer flattens by accident: an actor that is not a person, and the
 * nullables `readHistory` deliberately keeps apart. Flattening any of them throws
 * away the reason `readHistory` exists.
 */

/**
 * Who acted, as text a person reads.
 *
 * `actor` is a union (`contracts/events.ts`): a principal id, `{ system }` when a
 * consumer emitted the event on no one's behalf, `{ connection }` when a
 * connector's callback did — a third member rather than a synthetic principal,
 * because "a connector that reads as a person in the audit trail is worse than
 * one that cannot act at all" (#97) — `{ capability }` when whoever held a
 * link did (#1672), and `{ vertical }` when another app of the tenant did (#1706),
 * for the same reason. Only the first member is a string, and
 * putting either object straight into JSX throws `Objects are not valid as a
 * React child`; the dashboard carries no error boundary, so that unmounts the
 * whole SPA on the first consumer-emitted event in a record's history. Formatting
 * it here is also what keeps a non-human actor legible AS non-human.
 */
export function actorLabel(actor: Actor): string {
  if (typeof actor === 'string') return actor;
  if ('system' in actor) return `system · ${actor.system}`;
  if ('capability' in actor) return `link · ${actor.capability}`;
  // #1706: another app of the same tenant, calling through the platform — never a person.
  if ('vertical' in actor) return `app · ${actor.vertical}`;
  return `connector · ${actor.connection}`;
}

/**
 * The staff member behind an impersonated action (K-42).
 *
 * The stamp is `{ session, by }` — `by` is the PLATFORM actor, a different brand
 * from the principal the action was taken as, which is the whole point: a history
 * strip that cannot show this shows a customer's own name against a change their
 * support engineer made (#1004). Null is not an absence, it is the ordinary case
 * — nobody was impersonating — so it renders nothing rather than "none".
 */
export function impersonationLabel(entry: Pick<HistoryEntry, 'actor' | 'impersonation'>): string | null {
  return entry.impersonation === null ? null : `as ${actorLabel(entry.actor)} · by ${entry.impersonation.by}`;
}

/**
 * What authorized the mutation (K-34). Three answers, and collapsing any pair of
 * them is a lie: null is the row predating the platform recording it, `[]` is an
 * operation that genuinely checked nothing, and entries are the permissions it
 * checked and passed. Keeping the first two apart is why the column is nullable
 * in the DDL at all.
 *
 * An entry is `{ permission, grant? }`, and the optional half is a fourth
 * distinction inside the third answer (#1398): `grant` is present exactly when
 * the allow resolved through a `granted:<perm>` tuple rather than a role bundle,
 * and it names WHICH grant (`workorder:01J…`, `scope:01J…`). Dropping it makes a
 * check that passed because somebody shared one record read identically to one
 * that passed because the actor holds a role — on the screen whose whole pitch is
 * "under what authority". Absent `grant` already means "by a role", so the
 * wording for that case is unchanged and the distinction costs nothing.
 */
export function authorizationLabel(authorization: HistoryEntry['authorization']): string {
  if (authorization === null) return 'authorization unrecorded';
  if (authorization.length === 0) return 'no permission checked';
  return authorization.map((a) => (a.grant ? `${a.permission} via grant ${a.grant}` : a.permission)).join(', ');
}

/**
 * The payload, or the fact that it no longer has one. A shred nulls the payload
 * and keeps the row (§5.3: "pseudonymous keys and transaction facts remain"), so
 * an erasure is a supported result and not an error — rendering it blank would
 * read as an event that said nothing, which is a different claim.
 */
export function payloadText(payload: unknown): string {
  return payload == null ? 'payload erased' : JSON.stringify(payload);
}

/**
 * The operation the event was emitted from (#1231). This null honestly carries
 * BOTH meanings the two above keep apart — a consumer ran on behalf of no
 * operation, and a row written before the column is unrecorded — and the spine
 * cannot tell them apart after the fact, so neither does the copy.
 */
export function operationLabel(operation: string | null): string {
  return operation ?? 'no operation — a consumer, or unrecorded';
}

/**
 * Why the "Same call" control is open or shut (#1237).
 *
 * One string for both `title` and `aria-description`, because the control is
 * `aria-disabled` rather than `disabled` and therefore stays focusable: the sighted
 * reader gets the greyed styling and the tooltip, and a screen-reader user gets the
 * same sentence from the same source. A null id is a FACT — a seed or internal call
 * carried none, or the event predates the column — so the shut state says that rather
 * than reading as a broken button.
 */
export function callButtonTitle(invocationId: string | null): string {
  return invocationId === null
    ? 'no call was recorded for this event — a seed or internal call, or an event from before calls were recorded'
    : 'everything else the same request recorded, including events with no causal link to this one';
}

/**
 * The tooltip for "Logs for this call" (#1525) — the log-side twin of `callButtonTitle`,
 * for the same reason: the control stays focusable when it is shut, so the sentence that
 * says why has to exist for the shut state as well as the open one.
 */
export function callLogsButtonTitle(invocationId: string | null): string {
  return invocationId === null
    ? 'no call was recorded for this event, so there is no request to find log lines for'
    : 'the log lines this app wrote while serving the same request — including its own console output';
}

/** Either side of the event, in minutes: how far from `occurredAt` the call's lines are looked for. */
export const CALL_LOGS_MARGIN_MINUTES = 10;

/**
 * The window a call's log lines are read in, from the moment one of its events was
 * recorded (#1525).
 *
 * The log read takes a window, not just an id, and "the last 24 hours" is the wrong one
 * to hand it: an event from three days ago would find nothing and read as "this call
 * logged nothing". The event's own instant is the anchor — the call that emitted it ran
 * within moments of it — so the read is bracketed around that, wide enough for a slow
 * request and narrow enough to stay inside the plane's 72-hour ceiling however old the
 * event is.
 *
 * `until` is clamped to `now` (the plane refuses a window that ends in the future by more
 * than five minutes, and a fresh event's margin would otherwise overshoot it), and the
 * pair is returned as ISO 8601 text, the way the plane takes it. Null for an instant that
 * does not parse, so a caller shows "no window" rather than sending `NaN` on the wire.
 */
export function callLogsWindow(
  occurredAt: string,
  now: number = Date.now(),
): { since: string; until: string } | null {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return null;
  const margin = CALL_LOGS_MARGIN_MINUTES * 60_000;
  const until = Math.min(at + margin, now);
  // The window must have a positive width: an event stamped ahead of `now` (skew between
  // the browser's clock and the platform's) with a small margin could otherwise hand the
  // plane a `since` at or after `until`, which it refuses as a 400.
  const since = Math.min(at - margin, until - 1_000);
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/**
 * One call a dead-lettered delivery can be followed into (#1525).
 *
 * `kind` is what a reader needs to tell two ids apart, not decoration: the call that
 * EMITTED the event and the call that ATTEMPTED the delivery are routinely different for
 * an executor (attempt one runs in the emitting call's tail, every retry in a drain), so
 * a bare "call" would send someone to the wrong request and let them conclude it was the
 * culprit.
 */
export interface DeadLetterCall {
  readonly kind: 'attempt' | 'emitted';
  readonly invocationId: string;
  /** The control's label. */
  readonly label: string;
  /** What it opens, in a sentence — the tooltip. */
  readonly title: string;
}

/**
 * The calls a dead letter can be followed into — none, one, or two.
 *
 * A null id yields NO entry rather than a disabled one: on this list null is common (a
 * drain or alarm carries no call, and every row from before the columns existed has
 * none), so a greyed control on most rows would read as a fault to be fixed. Absence is
 * the honest rendering, and the row's own text says nothing about a call at all.
 *
 * The attempt call comes first because it is the one that gave up. The emitting call is
 * listed only when it is a DIFFERENT call: for an in-scope consumer the two agree, and
 * two controls opening the same list would suggest there were two calls to look at.
 */
export function deadLetterCalls(d: {
  readonly invocationId: string | null;
  readonly attemptInvocationId: string | null;
}): DeadLetterCall[] {
  const calls: DeadLetterCall[] = [];
  if (d.attemptInvocationId !== null) {
    calls.push({
      kind: 'attempt',
      invocationId: d.attemptInvocationId,
      label: 'Attempt call',
      title: 'the call the last attempt ran in, the one that gave up — with everything else that call recorded',
    });
  }
  if (d.invocationId !== null && d.invocationId !== d.attemptInvocationId) {
    calls.push({
      kind: 'emitted',
      invocationId: d.invocationId,
      label: 'Emitting call',
      title: 'the call that emitted this event — usually not the one that attempted the delivery',
    });
  }
  return calls;
}

/** Which cell in a browsed table opens that record's story. */
export interface TimelineTarget {
  /** The entity type a history read is keyed by — the model's own name for it. */
  readonly entityType: string;
  /** The column holding the id to read it with. */
  readonly idColumn: string;
  /**
   * The payload key the entity's declared lifecycle moves (#1767), when it declares one —
   * what lets the Event history tell a transition from any other change without guessing.
   */
  readonly stateField?: string;
}

/**
 * The way INTO a record's story (#1398), read off the emitted model rather than
 * guessed from column names.
 *
 * The first cut made a cell clickable when the column was literally called `id`,
 * which is the default identity and not the declared one: `primaryKey` is right
 * there in the same `entities` map the table→entity mapping already comes from,
 * and an entity keyed on anything else silently got no way into its own history.
 * Absence of `primaryKey` in the artifact is not missing data — `emitModel` omits
 * it exactly when it is the `['id']` default — so it resolves to `id` here for
 * the same reason `primaryKeyOf` does.
 *
 * A **composite** key yields no target at all. A history read addresses one
 * `EntityRef`, so a multi-column identity has no single cell that names the
 * record — which is the same fact `PointableName` encodes in the type system.
 * Offering the affordance on one of its columns would answer "nothing ever
 * happened" about a record that has a history, and a missing link is the better
 * failure of the two.
 */
export function timelineTargets(
  entities: Record<string, EmittedEntity>,
  lifecycles?: Record<string, EmittedLifecycle>,
): Record<string, TimelineTarget> {
  const byTable: Record<string, TimelineTarget> = {};
  for (const [entityType, def] of Object.entries(entities)) {
    const table = (def as { table?: string }).table;
    if (!table) continue;
    const key = def.primaryKey?.length ? def.primaryKey : ['id'];
    if (key.length !== 1) continue;
    const stateField = lifecycles?.[entityType]?.field;
    byTable[table] = stateField ? { entityType, idColumn: key[0]!, stateField } : { entityType, idColumn: key[0]! };
  }
  return byTable;
}
