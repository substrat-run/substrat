/**
 * The builder's CI vocabulary: preview tag conventions, the PR sticky-comment bodies,
 * and the generated GitHub Actions workflow.
 *
 * It lives here — not in the dashboard, not in the CLI — for the same reason the deploy
 * manifest does: BOTH ends must speak the same shape. Three writers exist for the same
 * two artifacts and any drift between them is a silent bug:
 *
 * - the **dashboard's one-click CI setup** commits the workflow to a customer repo and
 *   (via `GithubRepoLinkDO`) posts the PR comment from the platform side;
 * - **`substrat init --ci github`** writes the same workflow for a builder who owns their
 *   own CI and never connected the GitHub App;
 * - the **workflow itself** posts the same comment from the CI side, as the fallback for
 *   an App installation that lacks `pull-requests: write`.
 *
 * The comment bodies are generated once here and rendered into the workflow's `printf`
 * format string, so the platform-written and CI-written comments cannot say different
 * things about the same PR. One generator, three writers, no drift.
 *
 * Pure string building — no zod, no network, no node. Safe in a worker, a CLI, and a
 * browser bundle alike.
 */

// ---------------------------------------------------------------------------
// Tag conventions
// ---------------------------------------------------------------------------

/**
 * The sticky preview tag for a PR — one long-lived fork, REBOUND on every push, so the
 * URL always serves the PR's latest code. The git analogy is a **branch ref**: a moving
 * pointer, bookmarked once. Successive pushes roll their migrations forward on the one
 * fork, which is the rehearsal that de-risks the eventual release.
 */
export const previewTag = (prNumber: number): string => `pr-${prNumber}`;

/**
 * The per-build preview tag — a FRESH scope per build, bound once and never rebound, so
 * the URL is frozen to exactly that build forever. The git analogy is a **sha**.
 *
 * A moving pointer is only safe when every build is *also* addressable immutably: "the bug
 * on the PR preview" must always de-reference to a fixed artifact. That is the whole reason
 * this tag exists alongside the sticky one.
 */
export const buildPreviewTag = (prNumber: number, runId: string | number): string =>
  `pr-${prNumber}-${runId}`;

/**
 * The prefix that matches every per-build tag of one PR, and NOTHING else — note that
 * PR 12's sticky tag (`pr-12`) does not start with PR 1's build prefix (`pr-1-`), so the
 * two numbering spaces never collide.
 */
export const buildPreviewTagPrefix = (prNumber: number): string => `pr-${prNumber}-`;

// ---------------------------------------------------------------------------
// The PR sticky comment
// ---------------------------------------------------------------------------

/**
 * The sticky-comment marker. Every writer upserts the comment that starts with this
 * string, so whichever of the platform and CI posts first, the other updates in place
 * rather than double-posting.
 */
export const PREVIEW_COMMENT_MARKER = '<!-- substrat-preview -->';

/**
 * The sticky comment while the preview is live.
 *
 * `build` is the per-build immutable URL and is optional: it is present only when the repo
 * opted into per-build previews (`SUBSTRAT_PER_BUILD_PREVIEW`), because a frozen scope per
 * build is a real cost that not every project wants to pay.
 *
 * NOTE: keep the prose free of apostrophes. This same text is rendered into the workflow's
 * single-quoted `printf` format string, where one apostrophe closes the quote and takes the
 * whole preview job red on what looks like a copy-edit.
 */
export function previewCommentBody(urls: { sticky: string; build?: string | null }): string {
  if (!urls.build) {
    return (
      `${PREVIEW_COMMENT_MARKER}\n🔎 **Substrat preview:** ${urls.sticky}\n\n` +
      '_Runs the code in this PR against a fork of prod, and follows the PR — every push rebinds it. ' +
      'Reaped when the PR closes._'
    );
  }
  return (
    `${PREVIEW_COMMENT_MARKER}\n🔎 **Substrat preview:** ${urls.sticky}\n📌 **This build:** ${urls.build}\n\n` +
    '_The preview URL follows the PR — every push rebinds it, so it always serves the latest code. ' +
    'The build URL is frozen to this one build and never moves. Both are reaped when the PR closes._'
  );
}

/** The sticky comment after the PR closed and the preview forks were deleted. */
export const previewReapedBody = (): string =>
  `${PREVIEW_COMMENT_MARKER}\n🔎 **Substrat preview:** reaped — this PR is closed and the preview forks were deleted.`;

// ---------------------------------------------------------------------------
// The generated workflow
// ---------------------------------------------------------------------------

