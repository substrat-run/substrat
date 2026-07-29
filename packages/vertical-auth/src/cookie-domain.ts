/**
 * The shared-session cookie domain (vertical-auth-detach.md; the multi-surface case,
 * K-26): a scope whose surfaces are sibling hostnames — `crm.egeryds.se`,
 * `eka.egeryds.se`, … — shares ONE login by setting the session cookie with
 * `Domain=egeryds.se`. The signing secret is already per-tenant (DO-minted), so the
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
 * apex (`substrat.run`) is an ordinary registrable domain, NOT a public suffix, so it is
 * additionally guarded upstream (the platform refuses to deliver it as a cookie-domain).
 */
import { isPublicSuffix } from '@substrat-run/psl';

export function resolveCookieDomain(configured: string | undefined, host: string): string | null {
  if (!configured) return null;
  const domain = configured.trim().toLowerCase().replace(/^\./, '');
  if (!domain.includes('.')) return null; // a bare TLD is never a session boundary
  const h = host.toLowerCase();
  if (h !== domain && !h.endsWith(`.${domain}`)) return null; // browser would reject it anyway
  // Registrable-suffix guard (D-35): a cookie whose Domain is a public suffix — `co.uk`,
  // `pages.dev`, any multi-level registry suffix a label-count check misses — spans every
  // tenant under it. Reject it; the session degrades to host-only rather than leaking.
  if (isPublicSuffix(domain)) return null;
  return domain;
}
