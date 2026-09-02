/**
 * The connector-grant checkpoint (#726 gap 3), made mechanical.
 *
 * Three lists used to describe one fact and nothing checked that they agreed: the
 * connector declared what it needed in prose (a README line, a CHANGELOG entry), the
 * dashboard's provider catalog hardcoded what it would grant, and a vertical passed a
 * third list with its own upsert. The dashboard's Scrive entry still read
 * `['protocol:record-signature', 'protocol:attach']` after connector-scrive 0.9.0
 * shipped needing more — so the door could not grant what the connector required, for
 * any tenant, and the way that surfaced was a legal document failing to reach a
 * counterparty (#841).
 *
 * A connector now declares its standing grants as an exported constant, and this is
 * what makes that declaration load-bearing: a requirement no dashboard door carries is
 * a red here rather than a dispatch that dead-letters months later.
 *
 * **Standing grants only, deliberately.** Since #726 a connector's per-dispatch reads
 * are authorized by the delivery itself — the host admits the attachments of the entity
 * the delivered event names — so they need no grant and must not appear in either list.
 * What remains is the return path, which runs top-level with no delivered event behind
 * it and therefore genuinely needs standing authority.
 *
 * The catalog may carry MORE than a connector declares (a second connector for the same
 * provider, a key held for a path not modelled here); it may never carry less. Only the
 * shortfall is a failure — this checks a floor, not an equality, so tightening a
 * connector's needs never reds the repo on the strength of a stale extra.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint firing),
 * 2 = the tool could not do its job. A checkpoint that checked nothing must never
 * print a green light.
 */
import { SCRIVE_CONNECTION_GRANTS } from '../connectors/scrive/src/index.js';
import { FORTNOX_CONNECTION_GRANTS } from '../connectors/fortnox/src/index.js';
import { PROVIDERS } from '../apps/dashboard/src/integrations.js';

/** Each connector's declared standing grants, keyed by the provider its catalog entry uses. */
const DECLARED: Record<string, readonly string[]> = {
  scrive: SCRIVE_CONNECTION_GRANTS,
  // Empty, and deliberately so — see `FORTNOX_CONNECTION_GRANTS`. Fortnox lands its
  // ledger through the consuming vertical's own operation, so the permission is that
  // vertical's and cannot be named here. What replaces this declaration is a mechanism:
  // `bindFortnoxScope` refuses a binding whose grant is absent. Listed anyway so the
  // provider is COVERED by this gate rather than silently outside it — if the connector
  // ever grows a standing grant of its own, this row is where it becomes load-bearing.
  fortnox: FORTNOX_CONNECTION_GRANTS,
};

const fail = (message: string, code: 1 | 2): never => {
  console.error(message);
  process.exit(code);
};

const providers = Object.keys(DECLARED);
if (providers.length === 0) {
  fail('connector-grants: no connector declarations to check — refusing to report green', 2);
}

const problems: string[] = [];
for (const provider of providers) {
  const entry = (PROVIDERS as Record<string, { grants?: readonly string[] } | undefined>)[provider];
  if (!entry) {
    problems.push(
      `${provider}: declares grants but the dashboard catalog has no entry for it — no door ` +
        `can connect this provider at all`,
    );
    continue;
  }
  const carried = new Set(entry.grants ?? []);
  const missing = DECLARED[provider]!.filter((g) => !carried.has(g));
  if (missing.length > 0) {
    problems.push(
      `${provider}: the connector requires ${missing.map((m) => `\`${m}\``).join(', ')}, which ` +
        `the dashboard catalog cannot grant (it carries ${
          entry.grants?.length ? entry.grants.map((g) => `\`${g}\``).join(', ') : 'nothing'
        }). A tenant connecting through the dashboard would hold a credential that works ` +
        `and a return path that cannot write.`,
    );
  }
}

if (problems.length > 0) {
  console.error('connector grants: a connector requires what no dashboard door can grant\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nAdd the key to the provider's \`grants\` in apps/dashboard/src/integrations.ts, or drop ` +
      `it from the connector's declaration if the authority now rides the dispatch (#726).`,
  );
  process.exit(1);
}

console.log(
  `connector grants: ${providers.length} connector${providers.length === 1 ? '' : 's'} checked, ` +
    `every declared grant has a door that carries it`,
);
