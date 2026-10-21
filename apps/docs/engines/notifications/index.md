# Notifications engine

`@substrat-run/engine-notifications` turns an occasion your vertical names into email to the
people it concerns. It applies per-person preferences, renders escaped templates, and tracks
one delivery per occasion, topic and person.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-notifications` (not yet published to npm) |
| **Entitlement key** | `notifications` |
| **Composed** | by call: `notify(ctx, …)` inside your own transaction |
| **Owns** | the topics a scope has used, where each person's notifications go, which topics they muted or take as a digest, what is held for each digest, and what became of every delivery |
| **Emits** | `notifications.delivery-recorded`, `delivery-settled`, `preference-set`, `recipient-updated`, `topic-recorded`, `digest-sent`, `digest-failed`, `digest-quarantined`, `digest-released`, `digest-withdrawn` |
| **Consumes** | `email.sent`, `email.refused`, `email.dead-lettered`, which settle its deliveries |
| **Schedules** | `notifications/send-digests`, every 15 minutes, sending each person whose digest is due |
| **Permissions** | 3 (`notifications:self`, `notifications:read`, and `notifications:send-digests`, which only the digest schedule holds) |
| **Status** | product seed, used by the Handlebar demo |

## What it will not do

- It does not talk to a mail provider. It writes the kernel's send intent, and the platform
  delivers it.
- It has no channels other than email yet. Digests are daily only. When one goes out depends
  on when that person's oldest message arrived, not on a chosen time of day.
- It sends no digest where nothing runs schedules, or where nothing drains the sends. On the
  hosted platform the scope sweeper runs the schedule and the control plane drains the sends.
  A self-hosted server must run `startPlatformSweeper` (or `runDueSchedules`) and drain its
  platform intents, or held messages wait.
- A topic appears on a person's preferences screen only once it has been used.

## How these pages are organized

- [Domain model & invariants](./model) — stored records and the guarantees they carry
- [Operations & permissions](./surface) — registered operations and in-scope functions
- [Events](./events) — emitted milestones and consumed outcomes
- [Composing & extending](./composing) — integration and host responsibilities
