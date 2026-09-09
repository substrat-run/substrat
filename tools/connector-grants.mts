/**
 * The connector-wiring checkpoint (#726 gap 3, #1326), made mechanical.
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
 * ## The two halves this checks
 *
 * **The grants floor.** Every standing grant a registered connector declares must be
 * carried by the dashboard door that connects it. The catalog may carry MORE (a second
 * connector for the same provider, a key held for a path not modelled here); it may
 * never carry less. Only the shortfall is a failure — a floor, not an equality — so
 * tightening a connector's needs never reds the repo on the strength of a stale extra.
 *
 * **The pairing** (#1326). A door in the dashboard catalog and a registration in
 * `CONNECTORS` are the two ends of one connector, and neither is useful alone. A door
 * with no registration behind it is the worse direction and the reason this half
 * exists: `connector-planima` shipped with a catalog entry, a working sweep and both
 * probes exported — and no entry in `CONNECTORS`. So a tenant could paste a token, the
 * platform stored it, nothing ever polled it, and **Test connection** answered `501 no
 * probe registered for provider 'planima'`, which reads to the person pressing the
 * button as the provider being down. Every one of those is a silent no-op when the
 * registration is forgotten, which is exactly the failure mode `CONNECTORS` was
 * introduced to end.
 *
 * The probe itself is required by the type — `RegisteredConnectionInspector` in
 * `apps/control-plane/src/connectors.ts` — so a registration without one is a compile
 * error rather than a line here. This asserts it anyway, because `tsx` does not
 * typecheck and a gate that trusts a compiler it never runs is a gate in name only.
 *
 * **Standing grants only, deliberately.** Since #726 a connector's per-dispatch reads
 * are authorized by the delivery itself — the host admits the attachments of the entity
 * the delivered event names — so they need no grant and must not appear in either list.
 * What remains is the return path, which runs top-level with no delivered event behind
 * it and therefore genuinely needs standing authority.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint firing),
 * 2 = the tool could not do its job. A checkpoint that checked nothing must never
 * print a green light.
 */
import { CONNECTORS } from '../apps/control-plane/src/connectors.js';
import { PROVIDERS } from '../apps/dashboard/src/integrations.js';

const fail = (message: string, code: 1 | 2): never => {
  console.error(message);
  process.exit(code);
};

if (CONNECTORS.length === 0) {
  fail('connector wiring: no connector registrations to check — refusing to report green', 2);
}

const catalog = PROVIDERS as Record<string, { grants?: readonly string[] } | undefined>;
const problems: string[] = [];

for (const connector of CONNECTORS) {
  const { provider } = connector;
  const entry = catalog[provider];
  if (!entry) {
    problems.push(
      `${provider}: the control plane operates this connector but the dashboard catalog has ` +
        `no entry for it — no door can connect this provider at all`,
    );
    continue;
  }
  const carried = new Set(entry.grants ?? []);
  const missing = connector.grants.filter((g) => !carried.has(g));
  if (missing.length > 0) {
    problems.push(
      `${provider}: the connector requires ${missing.map((m) => `\`${m}\``).join(', ')}, which ` +
        `the dashboard catalog cannot grant (it carries ${
          entry.grants?.length ? entry.grants.map((g) => `\`${g}\``).join(', ') : 'nothing'
        }). A tenant connecting through the dashboard would hold a credential that works ` +
        `and a return path that cannot write.`,
    );
  }
  // Belt to the type's braces — see the header.
  const inspector = connector.inspector({});
  for (const half of ['probe', 'probeCandidate'] as const) {
    if (typeof inspector[half] !== 'function') {
      problems.push(
        `${provider}: the registration has no \`${half}\` — a connected tenant pressing ` +
          `Test connection gets a 501 that reads as the provider being unreachable`,
      );
    }
  }
}

const registered = new Set(CONNECTORS.map((c) => c.provider));
for (const provider of Object.keys(catalog)) {
  if (registered.has(provider)) continue;
  problems.push(
    `${provider}: the dashboard offers a door for this provider but \`CONNECTORS\` in ` +
      `apps/control-plane/src/connectors.ts has no registration behind it — a tenant can ` +
      `paste a credential that is never probed, never swept and never dispatched`,
  );
}

if (problems.length > 0) {
  console.error('connector wiring: a door and the connector behind it disagree\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nAdd the key to the provider's \`grants\` in apps/dashboard/src/integrations.ts, drop it ` +
      `from the connector's declaration if the authority now rides the dispatch (#726), or add ` +
      `the missing entry to \`CONNECTORS\` in apps/control-plane/src/connectors.ts.`,
  );
  process.exit(1);
}

console.log(
  `connector wiring: ${CONNECTORS.length} connector${CONNECTORS.length === 1 ? '' : 's'} checked ` +
    `— each has a door, a probe, and every declared grant the door carries`,
);
