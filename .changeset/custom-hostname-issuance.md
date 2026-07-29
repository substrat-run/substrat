---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/vertical-auth': patch
'@substrat-run/cli': patch
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
'@substrat-run/control-plane': minor
'@substrat-run/psl': minor
---

Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
isolation D-35 has always specified but never checked in code.

- **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
  wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
  `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
  Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
  calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
  **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
  to `active` with no per-hostname call.

- **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
  worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
  any stuck `pending` custom bind — issuance self-heals without a human. A new
  `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
  dashboard's *Check again*) re-polls on demand.

- **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
  algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
  cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
  label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
  domain that is a bare public suffix.

- **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
  (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
  adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
  `status` filter on `listHostnames` (index-backed) for the reconcile pass.

- **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
  add a custom domain (shows the DNS records to publish), *Check again*, and remove — no more
  mock rows. Removing a custom domain releases the Cloudflare custom hostname.

Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.
