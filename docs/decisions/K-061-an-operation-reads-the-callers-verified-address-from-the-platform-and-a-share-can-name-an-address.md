---
id: K-61
date: 2026-11-07
layer: kernel
title: "An operation reads the caller's verified address from the platform, and a share can name an address"
status: proposed
aliases: []
amends: []
tracking: ["#1359"]
---

# K-61 — An operation reads the caller's verified address from the platform, and a share can name an address

**`ctx.verifiedEmail` is the address `identifyEmail` admitted for this invocation, and null for anything else.** The door sets it through `vertical-auth`, carried with the invocation beside the principal. A door that sets nothing leaves it null, so leaving it out fails closed. It is null for a schedule, a consumer, a connection, a peer, a capability holder, acting as a person (K-42), a delegated token (#1824), and under `OIDC_ALLOW_UNVERIFIED_EMAIL`.

**`ctx.addressGrants` shares an entity with an address.** The kernel holds the row in the scope's own storage and, at the start of an invocation carrying that verified address, turns it into a grant for the caller, in that invocation's transaction. It delegates and refuses reserved keys as `ctx.grant` does. The granter is re-checked at claim, and a row whose granter no longer holds the keys lapses. The row stays after a claim, so it can be listed and withdrawn. The events carry no address, and erasure (#37) covers the row.

**The email stays the vertical's**, sent with `requestEmail`.

## Why

**A fact the platform holds should not be an input a project has to check.** An operation cannot see the session, so a vertical that shares by email takes the caller's address as input and writes host code to compare it, and leaving that out breaks nothing a project can see. A rule in a skill and a copy in a reference do not hold it.

**Omission is the risk, not a hostile vertical.** A vertical's worker already names the principal it calls `getScope` with, so the address takes the same path at the same trust. What changes is the default: a door that forgets now gets null instead of the typed address.

**A claim needs no lookup, no event and no consumer.** A person who has joined and one who has not are the same case, and the row carries the granter's authority, which is the reason the person joining could not be granted anything.

The design, the alternatives, someone with no principal, and the phases are in [rfc/verified-address.md](../rfc/verified-address.md).
