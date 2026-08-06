import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deployWorkflowYaml, type ReleaseMode } from '@substrat-run/contracts';

/**
 * `substrat init --ci github` — write the deploy workflow into the repo.
 *
 * The dashboard's one-click setup commits this same file for a builder who connected the
 * GitHub App; this is the path for everyone else — a builder who owns their own CI, or one
 * who wants the release-train shape rather than the trunk-based default. Both render from
 * the ONE generator in `@substrat-run/contracts`, so the two paths cannot diverge.
 *
 * Why it exists at all: the workflow encodes a version-label discipline (a prerelease label
 * for every non-release push, so previews and the test env never claim or advance the
 * coordinate the repo owns) that is real, load-bearing, and completely undiscoverable from
 * `--help`. Every vertical would otherwise re-derive it, and get it wrong the way our own
 * registry got holes punched in it (#509).
 */

export interface InitCiOptions {
  /** Repo root to write into. */
  dir: string;
  /** The vertical's bare slug. */
  slug: string;
  /** The branch whose pushes deploy prod. */
  branch: string;
  /** Control-plane API base baked into the workflow. */
  cpUrl: string;
  release: ReleaseMode;
  /** Overwrite an existing file (default: refuse, so a customized workflow is never clobbered). */
  force: boolean;
  /** Where to write, relative to `dir`. */
  path?: string;
}

export const DEFAULT_WORKFLOW_PATH = '.github/workflows/substrat-deploy.yml';

export interface InitCiResult {
  /** Absolute path written. */
  file: string;
  /** True when a file was already there and `--force` replaced it. */
  overwritten: boolean;
}

/**
 * Render and write the workflow. Refuses to clobber an existing file without `force`:
 * this file is meant to be edited after generation (it is a normal workflow, not a managed
 * artifact), so silently overwriting a builder's edits would be the worst possible default.
 */
export function writeCiWorkflow(opts: InitCiOptions): InitCiResult {
  const rel = opts.path ?? DEFAULT_WORKFLOW_PATH;
  const file = join(opts.dir, rel);
  const overwritten = existsSync(file);
  if (overwritten && !opts.force) {
    throw new Error(
      `${rel} already exists — pass --force to replace it (it is a normal workflow file; ` +
        'edits you made after generating it would be lost).',
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    deployWorkflowYaml({ branch: opts.branch, slug: opts.slug, cpUrl: opts.cpUrl, release: opts.release }),
  );
  return { file, overwritten };
}

/**
 * The repo's default branch, best-effort, for the `--branch` default. Reads
 * `.git/HEAD` rather than shelling out to git: the CLI must run where git may not be
 * installed, and a wrong guess here only means the builder passes `--branch`.
 */
export function detectDefaultBranch(dir: string): string {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m?.[1]) return m[1];
  } catch {
    // No git checkout (or a detached HEAD) — `main` is the right guess for a new repo.
  }
  return 'main';
}

/** The follow-up a generated workflow needs before its first run can authenticate. */
export function nextStepsMessage(slug: string, release: ReleaseMode): string {
  const lines = [
    '',
    'Next:',
    '  1. Add the push token as a repository secret named SUBSTRAT_SERVICE_TOKEN',
    '     (Settings → Secrets and variables → Actions). The dashboard mints one under',
    '     Deployments → CI setup; it is the `spt1.…` tenant-scoped credential.',
    '  2. Commit the workflow. The first push to the deploy branch registers the vertical —',
    `     until then there is no '${slug}' in the dashboard to hang an error off, so a failed`,
    '     first run shows up in the repository Actions tab, not in Deployments.',
    '',
    'Optional repository VARIABLES (same page, Variables tab):',
    '  SUBSTRAT_TEST_SCOPE_ID      a long-lived scope rebound on every merge — the test',
    '                              environment. Create one with:',
    `                                substrat preview create . --tag test --ttl none`,
    '                                substrat scope domain <scopeId> --domain test.example.com',
    '  SUBSTRAT_PER_BUILD_PREVIEW  set to 1 to also mint a frozen per-build preview URL on',
    '                              each PR push, alongside the sticky one',
    '',
  ];
  if (release === 'changesets') {
    lines.push(
      'Release mode: changesets — a merge releases ONLY when package.json version changed,',
      'so ordinary merges just move the test environment. Prod moves when the version PR lands.',
      '',
    );
  } else {
    lines.push(
      'Release mode: trunk — every merge to the deploy branch releases to prod. Use',
      '`--release changesets` if your repo owns its version (changesets, release-please, …).',
      '',
    );
  }
  return lines.join('\n');
}
