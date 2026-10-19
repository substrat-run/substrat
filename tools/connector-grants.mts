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
 * **No key reserved to a system principal** (#2430). A connection acts for the external
 * provider that holds its token, so a key a module declares `holder: 'system'` is never one
 * it holds: neither a connector's standing grants nor the door's may name one. The host's
 * `grantToConnection` refuses it at run time too; this makes the declaration red first. The
 * reservations are read off every engine's manifest, whose keys are the ones connectors are
 * granted.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint firing),
 * 2 = the tool could not do its job. A checkpoint that checked nothing must never
 * print a green light.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONNECTORS } from '../apps/control-plane/src/connectors.js';
import { PROVIDERS } from '../apps/dashboard/src/integrations.js';
import { repoRoot } from './repo-path.mjs';
import { reservedKeysOf } from './reserved-keys.mts';

const fail = (message: string, code: 1 | 2): never => {
  console.error(message);
  process.exit(code);
};

if (CONNECTORS.length === 0) {
  fail('connector wiring: no connector registrations to check — refusing to report green', 2);
}

type Catalog = Record<string, { grants?: readonly string[]; sendsMail?: true } | undefined>;
type Connector = Pick<(typeof CONNECTORS)[number], 'provider' | 'grants' | 'mail' | 'inspector'>;
type EngineModule = { manifest: { id: string; permissions: readonly { key: string; description: string; holder?: 'system' }[] } };

/**
 * Everything this checkpoint refuses, for the registrations, the doors and the engine modules it is
 * given. One function for the real run and the self-test below, so the self-test holds the path the
 * real run takes and not only a piece of it.
 */
function wiringProblems(connectors: readonly Connector[], catalog: Catalog, engineModules: readonly EngineModule[]): string[] {
  const problems: string[] = [];
  // #2430: a key an engine reserves to a system principal, on a registration or on a door.
  const reserved = reservedKeysOf(engineModules);
  const reservedLine = (where: string, key: string) =>
    `${where} grants ${key}, which ${reserved.get(key)!.declaredBy.join(', ')} declares \`holder: 'system'\` — ` +
    `a connection acts for the external provider holding its token, and a key reserved to a system principal is never its`;
  for (const c of connectors) {
    for (const g of c.grants.filter((k) => reserved.has(k))) problems.push(reservedLine(`${c.provider}: the connector registration`, g));
  }
  for (const [provider, door] of Object.entries(catalog)) {
    for (const g of (door?.grants ?? []).filter((k) => reserved.has(k))) problems.push(reservedLine(`${provider}: the dashboard door`, g));
  }

  for (const connector of connectors) {
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
    // #2098: whether the connection sends mail as the tenant is said twice — on the door, where
    // the tenant reads it, and on the registration, where the relay acts on it. Either alone is
    // a door that hides what connecting authorizes, or one that promises mail nothing sends.
    const registersMail = typeof connector.mail === 'function';
    if (registersMail !== (entry.sendsMail === true)) {
      problems.push(
        registersMail
          ? `${provider}: the connector registers a mail sender, but the dashboard door does not ` +
              `say \`sendsMail: true\` — a tenant connecting it would not be told it sends mail as them`
          : `${provider}: the dashboard door says \`sendsMail: true\`, but the connector registers ` +
              `no mail sender — the relay would refuse every message sent as its addresses`,
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

  const registered = new Set(connectors.map((c) => c.provider));
  for (const provider of Object.keys(catalog)) {
    if (registered.has(provider)) continue;
    problems.push(
      `${provider}: the dashboard offers a door for this provider but \`CONNECTORS\` in ` +
        `apps/control-plane/src/connectors.ts has no registration behind it — a tenant can ` +
        `paste a credential that is never probed, never swept and never dispatched`,
    );
  }
  return problems;
}

// #2430: the whole check, held on every run before it judges anything (as `lint:host-permissions`
// holds its predicate): a registration and a door that grant a key a synthetic engine reserves are
// each refused, through the same function the real run calls, and their unreserved twin is clean.
{
  const engine: EngineModule = { manifest: { id: '@t/engine', permissions: [{ key: 'x:use', description: 'use' }, { key: 'x:run', description: 'run', holder: 'system' }] } };
  const connector = (grants: string[]): Connector => ({ provider: 'p', grants, inspector: () => ({ probe: async () => ({ ok: true }), probeCandidate: async () => ({ ok: true }) }) }) as unknown as Connector;
  const found = wiringProblems([connector(['x:run'])], { p: { grants: ['x:run'] } }, [engine]);
  const twin = wiringProblems([connector(['x:use'])], { p: { grants: ['x:use'] } }, [engine]);
  if (
    found.length !== 2 ||
    !found[0]!.startsWith('p: the connector registration grants x:run, which @t/engine declares') ||
    !found[1]!.startsWith('p: the dashboard door grants x:run, which @t/engine declares') ||
    twin.length !== 0
  ) {
    fail(`connector wiring: the reserved-key check does not report what it must (self-test): ${JSON.stringify({ found, twin })}`, 2);
  }
}

// Every engine's module registrations, read off its entry: an export carrying a manifest.
const root = repoRoot(import.meta.url);
const engineModules: EngineModule[] = [];
for (const engine of readdirSync(join(root, 'engines'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const entry = join(root, 'engines', engine.name, 'src', 'index.ts');
  const exported: Record<string, unknown> = await import(pathToFileURL(entry).href);
  const modules = Object.values(exported).filter(
    (v): v is EngineModule =>
      typeof v === 'object' && v !== null && 'manifest' in v && Array.isArray((v as { manifest?: { permissions?: unknown } }).manifest?.permissions),
  );
  if (modules.length === 0) fail(`connector wiring: engines/${engine.name} exports no module registration to read reservations from`, 2);
  engineModules.push(...modules);
}
// A read that finds no reservation at all checks nothing (engines mark keys today, assistant:run
// among them), so it is the tool failing, never a green line.
if (reservedKeysOf(engineModules).size === 0) {
  fail('connector wiring: no engine manifest reserves a key to a system principal — the reservation read found nothing to check against', 2);
}

const problems = wiringProblems(CONNECTORS, PROVIDERS as Catalog, engineModules);

if (problems.length > 0) {
  console.error('connector wiring: a door and the connector behind it disagree\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nAdd the key to the provider's \`grants\` in apps/dashboard/src/integrations.ts, drop it ` +
      `from the connector's declaration if the authority now rides the dispatch (#726), or add ` +
      `the missing entry to \`CONNECTORS\` in apps/control-plane/src/connectors.ts. For mail, make ` +
      `the door's \`sendsMail\` and the registration's \`mail\` agree. A key reserved to a system ` +
      `principal comes off both lists: no connection may hold one.`,
  );
  process.exit(1);
}

console.log(
  `connector wiring: ${CONNECTORS.length} connector${CONNECTORS.length === 1 ? '' : 's'} checked ` +
    `— each has a door, a probe, every declared grant the door carries, the same answer on mail, ` +
    `and no key reserved to a system principal`,
);
