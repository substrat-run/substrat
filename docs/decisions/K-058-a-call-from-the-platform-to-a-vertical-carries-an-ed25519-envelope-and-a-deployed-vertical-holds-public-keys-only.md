---
id: K-58
date: 2026-10-23
layer: kernel
title: "A call from the platform to a vertical carries an Ed25519 envelope, a deployed vertical holds public keys only, and its calls up to the control plane give way to its outbox"
status: proposed
aliases: []
amends: []
tracking: []
---

# K-58 — A call from the platform to a vertical carries an Ed25519 envelope, a deployed vertical holds public keys only, and its calls up to the control plane give way to its outbox

> Proposed 2026-10-23, awaiting ratification. The argument, the rollout and ten open questions are [the wire-signing RFC](../rfc/wire-signing.md). If ratified, it amends [K-27](./K-027-the-router-presents-a-shared-secret-and-the-vertical-verifie.md) (the router's shared secret) and [K-31](./K-031-provisioning-is-control-plane-driven-pull-the-vertical-s-sel.md) (the same shape for the control plane's calls). Until then both stand as written, and nothing in the platform behaves differently.

**Every call the router or the control plane makes to a deployed vertical is to carry one Ed25519 envelope, and a deployed vertical is to hold public keys only.** The envelope is fifteen lines of UTF-8 joined by `\n`, with no trailing newline:

- the tag `substrat-wire/1`;
- the issuer, `router` or `platform`;
- the kind: `route` for an end user's request the router resolved, `call` for a call to an internal endpoint;
- the key id and the target deployment;
- the tenant and scope, the surface and the vertical;
- the method, the SHA-256 of the request's pathname and search, and the SHA-256 of a call's exact body;
- the issue and expiry times, and a 16-byte nonce.

Which fields an (issuer, kind) pair carries is a closed table. The router signs routes and its own calls, and the control plane signs calls only. A route carries its tenant, scope and surface and binds no body. A call binds its body. An envelope lives at most 120 seconds, with 30 seconds of skew. A deployment checks it in one function, `verifyWireEnvelope` (`@substrat-run/contracts/wire-signing`), in one fixed order. Every failure of the caller's returns the same refusal, and only a counter hears the reason. Every call states its replay policy. A call that changes state spends its nonce once, in the scope's own object, after every other check has passed.

**The scheme is K-52's.** The scope-store envelope's functions supply the key id, the private and public key forms and the list form. They also supply the refusals: of a small-order point, of a non-canonical spelling, and of a key listed for two signers. The key tool and the rotation runbook are the store's too. The keys themselves are new pairs, one for the router and one for the control plane, each with a standby key listed ahead of need, and each private key is held only by its signer.

**An environment's down-channel moves through three states: `legacy-only`, `dual` and `signed-only`.** `dual` accepts a call when either a valid signature or the legacy credential proves it, so a deployment can learn to verify before anything relies on it. A disagreement between two valid credentials is counted, never refused, in `dual`. Signers send the envelope beside the legacy headers until the very end. An environment becomes `signed-only` only when four things hold: every live version carries the verifier and the key lists, standby keys included, as the uploader records them; the counters show no legacy acceptance, no disagreement and no fault; the signers' release gate refuses switching signing off while it is `signed-only` (a rollback outside that workflow is not gated, and pages); and a person flips it. Each step reverts on its own, in reverse order.

**The up-channel goes, and only then the shared credentials.** What a vertical needs from the control plane it writes to its own outbox, and the platform pulls it. `signed-only` does not withdraw the shared credentials: a vertical's own up-calls still present one until they are moved, so they stay injected until the up-channel is gone. That work is on the critical path. The credentials are withdrawn only when every live version passes two tests: it makes no up-call with them, and it runs no legacy check of its own on the down-channel that the entry does not satisfy with a value unique to that deployment. A version that is never rebuilt fails both, and is either moved to per-deployment values for both of its legacy checks, accepted by the control plane only for that deployment's own up-calls and its own tenants and scopes (a bounded exception to the goal that a deployment holds no credential a platform worker accepts, for as long as that version is live), or named as holding the withdrawal back.

## Evidence and limits

- **Implemented and tested:** the primitives only. `packages/contracts/src/wire-signing.ts` signs, parses and verifies, with positive and negative shared vectors under the RFC 8032 test keys in `packages/contracts/test/vectors/wire-envelope.json`, checked by node's own Ed25519 as well. Every guard was removed in turn, and a test failed each time.
- **Not built:** the verifier's wiring, the signers, and the uploader's injection of the key lists and the capability record. Nor are the readiness report and its gates, the signers' release gate, the nonce store, the counters, the per-deployment values, or the up-channel removals. Each is a follow-on of the RFC (§10).
- **Not shown:** the verifier running on workerd.

## Why

**A shared secret cannot tell callers apart, and it verifies with the value it signs with.** Rotating it is also a change to the whole fleet at once.

**Signing separates the power to sign from the power to verify.** This is K-52's argument, made again for the other direction. A deployment that verifies with a public key holds nothing that signs, and each signer can sign only as itself.

**Dual first, because nothing live may break.** Every deployment in the field verifies the old way today. Deploy a verifier that accepts either before any signer relies on it, and the order of deploys stops mattering. Counters then show when the old way has stopped being used, which is evidence rather than a guess.

**The up-channel has to go for the secrets to go.** A vertical that still calls up to the control plane with a credential the control plane accepts still holds one. Pull, through the outbox, is the direction K-31 already chose for provisioning.
