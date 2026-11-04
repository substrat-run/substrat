---
id: K-60
date: 2026-11-04
layer: kernel
title: "A bind link binds the existing member it names, when their own session presents it"
status: accepted
aliases: []
amends: []
tracking: ["#2817", "#1686"]
---

# K-60 — A bind link binds the existing member it names, when their own session presents it

**A third capability mode, `bind`, binds a member who already exists to a record.** A binding invite (#1686) is a `become` link that also binds its claimant. Its principal is minted fresh for the invite, and a principal-minted `become` is refused for a principal some `become` has already yielded (`target-already-claimed`). So nobody who is already a member could be bound to a record later. That includes an owner who also does the work, and a colleague who starts holding a record after they joined.

A `bind` link names one existing member and one record. A holder of the binding's key on that record mints it through a host's bounded verb (`mintBindLinkBounded`). It is exchanged only under the `bind` exchange mode, and only when the presenter is the member it names. The presenter is the principal the caller's own authentication resolved. The exchange binds that member exactly as a binding invite's claim does (`bindIn`), and no principal changes hands. `become` and `target-already-claimed` are unchanged.

**What is judged.** At mint, the binding's own judgement (`judgeBind`): the binding is declared, the minter holds its key on the record (asked first, so a minter without it learns nothing about the record), and the record is there, one row, naming nobody, with nobody holding its shape. Then the target must hold something at the node, or the mint is refused `target-holds-nothing`. At the exchange, the presenter must be the named member and still hold something at the node, and `judgeBind` runs again with the minter. Every refusal comes before the use is taken and writes nothing. The link is always single use, and its expiry is optional, as a binding invite's is. There is no holdings bound and no digest: nobody acquires anything the target holds.

**On the spine.** The mint is `capability.bind-minted`, a new type, on the record, with the minter as actor. The exchange is the record's `entity.holder-bound` v1, unchanged: its `capabilityId` names the link, and its actor is the capability, as on a binding invite's claim. No `capability.exercised` is emitted for a `bind` link, because that payload's `mode` is `act` or `become` and widening a shipped enum breaks a consumer's strict parse of v1.

**Revoked by what closes the binding.** An unbind of the record revokes its pending `bind` links along with its other binding links (#2818), which makes the unbind route the way to withdraw a pending link. The erasure of the named member revokes every open `bind` link that names them.

**The kernel does not stop one member being bound to two records of the same type.** A binding is a fact about the record (its column names a person), and how many records one person may hold is the vertical's vocabulary. A vertical that wants one record per person says so in its own schema, for instance with a unique index on the binding column.

## Why

**A person is bound only by their own act.** A binding gives the shape's keys without a coverage bound: the minter vouches for the record and hands over none of their own authority. That is acceptable because the person bound is the one who acts. A direct verb that bound any member on a key holder's say-so was the other shape considered. It would turn the bind key into "give the protected keys on any unbound record to anyone here", with nothing of the person's in it. It would also have no capability for `entity.holder-bound`'s required `capabilityId` to name, so the event's payload would need a version bump, which is a replace for every consumer (K-39).

**A self-minted `become` was the smallest change, and it is refused.** A `become` link to someone who already exists is a second key to their whole identity for whoever holds the secret. That is exactly what `target-already-claimed` prevents. The `bind` link carries no identity: presented by anyone but the member it names, it is refused.

**Addressed, not "whoever opens it".** An unaddressed link would bind whoever it was forwarded to, or whoever it leaked to, to a record whose shape carries keys that only that record protects (K-48). Naming the member keeps a misdelivered link inert.
