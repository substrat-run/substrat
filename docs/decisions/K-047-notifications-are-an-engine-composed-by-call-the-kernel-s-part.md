---
id: K-47
date: 2026-10-10
layer: kernel
title: "Notifications are an engine composed by call; the kernel's part is the send intent"
status: proposed
aliases: []
amends: []
tracking: ["#118"]
---

# K-47 — Notifications are an engine composed by call; the kernel's part is the send intent

**The plan said the kernel owns notification dispatch, and it does not.** Master-plan §5.7 and the build/buy table said "kernel owns dispatch, templates, preferences, delivery tracking", and D-18's description of its adapter bucket repeated it. As built, those four are `engine-notifications`, an engine composed **by call**. D-18's triage itself still holds: the provider is an adapter (`adapter-email`, behind the platform's drain). Only the claim about who dispatches changes.

**The kernel already provides everything a notification layer needs.** A domain event reaches the vertical's consumers at least once. Any operation or consumer can write a send intent in its own transaction with `requestEmail` (#2102). If the caller throws, nothing is sent; if it commits, the platform's drain delivers the mail. The drain writes the outcome back into the scope as `email.sent`, `email.refused` or `email.dead-lettered`. Subject erasure finds a held send by the intent's `subjectId` and cancels it, and reaches a module's own table through the `erasure` the module declares (K-46). None of that is specific to notifications, and none of it needed changing.

**The engine owns what happens between "notify these people" and the send.** A vertical decides when to notify, usually in its own consumer of a domain event, and calls `notify(ctx, { topic, recipients, template, vars, dedupeKey, … })` inside its own transaction. The engine then owns:

- whether each person wants it: per-topic, per-channel mutes, except on a topic called `required`;
- where it goes;
- the escaped render: every variable is HTML-escaped, and a missing variable throws, rolling back the caller rather than sending a blank mail;
- the send intent;
- what became of it: one delivery row per occasion, topic, person and channel, unique on those four so a redelivered event mails nobody twice, settled from the outcome event.

The vertical needs the staff-granted `emailSender` capability, as for any `requestEmail`. Without it, each delivery settles `refused` with reason `permission_denied`. The caller names the occasion with `dedupeKey`; from a consumer that is the event's id. This is the by-call shape of workorder, booking and protocol: the vertical composes an exported function in its own transaction and does its own permission check.

**The registration is one frozen constant, like every other engine's.** Its consumers are fixed: the three email outcome events. Topics are what the caller names when it calls `notify`, so the scope learns them by use. A topic is recorded the first time it is used and follows the caller's latest description and `required` flag after that. That is what a preferences screen lists and what a mute must name. This makes a topic **one declaration**: every call site naming it must pass the same description and `required`, and changing them is a code change that lands at every call site at once. Last-writer is deliberate so that a deploy changing a topic updates the row an older deploy wrote; two call sites that disagree would instead make the row, and whether a mute is allowed, flip with whichever ran last. "Engines take no configuration" stands unamended.

**The address lives in the engine, not on any event.** An event is the one copy an erasure cannot rewrite, so an event carries a principal and never an address; `todo.list-shared` carries none for the same reason. Module code cannot read the identity directory. So the address a principal's notifications go to is a preference the engine holds, erasable and deleted with the person. Calling by function adds no copy of the template variables to the spine either: they go from the caller's transaction into the intent row, which erasure reaches.

## What it does not do, stated

- **Email is the only channel.** SMS, push and in-app are each a transport and a channel value, added when a vertical needs one.
- **No digests.** A digest is a schedule over a pending queue, and is the next slice.
- **Templates are the caller's code.** Tenant-edited and per-locale templates would be a table keyed by topic, overriding the template the caller passes.
- **A topic cannot be muted before its first use.** The preferences screen lists only the topics this scope has sent.
- **When an erasure cancels a send, its delivery stays `requested`.** The intent row records the cancellation. The kernel writes no outcome event for a cancellation, and an erasure hook may not emit, so the engine has nothing to settle the delivery from.

## Why

The kernel holds something only when only the kernel can guarantee it: an enforcement input, a contract every module meets, state no module may write. Templates, preferences and digests are none of those. Kept in the kernel, they would grow it with every channel and every template feature, and every fix would be a kernel release. The kernel-scope review (#1977, #1978) drew the same line for attachment text in K-43: the kernel provides the guarantee, and the domain-specific work plugs into it.

By call rather than by event because the engine's trigger is the vertical's own domain event. Composed by event, the engine would need to be told at registration which of the vertical's events to consume: a factory, which the "engines take no configuration" convention refuses. The alternative was a fixed command event carrying the recipients and variables, which would put a second immutable copy of every variable on the spine. By call, the vertical's consumer is the only code that knows the event, and the engine is a fixed module.
