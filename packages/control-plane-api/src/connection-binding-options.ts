import { isVerticalConnectorProvider, z } from '@substrat-run/contracts';

/**
 * The options a poll connector's scope binding takes, by provider, without the operation and key
 * every binding names (#2317, #2316). One schema for both doors that bind: the staff route, which
 * extends it with `operation` and `permission`, and the connector pass, which validates a
 * vertical's declared `connections[].options` with it before binding. A declaration the staff door
 * would refuse is therefore refused the same way, and reported on the connection's sweep row.
 *
 * Strict: an option a provider does not take is an error, not silently dropped, so a declaration
 * with a typo'd key does not bind with a default the vertical never meant.
 */
export function connectionBindingOptions(provider: string) {
  // A vertical-defined provider's options are its own connector's to validate, at bind
  // (vertical-connectors.md §6.1); the stored binding bounds their count.
  if (isVerticalConnectorProvider(provider)) return z.object({}).catchall(z.unknown());
  switch (provider) {
    case 'fortnox':
      return z
        .object({
          kind: z.enum(['ledger', 'supplier-invoice']).optional(),
          // A ledger binding's form: the monthly sums, or the whole SIE file.
          form: z.enum(['summary', 'sie']).optional(),
          // How many years before the current one a `form: 'sie'` binding keeps.
          years: z.union([z.literal('all'), z.number().int().min(0).max(100)]).optional(),
          // How far back a supplier-invoice binding's first pass reads: days, or every invoice.
          // A changed value re-binds, and a re-bound landing starts its first pass again.
          firstPass: z.union([z.literal('all'), z.number().int().positive().max(36_500)]).optional(),
          // The vertical's two operations behind writing back to Fortnox. Absent, nothing is written.
          writeback: z
            .object({ read: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/), record: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/) })
            .strict()
            .optional(),
        })
        .strict();
    case 'planima':
      return z
        .object({
          organizationId: z.number().int().positive().nullable().optional(),
          currency: z.string().regex(/^[A-Z]{3}$/).optional(),
          window: z
            .object({ fromYear: z.number().int(), toYear: z.number().int() })
            .refine((w) => w.toYear >= w.fromYear, 'window ends before it starts')
            .nullable()
            .optional(),
          horizonYears: z.number().int().min(0).optional(),
        })
        .strict();
    case 'microsoft365':
      // #2101: the channel folder, by its drive path. The connector resolves it and holds the
      // fence to it; this only bounds the input.
      return z.object({ folder: z.string().trim().min(1).max(400) }).strict();
    default:
      return z.object({}).strict();
  }
}

/**
 * Why a combination of options {@link connectionBindingOptions} admits field by field cannot bind,
 * or `undefined`. Every door asks it after the schema, so a staff PUT answers it as a refusal
 * rather than the connector's throw inside the write, and a declaration is reported on the sweep
 * row before anything is granted. Kept apart from the schema because the doors `extend` and
 * `strip` it, which a refinement would not survive.
 */
export function bindingOptionsRefusal(provider: string, options: { kind?: string | null; form?: string | null; years?: unknown; firstPass?: unknown; writeback?: unknown }): string | undefined {
  if (provider !== 'fortnox') return undefined;
  if (options.form != null && (options.kind ?? 'ledger') !== 'ledger') return `form applies to a ledger binding, not to '${options.kind}'`;
  if (options.years != null && options.form !== 'sie') return "years applies to a binding with form 'sie': the summary form lands the current year";
  if (options.firstPass != null && options.kind !== 'supplier-invoice') return `firstPass applies to a supplier-invoice binding, not to '${options.kind ?? 'ledger'}'`;
  if (options.writeback != null && options.kind !== 'supplier-invoice') return `writeback applies to a supplier-invoice binding, not to '${options.kind ?? 'ledger'}'`;
  return undefined;
}

/** Whether {@link bindingChangeRefusal} can refuse anything for `provider`, so a door reads the held binding only then. */
export const refusesBindingChange = (provider: string): boolean => provider === 'fortnox';

/**
 * Why a scope's held binding cannot take `next` in place, or `undefined` (#2704). Both doors that
 * bind ask it before writing: the staff route answers it as a 409, and the connector pass reports
 * it on the connection's sweep row. Fortnox lands one kind per scope, so a kind change is refused
 * rather than rewriting what the scope's data was landed as.
 */
export function bindingChangeRefusal(provider: string, held: { kind?: string | null } | undefined, next: { kind?: string | null }): string | undefined {
  if (!refusesBindingChange(provider) || !held) return undefined;
  const from = held.kind ?? 'ledger';
  const to = next.kind ?? 'ledger';
  return from === to ? undefined : `one Fortnox landing kind per scope; use a separate scope for the other kind (${from} to ${to})`;
}
