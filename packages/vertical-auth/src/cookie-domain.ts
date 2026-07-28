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
 * What this check CANNOT catch is a registrable-suffix domain like `substrat.run`
 * itself, which would share sessions across tenants. That is guarded upstream: the
 * platform refuses to deliver its own apex, and the PSL listing of the tenant-apps
 * domain makes browsers reject such a cookie outright.
 */
export function resolveCookieDomain(configured: string | undefined, host: string): string | null {
  if (!configured) return null;
  const domain = configured.trim().toLowerCase().replace(/^\./, '');
  if (!domain.includes('.')) return null; // a bare TLD is never a session boundary
  const h = host.toLowerCase();
  if (h !== domain && !h.endsWith(`.${domain}`)) return null; // browser would reject it anyway
  return domain;
}
