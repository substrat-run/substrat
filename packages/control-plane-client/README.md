# @substrat-run/control-plane-client

The typed HTTP client for the Substrat control-plane API — one transport for the CLI, the
console, the dashboard and a vertical's connect seam: how a request is authenticated, how a refusal is
read (RFC 9457 problem documents), and what an empty answer is.

```sh
pnpm add @substrat-run/control-plane-client
```

**Full documentation: https://substrat.net/reference/control-plane-client**

## Licence

**Apache-2.0**, unlike the AGPL server it talks to (`@substrat-run/control-plane-api`).
The client is what a builder's tooling imports; a client library that copyleft-captured
its callers would capture every vertical built on Substrat. It reaches nothing but `fetch`
and `@substrat-run/contracts`, and `test/entry.test.ts` holds that line.
