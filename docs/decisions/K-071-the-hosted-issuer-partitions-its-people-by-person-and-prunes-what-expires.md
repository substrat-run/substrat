---
id: K-71
date: 2026-11-25
layer: kernel
title: "A shared hosted issuer partitions its people by person, and prunes the sessions and tokens that expire"
status: proposed
aliases: []
amends: []
tracking: []
---

# K-71 — A shared hosted issuer partitions its people by person, and prunes the sessions and tokens that expire

> **Proposed 2026-11-25, not ratified.** The reasoning is in
> [rfc/tenant-scale.md](../rfc/tenant-scale.md) (§10). Nothing in it is built.

**An issuer that serves many tenants' people keeps them in partitions, not in one object.** The
hosted auth server (`demos/auth-server`) keeps one Durable Object per issuer today, holding every
user, account, session, token, consent and place of that issuer. An issuer shared across tenants,
the platform's own sign-in or a provisioner's team issuer under
[D-72](./D-072-a-managed-tenant-signs-in-at-its-provisioner-s-team-auth-server-and-the-platform-registers-its-client-and-place-there.md),
is split:

- **A configuration object** keeps clients, resources, signing keys, identity providers, branding,
  templates and the definitions of places. It is read-mostly and cacheable.
- **A fixed set of partition objects**, keyed by a hash of the normalized email or subject (256 to
  start, re-split by doubling), each keeps its people: users, accounts, sessions, refresh and access
  tokens, consents, memberships and activity. A unique-email claim is a single-object transaction in
  the partition the email hashes to, so uniqueness needs no global object.

**What expires is deleted.** Each partition keeps an alarm set while it holds a session or token
that will expire, and deletes it when it does. The issuer's sign-in log keeps its existing
prune-on-write.

**An issuer that serves one tenant stays one object.** A tenant's own auth-server install already
scales with that tenant. This record is for shared issuers.

[K-63](./K-063-a-tenant-s-people-are-owned-by-one-app-and-its-plugins-keep-the-master-s-answer-for-a-bounded-time.md)
is unchanged: a tenant's people are still owned by its master app. The issuer holds logins, not the
tenant's people.

## Why

**D-72 puts every managed tenant's people at one issuer.** A provisioner with 100,000 managed tenants
and 5 people each puts 500,000 users in one object, with every session and token. No code in
`demos/auth-server/src` prunes expired sessions or tokens; OAuth tokens are deleted only when a
client is removed. At 100,000 sign-ins a day and about 400 bytes a token row, tokens alone reach the
10 GB cap within a year, and every sign-in, refresh and account page is a request to the same object,
under its 1,000-requests-a-second soft limit.

**By person, not by tenant.** A person can belong to several managed tenants (D-72's account page
lists them), and email uniqueness is per issuer. Partitioning by tenant would split one person
across partitions; partitioning by person keeps each person's rows and their uniqueness in one place.

## Open choices for the owner

- The partition count and key (email hash or subject hash), and the re-split procedure.
- Whether a provisioner's issuer should instead be one issuer per managed tenant, which removes the
  shared issuer and the account page's cross-tenant list.
- Whether pruning ships before partitioning (recommended: it is needed at any size).

## Not built

All of it. The first thing to verify is whether Better Auth's queries all key on a column a
partition can be chosen from, and whether Better Auth deletes expired rows itself.
