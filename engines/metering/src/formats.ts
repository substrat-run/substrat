/**
 * The value formats metering speaks, in the one place both ends can import.
 *
 * A leaf module on purpose: `index.ts` imports `operations.ts` (the declared
 * surface is what the module registration is built from), so `operations.ts`
 * cannot import back. Without a third file the two ends re-express the same
 * rules by hand, and they drifted exactly as you would expect — the declared
 * input accepted `"not-a-date"` and `"-"`, and the handler's own parse then
 * refused them. That is the failure the host's boundary parse exists to prevent:
 * an operation contract that says a value is valid, and a handler that disagrees
 * after the guards have run.
 *
 * The declared inputs and the in-scope functions therefore share the FORMAT and
 * differ only where they must — see `isoInstant` below.
 */
import { z } from '@substrat-run/contracts';

/**
 * UTC ISO-8601, at most millisecond precision.
 *
 * Mixed precision would break every string comparison in this engine
 * ('…T00:00:00Z' sorts AFTER '…T00:00:00.000Z'), which is what the normalisation
 * in `isoInstant` is for — and why the two forms exist rather than one.
 */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const INSTANT_MESSAGE = 'must be a UTC ISO-8601 instant (…Z)';

/**
 * What a CALLER may send — validating, never transforming.
 *
 * The declared surface uses this one. A transforming schema at the door would
 * hand the handler a value the in-scope function then re-parses, and a declared
 * input is meant to describe what may be sent rather than what will be stored.
 */
export const isoInstantIn = z.string().regex(ISO_INSTANT, INSTANT_MESSAGE);

/**
 * What gets STORED — the same format, normalised to millisecond precision.
 *
 * The transform is the storage decision, so it stays on the storage side; both
 * ends accept exactly the same set of strings.
 */
export const isoInstant = isoInstantIn.transform((s) => new Date(s).toISOString());

/** A non-negative decimal string — a gauge's level sample. Never a float (D-E). */
export const nonNegDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');

/**
 * A signed decimal string — a counter's delta, and the widest quantity any
 * operation accepts. The per-kind narrowing (a gauge refuses a negative) needs
 * to know the meter, so it stays in the handler; a declared input that claimed
 * it would read stricter than it is.
 */
export const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'must be a decimal');
