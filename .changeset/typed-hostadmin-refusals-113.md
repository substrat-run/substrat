---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Every `HostAdmin` refusal now carries its error code from the place it is thrown (#113), and the control plane no longer guesses a code from the message. The last fourteen message patterns in `control-plane-api`'s `mapError` are gone, so an untyped throw is always the generic 500.

- Typed on both adapters: unknown tenant (`not_found`), tenant, org and scope slug already taken, an illegal scope transition, provisioning under an unknown or non-active tenant, an identity pool or vertical re-registered differently, a promotion that needs its permission or migration change acknowledged (`conflict`), an unknown table in the introspection read (`not_found`), the SQL console's read-only refusals (`validation_failed`, from the kernel's gate), and the scope-access gate (`conflict` for a tenant or scope that is not active, `not_found` for a scope with no tenant record). The sentences are unchanged.
- A refusal raised inside a Durable Object reaches the coordinator with its code. `ControlPlaneDO.reply` and the ScopeDO's `introspectTableReply`, `introspectQueryReply` and `applyProjectionReply` answer a failure as data, and the coordinator rethrows it typed. The original methods still throw, for a coordinator from before this change. The scope-gate and transition refusal records now carry a code on every refusal except a failed migration.
- **Status changes on a vertical's own surface.** The control plane's statuses do not change. A vertical door now answers the code's status where it used to answer the caller's 400 or leave the status to the vertical's own `onError`: a tenant or scope that is not active is `409`, a scope with no tenant record is `404`. A CP-less vertical's delegated table read answers `404` for an unknown table, where it answered `400`, and the control plane relays that `404`. `vertical-host` drops its `applyProjection refused` pattern, now that the refusal arrives typed.
