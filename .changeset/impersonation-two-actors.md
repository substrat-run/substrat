---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Act as a principal with the real actor preserved (K-42)

Supporting a customer's live vertical meant asking them to screenshot things: there was
no supported way to see what a named principal sees, and the only impersonation in the
tree was the `ALLOW_DEV_HEADER` dev bypass. Every platform grows this surface eventually,
and the version that grows by itself is a session swap that loses the real actor — which
is exactly the version that fails an audit.

An impersonated operation now carries **two** actors:

```ts
const session = await host.admin.beginImpersonation(staff, {
  tenantId, scopeId,
  principal: anna,
  reason: 'ticket #4182 — the invoice screen is empty',
  // minutes: 15 by default, capped at IMPERSONATION_MAX_MINUTES
  // mode: 'read-only' by default
});
const stub = await host.getImpersonatedScope(session.id, tenantId, scopeId);
await stub.invoke('callout/list-orders');   // answers as Anna
```

The permission model answers about the **impersonated** principal, through the ordinary
checker with no override branch — so a session against a principal who holds nothing is
refused precisely where that principal would be. The staff actor rides beside it as a
kernel-stamped `impersonation` on the outbox envelope, the denial row and the
platform-intent journal, on K-34's pattern: absent from `DomainEventInput`, so module
code can neither claim a session nor drop one. It is absent from `ctx` too — a vertical
that could read the session could hide rows from it.

**`read-only` is the default, and it is a mechanism rather than a promise.** The
effecting verbs (`emit`, `requestPlatform`, `grant`, `revoke`, `link`) refuse by name,
and the transaction is rolled back instead of committed — which is what holds when a
handler writes a row with plain `ctx.sql.exec` and calls none of them. The operation
still runs and still answers; only the writes do not survive.

Sessions are bounded and reason-carrying, admin-logged **before** they can be used
(K-33's failure ordering), and re-read on every invoke rather than once at the door — a
stub is a capability, so a session checked only when it was minted would expire for
everybody except the one caller holding it. `endImpersonation` closes one early;
`listImpersonations` reads the log and is access-logged like every other staff read.

Both adapters, held to one shared `impersonationContractSuite`. Additive throughout: the
new envelope, denial and intent fields are optional, and a null means "nobody was
impersonating" rather than "unrecorded".
