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
> **The reserved-key table this names is now a declaration; the decision stands.** A key is reserved to a system principal by `holder: 'system'` on its module's manifest permission entry (engine-assistant declares it on `assistant:run`), and `tools/reserved-keys.mts` reads the reserved keys off the loaded manifests rather than a table of its own. A system-held role may still carry only such keys, and no person's role or entity grant shape may carry one.

**A role may declare `holder: 'system'`.** `roleDefinition` gains an optional `holder`, `person` (absent means this) or `system`. A system-held role is the one role shape that may carry a key reserved to a system principal (`tools/reserved-keys.mts`, today `assistant:run`). It may carry nothing else, so a platform host's authority is exactly the reserved keys it is declared with. `lint:permissions` refuses a reserved key in a `person` role or an entity grant shape, as before, and refuses a system-held role holding a key that is not reserved. The checked-in `PERMISSIONS.md` renders system-held roles in their own section (§2a) and marks them in the coverage table, so granting or widening one is a line in a reviewed diff.

**Why this, and not a role defined outside `ROLES`.** The host that runs a thread must call `assistant/acquire-run` and `assistant/append-events` in the middle of a request. The sanctioned system holders, a schedule's or a peer's `permissions`, are not callable that way. A principal holding a role defined directly with `host.admin.defineRole`, outside the declared surface, would work, and would hold a powerful key where no artifact shows it. The marker puts the same principal in the artifact.

**What it is not.** It is not the long-term answer. The RFC's §6.0 ends with the assistant acting for the user under a stamped actor and a ceiling (#1824 part 2, a generalised K-42), where no standing principal holds the key. This record is the stopgap that makes the first host reviewable, and the marker is what lets a later change remove the principal cleanly.

## Evidence and limits

- **Held by** `tools/reserved-keys.test.mts`: the function, and the tool on fixture verticals (a system role passes and renders; a system role with `assistant:use` exits 2; `holder: 'person'` is the same as none).
- **Not enforced at runtime.** The directory does not yet refuse assigning a system-held role to a person. In the dashboard that assignment is unreachable, since invitations and member operations offer only the member roles, and the role is assigned to the host principal by the platform. Making `assignRole` refuse it is a follow-up, and until then this is a declared and reviewed line, not a mechanism at the assignment.
- **Not decided here:** the host principal's lifecycle per team, and the actor and ceiling model that replaces it.

## Why

**The key is reserved because it writes the assistant's side of the record.** A person holding `assistant:run` could append events to their own thread and have the record say the assistant wrote them. The record is only evidence if that key is out of every person's reach.

**An exception that is declared is reviewable; one that is merely made is not.** The repo's checkpoint is a human reading a diff. A grant that never appears in the diff is outside it.
