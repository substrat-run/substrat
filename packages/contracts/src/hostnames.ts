/**
 * Hostname parsing and platform classification, in one place (#973).
 *
 * Both facts below were restated at seven sites — the control plane's preview mint, the
 * dashboard's three derive paths, the CLI's surface mint, the egress hop and the
 * control-plane worker — each with its own copy of `host.split('.')` and its own idea of
 * what "a platform host" means. They are load-bearing guards, not conveniences: the
 * first-label convention is what makes `<label>--<tag>.<domain>` a sibling of
 * `<label>.<domain>` rather than a different zone, and the `--` reservation is what
 * stops a tenant's own label from colliding with a derived one.
 *
 * The two facts:
 *
 * 1. **A hostname is a first label plus everything after it.** Every derived name the
 *    platform mints — a surface (`<label>-<surface>.<rest>`), a preview
 *    (`<label>--<tag>.<rest>`), a snapshot (`<label>--s<id>.<rest>`) — replaces the
 *    first label and keeps the rest verbatim.
 * 2. **A platform host equals a base domain or is a subdomain of one.** Exact-or-dot
 *    boundary, so `notsubstrat.run` never matches `substrat.run` — the copy in
 *    `apps/vertical-egress` got that right and it is the behaviour kept here.
 *
 * PSL-aware classification (registrable domain, apex vs subdomain) deliberately stays in
 * `@substrat-run/control-plane-api`'s `custom-hostnames.ts`: it needs the public suffix
 * list, and contracts is the shared vocabulary rather than a place data tables live.
 */

/**
 * The separator reserved for platform-derived labels.
 *
 * A tenant's own label can never contain it — `slugify` collapses runs of `-` — so
 * `<label>--<tag>` is collision-free by construction rather than by a check at each
 * mint site. That is why it is a `--` and not a `-`.
 */
export const RESERVED_LABEL_SEPARATOR = '--';

/**
 * The platform's default base domain.
 *
 * Named here so a call site that has no `PLATFORM_BASE_DOMAINS` to read stops writing
 * the brand into a string literal. A site that CAN read the configured list should —
 * this is the fallback, not the answer.
 */
export const DEFAULT_PLATFORM_BASE_DOMAIN = 'substrat.run';

/** A hostname split at its first dot: the label the platform derives from, and the rest. */
export interface ParsedHostname {
  /** The first label, lowercased — `crm` in `crm.global.substrat.run`. */
  readonly label: string;
  /** Everything after the first dot, lowercased — `global.substrat.run`. */
  readonly rest: string;
}

/**
 * Split a hostname into its first label and the rest, lowercasing both.
 *
 * Returns `undefined` for anything with no dot — a bare label is not a hostname a
 * derived name can be minted from, and every call site already had to guard for it.
 */
export function parseHostname(hostname: string): ParsedHostname | undefined {
  const [label, ...rest] = hostname.trim().toLowerCase().split('.');
  if (!label || rest.length === 0) return undefined;
  return { label, rest: rest.join('.') };
}

/** True when a label already carries the reserved separator — i.e. is itself derived. */
export function isDerivedLabel(label: string): boolean {
  return label.includes(RESERVED_LABEL_SEPARATOR);
}

/**
 * Mint a sibling of `hostname` under a new first label: same zone, same everything else.
 *
 * `undefined` when the input has no dot, for the same reason `parseHostname` does.
 */
export function withLabel(hostname: string, label: string): string | undefined {
  const parsed = parseHostname(hostname);
  return parsed ? `${label}.${parsed.rest}` : undefined;
}

/**
 * Read a `PLATFORM_BASE_DOMAINS` env var: a comma-separated list, trimmed, lowercased,
 * empties dropped. Unset ⇒ an empty list, which classifies nothing as platform — the
 * #423 shape, and deliberately still the behaviour: a deployment that forgets the var
 * should fail loudly at the mint rather than quietly claim someone else's zone.
 */
export function parsePlatformBaseDomains(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this host on one of our own zones?
 *
 * Matches a base domain itself or any subdomain of it — `substrat.run`,
 * `x.global.substrat.run` and `x.global.test.substrat.run` all match `substrat.run`.
 * The dot boundary is the whole point: a bare `endsWith` would match `notsubstrat.run`.
 */
export function isPlatformHost(hostname: string, bases: readonly string[]): boolean {
  const h = hostname.trim().toLowerCase();
  return bases.some((b) => h === b || h.endsWith(`.${b}`));
}
