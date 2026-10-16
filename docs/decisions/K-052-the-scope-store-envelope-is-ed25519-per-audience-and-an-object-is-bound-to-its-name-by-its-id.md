---
id: K-52
date: 2026-10-15
layer: kernel
title: "The scope-store envelope is Ed25519 per audience, a store script holds public keys only, and an object is bound to its name by its id"
status: accepted
aliases: []
amends: ["K-49", "K-50"]
tracking: ["#2287", "#2289", "#2290"]
---

# K-52 — The scope-store envelope is Ed25519 per audience, a store script holds public keys only, and an object is bound to its name by its id

> **Ratified 2026-10-16.** It amends [K-49](./K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md) and [K-50](./K-050-a-hosted-scope-store-s-lifecycle-is-driven-by-the-platform-from-its-own-record.md), and it is the envelope's own record that [D-63](./D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md) defers to. D-63 stands as ratified, its pin included.

**Every call to a scope store carries one signed envelope, and the envelope is Ed25519.** The canonical form is nine lines joined by `\n`, with no trailing newline: the version (`1`), the audience (`caller` or `platform`), the key id, the store script's name, the object name, the operation, the SHA-256 hex of the exact request body, the issue time in Unix seconds, and a nonce. The key id is base64url of the first 8 bytes of SHA-256 over the raw public key. The nonce is 16 bytes. Both are in canonical base64url, and the issue time is at most 15 digits with no sign and no leading zero. The signature is base64url over those exact UTF-8 bytes. An envelope is fresh for 60 seconds on either side of the store's clock, and a store remembers no nonces. Which operations an audience may send is a closed table per version: `platform` sends exactly the reserved `substrat.*` operations, and `caller` sends anything else. The envelope checks run in one fixed order in one function, `verifyScopeStoreCall` (`@substrat-run/contracts/scope-store-envelope`): signature before digest before the body is parsed, and the body must name the signed operation and the signed object. Two checks sit outside it, in the entry. Before it, the entry reads the configured key lists through `scopeStorePublicKeysFrom` and the script name, and refuses everything (503) when they are unusable. After it, the object checks its own id (below).

**One signing key per audience, and a store script holds public keys only.** The router signs `caller` and the control plane signs `platform`, each with its own private key. Neither signer holds the other's key. A store script is given a list of public keys per audience, so a key can rotate: add the new key, switch the signer, drop the old key. A key id that no listed key has is refused. A key listed for both audiences is refused, and so is a small-order point or a key in non-canonical base64url, compared as decoded bytes, not as spellings. No store script holds a key that can mint an envelope, for itself or for any other script.

**The `script` line scopes an envelope to one store script, and it is an opaque string.** The signer writes the script name. The store is told its own name and compares the two for equality. Nothing parses the name, so a later change to how store scripts or objects are named does not change this record. [The store-instances RFC](../rfc/store-instances.md) may change both the object naming and the script grain (a tenant-level instance rather than one script per kind and vertical), and the opaque-string rule allows that.

**An object is bound to its name by its id.** Before the kind's class is constructed or called, the object refuses a call unless its own id is `idFromName` of the signed name. So a validly signed envelope for one name never reaches the kind's class in an object of another name, whether that object has served calls or is fresh. Nothing about the name is stored, so the kind, which shares the object's storage, has nothing to rewrite. "Before the kind runs" is about the class and the call, not about the kind's module. That module is evaluated when the entry imports it, before any call arrives, and in the same isolate. A Python kind's module can replace the entry's functions through `sys.modules`. So this binding holds against a kind that leaves the checks out, not against a hostile kind. That boundary is D-63's release review.

**The checks run in the platform's entry module, never in the kind.** The platform uploads the store script with its own entry module as the main module. The kind supplies only the class behind it, and that class is constructed after the call is verified, with an env that holds none of the entry's bindings. The entry exists in TypeScript and, for a Python kind, in Python. The two run one verifier: the Python entry imports the TypeScript entry's check, shipped beside it as an ES module, and parses no envelope of its own. Neither entry is a boundary against a hostile kind in the same isolate. That boundary is D-63's review of every pinned release.

