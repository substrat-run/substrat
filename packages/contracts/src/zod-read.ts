/**
 * Reading a Zod schema's shape back structurally — module-private to contracts, never exported
 * from the index. Shared by the model (`stamps`) and the derived-handler planners (#1773), which
 * both ask what a column or an input field IS underneath the wrappers that only change optionality.
 */

/**
 * A schema read structurally, through the wrappers that only change optionality: the zod def
 * underneath, and whether any wrapper on the way admits `null`.
 */
export function unwrapped(schema: unknown): { base: { type?: string } | undefined; nullable: boolean } {
  let current = schema;
  let nullable = false;
  for (let depth = 0; depth < 8; depth++) {
    const def = (current as { _zod?: { def?: unknown } })?._zod?.def as
      | { type?: string; innerType?: unknown }
      | undefined;
    if (!def) return { base: undefined, nullable };
    if (def.type === 'nullable' || def.type === 'nullish') nullable = true;
    else if (def.type !== 'optional' && def.type !== 'readonly') return { base: def, nullable };
    current = def.innerType;
  }
  return { base: undefined, nullable };
}

export const baseDefOf = (schema: unknown) => unwrapped(schema).base;
export const acceptsNull = (schema: unknown) => unwrapped(schema).nullable;
