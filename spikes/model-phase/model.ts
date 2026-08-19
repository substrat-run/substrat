/**
 * SPIKE — can a typed TS model make CRM-EFF's reference-integrity checks
 * compile errors instead of a bespoke validator?
 *
 * Target: the checks their `validate` enumerates that are pure reference
 * integrity. Numbering follows sdl/README.md "What validate must check".
 *
 *   1  @relation(parent:)      names a declared entity
 *   2  @entity(key:)           names fields that exist on the type
 *   3  @emits(entity:)         names a declared entity
 *   4  @projected(by:)         resolves to a declared operation
 *   6  entityIdFrom            names a real field of the operation's OUTPUT
 *   7  @schedule               names a declared operation
 *   8  @effect(enabledBy:)     names a declared env key
 *  18  {var} in @http(path:)   names a real input field
 *  21  @outbound(hosts:)      ⊇ every @effect(host:)
 *  22  every env key read      is declared
 *
 * Nothing here is proposed as final API. The question is only whether the
 * TYPE SYSTEM can carry these, and at what ergonomic cost.
 */
import { z } from 'zod';
import type {
	EngineContract,
	EventKey,
	PayloadOf,
	PredicateName,
	PredicateConfig,
	RequiredCompanions,
} from './engines.js';

// ---------------------------------------------------------------------------
// Path parameters — check 18. Extract {var} names from a literal path type.
// ---------------------------------------------------------------------------

type PathParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
	? P | PathParams<Rest>
	: never;

// ---------------------------------------------------------------------------
// Entities — checks 1 and 2.
//
// The self-referential constraint is the load-bearing trick: the entity map's
// own keys are available to constrain `parent`, inside the same literal.
// ---------------------------------------------------------------------------

interface EntityDef<Names extends string> {
	readonly table: string;
	readonly fields: z.ZodObject<z.ZodRawShape>;
	/** check 1 — must name a declared entity */
	readonly parent?: Names;
	/** check 2 — must name fields that exist on `fields` */
	readonly key?: readonly string[];
	/** ROUND 4 — §12: fields an erasure must be able to reach. */
	readonly erasable?: readonly string[];
	/**
	 * ROUND 3, and the clearest LIMIT the spike found. CRM-EFF's check 5 is
	 * "@renamedFrom(name:) exists in the previous journal AND NOT in the current
	 * schema". Neither half is a type:
	 *
	 *   - "exists in the previous journal" needs HISTORY, which the type system
	 *     cannot see — it knows one version of the model.
	 *   - "not in the current schema" is a NEGATIVE constraint. TypeScript has
	 *     no way to say "any string except these"; `Exclude<string, 'a'>` is
	 *     still `string`.
	 *
	 * What IS free is the positive neighbour: `to` must name a field that
	 * really exists now. So the shape is chosen to make the checkable half
	 * checkable, and both halves of check 5 stay in the emitter against
	 * journal.json.
	 */
	readonly renamedFrom?: readonly { readonly to: string; readonly from: string }[];
}

type EntityFields<E> = E extends { fields: infer F }
	? F extends z.ZodObject<z.ZodRawShape>
		? keyof z.infer<F> & string
		: never
	: never;

/**
 * Two constraints at once: `parent` against the map's own keys, and `key`
 * against each entity's own field names. The mapped type is what lets check 2
 * be per-entity rather than a union across all of them.
 */
export function defineEntities<
	T extends {
		readonly [K in keyof T]: EntityDef<keyof T & string> & {
			key?: readonly EntityFields<T[K]>[];
			erasable?: readonly EntityFields<T[K]>[];
			/** the NEW name must be a real current field; `from` cannot be checked */
			renamedFrom?: readonly { to: EntityFields<T[K]>; from: string }[];
		};
	},
>(entities: T): T {
	return entities;
}

// ---------------------------------------------------------------------------
// Env — checks 8 and 22.
// ---------------------------------------------------------------------------

interface EnvVar {
	readonly description: string;
	readonly secret?: boolean;
	readonly default?: string;
}

export function defineEnv<T extends Record<string, EnvVar>>(env: T): T {
	return env;
}

// ---------------------------------------------------------------------------
// Operations — checks 3, 6, 18, 21.
// ---------------------------------------------------------------------------

/** The op's own declared input/output keys, read back off itself. */
type InputKeys<O> = O extends { input: infer I }
	? I extends z.ZodType
		? keyof z.infer<I> & string
		: never
	: never;

