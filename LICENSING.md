# Licensing

Substrat is **dual-licensed**. Every package carries its license in `package.json` and
ships the full text in its tarball.

## The model

| Component | License | Why |
|---|---|---|
| `@substrat-run/contracts` (and the future SDK) | **Apache-2.0** | The product *interface*. Verticals import these; building against Substrat must never copyleft-capture your application. Maximum diffusion is the point — the moat is runtime enforcement, not schema files. |
| `@substrat-run/kernel`, `@substrat-run/adapter-sqlite`, `@substrat-run/adapter-cloudflare`, `@substrat-run/contract-tests` | **AGPL-3.0-only** + commercial | The substrate itself. AGPL makes the self-host/escrow story real — you can always run the kernel yourself — while requiring that proprietary derivatives and hosted offerings either open their changes or hold a commercial license. |
| `@substrat-run/control-plane-api` | **AGPL-3.0-only** + commercial | The audited admin surface over the kernel's `HostAdmin` — tenant registry, scope lifecycle, entitlements, the admin log. Same terms as the substrate, and the clearest case for AGPL rather than a permissive licence: it is served *over a network*, which is exactly what §13 is about. Self-hosting it is part of the escrow guarantee; running a modified one as a hosted offering means publishing the modifications or holding a commercial licence. |
| `@substrat-run/engine-*` | **AGPL-3.0-only** + commercial | Engines are independently licensable modules; same terms as the kernel. |
| `demos/*` (the templates: Callout, Handlebar, Meridian, RallyPoint, the shop) | **Apache-2.0** | Starting points, not products. A template is *copied* rather than imported, so it is the strongest case for the rule that governs `contracts`: building on Substrat must never copyleft-capture your application. Same tier and same patent grant. **They depend on AGPL engines** — the template is yours to do anything with, the platform it runs on is AGPL-or-commercial, and each template says so. Per the maturity ladder: fully mutable and fully unmaintained. |
| Unpublished workspace packages (`packages/ui`, `packages/adapter-email`, `packages/engine-test-kit`, `packages/builder-*`) | **AGPL-3.0-only** + commercial | Substrate internals that happen not to be published to npm yet. `private: true` is a *distribution* decision, not a licensing one — the terms are the substrate's, so that publishing one later changes nothing. |
| `apps/*` (control plane, router, dashboard, console, builder, docs) | **No grant** — source-available, all rights reserved | Readable so that an evaluator can inspect the surfaces that operate their data, and unlicensed so that reading is the only thing it entitles. Not open-core: nothing is withheld from the open build to manufacture a paid tier — per decision 32 the paid layer is *operations*, which is not code. See [apps/README.md](./apps/README.md). |

## What this means in practice

- **Building a vertical on the hosted platform**: your code is yours. You import
  Apache-licensed contracts/SDK; the AGPL kernel runs on our side of the network
  boundary under the commercial/hosted terms.
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
