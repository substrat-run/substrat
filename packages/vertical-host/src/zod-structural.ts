/**
 * Reading a Zod schema STRUCTURALLY — never `instanceof`, which fails across duplicate
 * copies of the library. Shared by the query coercion and pinned fields in
 * `operations-routes.ts` and the field walk in `field-coverage.ts`, so the set of wrappers
 * they look through is one list.
 */

/** Zod's internal definition, across the layouts read here. */
export interface ZodDef {
  readonly type?: string;
  readonly values?: unknown[];
  readonly value?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly shape?: unknown;
  readonly element?: unknown;
}

export function defOf(schema: unknown): ZodDef | undefined {
  return ((schema as { _zod?: { def?: unknown } })?._zod?.def ??
    (schema as { _def?: unknown })?._def) as ZodDef | undefined;
}

/**
 * The schema a wrapper that does not change the type wraps — `optional`, `nullable`,
 * `default`, `catch`, `readonly` and the like, and a pipe's input side (what a caller
 * sends, and what a handler returns) — or `undefined` when `def` is not one.
 */
export function transparentInner(def: ZodDef | undefined): unknown {
  switch (def?.type) {
    case 'optional':
    case 'nullable':
    case 'nullish':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return def.innerType;
    case 'pipe':
      return def.in;
    default:
      return undefined;
  }
}
