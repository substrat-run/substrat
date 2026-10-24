/**
 * #2540: an upstream trace handle on a withheld failure. A tenant-readable row and answer carry
 * only the platform's own reference; the upstream's (Cloudflare's `reference = <id>`) is kept in
 * the text of the row with no tenant, which only staff read, in this exact form, so a staff search
 * by either id lands on the pair (`OpsFailureFilter.referenceInText`). Bracketed, so one id is
 * never found inside a longer one.
 */
export function upstreamReferenceMarker(id: string): string {
  return `[upstream reference = ${id}]`;
}

/**
 * #2540: the `reference` narrowing of an ops-failure list, as SQL over `_substrat_ops_failures`,
 * the one both adapters run. Exact by default. With `inText` (staff's search), also both rows of
 * every pair whose row with no tenant names `reference` as its upstream handle.
 */
export function opsFailureReferenceWhere(reference: string, inText: boolean): { sql: string; params: string[] } {
  if (!inText) return { sql: 'reference = ?', params: [reference] };
  return {
    sql:
      '(reference = ? OR reference IN (SELECT p.reference FROM _substrat_ops_failures p ' +
      'WHERE p.tenant_id IS NULL AND p.reference IS NOT NULL AND instr(p.message, ?) > 0))',
    params: [reference, upstreamReferenceMarker(reference)],
  };
}
