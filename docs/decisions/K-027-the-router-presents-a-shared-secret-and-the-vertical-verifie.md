---
id: K-27
date: 2026-07-19
layer: kernel
title: "The router presents a shared secret and the vertical verifies it; the vertical reads its…"
status: accepted
aliases: []
tracking: []
---
# K-27 — The router presents a shared secret and the vertical verifies it; the vertical reads its…

**The router presents a shared secret and the vertical verifies it; the vertical reads its node through one kernel helper** (§4.7). K-26 makes the trust boundary "vertical workers have no public route, only a service binding from the router". That is correct and it is a **deployment fact**, not an enforced one — `workers.dev` is ON by default, so the property is one forgotten toggle away from false, and nothing in the code would notice. The consequence is not partial: the `(tenant, scope)` the vertical serves is a header, so anyone who can reach the worker directly reads any tenant's data. So the router also sets `x-substrat-router` from a shared secret, and `readRoutedNode` (kernel) verifies it in constant time. The router **strips every inbound `x-substrat-*` header by prefix** before setting its own, so a header added later is covered without anyone remembering. `readRoutedNode` distinguishes three outcomes and refuses to collapse them: **null** (no assertion — a standalone deploy substitutes its own node), **throw** (present but unsigned, incomplete, or malformed), **a node**. Standalone is gated on its own `STANDALONE` flag rather than folded into `ALLOW_DEV_HEADER`, because that flag lets any caller be any principal and wanting a single-tenant box should not require switching on impersonation

## Why

Defence in depth is usually a smell — two mechanisms for one property means neither owner is clear. It is warranted here because the two are not redundant: the config rule sets who *can reach* the worker, the secret sets who *may assert a tenant*, and only the second survives a misconfiguration of the first. The cost is real and stated: every vertical deployment now needs a secret provisioned in step with the router's, and a rotation is a two-sided change. Putting the reader in the **kernel** rather than in each vertical is the same instinct as the permission check — five demos each re-deriving how to trust a header is five chances to get it wrong, and the one that does is not obviously broken
