---
---

No package release: this changes the monorepo's own gates, not any published source.

`.builder/projects/*` are gitignored builder-studio scratch projects that are also pnpm
workspace members (deliberately — `workspace:*` deps must resolve and the per-project
gates must run). The root sweeps now exclude them and a pre-commit hook keeps them out of
the committed lockfile. Nothing under `packages/`, `engines/` or `connectors/` is touched,
so bumping anything here would publish unchanged code — the app-only-changeset trap
recorded in #451.
