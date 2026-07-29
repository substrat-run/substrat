import { z } from 'zod';
import { instant, scopeId, tenantId, verticalSlug } from './ids.js';

/**
 * The hostname map (K-26; control-plane.md §4.7).
 *
 * §4.2 provisions a scope; nothing gave it a URL. This is the directory data a
 * single environment-wide router resolves against — `hostname → (tenant, scope,
 * vertical, surface, region)` — before dispatching to the vertical's worker.
 */

/**
 * Which app answers on this hostname.
 *
 * §5.5 originally specified one hostname per scope, which is already wrong: the
 * shop fronts a storefront AND a back office from ONE scope, and RallyPoint a
 * player app and a manager console. Same data, different audience and chrome — the
 * split is deliberate and never a second source of truth.
 *
 * Vertical vocabulary, deliberately: the kernel never branches on it, exactly as it
 * never branches on `scope.kind`. It is carried so the router knows where to send
 * the request, and the vertical decides what that name means.
 */
export const surfaceName = z.string().min(1).max(32);

/**
 * A surface a vertical DECLARES it serves (package.json `substrat.surfaces` → the
 * deploy manifest → the registry). Labels only, today — the kernel and router stay
 * indifferent; what the declaration buys is operator UX: a hostname-binding picker
 * instead of free text, and a push-time warning when a version stops declaring a
 * surface that hostnames are still bound to. Free-text `surfaceName` remains valid
 * everywhere — an undeclared surface is not an error.
 *
 * This object is also the anchor #111 ("app as a first-class surface") extends when a
 * surface grows into a real authority boundary: a per-surface OPERATION-SET (the
 * scoped subset an app token may call, and the filter its OAS view is cut by) attaches
 * HERE, as optional additive fields — never as a second, competing surface list. Until
 * then the declaration must not be read as enforcement: it names, it does not gate.
 */
export const declaredSurface = z.object({
  name: surfaceName,
  label: z.string().min(1).max(80),
});
export type DeclaredSurface = z.infer<typeof declaredSurface>;

/**
 * Where the hostname's traffic may be processed.
 *
 * The DO jurisdiction (K-7) pins storage and execution and is fixed at provisioning.
 * This is the OTHER half: Regional Services pins TLS termination and processing.
 *
 * **This column records the region; it does not cause it** (K-30). TLS terminates
 * before any of our code runs, so nothing read from here can move it — the region is
 * enforced by a wildcard Regional Hostnames config per jurisdiction
 * (`*.eu.substrat.run`), and default hostnames carry the jurisdiction in the name.
 * What this column is for is letting the router detect a CONTRADICTION between the
 * edge configuration and the directory, and refuse the request.
 *
 * Which is also why it should be derived from the scope's jurisdiction rather than
 * accepted as an independent input: two values that must agree, supplied separately,
 * eventually disagree — and this is the one an EU claim rests on. `bindHostname` does
 * not enforce that yet.
 *
 * Null means unconstrained. Widening beyond `eu` is additive; Cloudflare also offers
 * `us` and `fedramp`, and `us` is needed as soon as a second jurisdiction ships.
 */
export const hostnameRegion = z.enum(['eu']).nullable();
export type HostnameRegion = z.infer<typeof hostnameRegion>;

/**
 * Where a hostname is in its provisioning lifecycle (§4.2).
 *
 * Custom domains ride Cloudflare for SaaS, so a hostname is not a string somebody
 * sets — it is DNS validation and certificate issuance, which take time and can
 * fail. Treating it as a column would make "the domain does not work yet" and "the
 * domain is broken" the same state.
 *
 * `pending`   — recorded, nothing asked of Cloudflare yet
 * `verifying` — DNS validation and cert issuance in flight
 * `active`    — serving
 * `failed`    — validation or issuance failed; `note` says why
 */
export const hostnameStatus = z.enum(['pending', 'verifying', 'active', 'failed']);
export type HostnameStatus = z.infer<typeof hostnameStatus>;

