/**
 * A hosted review record, printed in the checklist's report shape (plugin/substrat/review/checklist.md,
 * "Report shape"): the headline the plane derived, the findings, then the three closing lists.
 * Typed loosely on purpose: the plane owns the record and the CLI prints what it is given.
 */
export interface ReviewRecordView {
  id: string;
  state: string;
  reason?: string | null;
  headline?: string;
  findings?: Array<{ item: string; severity: string; confirmation: string; file: string; line: number; quote: string; failsWhen: string; fix: string; unconfirmed?: boolean }>;
  checkedClean?: string[];
  notApplicable?: string[];
  gates?: Array<{ name: string; status: string; reason?: string; exitCode?: number }>;
  notSent?: Array<{ path: string; rule: string }>;
  dropped?: number;
  model?: { label: string } | null;
}

export function formatReview(record: ReviewRecordView): string {
  const out: string[] = [record.headline ?? `review ${record.id}: ${record.state}`];
  out.push("This checks Substrat's rules only and is not a general code review.");
  if (record.state !== 'completed') out.push(`State: ${record.state}${record.reason ? ` (${record.reason})` : ''}`);
  if (record.model) out.push(`Read by: ${record.model.label}`);
  const findings = record.findings ?? [];
  const inside = findings.filter((f) => f.item !== 'outside');
  const outside = findings.filter((f) => f.item === 'outside');
  for (const f of inside) {
    const tag = f.unconfirmed ? `${f.item} unconfirmed` : `${f.item} ${f.severity}`;
    out.push('', `[${tag}, ${f.confirmation}: advisory] ${f.file}:${f.line}`, `  quote: ${f.quote}`, `  fails when: ${f.failsWhen}`, `  fix: ${f.fix}`);
  }
  if (outside.length) {
    out.push('', 'Outside this checklist:');
    for (const f of outside) out.push(`  ${f.file}:${f.line} ${f.failsWhen}: ${f.quote}`);
  }
  if (record.dropped) out.push('', `Dropped: ${record.dropped} reader finding(s) that named no changed line or no judgement item.`);
  if (record.notSent?.length) out.push('', `Not sent: ${record.notSent.map((n) => `${n.path} (${n.rule})`).join(', ')}`);
  out.push('', `Checked clean: ${record.checkedClean?.length ? record.checkedClean.join(', ') : 'none'}`);
  out.push(`Not applicable: ${record.notApplicable?.length ? record.notApplicable.join(', ') : 'none'}`);
  out.push('Gates run:');
  for (const g of record.gates ?? []) {
    out.push(`  ${g.name}: ${g.status}${g.exitCode !== undefined ? ` (exit ${g.exitCode})` : ''}${g.reason ? ` (${g.reason})` : ''}`);
  }
  return out.join('\n');
}
