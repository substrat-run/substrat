import { upstreamReferenceMarker } from '@substrat-run/contracts';

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