/**
 * How a merge to the deploy branch turns into a prod release.
 *
 * - `trunk` — **every merge releases.** The push carries no `--version`, so the registry
 *   patch-bumps and `--promote prod` points prod at it in the same run. The simplest thing
 *   that works, and the default the dashboard commits.
 * - `changesets` — **the repo owns the version** (`package.json`), so a merge that only
 *   lands a changeset must NOT release; only the merge that MOVES the version does. The job
 *   compares `package.json` against the previous commit and no-ops when it did not change.
 *   This is the workflow the release-train table in the docs describes.
 *
 * Both are legitimate; the platform enables workflows rather than encoding one (#509 §3).
 */
export type ReleaseMode = 'trunk' | 'changesets';

export interface DeployWorkflowOptions {
  /** The branch whose pushes deploy prod. */
  branch: string;
  /** The vertical's bare slug — the control plane forms the `<tenant>/` prefix. */
  slug: string;
  /** The control-plane API base, e.g. `https://console.substrat.net/api`. */
  cpUrl: string;
  /** Defaults to `trunk`. */
  release?: ReleaseMode;
  /**
   * The vertical's directory INSIDE the repo, for a monorepo whose package is not the
   * repo root (e.g. `demos/auth-server`). Every push/preview runs against this directory,
   * the version gates read ITS package.json, and the triggers gain a `paths:` filter so a
   * merge that never touched the package does not release it. Install still runs at the
   * repo root — a workspace repo's lockfile lives there. Omitted = the repo root, exactly
   * the file this generator always produced.
   */
  path?: string;
}

/**
 * Normalize a package directory to the repo-relative form the workflow embeds: no leading
 * `./`, no trailing `/`. Root spellings (``, `.`, `./`) collapse to undefined so callers
 * cannot generate a `push ./` that means the same thing as the pathless file but diffs
 * against it. Traversal is refused here — a generator shared by three writers must not
 * rely on every caller validating.
 */
export function normalizeWorkflowDir(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.replace(/^\.\//, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return undefined;
  if (trimmed.startsWith('/') || trimmed.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`not a repo-relative package directory: '${path}'`);
  }
  return trimmed;
}

/** Render a comment body as a single-quoted `printf` format string (literal `\n`, `%s` holes). */
const printfFormat = (body: string): string => body.replace(/\n/g, '\\n');

/**
 * The workflow the one-click setup commits and `substrat init --ci github` writes.
 *
 * Self-contained on purpose: a committed file is read by humans, so there is no
 * reusable-workflow indirection to chase. The install step is load-bearing — `substrat
 * push`/`preview` runs the repo's OWN build (a wrangler custom build), which needs the
 * repo's devDependencies on disk; corepack picks the package manager from the lockfile.
 * In a monorepo (`path`) a second step builds the workspace packages the vertical imports:
 * install only *links* a sibling, and its `exports` point at a `dist/` a fresh checkout
 * does not have, so without it the very first bundle dies with `Could not resolve
 * "@scope/pkg"` — which is exactly how the first hosted push of an in-repo demo failed.
 *
 * Two behaviours are opt-in through **repository variables**, so one generated file serves
 * every project and enabling them never means regenerating it:
 *
 * - `SUBSTRAT_TEST_SCOPE_ID` — a long-lived test scope. Set it and every merge rebinds that
 *   scope to the just-built version: the "tracks main" environment, kept a CI step rather
 *   than a platform noun (a "this scope auto-tracks X" setting would be the retired
 *   dev/staging channel re-buried one layer down).
 * - `SUBSTRAT_PER_BUILD_PREVIEW` — set it to `1` and each PR push also creates a frozen,
 *   short-TTL clean-room preview whose URL names exactly that build.
 */
