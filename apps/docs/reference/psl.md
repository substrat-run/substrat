# @substrat-run/psl

A self-contained **Public Suffix List** guard — dependency-free, web-standard only, and
vendored so it never fetches at runtime.

## Why the real list

The registrable-suffix boundary is where one tenant's cookie could reach another. Enforcing it
needs the actual Public Suffix List, not a label-count heuristic: `acme.com` is registrable,
but `acme.co.uk` sits one level deeper, and only the list knows the difference. A rule like
"the last two labels are the domain" gets `acme.co.uk` wrong in the direction that leaks.

The list is **checked in**, not fetched. That is what lets the same guard run unchanged in
[module code](/concepts/modules), in a Worker, and in Node — no network, no dependency, no
per-environment behaviour difference.

## API

```ts
import {
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  sameRegistrableDomain,
  normalizeHost,
  PSL_VERSION,
} from '@substrat-run/psl';

isPublicSuffix('co.uk');                             // true
getRegistrableDomain('app.acme.co.uk');              // 'acme.co.uk'
sameRegistrableDomain('a.acme.com', 'b.acme.com');   // true
```

`normalizeHost` lower-cases and strips a trailing dot before comparison. `PSL_VERSION`
identifies the vendored snapshot, so a refresh of the list is a visible, reviewable change.

## Where it is enforced

- **Session cookies** — the cookie-domain guard in
  [`@substrat-run/vertical-auth`](/reference/vertical-auth) refuses to set a cookie on a public
  suffix.
- **Custom hostnames** — the bind check in
  [`@substrat-run/control-plane-api`](/reference/control-plane-api) refuses to bind a hostname
  that is a bare public suffix.

Both are the same question asked at two layers: *is this name something a single tenant may
legitimately own?*
