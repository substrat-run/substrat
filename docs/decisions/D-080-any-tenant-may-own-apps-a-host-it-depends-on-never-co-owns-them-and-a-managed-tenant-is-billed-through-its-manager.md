---
id: D-80
date: 2026-11-27
layer: plan
title: "Any tenant may own apps, a host it depends on never co-owns them, and a managed tenant is billed through its manager"
status: proposed
aliases: []
amends: [D-33]
tracking: ["#3439"]
---

# D-80 — Any tenant may own apps, a host it depends on never co-owns them, and a managed tenant is billed through its manager

> **Proposed 2026-11-27, not ratified.** It comes from #3439: a back office built on Substrat whose
> customers want to add modules of their own, written with an agent in the builder studio. The owner
> gave two leans on that thread: a tenant may own apps, and a managed tenant pays through the host's
> team. This entry writes those down. Nothing in it is built.

**Any tenant may own apps.** Owning an app is a property of a tenant, not of how the tenant came to
exist. A team that signed up on the dashboard is a tenant ([dashboard-teams.md](../architecture/dashboard-teams.md)
§1), and so is a tenant a manager provisioned, or a tenant that installed a listed app. Each may hold
apps of its own. The owner is the party that pins and pushes
([K-65](./K-065-one-version-rule-an-install-follows-its-app-within-a-major-and-a-breaking-change-is-a-new-major-served-beside-the-old.md)).
An app a tenant owns is private to it, and
[D-36](./D-036-the-staff-admission-gate-moves-to-the-audience-boundary-a-pr.md) applies unchanged:
it is self-admitted, its owner promotes it, and the owner's people read its migration and permission
diffs at their own checkpoint.

**Building is not reserved to one audience.** D-33 named four audiences and made the second, builders
signing in on the platform, the only one that builds. It still names four audiences, and the auth
regimes stay distinct. What changes is that the audience a person belongs to no longer decides whether
they may build. A person may author for a tenant when that tenant says so. A person who signs in to
an app of the tenant, never to the platform, may author its apps without being given a platform
login. How the studio learns who such a person is, and what the tenant has allowed them, is a
separate entry. It is meant to reuse the person contract of
[K-63](./K-063-a-tenant-s-people-are-owned-by-one-app-and-its-plugins-keep-the-master-s-answer-for-a-bounded-time.md)
rather than add a new sign-in path.

**A host an app depends on never co-owns it.** A tenant's app may depend on another app, its host
([D-75](./D-075-five-concepts-and-one-glossary-scope-module-app-store-dependency.md)'s plugin). The
host may be published by another tenant. The tenant still owns the app alone. The host holds exactly
what its contract gives it:
- it refuses calls at its door;
- it sets its own majors' lifecycle (K-65);
- it declares what can be extended.

It has no review veto over the app's releases, and no hand in deciding who may author it. It reads
the app's source or its builder chats only with the owning tenant's consent, given for a stated time
and recorded. A host can also be the tenant's manager. Being its manager does not change this
section.

**A managed tenant is billed through its manager.** A tenant a manager provisioned (the directory's
`provisionedByTenant`, [D-72](./D-072-a-managed-tenant-signs-in-at-its-provisioner-s-team-auth-server-and-the-platform-registers-its-client-and-place-there.md))
has its use metered against itself and invoiced to the manager's team. The manager resells it on
whatever terms it has with its customer. The use covers hosting, storage, the builder's models and
its builds. A tenant no manager provisioned is billed directly. The manager's invoice carries amounts
per meter and per managed tenant, never content. Paying for a tenant gives the manager no access to
what the tenant built.

## Why

**Ownership has to follow the code, or it follows whoever is easiest to bill.** The party that pins
and pushes answers for what runs on the tenant's data. In #3439 that is the tenant. The host neither
pins the app nor pushes it. A compound owner `(host, tenant)` would give the host a say over code it
neither wrote nor runs. It would also need a third kind of owner that no other part of the platform
knows. A tenant already owns apps in every other case, so the plugin case adds nothing new.

**D-33's audiences describe how people sign in, not who may build.** D-33 split builders from tenant
admins because they sign in differently and are different actors, and that remains true. It then let
the split decide who builds. That was harmless while every builder was a developer at a software
company. It is not harmless once the studio lets a business person build a module with an agent.
That person signs in to their company's app, not to the platform. Requiring a platform login of
them would recreate the ownership problem as a sign-up step.

**Billing follows the commercial relationship.** A managed tenant's customer relationship is with its
manager. The manager provisioned it, sells it plan SKUs (kernel-design §7.1, #2388), and runs the issuer
its people sign in at (D-72). Asking that customer to hold a second account with the platform, to pay
for modules inside a product they bought from someone else, breaks the product the manager is
selling. Metering against the managed tenant keeps the numbers per tenant, so the manager can
resell at a margin or include the use in a plan. Keeping invoices to amounts keeps billing from
becoming a way to read what a tenant built.

**What it costs.**
- The manager carries the credit risk of its tenants' use, including model use that one tenant can
  drive up quickly. A manager therefore needs a limit per managed tenant that it sets. That limit
  is not built and belongs to the platform billing app (#3186).
- The studio and the builder's metering are keyed on teams today. Both move to keys on tenants
  that are agnostic about how the tenant came to exist, and a tenant whose authors have no platform
  login needs the studio entry that this record leaves to a later decision.
- A host loses a lever it might want: it cannot stop a tenant from shipping a plugin it dislikes,
  except by what its contract refuses at its door. That is deliberate. A host that wants a gate
  declares it in its contract, where every plugin can see it.
