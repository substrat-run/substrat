import type { Actor, EmittedEntity, HistoryEntry } from '@substrat-run/contracts';

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
 * one that cannot act at all" (#97). Only the first member is a string, and
 * putting either object straight into JSX throws `Objects are not valid as a
 * React child`; the dashboard carries no error boundary, so that unmounts the
 * whole SPA on the first consumer-emitted event in a record's history. Formatting
 * it here is also what keeps a non-human actor legible AS non-human.
 */
export function actorLabel(actor: Actor): string {
  if (typeof actor === 'string') return actor;
  if ('system' in actor) return `system · ${actor.system}`;
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

/** Which cell in a browsed table opens that record's story. */
export interface TimelineTarget {
  /** The entity type a history read is keyed by — the model's own name for it. */
  readonly entityType: string;
  /** The column holding the id to read it with. */
  readonly idColumn: string;
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
export function timelineTargets(entities: Record<string, EmittedEntity>): Record<string, TimelineTarget> {
  const byTable: Record<string, TimelineTarget> = {};
  for (const [entityType, def] of Object.entries(entities)) {
    const table = (def as { table?: string }).table;
    if (!table) continue;
    const key = def.primaryKey?.length ? def.primaryKey : ['id'];
    if (key.length !== 1) continue;
    byTable[table] = { entityType, idColumn: key[0]! };
  }
  return byTable;
}
