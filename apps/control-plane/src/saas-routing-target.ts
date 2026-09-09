import { DEFAULT_PLATFORM_BASE_DOMAIN, parsePlatformBaseDomains } from '@substrat-run/contracts';

/**
 * The CNAME value a tenant points a custom domain at — the Cloudflare-for-SaaS fallback
 * ingress (#973).
 *
 * The name is `cname.<first platform base domain>`, and that prefix is not a preference:
 * it is the record production publishes, the one `wrangler.jsonc` documents beside
 * `CF_SAAS_ROUTING_TARGET`, and the one the custom-domain runbook tells a tenant to grey-cloud.
 * The default here used to read `edge.<base>`, which resolves nowhere — so a deployment that
 * never set the secret handed every tenant a routing record that could not validate, and the
 * custom bind sat in `verifying` with nothing in the logs to say why. The default and the
 * documented value have to be the same string or the default is a trap.
 *
 * Unlike `dispatchNamespaceOf`, an absent value is NOT an error: a wrong guess here costs a
 * tenant one DNS record they can re-point, not a deploy written into another environment.
 * But it must be a guess a standard deployment can live with, which is what makes the
 * prefix load-bearing.
 *
 * `DEFAULT_PLATFORM_BASE_DOMAIN` is the last resort, for the deployment that configured no
 * `PLATFORM_BASE_DOMAINS` at all — the same fallback the rest of the platform's hostname
 * decisions take, rather than a fresh brand literal.
 *
 * A blank `CF_SAAS_ROUTING_TARGET` reads as unset. An empty secret is how a rotation that
 * half-ran leaves it, and surfacing `''` as the routing record tells the tenant to point
 * their domain at nothing.
 */
export function saasRoutingTargetOf(env: {
  CF_SAAS_ROUTING_TARGET?: string;
  PLATFORM_BASE_DOMAINS?: string;
}): string {
  const configured = env.CF_SAAS_ROUTING_TARGET?.trim();
  if (configured) return configured;
  const base = parsePlatformBaseDomains(env.PLATFORM_BASE_DOMAINS)[0] ?? DEFAULT_PLATFORM_BASE_DOMAIN;
  return `cname.${base}`;
}
