---
id: D-64
date: 2026-10-15
layer: plan
title: "A store kind's registration is reviewed once; its releases are published, not pinned"
status: proposed
aliases: []
amends: ["D-63"]
tracking: ["#2207", "#2210", "#2297"]
---

# D-64 — A store kind's registration is reviewed once; its releases are published, not pinned

> Proposed, not accepted. It amends the pin in [D-63](./D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md). D-63, K-49 and K-50 stay proposed until they are ratified.

**A store kind is registered once in this repo. A release of it is not pinned here.** The registration names the kind, the runtime, the class, the operation catalog, and who may publish. It does not name a release, a checksum, or a script hash. A review of the registration is the review of what the platform is willing to run. A review of a release is the publish itself.

**A person allowed to publish ships a release from the kind's own workspace, with one command.** The control plane stores the bytes and their sha256, writes an audit row, and rolls the release out one vertical at a time: the first vertical is uploaded, `substrat.size` is called on a reserved object name, and only then are the rest uploaded. A failure returns every vertical that already moved to the previous release. `substrat store-kind rollback` does the same on purpose. The objects keep their storage, and the kind migrates its schema when an object wakes, which is the upgrade-in-place half of D-63 and is unchanged.

**The envelope is Ed25519, one private key per audience.** The router holds the `caller` key. The control plane holds the `platform` key. A store script is given only the two public keys, and the vertical it serves. HMAC would have required the control plane, which uploads the script, to hold the router's key in order to place it in the script. A store script must not hold a key that can mint an envelope. The entry also checks that the name's vertical is the script's own, so a signature minted for another script does not open this one.

## Why

D-63 pinned a kind to an exact release the way a connector is pinned, so that a review of the registration was a review of the bytes. A connector changes rarely and the pin is the review. A store kind changes with the product that implements it, and a pin in this repo would make every release a pull request here. The registration still has to show the envelope, the reserved operations (including `substrat.erase`), and no per-object state at module level. What leaves the repo is only the release pin. [#2297](https://github.com/substrat-run/substrat/issues/2297) is the publish flow, under [#2210](https://github.com/substrat-run/substrat/issues/2210).

The HMAC in [#2247](https://github.com/substrat-run/substrat/issues/2247) and [#2254](https://github.com/substrat-run/substrat/issues/2254) signs the object name alone, and the key that verifies it is the key that mints it. The control plane uploads the store script, so handing it that key would let the uploader mint `caller` envelopes. Ed25519 splits the two: the script verifies, and only the router and the control plane sign, each for its own audience.