type OutputKeys<O> = O extends { output: infer Out }
	? Out extends z.ZodType
		? keyof z.infer<Out> & string
		: never
	: never;

/** check 18 — every {var} in the path must name an input field, or the path type collapses. */
type CheckedPath<O> = O extends { http: { path: infer P } }
	? P extends string
		? [PathParams<P>] extends [InputKeys<O>]
			? P
			: never
		: never
	: string;

/**
 * The per-operation constraint. Self-referential in `O`: each operation is
 * checked against ITS OWN declared input and output, not against an erased
 * supertype. This is the difference between the checks biting and not.
 */
/**
 * ROUND 4 — the erasable set OF THE ENTITY THIS EVENT IS ABOUT.
 *
 * CRM-EFF's validator matches the field NAME across all entities and says so:
 * "a different `email` that is not erasable would be refused too. Sound in the
 * safe direction, but crude." Resolving through `emits.entity` makes it exact.
 */
type ErasableOf<Entities, O> = O extends { emits: { entity: infer EN } }
	? EN extends keyof Entities
		? Entities[EN] extends { erasable: readonly (infer F)[] }
			? F & string
			: never
		: never
	: never;

/**
 * ROUND 4 — the platform's own event invariant, as a type. `contracts/events.ts`
 * enforces "subjectId is required when piiClass is not 'none'" with a Zod
 * superRefine, at runtime. This is the same rule at compile time.
 */
type PiiShape<O, OutKeys extends string> = O extends { emits: { piiClass: 'none' } }
	? { readonly piiClass: 'none'; readonly subjectId?: never }
	: { readonly piiClass: 'pseudonymous' | 'direct'; readonly subjectId: OutKeys };

type OperationShape<
	O,
	Entities,
	EntityName extends string,
	EnvKey extends string,
	Host extends string,
	PermKey extends string,
> = {
	readonly input: z.ZodObject<z.ZodRawShape>;
	/** Declared, not inferred — #695 Ask 2, and what check 6 needs to bite. */
	readonly output: z.ZodType;
	readonly http?: {
		readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
		readonly path: CheckedPath<O>;
	};
	readonly emits?: {
		/** check 3 — must name a declared entity */
		readonly entity: EntityName;
		/**
		 * check 6 — must name a field of the OUTPUT.
		 * This is the one that would have caught #695's 18 broken events.
		 */
		readonly entityIdFrom: OutputKeys<O>;
		readonly type: string;
		/**
		 * check 15 — the check the whole PII posture rests on. A payload field
		 * may be any OUTPUT field EXCEPT one marked erasable on the entity the
		 * event is about. `Exclude` over a finite union of literals works; this
		 * is why §3.3's "negative constraints do not exist" is about `string`,
		 * not about closed sets.
		 */
		readonly payload?: readonly Exclude<OutputKeys<O>, ErasableOf<Entities, O>>[];
	} & PiiShape<O, OutputKeys<O>>;
	readonly effect?: {
		/** check 8 — must name a declared env key */
		readonly enabledBy: EnvKey;
		/** check 21 — must be a declared outbound host */
		readonly host: Host;
	};
	/**
	 * ROUND 3 — `@gate`: per-field permission on the projection. Keys must be
	 * fields of the OUTPUT; values must be declared permissions. Omission, not
	 * denial: the impl still returns the whole object, the projection strips.
	 */
	readonly gates?: { readonly [F in OutputKeys<O>]?: PermKey };
} & OpAuthority<O, PermKey>;

/**
 * ROUND 3 — check 14, one of the "semantic rules" I claimed needed real logic
 * in any notation. It is a discriminated union: an operation carries a leading
 * `permission`, OR `@narrows` with a reason (the per-row proof walk), never
 * both and never neither.
 */
type OpAuthority<O, PermKey extends string> = O extends { narrows: unknown }
	? { readonly narrows: { readonly reason: string }; readonly permission?: never }
	: { readonly permission: PermKey; readonly narrows?: never };

// ---------------------------------------------------------------------------
// The model — checks 4 and 7 close over the operation names.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ROUND 2 — cross-module. Engines are npm packages, so their contracts IMPORT.
// ---------------------------------------------------------------------------

