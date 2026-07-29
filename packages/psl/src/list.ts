/**
 * The Public Suffix List matching algorithm (https://publicsuffix.org/list/).
 *
 * A *public suffix* is a domain under which the public can register names directly —
 * `com`, `co.uk`, `pages.dev`. The *registrable domain* is a public suffix plus the
 * one label to its left — `example.com`, `bbc.co.uk`. This is the boundary a cookie
 * may NOT cross: a browser rejects `Domain=co.uk` outright, and Substrat rejects a
 * cookie-domain / custom-hostname bind that would sit on a registrable suffix, because
 * that is where one tenant's session could reach another (D-35, control-plane.md §4.7).
 *
 * The rules (from the PSL spec):
 *   - A normal rule (`com`, `co.uk`) matches by exact right-anchored label equality.
 *   - A wildcard rule (`*.ck`) matches when its non-`*` labels match and one more label
 *     is present for the `*`.
 *   - An exception rule (`!www.ck`) un-does a wildcard: the public suffix is the rule
 *     minus its leftmost label.
 *   - When several rules match, the one with the most labels prevails; an exception
 *     rule always beats a wildcard.
 *   - A domain matching no rule has the implicit public suffix `*` (its rightmost
 *     label), so an unknown TLD's registrable domain is `label.tld`.
 */
import { PSL_RULES } from './data.js';

interface Rules {
  /** Normal + wildcard rules, keyed by rule text (`com`, `*.ck`). */
  readonly exact: Set<string>;
  /** Exception rules WITHOUT the leading `!` (`www.ck`). */
  readonly exceptions: Set<string>;
}

let cached: Rules | undefined;

function rules(): Rules {
  if (cached) return cached;
  const exact = new Set<string>();
  const exceptions = new Set<string>();
  for (const line of PSL_RULES.split('\n')) {
    if (!line) continue;
    if (line.startsWith('!')) exceptions.add(line.slice(1));
    else exact.add(line);
  }
  cached = { exact, exceptions };
  return cached;
}

/** Normalize a host: lower-case, trim, drop a trailing dot and a leading `.`/`*.`. */
export function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\*\./, '')
    .replace(/^\./, '');
}

/**
 * The public suffix of `host` (e.g. `co.uk` for `bbc.co.uk`), or `null` when the host
 * is empty/invalid. A host that IS a public suffix returns itself.
 */
export function getPublicSuffix(host: string): string | null {
  const h = normalizeHost(host);
  if (!h || h.includes('..')) return null;
  const labels = h.split('.');
  if (labels.some((l) => l.length === 0)) return null;
  const { exact, exceptions } = rules();

  // Exception rules win outright: the public suffix is the rule minus its first label.
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (exceptions.has(candidate)) return labels.slice(i + 1).join('.') || null;
  }

  // Otherwise the prevailing (longest) matching rule. Try longest suffix first.
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (exact.has(candidate)) return candidate;
    // Wildcard: `*.<rest>` matches when the labels to the right of this one are a rule.
    if (i > 0 && exact.has(`*.${labels.slice(i).join('.')}`)) {
      return labels.slice(i - 1).join('.');
    }
  }

  // No rule matched: the implicit `*` rule — the rightmost label is the public suffix.
  return labels[labels.length - 1] ?? null;
}

/**
 * True when `host` is itself a public suffix (`com`, `co.uk`, `pages.dev`) — i.e. NOT
 * a registrable domain. This is the cookie-boundary test: a cookie-domain that is a
 * public suffix is unsafe (browsers reject it; it would span tenants).
 */
export function isPublicSuffix(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return getPublicSuffix(h) === h;
}

/**
 * The registrable domain of `host` — its public suffix plus one more label
 * (`bbc.co.uk` for `www.bbc.co.uk`). `null` when the host has no label above its
 * public suffix (i.e. it IS a public suffix, or is empty/invalid).
 */
export function getRegistrableDomain(host: string): string | null {
  const h = normalizeHost(host);
  const suffix = getPublicSuffix(h);
  if (!suffix || suffix === h) return null;
  const suffixLabels = suffix.split('.').length;
  const labels = h.split('.');
  if (labels.length <= suffixLabels) return null;
  return labels.slice(labels.length - suffixLabels - 1).join('.');
}

/**
 * Do two hosts share a registrable domain? `crm.acme.com` and `hr.acme.com` do
 * (`acme.com`); `acme.com` and `acme.co.uk` do not. Used to check a cookie-domain
 * actually covers the request host at the registrable boundary.
 */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const ra = getRegistrableDomain(a);
  const rb = getRegistrableDomain(b);
  return ra !== null && ra === rb;
}
