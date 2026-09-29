/**
 * What a routed request did, as the ROUTER meters it (#1904).
 *
 * The router writes one Analytics Engine datapoint per resolved request, and the request
 * histogram and facet counts are read from that dataset. The router knows the tenant, scope,
 * surface and status on its own. It does not know which operation ran, how it failed, or who
 * it ran as: only the vertical's handler chain learns those, into the kernel's
 * `InvocationRecord`. The platform's entry (`withInvocationLog`) hands them back on one
 * response header, and the router reads it into the datapoint and strips it before the
 * response leaves.
 *
 * Shared vocabulary rather than kernel code, because the router does not depend on the
 * kernel and both ends must agree on the name and the encoding.
 *
 * ## What the header is trusted with
 *
 * Only a vertical's description of its OWN request. The datapoint's index is the tenant the
 * router resolved, never anything the response says, so the most a vertical can do with this
 * header is mislabel its own operations in its own counts. It is written only on a request the
 * router vouched for, so a direct caller never sees it either.
 */

/** The response header carrying a request's record from the vertical to the router. */
export const INVOCATION_RECORD_HEADER = 'x-substrat-invocation-record';

/** The fields the header carries. Every one is optional: a request may reach no operation. */
export interface InvocationRecordFields {
  operation?: string | null | undefined;
  problemCode?: string | null | undefined;
  principalKind?: string | null | undefined;
}

/** The longest value kept per field — an operation name, an error code, a subject kind. */
export const INVOCATION_RECORD_FIELD_MAX = 128;

const FIELDS = ['operation', 'problemCode', 'principalKind'] as const;

/**
 * The header value for a record, or `null` when it names nothing. URL-encoded, so any
 * operation name survives a header, which must be Latin-1.
 */
export function encodeInvocationRecord(record: InvocationRecordFields): string | null {
  const params = new URLSearchParams();
  for (const key of FIELDS) {
    const v = record[key];
    if (typeof v === 'string' && v !== '') params.set(key, v.slice(0, INVOCATION_RECORD_FIELD_MAX));
  }
  const value = params.toString();
  return value === '' ? null : value;
}

/**
 * A header value read back. Never throws: a malformed value is an empty record, since the
 * reader meters a request and must not fail it. Unknown keys are ignored and every value is
 * capped, so a vertical cannot grow the router's datapoint.
 */
export function decodeInvocationRecord(value: string | null | undefined): {
  operation: string | null;
  problemCode: string | null;
  principalKind: string | null;
} {
  const out = { operation: null as string | null, problemCode: null as string | null, principalKind: null as string | null };
  if (!value) return out;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(value);
  } catch {
    return out;
  }
  for (const key of FIELDS) {
    const v = params.get(key);
    if (v !== null && v !== '') out[key] = v.slice(0, INVOCATION_RECORD_FIELD_MAX);
  }
  return out;
}

/** The level a request is filed under (#1746). See {@link invocationLevelOf}. */
export type InvocationLevel = 'error' | 'warn' | 'info';

/**
 * The level of an invocation, from how it ended.
 *
 * A stamped line is pure JSON, so the log platform sets no level on it (the reader's
 * comments in `cf-observability.ts` found this out the hard way). The level histogram
 * still needs one per request, so the line carries its own: a 5xx or an escaped throw is
 * an error, a 4xx is a warning (the request was refused, which the caller may need to
 * hear about, and nothing broke), a success carrying a problem code is a warning too, and
 * anything else is info.
 *
 * Here rather than in the kernel since #1904: the router files its datapoint under the same
 * level, and the two must agree.
 */
export function invocationLevelOf(
  status: number | null,
  threw: boolean,
  problemCode?: string | null,
): InvocationLevel {
  if (threw || status === null || status >= 500) return 'error';
  if (status >= 400) return 'warn';
  // A failure answered IN-BAND — an MCP tool error is a 200 carrying `isError` — is still
  // a refused call, and filing it as info would hide it from the one filter that looks.
  if (problemCode) return 'warn';
  return 'info';
}