/** check 10 — the guard's config must match the shape the predicate's engine declares. */
type GuardShape<G, OpName extends string, E extends readonly EngineContract[]> = {
	readonly before: OpName;
	readonly predicate: PredicateName<E>;
	readonly config: G extends { predicate: infer P }
		? P extends PredicateName<E>
			? PredicateConfig<E, P>
			: never
		: never;
};

/** Events sharing a completion group with something already handled, minus what is handled. */
type MissingCompanions<E extends readonly EngineContract[], Handled extends string> = Exclude<
	RequiredCompanions<E, Handled>,
	Handled
>;

/**
 * #696, as a type. Collapses to `unknown` when every completion group is fully
 * handled; otherwise DEMANDS the missing members, so the error names them.
 */
type ConsumerCompleteness<E extends readonly EngineContract[], Handled extends string> = [
	MissingCompanions<E, Handled>,
] extends [never]
	? unknown
	: { readonly [M in MissingCompanions<E, Handled>]: (payload: never) => Promise<void> };

interface ModelInput<
	Entities extends Record<string, EntityDef<string>>,
	Env extends Record<string, EnvVar>,
	Hosts extends readonly string[],
	Ops,
	Perms extends readonly string[],
	E extends readonly EngineContract[],
	Consumers,
	Guards,
> {
	readonly entities: Entities;
	readonly env: Env;
	/** check 21's left side */
	readonly outbound: Hosts;
	/** ROUND 3 — the declared permission keys operations and gates must name. */
	readonly permissions: Perms;
	readonly operations: Ops;
	/** The engines this vertical composes — their contracts, imported. */
	readonly engines?: E;
	/**
	 * check 9 — an unknown event key is an excess property; the payload is typed;
	 * and a half-handled completion group is a missing-property error (#696).
	 *
	 * The mapped type is written over `EventKey<E>` rather than over `Consumers`
	 * on purpose: a callback parameter cannot be contextually typed by a generic
	 * being inferred from the very object that contains it. `Consumers` carries
	 * only the KEYS, for the completeness check.
	 */
	readonly consumers?: Consumers & {
		readonly [K in EventKey<E>]?: (payload: PayloadOf<E, K>) => Promise<void>;
	} & ConsumerCompleteness<E, keyof Consumers & string>;
	/** check 10 — predicate name and its config shape, both from the engine. */
	readonly guards?: Guards;
	/** check 7 — must name a declared operation */
	readonly schedules?: readonly { readonly operation: keyof Ops & string; readonly everyMinutes: number }[];
	/** check 4 — must name a declared operation */
	readonly projections?: readonly { readonly entity: keyof Entities & string; readonly by: keyof Ops & string }[];
}

export function defineModel<
	const Entities extends Record<string, EntityDef<string>>,
	const Env extends Record<string, EnvVar>,
	const Hosts extends readonly string[],
	const Perms extends readonly string[],
	const Ops extends {
		readonly [K in keyof Ops]: OperationShape<
			Ops[K],
			Entities,
			keyof Entities & string,
			keyof Env & string,
			Hosts[number],
			Perms[number]
		>;
	},
	const E extends readonly EngineContract[] = [],
	/**
	 * Self-referential again: a key that is not an engine event type gets value
	 * type `never`, so a handler assigned to it fails. `Partial<Record<…>>` was
	 * NOT enough — an all-optional record is structurally satisfied by an object
	 * carrying extra keys, so an unknown event type passed silently.
	 */
	const Consumers extends {
		readonly [K in keyof Consumers]: K extends EventKey<E> ? unknown : never;
	} = Record<never, never>,
	const Guards extends {
		readonly [I in keyof Guards]: GuardShape<Guards[I], keyof Ops & string, E>;
	} = [],
>(
	model: ModelInput<Entities, Env, Hosts, Ops, Perms, E, Consumers, Guards>,
): ModelInput<Entities, Env, Hosts, Ops, Perms, E, Consumers, Guards> {
	return model;
}

// ---------------------------------------------------------------------------
// Emitted-tier proof: the Impl interface CRM-EFF derives, as a type.
// This is what `satisfies Impl` in the hand-written impl would check against.
// ---------------------------------------------------------------------------

export type Impl<M> = M extends { operations: infer Ops }
	? {
			[K in keyof Ops]: Ops[K] extends { input: infer I; output: infer O }
				? I extends z.ZodType
					? O extends z.ZodType
						? (input: z.infer<I>) => Promise<z.infer<O>>
						: never
					: never
				: never;
		}
	: never;
