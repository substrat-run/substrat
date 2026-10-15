# @substrat-run/engine-notifications

## 0.1.4

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0

## 0.1.3

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
- Updated dependencies [cb957bc]
  - @substrat-run/contracts@0.147.0
  - @substrat-run/kernel@0.147.0

## 0.1.2

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.1.1

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0

## 0.1.0

### Minor Changes

- b508cdc: New engine, `@substrat-run/engine-notifications` (#118): an occasion a vertical names becomes email to the people it concerns. It is composed by call. A vertical calls `notify(ctx, { topic, description, dedupeKey, recipients, vars, about, template, required? })` in its own transaction, usually from its own consumer of a domain event. For each recipient, the engine:

  - applies their mutes, unless the topic is required;
  - looks up their address;
  - renders the template with every variable HTML-escaped;
  - writes a send intent with the kernel's `requestEmail`;
  - records one delivery per (dedupe key, topic, person, channel).

  Pass the triggering event's id as `dedupeKey`, and a redelivered event mails nobody twice. A template variable the caller did not pass makes `notify` throw `validation_failed`, which rolls back the caller rather than sending a blank mail. The engine settles each delivery from the `email.sent`, `email.refused` or `email.dead-lettered` event the platform writes back. A delivery that was not sent says why: `muted` or `no_address`. A topic is recorded the first time it is used, and that is what a person's preferences list.

  A person's notification address is held by the engine, never put on an event, and deleted by a subject erasure. The send intent names the person as its subject, so the same erasure cancels a send that is still held.

  Operations:

  - `notifications/my-preferences`, `notifications/set-my-address` and `notifications/set-my-preference` require `notifications:self` and act on the caller only.
  - `notifications/list-deliveries` requires `notifications:read`.

  The package is private until its first release is set up.

  The Handlebar demo composes it: its own consumer of `workorder.assigned` mails the mechanic a repair was assigned to.

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0
