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
 * The name space scope-store scripts are uploaded into (RFC scope-stores §10.7, L20). Store
 * scripts share the dispatch namespace with every vertical's scripts, so no vertical script may
 * be named inside it: {@link platformScriptCollision} refuses a slug whose stem is the bare
 * prefix or starts with it, which covers its stable, jurisdictional and per-version scripts.
 */
export const SCOPE_STORE_SCRIPT_PREFIX = 'substrat-store-';

/** A store driver id (L20). No `-` and no `_`, which is what keeps {@link scopeStoreScriptName} injective. */
export const STORE_DRIVER_ID = /^[a-z0-9]+$/;

/** The registry id grammar `verticalSlug` parses (ids.ts), repeated so this file imports nothing. */
const VERTICAL_SLUG = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The script a scope-store driver is uploaded as, for one vertical (#2210).
 *
 * Stable across releases and across the vertical's own pushes: a new release of the kind
 * replaces this script in place, and the objects stay where `scopeStoreObjectName` addresses
 * them, since that carries no version either.
 *
 * Injective over (kind, vertical) (L20): `substrat-store-<kind>-<vertical>`, with the `/` of a
 * `<tenant>/<name>` slug written as `_`. A slug never contains `_` and a kind never contains `-`,
 * so the kind ends at the first `-` after the prefix and the rest maps back to exactly one slug.
 * A vertical's own stem flattens `/` to `-`, which is not injective; this name does not reuse it.
 * Anything outside those two grammars is refused rather than flattened.
 */
export function scopeStoreScriptName(vertical: string, kind: string): string {
  if (!STORE_DRIVER_ID.test(kind)) {
    throw new Error(`not a scope-store driver id: '${kind}' (expected [a-z0-9]+)`);
  }
  if (!VERTICAL_SLUG.test(vertical)) {
    throw new Error(`not a vertical slug: '${vertical}'`);
  }
  return `${SCOPE_STORE_SCRIPT_PREFIX}${kind}-${vertical.replace('/', '_')}`;
}

/**
 * The vertical segment of the platform's canary script and objects (D-63, #2300). It starts with
 * `-`, which no vertical slug does, so no vertical's store script or store object is named with it.
 */
export const SCOPE_STORE_CANARY = '-canary';

/**
 * The script a kind's release is canaried in before any vertical runs it (D-63, #2300): the
 * platform's own, `substrat-store-<kind>--canary`. {@link scopeStoreScriptName} cannot produce it,
 * because the part after the kind would be a slug starting with `-`.
 */
export function scopeStoreCanaryScriptName(kind: string): string {
  if (!STORE_DRIVER_ID.test(kind)) {
    throw new Error(`not a scope-store driver id: '${kind}' (expected [a-z0-9]+)`);
  }
  return `${SCOPE_STORE_SCRIPT_PREFIX}${kind}-${SCOPE_STORE_CANARY}`;
}

/**
 * The platform script name a vertical with this slug would deploy under, or `null`. Checks the
 * stable script and its jurisdictional variants. A per-version script ends in a 26-character
 * ULID, which no platform name does. A stem inside the scope-store name space is returned as
 * itself: every script the slug could deploy under would fall in it.
 */
export function platformScriptCollision(slug: string): string | null {
  const stem = verticalScriptStem(slug);
  if (`${stem}-`.startsWith(SCOPE_STORE_SCRIPT_PREFIX)) return stem;
  for (const name of [stem, ...JURISDICTION_SUFFIXES.map((j) => `${stem}-${j}`)]) {
    if (PLATFORM_SCRIPT_NAMES.has(name)) return name;
  }
  return null;
}

/** The refusal a registration or a deploy gives for {@link platformScriptCollision}. */
export function platformScriptRefusal(slug: string, collision: string): string {
  return `vertical slug '${slug}' would deploy under '${collision}', a script name the platform's own workers use`;
}
