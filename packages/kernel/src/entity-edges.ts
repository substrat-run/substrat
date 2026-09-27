import {
  ENTITY_RELINKED,
  entityObjectRef,
  entityRelinkedPayload,
  substratError,
  type DomainEventInput,
  type EntityRef,
  type Instant,
} from '@substrat-run/contracts';
import type { OperationContext, ScopedSql } from './scope-host.js';

/**
 * `ctx.link` and `ctx.relink` (K-16, #1864), written once — both adapters hand the same
 * function the same five things, the way `createCapabilityVerbs` is shared.
 *
 * Neither verb checks a permission. The operation calling it already has (its first line),
 * and a move's authority is vocabulary only the vertical has — `folder:move` on the child,
 * `folder:write` on both parents — so the vertical checks child, `from` and `to` itself.
 * What the kernel holds is the SHAPE of the graph: a ref it can store, a declared relation,
 * an edge that actually exists, no cycle.
 */
export interface EntityEdgeDeps {
  /** RAW spine access inside the operation's own transaction — not the guarded `ctx.sql`. */
  sql: ScopedSql;
  /** child entity type → the parent types some registered module declared for it. */
  relations: ReadonlyMap<string, ReadonlySet<string>>;
  /** The operation's instant — what a tombstone is stamped with. */
  now: Instant;
  /** `ctx.emit` — stamps the actor, K-34 authorization and the operation. */
  emit: (event: DomainEventInput) => void;
  /** K-42's read-only refusal, for the effecting verbs. */
  assertWrites: (verb: string) => void;
}

export type EntityEdgeVerbs = Pick<OperationContext, 'link' | 'relink'>;

export function createEntityEdgeVerbs(deps: EntityEdgeDeps): EntityEdgeVerbs {
  const assertDeclared = (verb: string, child: EntityRef, parent: EntityRef) => {
    if (!deps.relations.get(child.entityType)?.has(parent.entityType)) {
      throw substratError(
        'validation_failed',
        `${verb}: undeclared entity relation: ${child.entityType} → ${parent.entityType} ` +
          `(declare it in a module manifest's entityRelations)`,
      );
    }
  };

  /**
   * Insert the edge, or REVIVE its tombstone. The primary key is (subject, relation,
   * object), so an edge `relink` moved away from is still a row — and `INSERT OR IGNORE`
   * would keep it dead while the caller was told it linked.
   */
  const writeEdge = (child: string, parent: string) => {
    deps.sql.exec(
      `INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, 'parent', ?)
       ON CONFLICT (subject, relation, object) DO UPDATE SET revoked_at = NULL
       WHERE revoked_at IS NOT NULL`,
      [child, parent],
    );
  };

  return {
    link(child, parent) {
      deps.assertWrites('ctx.link');
      const c = entityObjectRef(child, 'ctx.link'); // #1856: an edge the walk can read back
      const p = entityObjectRef(parent, 'ctx.link');
      assertDeclared('ctx.link', child, parent);
      writeEdge(c, p);
    },

    relink(child, from, to) {
      deps.assertWrites('ctx.relink');
      const c = entityObjectRef(child, 'ctx.relink');
      const f = entityObjectRef(from, 'ctx.relink');
      const t = entityObjectRef(to, 'ctx.relink');
      // `to` is held to link's rule, so a move can never put the child anywhere a link
      // could not. `from` is NOT held to it: the walk expands every live parent edge
      // whether or not its relation is still declared, so an edge that grants must stay
      // movable. What `from` must be is an edge that exists.
      assertDeclared('ctx.relink', child, to);
      // The walk's own `live` predicate (permission-eval.ts), as SQL — here and in the CTE.
      const live = deps.sql.query(
        `SELECT 1 AS live FROM _substrat_tuples
         WHERE subject = ? AND relation = 'parent' AND object = ?
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        [c, f, deps.now],
      );
      if (live.length === 0) {
        throw substratError(
          'conflict',
          `ctx.relink: ${f} is not a live parent of ${c} — there is no edge to move`,
        );
      }
      if (f === t) return; // already there: nothing written, nothing emitted
      // Refuse a move under the child itself or one of its descendants. The walk would
      // terminate (it is depth-capped), but the subtree would lose every ancestor above
      // it at once. UNION, not UNION ALL, so an already-cyclic graph still terminates.
      const cycle = deps.sql.query(
        `WITH RECURSIVE up(ref) AS (
           SELECT ?
           UNION
           SELECT e.object FROM _substrat_tuples e JOIN up ON e.subject = up.ref
           WHERE e.relation = 'parent' AND e.revoked_at IS NULL
             AND (e.expires_at IS NULL OR e.expires_at > ?)
         )
         SELECT 1 AS hit FROM up WHERE ref = ? LIMIT 1`,
        [t, deps.now, c],
      );
      if (cycle.length > 0) {
        throw substratError(
          'validation_failed',
          `ctx.relink: ${t} is ${c} or lies beneath it — the move would make ${c} its own ancestor`,
        );
      }
      // Tombstone (K-21), never DELETE: the old edge is evidence of why an access was once
      // allowed. The walk skips it from the next check on, in this same transaction.
      deps.sql.exec(
        `UPDATE _substrat_tuples SET revoked_at = ?
         WHERE subject = ? AND relation = 'parent' AND object = ? AND revoked_at IS NULL`,
        [deps.now, c, f],
      );
      writeEdge(c, t);
      deps.emit({
        type: ENTITY_RELINKED,
        schemaVersion: 1,
        entity: { entityType: child.entityType, entityId: child.entityId },
        piiClass: 'none',
        payload: entityRelinkedPayload.parse({ child, from, to }),
      });
    },
  };
}
