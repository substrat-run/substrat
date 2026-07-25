# @substrat-run/boundary-lint

## 0.0.3

### Patch Changes

- 6a7768a: Recognize `auth-do.ts` as harness. A Durable Object that wires an authentication adapter
  (Better Auth over the DO's own SQLite) is the workerd analogue of the already-exempt
  `auth-node.ts` — edge auth wiring, not module code — so its `fetch` request-interface method
  is no longer mistaken for a network call by the R3 rule.

## 0.0.2

### Patch Changes

- d0cb7a6: Treat `page.ts` and `oidc.ts` as harness. A served SPA (an HTML/JS string the worker
  returns) is edge wiring, not module code reachable from a `ModuleRegistration` — its
  `fetch` is browser code. `oidc.ts` is an OIDC relying party at the server edge (token
  exchange, JWKS) — the same node/network-touching auth-adapter class as `auth.ts`.
  Both added to `DEFAULT_HARNESS` alongside `worker.ts`/`routes.ts`, so R3 (no network
  in module code) no longer false-positives on a vertical's served page or auth edge.
- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.
