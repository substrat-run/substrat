/**
 * The shared-session cookie domain (vertical-auth-detach.md; the multi-surface case,
 * K-26): a scope whose surfaces are sibling hostnames — `crm.acme.se`,
 * `eka.acme.se`, … — shares ONE login by setting the session cookie with
 * `Domain=acme.se`. The signing secret is already per-tenant (DO-minted), so the
 * cookie verifies on every surface; the Domain attribute is the only missing piece.
 *
 * The domain is per-scope DELIVERED config (`substrat:auth`), never code, and it is
 * validated HERE, where the cookie is set: it must cover the request host (equal, or a
 * proper suffix at a label boundary) and must not be a bare TLD. A domain that fails
 * validation degrades to a host-only cookie — sessions simply don't share — because a
 * misdelivered config must never break sign-in.
 *
 * The registrable-suffix half is now enforced HERE too, not only upstream (#305, D-35):
 * a configured domain that is itself a public suffix — `co.uk`, `pages.dev`, or any
 * multi-level registry suffix a label-count check would miss — is rejected via the
 * vendored Public Suffix List (`@substrat-run/psl`). A cookie on a public suffix spans
 * every tenant registered under it, so it must never be honoured. The platform's own
 * hostname space is an ordinary registrable domain, not a public suffix, and is
 * refused here too: sibling platform hostnames can belong to different tenants.
 */
import { isPublicSuffix } from '@substrat-run/psl';

const PLATFORM_DOMAIN = 'substrat.run';

export function resolveCookieDomain(configured: string | undefined, host: string): string | null {
  if (!configured) return null;
  const domain = configured.trim().toLowerCase().replace(/^\./, '');
  if (!domain.includes('.')) return null; // a bare TLD is never a session boundary
  const h = host.toLowerCase();
  if (h !== domain && !h.endsWith(`.${domain}`)) return null; // browser would reject it anyway
  // A configured parent within the platform's own hostname space can cover another
  // tenant's app. Even an exact app hostname needs no Domain attribute: host-only is
  // the safe default and also avoids sending its cookie to subdomains.
  if (domain === PLATFORM_DOMAIN || domain.endsWith(`.${PLATFORM_DOMAIN}`)) return null;
  // Registrable-suffix guard (D-35): a cookie whose Domain is a public suffix — `co.uk`,
  // `pages.dev`, any multi-level registry suffix a label-count check misses — spans every
  // tenant under it. Reject it; the session degrades to host-only rather than leaking.
  if (isPublicSuffix(domain)) return null;
  return domain;
}
