/**
 * The Cloudflare script names the PLATFORM's own workers deploy under, and the rule that a
 * vertical's scripts never take one (#1923).
 *
 * Workers Logs are account-wide and name a line's writer only by script (`$metadata.service`),
 * and a dispatch-namespace script logs into the same store as a top-level worker. So a vertical
 * whose script were named `substrat-router` would write lines a reader cannot tell from the
 * router's. The field-coverage tally trusts the router's lines as provenance, so the names have
 * to be the platform's alone: a slug that would deploy under one is refused when it is
 * registered and again when it is deployed, from this one list.
 *
 * `test/script-names.test.ts` holds the list to every `apps/*` wrangler config and the shared
 * issuer's, so a new platform worker cannot ship without its name being reserved here.
 */

/** The router's scripts: the provenance a field-coverage report is joined to. */
export const ROUTER_SCRIPT_NAMES: readonly string[] = ['substrat-router', 'substrat-router-test'];

/** Every platform worker's script name, test environments included. */
export const PLATFORM_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  ...ROUTER_SCRIPT_NAMES,
  'substrat-auth-server',
  'substrat-builder',
  'substrat-control-plane',
  'substrat-control-plane-test',
  'substrat-dashboard',
  'substrat-dashboard-test',
  'substrat-docs',
  'substrat-social-relay',
  'substrat-social-relay-test',
  'substrat-vertical-egress',
  'substrat-vertical-egress-test',
]);

/** The jurisdictional serving scripts a vertical's stem may grow (K-30): `<stem>-eu`, `<stem>-us`. */
const JURISDICTION_SUFFIXES = ['eu', 'us'] as const;

/**
 * A vertical slug as a script-name stem: lowercased, anything outside `[a-z0-9_-]` (the `/` of
 * `<tenant>/<name>`) flattened to `-`, and no leading or trailing `-`. The stable serving script
 * is exactly this; a per-version script is this plus `-<ulid>`.
 */
export function verticalScriptStem(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The platform script name a vertical with this slug would deploy under, or `null`. Checks the
 * stable script and its jurisdictional variants. A per-version script ends in a 26-character
 * ULID, which no platform name does.
 */
export function platformScriptCollision(slug: string): string | null {
  const stem = verticalScriptStem(slug);
  for (const name of [stem, ...JURISDICTION_SUFFIXES.map((j) => `${stem}-${j}`)]) {
    if (PLATFORM_SCRIPT_NAMES.has(name)) return name;
  }
  return null;
}

/** The refusal a registration or a deploy gives for {@link platformScriptCollision}. */
export function platformScriptRefusal(slug: string, collision: string): string {
  return `vertical slug '${slug}' would deploy under '${collision}', a script name the platform's own workers use`;
}
