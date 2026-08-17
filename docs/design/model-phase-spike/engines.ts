/**
 * ROUND 2 — the cross-module checks.
 *
 * Round 1 conceded that CRM-EFF's checks 9–12 "need the composed engines'
 * manifests, and stay real work in any notation". That concession assumed the
 * SDL framing, where a schema file cannot import anything.
 *
 * An engine is an npm package. In TypeScript it can EXPORT its contract, and
 * the vertical's model IMPORTS it — so the cross-module checks become ordinary
 * type checking. This file is what an engine would export.
 *
 * It also builds #696's fix (typed event seam) and tests whether the exact
 * production bug — consuming `protocol.signed` and not `protocol.countersigned`
 * — can be made a compile error.
 */
import { z } from 'zod';

export interface EngineContract {
	readonly id: string;
	/** #696 item 1: the event map — event type → payload schema. */
	readonly events: Record<string, z.ZodType>;
	/** Named predicates this engine contributes, with their config shapes. */
	readonly predicates: Record<string, z.ZodType>;
	/** #696 item 3: entity-type constants, so `ref()` can be checked. */
	readonly entityTypes: readonly string[];
	/**
	 * Sets of events that report the SAME fact by different routes. A consumer
	 * that handles one must handle all — this is the shape of the Egeryds bug.
	 */
	readonly completionGroups?: Record<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// engine-protocol, as it actually emits today (engines/protocol/src/index.ts:1497-1556):
// both events are built from one shared `base`, so `complete` is on both — a
// fact a consumer can only learn today by reading engine source.
// ---------------------------------------------------------------------------

const signatureComplete = z.object({
	instanceId: z.string(),
	templateKey: z.string(),
	entity: z.object({ entityType: z.string(), entityId: z.string() }),
	contentHash: z.string(),
	signedAt: z.string(),
	/** False while other requested parties are still outstanding. */
	complete: z.boolean(),
});

export const protocolEngine = {
	id: '@substrat-run/engine-protocol',
	events: {
		'protocol.signed': signatureComplete,
		'protocol.countersigned': signatureComplete,
		'protocol.voided': z.object({ instanceId: z.string(), reason: z.string() }),
	},
	predicates: {
		'protocol/all-signed': z.object({ templateKey: z.string(), minSignatures: z.number() }),
	},
	entityTypes: ['protocol'],
	completionGroups: {
		/** Completion rides on whoever signs LAST — a countersignature completes
		 *  a two-party contract. Handling one and not the other is the bug. */
		signature: ['protocol.signed', 'protocol.countersigned'],
	},
} as const satisfies EngineContract;

export const workorderEngine = {
	id: '@substrat-run/engine-workorder',
	events: {
		'workorder.completed': z.object({ workorderId: z.string(), completedAt: z.string() }),
	},
	predicates: {},
	entityTypes: ['workorder', 'facility'],
} as const satisfies EngineContract;

// ---------------------------------------------------------------------------
// Type machinery over a tuple of engine contracts.
// ---------------------------------------------------------------------------

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export type EngineEvents<E extends readonly EngineContract[]> = UnionToIntersection<E[number]['events']>;
export type EventKey<E extends readonly EngineContract[]> = keyof EngineEvents<E> & string;
export type PayloadOf<E extends readonly EngineContract[], K extends EventKey<E>> =
	EngineEvents<E>[K] extends z.ZodType ? z.infer<EngineEvents<E>[K]> : never;

export type EnginePredicates<E extends readonly EngineContract[]> = UnionToIntersection<E[number]['predicates']>;
export type PredicateName<E extends readonly EngineContract[]> = keyof EnginePredicates<E> & string;
export type PredicateConfig<E extends readonly EngineContract[], P extends PredicateName<E>> =
	EnginePredicates<E>[P] extends z.ZodType ? z.infer<EnginePredicates<E>[P]> : never;

export type EngineEntityType<E extends readonly EngineContract[]> = E[number]['entityTypes'][number];

// ---------------------------------------------------------------------------
// Completion-group exhaustiveness — the #696 case.
//
// Given the set of event keys a vertical consumes, find any group where it
// handles some members but not all, and surface the MISSING ones.
// ---------------------------------------------------------------------------

type Groups<E extends readonly EngineContract[]> = UnionToIntersection<
	Extract<E[number], { completionGroups: Record<string, readonly string[]> }>['completionGroups']
>;

type MembersOf<G, Name extends keyof G> = G[Name] extends readonly (infer M)[] ? M & string : never;

/**
 * Every event that shares a completion group with something in `Handled`.
 * The `[…] extends [never]` bracketing is load-bearing — a naked `extends never`
 * distributes and silently yields `never` for every group.
 */
export type RequiredCompanions<E extends readonly EngineContract[], Handled extends string> = {
	[N in keyof Groups<E>]: [Extract<MembersOf<Groups<E>, N>, Handled>] extends [never]
		? never
		: MembersOf<Groups<E>, N>;
}[keyof Groups<E>];
