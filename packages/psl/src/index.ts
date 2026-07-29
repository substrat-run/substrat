/**
 * `@substrat-run/psl` — a self-contained Public Suffix List guard.
 *
 * The registrable-suffix boundary (D-35, control-plane.md §4.7) is where one tenant's
 * cookie could reach another. Enforcing it needs the real PSL, not a label-count
 * heuristic: `acme.com` is registrable but `acme.co.uk` sits one level deeper, and
 * only the list knows the difference. The list is VENDORED (checked in, no runtime
 * fetch) so the guard runs unchanged in module code, a Worker, or node — web-standard
 * only, no dependency.
 *
 * Two callers: the cookie-domain guard in `@substrat-run/vertical-auth` (reject a
 * session cookie on a public suffix) and the control-plane bind check (reject binding
 * a custom hostname that is a bare public suffix).
 */
export {
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  sameRegistrableDomain,
  normalizeHost,
} from './list.js';
export { PSL_VERSION } from './data.js';
