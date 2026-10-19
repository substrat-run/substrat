---
id: K-55
date: 2026-10-18
layer: kernel
title: "A platform host's standing principal holds a system-only key through a role declared holder: system"
status: proposed
aliases: []
amends: []
tracking: ["#2283"]
---

# K-55 — A platform host's standing principal holds a system-only key through a role declared `holder: 'system'`

> Proposed 2026-10-18, awaiting ratification. It records the mechanism the dashboard's assistant host (P1 of [#2283](https://github.com/substrat-run/substrat/issues/2283)) needs, and the only one of its kind.
>
> **Since #2430 the reservation is also refused at push and at a host's doors; see "Evidence and limits".**
>
> **The reserved-key table this names is now a declaration; the decision stands.** A key is reserved to a system principal by `holder: 'system'` on its module's manifest permission entry (engine-assistant declares it on `assistant:run`), and `tools/reserved-keys.mts` reads the reserved keys off the loaded manifests rather than a table of its own. A system-held role may still carry only such keys, and no person's role or entity grant shape may carry one.

**A role may declare `holder: 'system'`.** `roleDefinition` gains an optional `holder`, `person` (absent means this) or `system`. A system-held role is the one role shape that may carry a key reserved to a system principal (`tools/reserved-keys.mts`, today `assistant:run`). It may carry nothing else, so a platform host's authority is exactly the reserved keys it is declared with. `lint:permissions` refuses a reserved key in a `person` role or an entity grant shape, as before, and refuses a system-held role holding a key that is not reserved. The checked-in `PERMISSIONS.md` renders system-held roles in their own section (§2a) and marks them in the coverage table, so granting or widening one is a line in a reviewed diff.

**Why this, and not a role defined outside `ROLES`.** The host that runs a thread must call `assistant/acquire-run` and `assistant/append-events` in the middle of a request. The sanctioned system holders, a schedule's or a peer's `permissions`, are not callable that way. A principal holding a role defined directly with `host.admin.defineRole`, outside the declared surface, would work, and would hold a powerful key where no artifact shows it. The marker puts the same principal in the artifact.

**What it is not.** It is not the long-term answer. The RFC's §6.0 ends with the assistant acting for the user under a stamped actor and a ceiling (#1824 part 2, a generalised K-42), where no standing principal holds the key. This record is the stopgap that makes the first host reviewable, and the marker is what lets a later change remove the principal cleanly.

## Evidence and limits

- **Held by** `tools/reserved-keys.test.mts`: the function, and the tool on fixture verticals (a system role passes and renders; a system role with `assistant:use` exits 2; `holder: 'person'` is the same as none).
- **Enforced at runtime, by keys alone (#2430).** A host reads the reserved keys off the modules it registers and the modules its declared `permissions` lists, and refuses them at its doors:
  - The person-facing role doors (an invite's scope role, a role change, a membership add) refuse any role carrying a reserved key, and `canAssign` answers the same, for taking such a role away as for giving it.
  - A raw grant of one to a principal or an org is refused, `ctx.grant` included, whoever the caller is.
  - So is a grant of one to a connection, which acts for the external provider holding its token, and `lint:connector-grants` refuses a connector whose standing grants name one. A connection grant already recorded is skipped and reported when a provision or reconcile delivers it, never failing the provision.
  - A reconcile of declared entity-grant shapes refuses a shape holding one, before it tops up any holder or records what a binding link grants.
  - The platform's role assignment refuses a role that mixes reserved keys with others, and admits a role made only of reserved keys, since that is this record's shape.
- **Not checked yet.** Roles and grants a host seats or composes itself, a role definition widened after it was assigned, roles and grants conferred on a host that registers no modules, the directory record a shared control plane keeps of a connection grant whose serving deployment refuses it (it confers nothing, but stays listed until revoked), and grants and shape bindings recorded before these checks existed or before the key was reserved, with what reaches a person through them later, an older build's re-seat after a rollback included.
- **What that door cannot tell.** A stored role does not record its holder, and the door does not know whether the assignee is a person or a host principal. So a role made only of reserved keys is admitted for any principal. One principal given two roles at that door can hold reserved keys and person keys together, which the engine test kit does, deliberately, to build a test principal. Persisting the role holder (#2444) would let the door refuse a person's role carrying a reserved key and admit only a system-held one. Telling a person from the host principal it is meant for needs a record of what kind of principal each one is, which nothing keeps yet.
- **Not decided here:** the host principal's lifecycle per team, and the actor and ceiling model that replaces it.

## Why

**The key is reserved because it writes the assistant's side of the record.** A person holding `assistant:run` could append events to their own thread and have the record say the assistant wrote them. The record is only evidence if that key is out of every person's reach.

**An exception that is declared is reviewable; one that is merely made is not.** The repo's checkpoint is a human reading a diff. A grant that never appears in the diff is outside it.