**This supersedes three things in the ratified text.** It replaces K-50's "Its MAC covers…" with the envelope above. It replaces K-50's "Signing keys are scoped per store script and per audience" with one key per audience, scoped to a script by the signed `script` line. And it replaces the first-name memory in K-49 ("the store is meant to remember the first name it accepts") and K-50 ("and the first name it accepted") with the id binding above. That binding is the answer RFC Q3 already gave (decided 2026-10-15, after K-49 and K-50 were written). This record carries that answer into the decision log as an amendment of both. Everything else in K-49 and K-50 is unchanged.

## Evidence and limits

This record describes code that is on `main`. No store script runs behind it in production yet.

- **Implemented and tested.**
  - The envelope, its signer and its verifier (#2293, `packages/contracts/src/scope-store-envelope.ts`, with shared vectors in `packages/contracts/test/vectors/scope-store-envelope.json`), the router hop that signs `caller` (#2294), the TypeScript entry and `withStoreEntry` (#2295) and the Python entry with the shared verifier (#2296, `packages/store-entry-python/`) are all merged.
  - #2295 shows the id binding, the stripped env and both flags on workerd (`apps/vertical-egress/test/store-entry.workerd.test.ts`). #2296's probe shows the same checks on local workerd under `pywrangler dev`.
  - The upload of a store script behind the entry, with pinned releases, is merged (#2299). So is storing, canarying, rolling out and rolling back a release by a person (#2300), and the control plane worker wires the store and canary ensurers. Issue [#2297](https://github.com/substrat-run/substrat/issues/2297), which #2300 works on, is still open. Generating, checking and rotating the envelope keys is merged (#2328).
- **Not live.** `STORE_DRIVERS` is empty: no driver release is registered, so no store script is uploaded behind either entry in a deployed environment.
- **Not shown.** A store script that mixes a Python main module with an ES module (the shared verifier) has not been uploaded through the dispatch-namespace API in production.
- **Ratification conditions met.** D-63 made this record conditional on #2293, #2294 and #2295 being final, and the Python half on #2296. All four are merged.

## Why

**A MAC key in the store is a key that can mint.** The control plane uploads the store script. With a MAC, the key that verifies a `caller` envelope is the key that signs one, so placing it in the script means the uploader holds the router's signing power, and so does every store script that holds it. Ed25519 separates the two: a script verifies and cannot sign, and each signer can sign only for its own audience. The name-only MAC of the spike also bound no audience, no operation and no time, so a captured signature stayed valid for every operation on its object.

**A per-script key does not scale and is not needed.** Scoping by key would mean a key pair per store script, all held by both signers. The `script` line does the same scoping inside the signature with one key per audience, and it keeps the script's name a fact the signer states and the store compares, without either of them knowing how names are built.

**A remembered first name is state the kind can reach.** The object's storage is shared with the kind's class, so a stored name is one the kind could rewrite, and a fresh object would accept whatever name arrived first. The id the runtime gave the object is deterministic, is stored nowhere, and cannot be rewritten. The entry needs only that id to refuse every other name.

**One verifier, because two parsers drift.** A second hand-written verifier in another language disagrees with the first on some input. In the first Python entry it disagreed on non-ASCII digits and invalid UTF-8. Shipping the one function to both entries removes that class of bug, rather than testing it away.

The argument and the evidence are [the RFC](../rfc/scope-stores.md) §10.3 and the envelope, entry and Python entry pull requests ([#2293](https://github.com/substrat-run/substrat/pull/2293), [#2295](https://github.com/substrat-run/substrat/pull/2295), [#2296](https://github.com/substrat-run/substrat/pull/2296)).
