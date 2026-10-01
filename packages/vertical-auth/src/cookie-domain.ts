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
import { DEFAULT_PLATFORM_BASE_DOMAIN, isPlatformHost } from '@substrat-run/contracts';

export interface CookieDomainDecision {
  domain: string | null;
  /** A previously issued domain cookie that must be expired on the response. */
  cleanupDomain: string | null;
}

export function cookieDomainDecision(
  configured: string | undefined,
  host: string,
  platformBaseDomains: readonly string[] = [],
): CookieDomainDecision {
  const hostOnly = { domain: null, cleanupDomain: null };
  if (!configured) return hostOnly;
  const domain = configured.trim().toLowerCase().replace(/^\./, '');
  if (!domain.includes('.')) return hostOnly; // a bare TLD is never a session boundary
  const h = host.toLowerCase();
  if (h !== domain && !h.endsWith(`.${domain}`)) return hostOnly; // browser would reject it anyway
  // A configured parent within the platform's own hostname space can cover another
  // tenant's app. Even an exact app hostname needs no Domain attribute: host-only is
  // the safe default and also avoids sending its cookie to subdomains.
  if (isPlatformHost(domain, [DEFAULT_PLATFORM_BASE_DOMAIN, ...platformBaseDomains])) {
    return { domain: null, cleanupDomain: domain };
  }
  // Registrable-suffix guard (D-35): a cookie whose Domain is a public suffix — `co.uk`,
  // `pages.dev`, any multi-level registry suffix a label-count check misses — spans every
  // tenant under it. Reject it; the session degrades to host-only rather than leaking.
  if (isPublicSuffix(domain)) return hostOnly;
  return { domain, cleanupDomain: null };
}

export function resolveCookieDomain(
  configured: string | undefined,
  host: string,
  platformBaseDomains: readonly string[] = [],
): string | null {
  return cookieDomainDecision(configured, host, platformBaseDomains).domain;
}

/** Replace caller-supplied internal headers with the worker's delivered cookie settings. */
export function forwardIdentityCookieConfig(
  request: Request,
  opts?: { cookieDomain?: string; platformBaseDomains?: readonly string[] },
): Request {
  const relayed = new Request(request);
  relayed.headers.delete('x-substrat-cookie-domain');
  relayed.headers.delete('x-substrat-platform-base-domains');
  if (opts?.cookieDomain) {
    relayed.headers.set('x-substrat-cookie-domain', opts.cookieDomain);
    if (opts.platformBaseDomains?.length) {
      relayed.headers.set('x-substrat-platform-base-domains', opts.platformBaseDomains.join(','));
    }
  }
  return relayed;
}

/** Clear the domain-scoped Better Auth cookies issued before a platform zone was refused. */
export function expireBetterAuthDomainCookies(response: Response, origin: string, domain: string | null): Response {
  if (!domain) return response;
  const headers = new Headers(response.headers);
  for (const name of ['session_token', 'session_data', 'account_data', 'dont_remember']) {
    for (const prefix of ['better-auth.', '__Secure-better-auth.']) {
      headers.append('set-cookie', `${prefix}${name}=; Path=/; Domain=${domain}; Max-Age=0; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
