---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A permission key is at most 41 characters now, and `ctx.check` refuses one that is not a key.

**Breaking, for a key of 42 characters or more.** `permissionKey` gains `.max(41)`, exported as
`PERMISSION_KEY_MAX_LENGTH`. A manifest, role or grant naming a longer key is refused when it is
parsed, including at push. It is not an arbitrary number: the checker finds a principal's grants
with `relation LIKE 'granted:<key>%'`, and a Durable Object's SQLite refuses a LIKE pattern over
50 bytes. A 42-character key parsed, deployed, and then made every check of it throw on a hosted
scope while passing every local test. The longest key declared anywhere in this repository is 29
characters.

**`ctx.check` parses the key it is handed.** The `PermissionKey` type is compile-time only, so a
module that cast a string past it (`'Workorder:Read' as PermissionKey`) used to be refused as a
denial and recorded in the denial log under a key that cannot exist. Under a system actor (a
consumer), whose check is allowed without asking the checker, the same key was allowed, and
`ctx.grant` wrote it into the tuple store. Both adapters now parse the key first, above the
system-actor shortcut. A malformed key throws an `internal` error that names it. That error is not
a denial, so no denial row is written. `ctx.grant` and `ctx.revoke` inherit the check, because they
re-check before writing.

It fails closed. A throw hands back no decision, so nothing can pass `assertAllowed`, and nothing is
added to the `authorization` the operation's events carry. A caller that catches the throw and
carries on has skipped a check. It has not been granted one.

The new `assertPermissionKey` in `@substrat-run/kernel` is the one parse both adapters call.
