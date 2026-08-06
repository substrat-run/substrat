---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

feat(ci): generate the deploy workflow, and name an immutable per-build preview URL (#509)

The CI recipe is now a generator rather than prose. `deployWorkflowYaml` moves into
`@substrat-run/contracts`, and the new `substrat init --ci github` writes the same
`.github/workflows/substrat-deploy.yml` the dashboard's one-click setup commits — for the
builder who owns their own CI, or who wants the release-train shape (`--release changesets`:
only a `package.json` version move releases; ordinary merges just move the test env).

Why generate it: the workflow encodes a version-label discipline that is load-bearing and
undiscoverable from `--help`, and the hand-written one got it wrong — it pushed
`--version 0.1.<run number>` on every run, claiming a real registry patch coordinate each time
and punching holes in the version sequence. Generated runs now use the registry bump for a
trunk release, the repo's own version for a changesets release, and a semver **prerelease**
label for everything else, which `nextVersion`'s anchored parse skips.

The PR sticky comment now names **two** URLs: the sticky `--pr-<n>` preview, which is rebound
on every push, and — when the repo opts in with the `SUBSTRAT_PER_BUILD_PREVIEW` variable — an
immutable `--pr-<n>-<run>` URL frozen to exactly that build. A moving pointer is only safe when
every build is also addressable, so "the bug on the PR preview" can always de-reference to a
fixed artifact. The comment bodies are rendered from one module for both writers, so the
CI-written and platform-written comments are byte-identical rather than merely similar.
`SUBSTRAT_TEST_SCOPE_ID` likewise makes every merge rebind a long-lived test environment,
keeping "tracks main" a CI step rather than a platform noun.