export function deployWorkflowYaml(opts: DeployWorkflowOptions): string {
  const { branch, slug, cpUrl } = opts;
  const release = opts.release ?? 'trunk';
  const cli = 'npx @substrat-run/cli';
  // The package directory: what push/preview build, whose package.json owns the version.
  const path = normalizeWorkflowDir(opts.path);
  const dir = path ?? '.';
  const pkgRef = path ? `./${path}/package.json` : './package.json';

  // A workspace package reaches its siblings through their package.json `exports`, and those
  // point at dist/ — which install links but never builds. Build the vertical's dependency
  // closure and nothing else: pnpm's `^...` selector is "the dependencies of, not the package
  // itself" (push runs ITS build), and a filtered `run` is in dependency order. Yarn Berry's
  // `foreach --topological-dev` is the same shape minus the selector; Yarn Classic has neither
  // `foreach` nor an order (a lockfile does not say which yarn it is, so the major is read at
  // run time), and npm runs workspaces in the order package.json lists them. Rendered only
  // for a monorepo — a single-package repo depends on published packages, which install
  // already resolved.
  const buildDeps = path
    ? `
      - name: Build workspace dependencies
        # Sibling packages resolve through their package.json exports, which point at dist/ —
        # a fresh checkout has none, and install links without building. pnpm and Yarn Berry
        # build in dependency order and skip packages without a build script (pnpm only the
        # closure this package imports). Yarn Classic and npm have no dependency order: Classic
        # runs every workspace's build and fails on one that has none; npm follows the order
        # package.json lists workspaces in, so list dependencies before dependents.
        # Delete this step if the package imports no workspace packages.
        run: |
          if [ -f pnpm-lock.yaml ]; then pnpm --filter "{${path}}^..." run --if-present build
          elif [ -f yarn.lock ] && ! yarn --version | grep -q '^1\\.'; then yarn workspaces foreach --all --topological-dev --exclude '${path}' run build
          elif [ -f yarn.lock ]; then yarn workspaces run build
          else npm run build --workspaces --if-present
          fi`
    : '';

  // The gate, between the build and every push (#955).
  //
  // A push IS a release: it uploads a bundle the platform admits and serves. So everything
  // the project enforces mechanically has to hold BEFORE the upload, not in a CI job running
  // beside this one that goes red on code prod is already serving. Outside this monorepo
  // nothing else ever runs those rules — the hosted push path is the only path a customer
  // has — which is what made R2's ambient-env ban, R5, R6 and R7 advisory for every project
  // that is not this repo.
  //
  // The three names are the gates a scaffolded project ships with (`npm create substrat`
  // writes `test`, `typecheck` and `lint:boundaries`), and each runs only if THIS package
  // declares it — never the repo root, even in a monorepo. The step above builds the
  // vertical's dependency closure and nothing else, so a root script is free to need a tool
  // this job never built: falling back to the root `lint:boundaries` is how the first
  // version of this gate died, on a `packages/boundary-lint/dist` that was correctly absent.
  // A monorepo package that wants the layer rules gated declares them itself —
  // `"lint:boundaries": "substrat-boundary-lint"` beside a devDependency on
  // @substrat-run/boundary-lint, which then IS in the closure the build step covers.
  //
  // A project that declares none of the three is still pushed — this file is regenerated
  // into repos that predate the gate, and refusing there would break their deploy on an
  // upgrade — but it says so loudly instead of passing quietly.
  const pkgRelRef = path ? `${path}/package.json` : 'package.json';
  const gate = `
      - name: Gate the push (typecheck, tests, layer rules)
        # Runs the gates ${pkgRelRef} declares — a violation fails the job before anything
        # is uploaded. Add \`test\`, \`typecheck\` and \`lint:boundaries\` scripts to gate more;
        # \`lint:boundaries\` is \`substrat-boundary-lint\` from @substrat-run/boundary-lint.
        run: |
          set -euo pipefail
          if [ -f pnpm-lock.yaml ]; then PM=pnpm
          elif [ -f yarn.lock ]; then PM=yarn
          else PM=npm
          fi
          declares() { node -e "const s=require(process.cwd()+'/'+process.argv[1]).scripts||{};process.exit(s[process.argv[2]]?0:1)" '${pkgRelRef}' "$1"; }
          RAN=''
          for s in typecheck test lint:boundaries; do
            if declares "$s"; then ( cd ${dir} && $PM run "$s" ); RAN="$RAN $s"
            else echo "no '$s' script in ${pkgRelRef} — skipped"
            fi
          done
          if [ -z "$RAN" ]; then
            echo "::warning::no typecheck, test or lint:boundaries script in ${pkgRelRef} — this push is UNGATED. See https://substrat.net/guide/deploying"
          else
            echo "gates passed:$RAN"
          fi`;

  // The install block repeats across jobs (self-contained file, see above). `fetch-depth: 2`
  // is what lets the changesets release gate diff package.json against the previous commit.
  //
  // `persist-credentials: false` because nothing here speaks git over the network after the
  // checkout: the CLI pushes with SUBSTRAT_SERVICE_TOKEN and `gh` is handed GH_TOKEN
  // explicitly. Left at its default, the workflow token sits in .git/config while the job
  // installs and builds repository-controlled code, which is one dependency away from
  // being readable.
  const setup = (fetchDepth?: number): string => `      - uses: actions/checkout@v7
        with:
          persist-credentials: false${
            fetchDepth ? `\n          fetch-depth: ${fetchDepth}` : ''
          }
      - uses: actions/setup-node@v6
        with:
          # 22+: corepack resolves the latest pnpm for lockfile-only repos, and pnpm 11
          # needs Node >= 22.13 (node:sqlite).
          node-version: 22
      - name: Install dependencies
        env:
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
        run: |
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile
          elif [ -f package-lock.json ]; then npm ci
          else npm install
          fi${buildDeps}${gate}`;

  const cpEnv = `        env:
          SUBSTRAT_SERVICE_TOKEN: \${{ secrets.SUBSTRAT_SERVICE_TOKEN }}
          SUBSTRAT_CP_URL: ${cpUrl}`;

  // --- the release step, per mode ------------------------------------------------------
  //
  // Both print the pushed version id on the `✓ pushed … version <id> …` line; the test-env
  // bind below reads it back out of the captured stdout. `set -euo pipefail` means a failed
  // push fails the step rather than letting a masked non-zero exit reach the bind.
  const release_ = release === 'changesets'
    ? `      - name: Release (only when package.json version moved)
${cpEnv}
        run: |
          set -euo pipefail
          CUR=$(node -p "require('${pkgRef}').version")
          PREV=$(git show HEAD^:${path ? `${path}/package.json` : 'package.json'} 2>/dev/null | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo '')
          if [ "$CUR" = "$PREV" ]; then
            echo "package.json version is still $CUR — this merge landed a changeset, not a release. Skipping prod."
            exit 0
          fi
          echo "releasing $CUR (was \${PREV:-none})"
          ${cli} push ${dir} --slug ${slug} --version "$CUR" --promote prod`
    : `      - name: Release to prod
${cpEnv}
        run: |
          set -euo pipefail
          ${cli} push ${dir} --slug ${slug} --promote prod`;

  // --- the "tracks main" test environment ---------------------------------------------
  //
  // Runs on EVERY merge, release or not — that is the point of a test env: it is always the
  // head of the branch, a merge ahead of prod, rehearsing each migration on accumulated data.
  // It pushes its OWN build rather than reusing the release step's, because in `changesets`
  // mode most merges produce no release at all and the test env must still move; doing it the
  // same way in both modes keeps one legible file. The label is a PRERELEASE, so this push can
  // never claim or advance the release coordinate the repo owns.
  const testEnv = `      - name: Update the test environment
        if: vars.SUBSTRAT_TEST_SCOPE_ID != ''
${cpEnv}
        run: |
          set -euo pipefail
          BASE=$(node -p "require('${pkgRef}').version")
          ${cli} push ${dir} --slug ${slug} --version "$BASE-test.\${{ github.run_number }}" | tee push.out
          # '|| true' so an unmatched grep does not trip pipefail before the message below —
          # "could not read the pushed version id" beats a bare exit 1 from grep.
          VID=$(grep -F '✓ pushed' push.out | grep -oE 'version [A-Za-z0-9]+' | head -1 | cut -d' ' -f2 || true)
          if [ -z "$VID" ]; then echo "could not read the pushed version id from:" >&2; cat push.out >&2; exit 1; fi
          ${cli} scope bind \${{ vars.SUBSTRAT_TEST_SCOPE_ID }} --version "$VID" --snapshot`;

  // --- the PR previews -----------------------------------------------------------------
  //
  // Sticky first (it is the URL a reviewer bookmarks and must exist even if the optional
  // per-build one fails), then the frozen per-build clean room when the repo opted in.
  const previewSteps = `      - name: Create/update the preview
${cpEnv}
        run: |
          set -euo pipefail
          ${cli} preview create ${dir} --slug ${slug} --tag pr-\${{ github.event.number }} | tee preview.out
          # Take the URL from the CLI success line (the ✓ marker) only — the push it runs
          # first also prints an https:// *deploy endpoint* we must never mistake for a preview.
          grep -F '✓ preview' preview.out | grep -oE 'https://[a-zA-Z0-9.:/_-]+' | tail -1 > preview.url || true
      - name: Create the per-build preview
        if: vars.SUBSTRAT_PER_BUILD_PREVIEW != ''
${cpEnv}
        run: |
          set -euo pipefail
          # A FRESH scope, bound once and never rebound, so this URL is frozen to this build
          # forever. Clean-room (--empty) rather than a fork: a throwaway per build should not
          # copy prod data every push. Short TTL — the sticky preview is the one that lives.
          ${cli} preview create ${dir} --slug ${slug} \\
            --tag pr-\${{ github.event.number }}-\${{ github.run_id }} --empty --ttl 24h | tee build.out
          grep -F '✓ preview' build.out | grep -oE 'https://[a-zA-Z0-9.:/_-]+' | tail -1 > build.url || true`;

  // The comment body comes from previewCommentBody() so the CI-written and platform-written
  // comments cannot diverge. Two formats: with and without the per-build line.
  const stickyOnlyFmt = printfFormat(previewCommentBody({ sticky: '%s' }));
  const withBuildFmt = printfFormat(previewCommentBody({ sticky: '%s', build: '%s' }));

  const commentStep = `      - name: Comment the preview URLs
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -uo pipefail
          URL=$(cat preview.url 2>/dev/null || true)
          [ -z "$URL" ] && exit 0
          BUILD=$(cat build.url 2>/dev/null || true)
          if [ -n "$BUILD" ]; then
            BODY=$(printf '${withBuildFmt}' "$URL" "$BUILD")
          else
            BODY=$(printf '${stickyOnlyFmt}' "$URL")
          fi
          REPO=\${{ github.repository }}
          PR=\${{ github.event.number }}
          ID=$(gh api "repos/$REPO/issues/$PR/comments" --jq '.[] | select(.body | startswith("${PREVIEW_COMMENT_MARKER}")) | .id' | head -1)
          if [ -n "$ID" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/$ID" -f body="$BODY" >/dev/null
          else
            gh api -X POST "repos/$REPO/issues/$PR/comments" -f body="$BODY" >/dev/null
          fi`;

  // Close ⇒ reap both forks. The per-build tag is unknown at close time (it named a run id),
  // so the sticky one is deleted by tag and the rest are left to their 24h TTL — the GC sweep
  // is the backstop the short TTL exists for.
  const cleanup = `  preview_cleanup:
    # Reap only — no repo build needed, so skip checkout/install and just run the CLI.
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    concurrency: substrat-preview-\${{ github.event.number }}
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Reap the preview
${cpEnv}
        run: ${cli} preview delete --slug ${slug} --tag pr-\${{ github.event.number }}`;

  // A nested package only deploys when a change could have affected it. The filter is
  // deliberately editable prose, not policy: a workspace package that consumes SIBLING
  // packages should add their paths, or delete the filter to deploy on every merge.
  const pathsFilter = path
    ? `
    # Only changes that can affect ${path} deploy it. If this package depends on other
    # directories of the repo (workspace packages, shared config), add their paths here —
    # or remove the filter to build on every merge.
    paths:
      - '${path}/**'
      - '.github/workflows/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'yarn.lock'
      - 'package-lock.json'`
    : '';

  const releaseNote = release === 'changesets'
    ? `    # Release train: the version lives in package.json and only a version PR moves it, so a
    # merge releases ONLY when that version changed. Every merge still updates the test env.`
    : `    # Trunk-based: every merge to ${branch} releases. A private vertical's push lands admitted
    # and prod is self-serve, so the same run points prod at the new version.`;

  return `name: Deploy to Substrat

# Generated by Substrat (substrat init --ci github). The workflow this encodes — one prod
# channel, previews as the only non-prod environment — is documented at
# https://substrat.net/guide/environments-and-previews${
    path
      ? `\n#\n# Monorepo: this deploys the '${slug}' vertical from ${path}/. Dependencies still install\n# at the repo root (the workspace lockfile lives there), and the workspace packages this\n# vertical imports are built before every push — a sibling resolves through its dist/.`
      : ''
  }
#
# Optional repository variables (Settings → Secrets and variables → Actions → Variables):
#   SUBSTRAT_TEST_SCOPE_ID      a long-lived scope rebound to every merge (the test env)
#   SUBSTRAT_PER_BUILD_PREVIEW  set to 1 to also mint a frozen per-build preview URL per push

on:
  push:
    branches: [${branch}]${pathsFilter}
  # Per-PR previews: open/update a PR → a preview instance running the PR's code against a
  # FORK of prod on its own URL; close the PR → it is reaped (the TTL is the GC backstop).
  pull_request:
    types: [opened, synchronize, reopened, closed]${pathsFilter}

jobs:
  deploy:
${releaseNote}
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
${setup(release === 'changesets' ? 2 : undefined)}
${release_}
${testEnv}

  preview:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    runs-on: ubuntu-latest
    # Never overlap two runs for the same PR — a rapid re-push waits for the first.
    concurrency: substrat-preview-\${{ github.event.number }}
    permissions:
      contents: read
      pull-requests: write
    steps:
${setup()}
${previewSteps}
${commentStep}

${cleanup}
`;
}
