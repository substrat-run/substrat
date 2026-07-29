// Regenerate the vendored Public Suffix List data (`../src/data.ts`) from the
// canonical source. Run when refreshing the list:
//
//   node packages/psl/scripts/build-data.mjs
//
// The list is intentionally VENDORED (checked in), not fetched at runtime: module
// code and Workers have no network, and a cookie-safety guard must never depend on a
// live download. Refreshing is a reviewable diff, like any other checked-in data.
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';
const src = process.argv[2] ?? '/tmp/psl.dat';
const raw = readFileSync(src, 'utf8');
const version = (raw.match(/VERSION: (.*)/) || [])[1]?.trim() || 'unknown';

const rules = [];
for (let line of raw.split('\n')) {
  line = line.trim();
  if (!line || line.startsWith('//')) continue; // comments + blanks
  rules.push(line.toLowerCase());
}
const uniq = Array.from(new Set(rules)).sort();
const data = uniq.join('\n');

const out = `// AUTO-GENERATED — do not edit by hand.
// Source: ${SOURCE}
// ${uniq.length} rules (ICANN + PRIVATE sections). PSL VERSION: ${version}
// Regenerate: node packages/psl/scripts/build-data.mjs
//
// One rule per line. A leading '*' is a wildcard label; a leading '!' is an exception
// rule. The matching algorithm lives in ./list.ts (the canonical PSL algorithm).
export const PSL_VERSION = ${JSON.stringify(version)};
export const PSL_RULES = ${JSON.stringify(data)};
`;
writeFileSync(new URL('../src/data.ts', import.meta.url), out);
console.log(`wrote ${uniq.length} rules (${data.length} bytes), version ${version}`);
