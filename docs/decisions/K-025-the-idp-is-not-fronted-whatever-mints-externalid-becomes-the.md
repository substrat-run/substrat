---
id: K-25
date: 2026-07-19
layer: kernel
title: "The IdP is not fronted: whatever mints externalId becomes the identity of record"
status: accepted
aliases: []
tracking: []
---
# K-25 — The IdP is not fronted: whatever mints externalId becomes the identity of record

**The IdP is not fronted: whatever mints `externalId` becomes the identity of record** (§4.3; settles how authhero arrives alongside Better Auth). Templates default to **Better Auth**, registered as its own pool. The hosted product's IdP is **authhero over OIDC, talked to directly** — *not* behind Better Auth — and registers as a second pool (`oidc:<issuer>`). Both coexist: K-23's registry makes providers distinguishable and separately enforceable, the adapter chain already takes a list, and the choice is therefore **per deployment rather than per codebase**. The rule that decides it: the directory stores `(tenantId, provider, externalId)`, so whichever system mints that `externalId` is the identity of record **forever** — fronting authhero with Better Auth would put Better Auth's user ids in `_substrat_identities` and pin the layer that was supposed to stay swappable, making the IdP swappable and the session library not. Going direct also buys the thing a front cannot: §4.3's **org claim selects the tenant**, replacing a client-supplied venue/tenant header with something the token asserts. Consequence to state rather than discover: one human arriving through two pools is **two identity rows and two principals** — correct, since different pools are different subject namespaces, but it means "local-dev me" and "production me" are not the same person

## Why

D-16 committed to identity being a swappable adapter with our auth platform as the reference implementation; this says where the seam actually cuts, which the demos were about to answer by accident. The retrofit argument is the same one D-33's `OrgId` and K-22's tenant-scoped key already paid for: an identifier the directory keys on is brutal to change once rows exist, so the question is settled before there are any. The org-claim payoff is what makes "direct" more than aesthetic — RallyPoint is the concrete case, where clubs are tenants and the venue is currently a header the client chooses; under an org-scoped token the tenant is asserted rather than requested, which is the difference between a routing hint and an authorization fact. Templates keep Better Auth because a template is copied and must run with no external dependency: pointing every starter at a hosted IdP would make "clone and go" require an account, which is exactly the friction a template exists to remove
