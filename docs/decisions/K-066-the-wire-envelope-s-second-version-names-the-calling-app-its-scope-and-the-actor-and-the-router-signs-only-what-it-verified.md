---
id: K-66
date: 2026-11-24
layer: kernel
title: "The wire envelope's second version names the calling app, its scope and the actor, and the router signs only what it verified"
status: proposed
aliases: []
amends: ["K-58"]
tracking: ["#2994"]
---

# K-66 — The wire envelope's second version names the calling app, its scope and the actor, and the router signs only what it verified

> **Proposed 2026-11-24, not ratified.** It is the amendment to
> [K-58](./K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)
> that [K-64](./K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md)
> owes before any receiver relies on the calling app or the actor (#2994). The design choices that
> are the maintainer's are named at the end. Nothing in it is built.

**`substrat-wire/2` adds three lines to K-58's fifteen: the calling app, the calling scope and the
actor.** They follow the `<vertical>` line, which keeps naming the target. The other fourteen lines
keep their meaning, order and rules, and so do the signature, the key lists, the lifetime and the
refusals. The tag changes, so no version 1 envelope parses as version 2, and the reverse is also
true.

```
substrat-wire/2
router|platform
route|call
<kid>
<aud>
<tenant id>
<scope id>
<surface>
<vertical>                     the target's slug, as in version 1
<caller app>                   the calling app's slug, or empty
<caller scope>                 the calling scope's id (a ULID), or empty
<actor>                        app | platform | person:<sha256 hex>, or empty
<METHOD>
<sha256 hex of the target>
<sha256 hex of the body>
<iat>
<exp>
<nonce>
```

**The router writes the caller from the dispatch, never from what the caller says.** On a peer
invocation the router already knows which deployment called it and from which scope, because the
call arrives through that deployment's own binding (#1706). Those facts become `<caller app>` and
`<caller scope>`. Until now they rode only in the signed body (`caller`). A field in the caller's
request that names an app or a scope is never copied into these lines.

**The actor says who the call acts for, and the router vouches only for what it can see.**

- `app`: the calling app acts as itself. This is a peer call with no person behind it.
- `person:<sha256 hex>`: the call carries a person's token that the issuer minted for this target
  (the exchange of #3161, sent as `onBehalf`). The line binds the SHA-256 of that exact token. The
  router does not verify the person. The receiver verifies the token itself, as it does today, and
  refuses one whose digest differs from the signed line, so a token cannot be moved onto another
  call.
- `platform`: the platform acts, on a call the control plane signs or a call the router makes for
  it, such as a connector sweep.
- empty: an end user's routed request. The app's own door authenticates the person, and the router
  claims nothing about them.

**The closed table, version 2:**

| (issuer, kind) | caller app | caller scope | actor |
|---|---|---|---|
| (router, route) | absent | absent | absent |
| (router, call), a peer invocation | required | required | `app` or `person:…` |
| (router, call), a call for the platform | absent | absent | `platform` |
| (platform, call) | absent | absent | `platform` |

A peer invocation and a call made for the platform are told apart by the target endpoint, which is
already a closed list in `wire-signing.ts`: `/internal/vertical-invoke` is a peer invocation, and
`/internal/connector-call` and `/internal/connector-probe` are calls made for the platform.

**A receiver reads the caller and the actor only from a version 2 envelope it has verified.** A call
admitted by a version 1 envelope, or by the shared credential while an environment is `legacy-only`
or `dual`, carries no caller and no actor. A check that needs either one refuses that call. It
never falls back to a header or a body field. That refusal is what makes the two claims safe to
build on before every environment is `signed-only`.

**Receivers learn version 2 before any signer sends it.** This is the order K-58's rollout already
uses. First, every verifier, the platform entry included, accepts both tags. Then the signers switch
to version 2. Version 1 is refused once every signer has sent only version 2 for a week, the
cutover window the [wire-signing RFC](../rfc/wire-signing.md) proposes for `signed-only`.

## Why

**The caller is a fact the router has, so it should be signed and not re-derived.** Today a target
learns who called it by parsing a body that the envelope binds by digest. A typed line lets every
receiver, and K-64's child scope, check the caller without knowing each endpoint's body. It also
lets a check that is not about a body, such as a parent link, read it.

**The router must not sign a person it has not verified.** A person named by the calling app's code
is that app's word, even when a library in the same isolate wrote it. That is the line
[D-61](./D-061-do-originated-egress-is-observed-and-never-refused-d-46-s-limit.md) draws for code
laid over a capability the bundle already holds. The only person the platform can prove is one the
issuer signed for. Binding the token's digest keeps the router out of issuer trust and still makes
the token useless on any other call.

## For the maintainer

1. **The caller scope as its own line**, rather than folded into the caller app. Proposed: its own
   line, because K-64's parent link is judged per scope.
2. **The person on a peer call: bind the token's digest, or have the router verify the token and
   sign a stable id.** Proposed: the digest. The receiver already verifies the token (#3161), and the
   router would otherwise need each tenant's issuer keys. K-67 takes the other choice for stores,
   because a driver cannot verify a token.
3. **Version 1's retirement**: a week of only version 2, as proposed, or a fixed date.

## Revisit

This record is revisited if a receiver needs the person's stable identity on a peer call, which
would move the verification into the router as K-67 does for stores.
