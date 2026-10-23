---
id: K-56
date: 2026-10-23
layer: kernel
title: "A runtime-installed extension acts only as a capability the vertical mints for it"
status: accepted
aliases: []
amends: []
tracking: ["#1671", "#1672"]
---

# K-56 — A runtime-installed extension acts only as a capability the vertical mints for it

**Runtime-installed sandboxed UI extensions stay outside K-15, and their authority does not.** K-15 governs how the platform composes a vertical's own UI at build time. An extension a vertical's *end users* install at runtime (a viewer for a file type, a panel, a small tool, running as untrusted code in a sandboxed iframe) is not composed by it, and the message bridge between the extension and the vertical's page stays the vertical's to design. What an extension may *do* is fixed here: it acts only as an `act` capability the vertical mints for it (`ctx.capabilities.mint`, #1672), narrowed to the entity subtree, the keys and the operations it needs. It never receives the user's session and the vertical never proxies calls under it. The capability's own checks (a key re-checked on every use, revocable, recorded on the spine as `{ capability }`) are what bound it.

**A kernel bridge contract is built on a trigger, not now.** The contract #1671 names (an extension declares what it needs and its calls route through the checker) is built when one of these happens: a second vertical needs user-installable extensions; the platform's own MCP or assistant surface renders third-party UI; or a review finds a bridge that passes the session. When it is built it follows the host bridge MCP Apps already defines rather than inventing one. Until then the review checklist holds the rule (S9).

## Why

**The permission boundary is the kernel's even where the UI is not.** An extension acting on a user's behalf needs less authority than the user has: "this viewer may read this one file", not "everything this person can do". If each vertical narrows that inside its own bridge, each re-implements the checker outside the checker. A capability minted by the vertical is the narrowing the kernel already ships, already re-checked on every use and already on the spine, so the stance costs no new mechanism.

**The wire protocol is not worth owning yet.** One vertical has the shape. A kernel contract cut from one consumer is the extraction D-27 warns against, and an MCP-aligned bridge is the likelier second consumer. Owning the authority now and the protocol later keeps the part that is hard to retrofit (who may act, and as what) out of each vertical's hands without freezing the part that is still moving.
