---
id: K-67
date: 2026-11-24
layer: kernel
title: "A store call's second envelope version names the actor, and the router names a person only after verifying their token"
status: accepted
aliases: []
amends: ["K-52"]
tracking: ["#2994"]
---

# K-67 — A store call's second envelope version names the actor, and the router names a person only after verifying their token

> **Proposed and ratified 2026-11-24, with the answers it proposed.** It is the amendment to
> [K-52](./K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md)
> that [K-64](./K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md)
> owes, so that a store can tie a session to a person (#2994). It is the store-call half of
> [K-66](./K-066-the-wire-envelope-s-second-version-names-the-calling-app-its-scope-and-the-actor-and-the-router-signs-only-what-it-verified.md).
> The maintainer's choices and the answers given are at the end. Nothing in it is built.

**Version `2` of the store envelope adds one line to K-52's nine: the actor.** It follows the
`<operation>` line. The other eight lines keep their meaning, order and rules, and so do the key per
audience, the freshness window, the id binding and the spent nonce
([K-59](./K-059-a-store-object-admits-each-envelope-once.md)). The first line changes from `1` to `2`,
so neither version parses as the other.

```
2
caller|platform
<kid>
<store script name>
<object name>
<operation>
<actor>                        app | platform | person:<sha256 hex>
<sha256 hex of the exact request body>
<iat, unix seconds>
<nonce, base64url of 16 bytes>
```

| audience | actor |
|---|---|
| `caller` | `app` or `person:<sha256 hex>` |
| `platform` | `platform` |

Which operations each audience may send stays K-52's closed table, carried to version 2 unchanged.

**A store gets a stable person, because it cannot verify a token.** A driver has no network
([D-70](./D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md)),
and a person's token changes from call to call, so the digest K-66 binds on a peer call would name
a different person every time. Here the router verifies the person and signs a stable,
pseudonymous id instead:

- **The app's worker presents the person's token with the store call.** It is the access token the
  issuer gave the app for the person's session at that app. The router verifies its signature
  against the issuer the directory records for that app and tenant, checks that it was issued to
  the app's own client and that it has not expired, and **strips it** before the store is called. A
  store never sees a token.
- **The actor is `person:` followed by the SHA-256 hex of the issuer and the `sub`, joined by
  `\n`.** It is the same person across every call and every store of that app, it holds no address
  even where an issuer uses one as a `sub`, and the platform can recompute it from the issuer and
  the `sub` when a person is erased.
- **A store call with no token is made as `app`.** A schedule, or work with no person behind it, is
  the app acting as itself.
- **An invalid or expired token is refused at the router.** The call is not made as `app` instead.
- **An app whose sign-in issuer the platform does not record cannot name a person.** Its store
  calls are made as `app` until the platform knows the issuer it registered the app's client with.

**The store entry hands the driver the actor beside the call, after it verifies the envelope.** A
driver that keeps a session ties it to the actor on first use, and refuses a different actor on
that session. That is the protection #2994 asked for: no other code in the scope can resume, read
or commit another person's session through the store.

**Stores learn version 2 before the router sends it,** as K-66 orders the wire envelope. Both store
entries, TypeScript and Python, accept both versions first. Then the router switches. Version 1 is
refused once only version 2 has been sent for a week.

## Why

**The person has to be proven to someone who can check the proof.** A person the app's worker
names is that app's word. On a peer call the receiver can check the issuer's token itself (K-66).
A store cannot, so the router, which has the network and the directory, checks it once and signs
the result. That puts issuer trust in one platform component rather than in every driver.

**A pseudonymous id keeps personal data out of every store's sessions.** A `sub` may be an
address. A digest of the issuer and the `sub` is stable enough to tie a session, carries no address,
and stays erasable, because the platform can name it from the person's record.

**What it proves is bounded the way #3161's exchange is.** A live token proves that the person
signed in to the app, and that the session is not yet over. It does not prove that the person is
behind this request: the app holds the token for as long as the session lives. A store therefore
gets "this person's session at this app", which is what tying a session needs, and no more.

## For the maintainer

Answered at ratification, 2026-11-24, as proposed: the router verifies the person, the id is the
digest of the issuer and the `sub`, and the token is the app's own access token, which the router
strips.

1. **Router-verified person, or the app's word.** Proposed: router-verified. The alternative signs a
   person the app names and marks it as asserted, which protects against mistakes in the app and not
   against the app itself.
2. **The id: a digest of (issuer, `sub`), or the tenant's principal id.** Proposed: the digest. A
   principal is per tenant and per app, so the router would need a directory read for every store
   call, and the digest needs none.
3. **Which token: the app's own access token for the person, or one exchanged for the store hop.**
   Proposed: the app's own token, which the router strips. An exchanged token would add an issuer
   round trip to every store call that has no cached token.

## Revisit

This record is revisited if the issuer key lookup proves too slow for the store hop, or if a driver
needs the person's attributes beyond a stable id.