/**
 * A DNS record the tenant must publish for Cloudflare for SaaS to validate ownership
 * and route traffic. Two kinds ride the same shape:
 *
 * - `hostname`  — the routing CNAME (`legal.acme.com → edge.substrat.run`). Present as
 *   soon as the custom hostname is created.
 * - `txt`       — a DCV (domain-control-validation) TXT record, when the cert uses TXT
 *   validation (`_cf-custom-hostname.legal.acme.com`). CNAME-validated certs omit it.
 *
 * The dashboard renders these verbatim ("add this record with your DNS provider"), so
 * the shape is exactly name/value/type — what a DNS UI asks for, nothing router- or
 * Cloudflare-specific. `status` mirrors Cloudflare's per-record validation state when
 * known, so a half-validated domain can say *which* record is still missing.
 */
export const dnsRecord = z.object({
  type: z.enum(['hostname', 'txt']),
  /** The record name to create (`legal` or the full `_cf-custom-hostname.legal.acme.com`). */
  name: z.string().min(1),
  /** The record value (`edge.substrat.run`, or the DCV token). */
  value: z.string().min(1),
  /** Cloudflare's validation state for this record, when reported. Null before a poll. */
  status: z.string().nullable().default(null),
});
export type DnsRecord = z.infer<typeof dnsRecord>;

/**
 * A hostname, normalized to lower case.
 *
 * DNS is case-insensitive, so `ACME.example.com` and `acme.example.com` are the same
 * name — and if the map stored them as two rows, the global-uniqueness check would
 * let two different scopes each hold "the same" hostname, and a request would resolve
 * to whichever casing it happened to arrive in. Normalizing in the schema means both
 * adapters inherit it rather than each remembering to.
 *
 * 253 is the maximum length of a fully-qualified domain name.
 */
export const hostname = z.string().min(1).max(253).toLowerCase();

export const hostnameBinding = z.object({
  hostname,
  tenantId,
  scopeId,
  /** Denormalized from the scope, so the router resolves in one read. A registry
   *  id — `<tenantSlug>/<name>` for a builder's vertical, bare for platform. */
  verticalSlug: verticalSlug.nullable(),
  surface: surfaceName,
  region: hostnameRegion,
  status: hostnameStatus,
  /** Why it failed, when it did. Null otherwise. */
  statusNote: z.string().nullable(),
  /**
   * The one hostname a surface redirects to and issues certs for. Exactly one per
   * (scope, surface) may hold it — the rest are aliases.
   */
  canonical: z.boolean(),
  createdAt: instant,
  /**
   * Cloudflare-for-SaaS custom-hostname id (`ch_…`), once issuance has been asked of
   * Cloudflare — the handle the reconcile poll and cert lifecycle read. Null for a
   * platform hostname (it rides the wildcard cert; no per-hostname CF object) and for a
   * custom domain still `pending` (recorded, nothing asked of Cloudflare yet). Added
   * additively (§4.7 issuance): a reader that predates issuance sees null and behaves
   * exactly as before.
   */
  customHostnameId: z.string().nullable().default(null),
  /**
   * The DNS records the tenant must publish, surfaced through the whole lifecycle so
   * "the domain does not work yet" can say *why*. Populated when the custom hostname is
   * created; empty for a platform hostname. See `dnsRecord`.
   */
  validationRecords: z.array(dnsRecord).default([]),
});
export type HostnameBinding = z.infer<typeof hostnameBinding>;

export const bindHostnameInput = hostnameBinding.pick({
  hostname: true,
  tenantId: true,
  scopeId: true,
  surface: true,
  region: true,
  canonical: true,
});
export type BindHostnameInput = z.infer<typeof bindHostnameInput>;

/**
 * What the router needs to dispatch. Deliberately smaller than the full binding: a
 * per-request hot path should read what it uses and nothing else.
 */
export const routeTarget = z.object({
  tenantId,
  scopeId,
  verticalSlug: verticalSlug.nullable(),
  /**
   * The dispatch script the scope's bound version deploys as (orchestration.md §5.4) —
   * what the router hands to `env.DISPATCH.get(...)`. Null when the scope has no bound
   * version, in which case the router has nothing to dispatch and answers 502.
   * Resolved by the directory read (a join scope → version), so the hot path stays one
   * DO call.
   */
  deploymentRef: z.string().min(1).nullable(),
  surface: surfaceName,
  region: hostnameRegion,
});
export type RouteTarget = z.infer<typeof routeTarget>;
