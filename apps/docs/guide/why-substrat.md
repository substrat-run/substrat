---
description: "Templates, code generators and BaaS platforms all deliver their guarantees as conventions, and conventions erode on the next edit. Why Substrat enforces them in the runtime instead."
---

# Why runtime enforcement?

Every adjacent way of getting a "production-grade foundation" delivers its guarantees as
**conventions**:

- **Templates and boilerplates** give you correct code once — and every edit after that,
  human or AI, erodes it. Nothing stops the fifth iteration of a form handler from
  querying across tenants.
- **Code generators** produce the foundation and leave. "Zero lock-in, no runtime
  dependencies" also means zero enforcement the day after generation.
- **BaaS platforms** enforce at runtime, but make the guarantee contingent on rules the
  builder must write correctly — row-level-security policies are precisely the thing
  inexperienced builders and LLMs misconfigure most.

The industry pattern is well documented: analyses of AI-generated apps keep finding the
same failure list — missing row-level security, broken auth boundaries, no tenant
isolation, no audit trail. Prompting the model to "be secure" measurably doesn't fix it.

## The structural insight

**The layer where LLMs are weakest — tenancy, auth, migrations, integrations,
compliance — is the layer where mistakes are catastrophic. The layer where LLMs are
strongest — screens, forms, workflows, reports — is the layer where mistakes are
cosmetic.**

Substrat puts humans and hard guarantees under the line, and AI velocity above it.

## Defaults, not configuration

The subtler failure mode than "no enforcement" is **enforcement you can misconfigure**:
platforms where isolation is real but contingent on builder-declared policy — a public
ACL here, a system-mode default there. Substrat guarantees are defaults of the substrate,
not configuration surfaces:

- There is no API that returns another scope's data with the wrong flag set — the API
  for reaching a scope *is* the isolation mechanism.
- There is no "remember to log this" — the event envelope is stamped kernel-side on
  every `emit`, and the audit-relevant fields (tenant, scope, actor, time) are not
  parameters.
- The permission checker's secure default is **deny everything**. The permissive test
  checker is exported as `UNSAFE_allowAllChecker` — the name is the warning.

## Why this survives better models

Even a future AI that writes flawless tenancy code doesn't solve the **trust** problem:
someone has to underwrite that isolation, audit, and GDPR hold structurally — to a
customer, an auditor, or a procurement checklist. A property of the substrate can be
tested, demonstrated, and certified once, below all the code that changes daily.

That's also why the enforcement is verified mechanically: every adapter that hosts scopes
must pass [the same conformance suite](/reference/contract-tests) — isolation,
serialization, fail-closed addressing, stamped envelopes — unchanged, forever.

## The two human checkpoints

Substrat is built for verticals that iterate at AI speed, but two things stay under human
review even in a fully agent-driven shop:

1. **Schema migrations** — the blast radius of a bad migration is data, not pixels.
2. **Permission definitions** — who can do what, where in the tree, reviewed as a
   human-readable diff.

Everything else iterates freely with contained blast radius. The module manifest and the
permission model are designed to make exactly these two reviews small and legible:
permissions are declared with descriptions in the manifest, and every permission decision
carries a proof path that explains it.
