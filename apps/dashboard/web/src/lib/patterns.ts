/**
 * The Patterns mode's pure half (#1747): a `ctx.log` template split into its literal text
 * and its `{name}` placeholders, so the row can style each placeholder as the value slot it
 * is. The placeholder grammar is the one `renderTemplate` fills (`module-log.ts`).
 */
export type TemplatePart = { text: string; slot: boolean };

export function templateParts(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const re = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
  let at = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > at) parts.push({ text: template.slice(at, m.index), slot: false });
    parts.push({ text: m[1]!, slot: true });
    at = m.index + m[0].length;
  }
  if (at < template.length) parts.push({ text: template.slice(at), slot: false });
  return parts;
}

/** A share as the row says it: one decimal under 10 %, whole percents above, `<0.1%` for a sliver. */
export function shareLabel(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}
