# @substrat-run/psl

A self-contained Public Suffix List guard for
[Substrat](https://github.com/substrat-run/substrat) — dependency-free, web-standard only.

**Full documentation: https://substrat.net/reference/psl**

## Why it exists

The registrable-suffix boundary is where one tenant's cookie could reach another. Enforcing it
needs the real Public Suffix List, not a label-count heuristic: `acme.com` is registrable, but
`acme.co.uk` sits one level deeper, and only the list knows the difference.

The list is **vendored** — checked in, no runtime fetch — so the guard runs unchanged in module
code, a Worker, or Node.

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

isPublicSuffix('co.uk');                              // true
getRegistrableDomain('app.acme.co.uk');               // 'acme.co.uk'
sameRegistrableDomain('a.acme.com', 'b.acme.com');    // true
```

`PSL_VERSION` identifies the vendored snapshot.

## Two callers

- The cookie-domain guard in
  [`@substrat-run/vertical-auth`](https://npmjs.com/package/@substrat-run/vertical-auth) —
  refuse to set a session cookie on a public suffix.
- The control-plane bind check in
  [`@substrat-run/control-plane-api`](https://npmjs.com/package/@substrat-run/control-plane-api) —
  refuse to bind a custom hostname that is a bare public suffix.

## Status

Pre-release (0.x): interfaces change without notice until the first vertical ships.
