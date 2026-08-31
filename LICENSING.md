# Licensing

Substrat is **dual-licensed**. Every package carries its license in `package.json` and
ships the full text in its tarball.

## The model

Every workspace member is in this table, and the licence in each row is the one that
directory's `package.json` carries. **"private" means `"private": true`** — never published
to npm, whatever the licence field says; `private: true` is a *distribution* decision, not a
licensing one, so publishing one later changes nothing about its terms.

| Component | License | Why |
|---|---|---|
| `@substrat-run/contracts` | **Apache-2.0** | The product *interface*. Verticals import it; building against Substrat must never copyleft-capture your application. Maximum diffusion is the point — the moat is runtime enforcement, not schema files. |
| `@substrat-run/cli`, `create-substrat`, `@substrat-run/model-emit`, `@substrat-run/boundary-lint` | **Apache-2.0** | The tools you run against *your own* code — the command line, the scaffold and its template, the model emitter, the layer rules. Same reason as `contracts`: a build tool that copyleft-captured its input would capture every vertical built with it. |
| `@substrat-run/kernel`, `@substrat-run/adapter-sqlite`, `@substrat-run/adapter-cloudflare`, `@substrat-run/contract-tests` | **AGPL-3.0-only** + commercial | The substrate itself. AGPL makes the self-host/escrow story real — you can always run the kernel yourself — while requiring that proprietary derivatives and hosted offerings either open their changes or hold a commercial license. |
| `@substrat-run/control-plane-api` | **AGPL-3.0-only** + commercial | The audited admin surface over the kernel's `HostAdmin` — tenant registry, scope lifecycle, entitlements, the admin log. Same terms as the substrate, and the clearest case for AGPL rather than a permissive licence: it is served *over a network*, which is exactly what §13 is about. Self-hosting it is part of the escrow guarantee; running a modified one as a hosted offering means publishing the modifications or holding a commercial licence. |
| `@substrat-run/vertical-host`, `@substrat-run/vertical-auth`, `@substrat-run/oidc-rp`, `@substrat-run/dev-issuer` | **AGPL-3.0-only** + commercial | The host a deployed vertical runs on and the auth composition it mounts — substrate, not interface: a vertical *runs on* them rather than shipping them. `dev-issuer` is published because the scaffold template imports it, and its signing key is checked in, which is why it is for development only. |
| `@substrat-run/psl`, `@substrat-run/model-providers` | **AGPL-3.0-only** + commercial | Platform internals that happen to be useful alone — the public suffix list behind hostname decisions, and the model catalogue and rate card behind platform-provided models. Same terms as the substrate. |
| `@substrat-run/engine-*` (`workorder`, `invoicing`, `booking`, `protocol`, `invites`, `metering`, `absence`) | **AGPL-3.0-only** + commercial | Engines are independently licensable modules; same terms as the kernel. |
| `connectors/*` (`@substrat-run/connector-scrive`) | **AGPL-3.0-only** + commercial | Host code that reaches a third-party API on a tenant's behalf — never module code. Same terms as the substrate it runs beside. |
| `demos/*` (Callout, Todo, ticket0, Meridian, Manyfold, the shop, RallyPoint, Handlebar, and the `auth-server` issuer) | **Apache-2.0**, private | Starting points, not products. A template is *copied* rather than imported, so it is the strongest case for the rule that governs `contracts`: building on Substrat must never copyleft-capture your application. Same tier and same patent grant. **They depend on AGPL engines** — the template is yours to do anything with, the platform it runs on is AGPL-or-commercial, and each template says so. Per the maturity ladder: fully mutable and fully unmaintained. They are `private: true` because you get one by copying this repo or by `npm create substrat`, not by installing it. |
| `packages/template-check` | **Apache-2.0**, private | The `create-substrat` template materialized as a workspace member so the compiler sees it (#878). Same licence as the template it is a copy of; private because it exists only to be compiled here. |
| `packages/ui`, `packages/adapter-email`, `packages/engine-test-kit`, `packages/builder-generator`, `packages/builder-workspace` | **AGPL-3.0-only** + commercial, private | Substrate internals that happen not to be published to npm yet. The terms are the substrate's, so that publishing one later changes nothing. |
| `apps/*` (router, control plane, console, dashboard, builder, vertical-egress, docs) | **No grant** — source-available, all rights reserved | Readable so that an evaluator can inspect the surfaces that operate their data, and unlicensed so that reading is the only thing it entitles. Not open-core: nothing is withheld from the open build to manufacture a paid tier — per decision 32 the paid layer is *operations*, which is not code. See [apps/README.md](./apps/README.md). |
| `examples/*`, `spikes/*` | **Unstated** — no `package.json` licence field, no licence file, no source header | Not workspace members and not products: `examples/external-vertical` exists to prove an npm install works, and a spike is the evidence an RFC cites. Neither declares terms of its own, and the repository root carries the AGPL text, so what applies to them is *unresolved* rather than settled either way. Whether `examples/*` should say Apache-2.0 like the demos is an open question, not a decision recorded here. |

## What this means in practice

- **Building a vertical on the hosted platform**: your code is yours. You import
  Apache-licensed `contracts` and scaffold with the Apache-licensed CLI and template; the
  AGPL kernel, host and engines run on our side of the network boundary under the
  commercial/hosted terms.
- **Self-hosting under AGPL**: fully allowed — that is the escrow guarantee. If you
  modify the kernel or engines and offer them over a network, AGPL §13 requires you to
  publish those modifications.
- **Proprietary self-host / embedding without copyleft obligations**: requires a
  commercial license — contact the maintainers.
- **Running the `apps/*` code yourself**: not licensed, at any scale — those carry no
  grant at all. The kernel, adapters, engines and `control-plane-api` underneath them
  are AGPL, so a self-hosted Substrat is built from those; a commercial license is the
  route to the first-party apps.

## Contributions

Dual licensing requires unified copyright. All contributions are accepted under a
Contributor License Agreement granting the project the right to license the
contribution under both the open-source and commercial terms (formal CLA flow to be
added before external contributions are accepted — see the master plan's governance
section).

## Copyright

Copyright © 2026 Markus Ahlstrand. (The kernel's eventual legal home — own entity vs
existing holding — is an open item in the master plan §11; the copyright line follows
that decision when made.)
