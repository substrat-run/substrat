import { describe, expect, it } from 'vitest';
import source from '../src/control-plane-do.ts?raw';
import {
  AUDITED_CALLERS,
  DIRECTORY_TRANSACTION_SITES,
  WRITE_AND_AUDIT_CALLERS,
  type SiteRow,
} from '../src/directory-split-inventory.js';

/**
 * K-68 (directory split), step 3a: the inventory of `control-plane-do.ts`'s transaction sites is
 * the list steps 3b to 3f rewrite, so it has to be the file's, method by method. A site added,
 * moved or removed without its row is red here; the fix is the row in `directory-split-inventory.ts`.
 */
const lines = source.split('\n');
/** A class member's opening line, at the class body's two-space indent. */
const MEMBER = /^ {2}(?:(?:private|public|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch']);

function enclosing(index: number): string {
  for (let j = index; j >= 0; j--) {
    const m = MEMBER.exec(lines[j]!);
    if (m && !KEYWORDS.has(m[1]!)) return m[1]!;
  }
  return '(outside a member)';
}

/** Sites per member: lines matching `pattern` that are code, not a comment. */
function sitesBy(pattern: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  lines.forEach((line, i) => {
    if (!pattern.test(line) || /^\s*(\*|\/\/|\/\*)/.test(line)) return;
    const member = enclosing(i);
    out[member] = (out[member] ?? 0) + 1;
  });
  return out;
}

const inventoried = (rows: readonly SiteRow[]): Record<string, number> => Object.fromEntries(rows.map((r) => [r.method, r.sites]));
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

describe('the directory split inventory (K-68)', () => {
  it('lists every transaction site in control-plane-do.ts, per method', () => {
    expect(sorted(inventoried(DIRECTORY_TRANSACTION_SITES))).toEqual(sorted(sitesBy(/\.transactionSync\(|storage\.transaction\(/)));
    expect(DIRECTORY_TRANSACTION_SITES.reduce((n, r) => n + r.sites, 0)).toBe(48);
  });

  it('lists every caller of writeAndAudit, and of audited and auditedConnectLink', () => {
    expect(sorted(inventoried(WRITE_AND_AUDIT_CALLERS))).toEqual(sorted(sitesBy(/this\.writeAndAudit\(/)));
    expect(sorted(inventoried(AUDITED_CALLERS))).toEqual(sorted(sitesBy(/this\.(audited|auditedConnectLink)\(/)));
  });

  it('splits writeAndAudit’s callers as rfc §7.2 does (19 registry, 21 tenant, 2 lake, 4 crossing), plus step 2’s 4 per-object callers (#3403, #3406)', () => {
    const by = (lands: string, crossing = 'none') => WRITE_AND_AUDIT_CALLERS.filter((r) => r.lands === lands && r.crossing === crossing).length;
    expect([by('registry'), by('tenant'), by('lake'), WRITE_AND_AUDIT_CALLERS.filter((r) => r.crossing !== 'none').length, by('both')]).toEqual([19, 21, 2, 4, 4]);
  });
});
