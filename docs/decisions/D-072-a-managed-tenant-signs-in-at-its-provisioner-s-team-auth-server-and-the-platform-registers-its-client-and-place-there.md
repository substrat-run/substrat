---
id: D-72
date: 2026-11-16
layer: plan
title: "A managed tenant may sign in at its provisioner's team auth-server, and the platform registers its client and its place there"
status: proposed
aliases: []
amends: ["D-62"]
tracking: ["#3202"]
---

# D-72 — A managed tenant may sign in at its provisioner's team auth-server, and the platform registers its client and its place there

> **Proposed 2026-11-16, not ratified.** #3202 asked how a person lists every managed tenant they
> belong to, for a vertical's business switcher. The owner delegated the choice to the orchestrator,
> with the instruction to take the long-term best solution. The orchestrator chose this entry. The
> owner ratifies it by merging the [CHECKPOINT] PR that implements it.

**A `provision-tenant` request may name, in `instance.signIn.issuer`, one of the manager's own
team auth-servers. The platform then does for the new tenant what the dashboard does for an app it
installs (D-62). It registers an OIDC client for the tenant's address at that issuer, delivers the
client as the scope's `substrat:auth`, and registers the tenant as a place there, under the managed
tenant's own key (`substrat:places:<tenant id>` = that one app). The issuer must be an active
hostname of an active scope in the drained scope's tenant, running a vertical that provides
`oidc-issuer`. The tenant comes from the directory, never from the payload, so a manager cannot
have the platform write a client or a place at another team's issuer. A vertical lists a person's
businesses by linking to that issuer's account page (`<issuer>/account`). D-62's deferral of an
in-vertical list stands: no vertical reads anyone's places.**

## Why

D-62 lists managed tenants under "Not done". No party could register a managed tenant as a place.
The dashboard registers only its own team's apps. A manager-supplied client cannot stand for a
place, because the index allows one client per place, and a registration naming a client takes it
over. A manager naming another app's client would empty that app's entries. Accepting the
manager's word for which client is the place's is also the vertical self-registration D-62
declined.

Letting the platform register the client keeps D-62's split whole. The platform says which app is
a place, under which tenant, hostname and name. The tenant's name is the one the platform recorded
when it created the tenant. The vertical says only who is bound in its scope, as the client the
platform registered for it. The issuer keeps an addition only for a login it has itself issued to
that client. So a person invited into a business later appears in that business's place after
their first sign-in, and in no other.

It also closes two gaps #3202's other halves left open. A managed tenant had no sign-in client at
its own address, and its requester landed signed in only if the manager happened to share an
issuer with it. With one pool for the manager and its tenants, both hold by construction.

The in-vertical switcher, a per-login projection pushed into verticals, was not chosen. It would
put cross-tenant membership data inside a vertical, which is what D-62 deferred to a decision of
its own.

**Not done.** Deleting a managed tenant does not clear its place; that waits for the repair D-62
lists. A retry that registered a client and stopped before the place leaves that client unused at
the issuer: it is a client nothing names as a place, so it lists nobody.
