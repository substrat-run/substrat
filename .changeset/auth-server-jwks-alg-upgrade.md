---
'@substrat-run/demo-auth-server': patch
---

An issuer upgraded from 1.6 can be signed into again.

Every signed-in request to an issuer whose store predates the 1.7 `jwt` plugin
answered 400, with `JOSENotSupported: Invalid or unsupported JWK "alg"` in the
body. Signed OUT, the same issuer was perfectly healthy — the login screen drew,
discovery and JWKS answered — so it read as "sign-in is broken" when in fact
sign-in worked and every session read after it failed.

`jwks` gained `alg` and `crv` with the plugin, and `db/upgrade.ts` did not add
them; `CREATE TABLE IF NOT EXISTS` cannot. The two earlier columns it does add —
`account.issuer`, `identity_provider.issuer` — were found because their absence
throws. This one does not throw, and that is the whole reason it survived three
releases: drizzle quotes every identifier, and a Durable Object's SQLite still
honours a double-quoted name that matches no column as a string literal. So
`select "alg" … from "jwks"` returned the text `"alg"` as the key's algorithm,
the read succeeded, and the refusal surfaced three layers up inside `importJWK`,
on the one path that signs — the `set-auth-jwt` header the `jwt` plugin attaches
to `getSession`, which only runs when there is a session to attach it to.

Both columns are now added on boot, nullable and with no backfill, because NULL
is already what the plugin means by a key minted before the column existed: it
reads a null `alg` as the configured default and takes the curve from the key's
own JWK. The existing key keeps its `kid`, so a relying party that cached it can
still verify with it, and nobody is signed out by the upgrade.

The suite gained the table rather than the assertion. `test/upgrade.test.ts`
builds a frozen 1.6 store to upgrade, and that fixture never created `jwks`,
`session` or `verification` — a table it does not build is one no assertion in it
can be wrong about. All three are there now, and beside the two `jwks` cases
there is a general one: after upgrading the fixture, no surviving table may be
short of a column the current DDL declares. That case fails for the next column
added without an upgrade entry, which is the class of bug rather than this
instance of it. It cannot pin the string-literal read itself — better-sqlite3 is
compiled with that misfeature off and says `no such column` — so it pins the
column, which is the thing that was actually missing.
