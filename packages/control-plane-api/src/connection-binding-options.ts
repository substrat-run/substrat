import { z } from '@substrat-run/contracts';

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
  switch (provider) {
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
