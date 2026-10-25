import { upstreamReferenceMarker, withUpstreamReference, type TenantId } from '@substrat-run/contracts';
import type { OpsFailureInput } from './scope-host.js';
import { ulid } from './ulid.js';

/**
 * #2540, #2554: one failure filed under a tenant whose text is not the tenant's to read, as the
 * input every writer hands `recordOpsFailure`: the API's routes, and the host-level writers below
 * it (a lifecycle delivery, the platform drain). The tenant's row says only `answered(reference)`;
 * the text goes to `detail`, which the host writes on a row with no tenant under the same
 * reference, the form staff's row always takes (`withUpstreamReference`). The reference is the
 * platform's own ulid unless the caller already minted one (a log line written under it first).
 * `raw` is the text as the failure gave it: never one already passed through
 * `withUpstreamReference`, which is not idempotent.
 */
export function withheldOpsFailure<E extends Omit<OpsFailureInput, 'actor' | 'message' | 'detail' | 'reference'> & { tenantId: TenantId }>(
  entry: E,
  raw: string,
  answered: (reference: string) => string,
  reference: string = ulid(),
): E & { message: string; detail: string; reference: string } {
  return { ...entry, reference, message: answered(reference), detail: withUpstreamReference(raw) };
}

/**
 * #2556: staff's row alone, for a failure whose text is withheld from a tenant that is told
 * nothing on the ledger (the drain journals the sentence and `reference` in the scope instead):
 * no tenant, `reference` the platform's, the text in the form staff's row of a pair takes.
 * `opening` is the platform's own words ahead of `raw`, after any upstream marker, which is read
 * from `raw` alone (`withUpstreamReference`).
 */
export function withheldStaffFailure<E extends Omit<OpsFailureInput, 'actor' | 'message' | 'detail' | 'reference' | 'tenantId'>>(
  entry: E,
  raw: string,
  reference: string,
  opening = '',
): E & { tenantId: null; message: string; reference: string } {
  return { ...entry, tenantId: null, reference, message: withUpstreamReference(raw, opening) };
}

/**
 * #2540: the `reference` narrowing of an ops-failure list, as SQL over `_substrat_ops_failures`,
 * the one both adapters run. Exact by default. With `inText` (staff's search), also both rows of
 * every pair whose row with no tenant begins with `reference` as its upstream handle
 * (`upstreamReferenceMarker`, written first so a bounded row keeps it). Only the start of the text
 * is read, so the marker's spelling anywhere else in a body never matches.
 */
export function opsFailureReferenceWhere(reference: string, inText: boolean): { sql: string; params: string[] } {
  if (!inText) return { sql: 'reference = ?', params: [reference] };
  return {
    sql:
      '(reference = ? OR reference IN (SELECT p.reference FROM _substrat_ops_failures p ' +
      'WHERE p.tenant_id IS NULL AND p.reference IS NOT NULL AND instr(p.message, ?) = 1))',
    params: [reference, upstreamReferenceMarker(reference)],
  };
}
