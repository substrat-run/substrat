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

/** C0 and C1 control characters (tab kept): a record's text must not move the cursor, clear a line or write a clipboard. */
export const printable = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');

/**
 * Every string here comes from the plane, and some of it from a model, so each value is cleaned
 * before it is placed: an embedded newline cannot forge a line, nor an escape move the cursor.
 */
export function formatReview(record: ReviewRecordView): string {
  const p = printable;
  const out: string[] = [record.headline ? p(record.headline) : `review ${p(record.id)}: ${p(record.state)}`];
  out.push("This checks Substrat's rules only and is not a general code review.");
  if (record.state !== 'completed') out.push(`State: ${p(record.state)}${record.reason ? ` (${p(record.reason)})` : ''}`);
  if (record.model) out.push(`Read by: ${p(record.model.label)}`);
  const findings = record.findings ?? [];
  const inside = findings.filter((f) => f.item !== 'outside');
  const outside = findings.filter((f) => f.item === 'outside');
  for (const f of inside) {
    const tag = f.unconfirmed ? `${p(f.item)} unconfirmed` : `${p(f.item)} ${p(f.severity)}`;
    out.push('', `[${tag}, ${p(f.confirmation)}: advisory] ${p(f.file)}:${p(f.line)}`);
    if (f.quote) out.push(`  quote: ${p(f.quote)}`);
    out.push(`  fails when: ${p(f.failsWhen)}`, `  fix: ${p(f.fix)}`);
  }
  if (outside.length) {
    out.push('', 'Outside this checklist:');
    for (const f of outside) out.push(`  ${p(f.file)}:${p(f.line)} ${p(f.failsWhen)}: ${p(f.quote)}`);
  }
  if (record.dropped) out.push('', `Dropped: ${p(record.dropped)} reader finding(s) the runner could not hold to a changed line and a judgement item.`);
  if (record.notSent?.length) out.push('', `Not sent: ${record.notSent.map((n) => `${p(n.path)} (${p(n.rule)})`).join(', ')}`);
  out.push('', `Checked clean: ${record.checkedClean?.length ? record.checkedClean.map(p).join(', ') : 'none'}`);
  out.push(`Not applicable: ${record.notApplicable?.length ? record.notApplicable.map(p).join(', ') : 'none'}`);
  out.push('Gates run:');
  for (const g of record.gates ?? []) {
    out.push(`  ${p(g.name)}: ${p(g.status)}${g.exitCode !== undefined ? ` (exit ${p(g.exitCode)})` : ''}${g.reason ? ` (${p(g.reason)})` : ''}`);
  }
  return out.join('\n');
}
