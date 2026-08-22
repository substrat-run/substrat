#!/usr/bin/env node
/**
 * The scaffold checkpoint (#797) — run what a user runs, against what we shipped.
 *
 * `packages/create-substrat/template` carries a complete working vertical: `src/`,
 * `test/scenario.test.ts`, two tsconfigs. None of it runs in CI. The workspace globs
 * are `packages/*`, so `packages/create-substrat` is a member but `template/` under it
 * is not — its scenario tests have never been executed by `pnpm test` and its
 * `typecheck` script has never been run. #796 found it broken against current packages
 * (1 of 9 scenario tests failing, 2 type errors) and it had been that way for four
 * minors. #796 fixed the breakage and froze the pins; this is the check that would
 * have caught it.
 *
 * ## Why the template is not simply made a workspace member
 *
 * That would resolve `@substrat-run/*` to the workspace, which is exactly what must NOT
 * happen. The template's whole job is to prove that a project installing from **npm**,
 * with published version ranges and no workspace links, works. A workspace-linked
 * template passes while every real scaffold fails — the failure mode we just had, in a
 * new costume. So this installs from the registry, like a user.
 *
 * ## Why there is no `pull_request` trigger
 *
 * This check is only honest AFTER a release, and that is not a scheduling preference —
 * it is a property of the thing being checked. Between a merge that adds a surface and
 * the release that publishes it, the template legitimately runs AHEAD of npm: #812
 * landed `ctx.now()` and rewrote the template's `src/module.ts` to call it, while the
 * emitted pins still said `^0.83.0`, a version with no `ctx.now`. Scaffold-and-install
 * at that moment is red, and correctly so — nothing is wrong with the PR. A
 * `pull_request` trigger would spend that red on every template edit and get suppressed
 * wholesale, which is worse than not having the check.
 *
 * The release is the first moment the artifact under test exists. So: post-release
 * (release.yml), weekly (a transitive dependency moving under a frozen scaffold), and
 * on demand.
 *
 * ## What red means
 *
 * A published engine moving is not the scaffolder's fault, so a failure names the
 * surface that moved rather than just failing. Every gate runs even after one fails, so
 * one run reports the whole picture, and the diagnosis prints the declared pins beside
 * the versions that actually resolved.
 *
 *   node tools/scaffold-check.mjs                 # scaffold from the registry, as a user does
 *   node tools/scaffold-check.mjs --from=local    # use this checkout's index.js instead
 *   node tools/scaffold-check.mjs --keep          # leave the scaffold behind for poking at
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const FROM = (args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? 'registry').trim();
if (FROM !== 'registry' && FROM !== 'local') {
  process.stderr.write(`scaffold-check: --from must be 'registry' or 'local', got '${FROM}'\n`);
  process.exit(2);
}

const PKG_DIR = 'packages/create-substrat';
const VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;

/**
 * The npm packument is not readable the instant `pnpm publish` returns, so a
 * post-release run can arrive before the version it is meant to test. Bounded on
 * purpose: if it never appears, that is a failed release, and reporting "the release
 * did not publish" is more useful than a scaffold error twenty minutes later.
 */
const PUBLISH_WAIT_TRIES = 12;
const PUBLISH_WAIT_MS = 15_000;

/** The gates a scaffolded project ships with — every one runs, even after a failure. */
const GATES = [
  { name: 'npm test', argv: ['test'] },
  { name: 'npm run typecheck', argv: ['run', 'typecheck'] },
  { name: 'npm run lint:boundaries', argv: ['run', 'lint:boundaries'] },
];

function run(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, status: r.status, output };
}

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

/** `npm view` on an exact version: prints it when published, exits non-zero when not. */
function isPublished(version) {
  return run('npm', ['view', `create-substrat@${version}`, 'version'], process.cwd()).ok;
}

async function waitForPublish(version) {
  for (let i = 1; i <= PUBLISH_WAIT_TRIES; i++) {
    if (isPublished(version)) return true;
    log(`  create-substrat@${version} not on the registry yet (${i}/${PUBLISH_WAIT_TRIES}) …`);
    await new Promise((r) => setTimeout(r, PUBLISH_WAIT_MS));
  }
  return isPublished(version);
}

/** `^0.83.0` → `0.83.0`. The floor is what the pin was written against. */
function floorOf(range) {
  const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(range ?? '');
  return m ? m[1] : null;
}

function compareSemver(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Unreleased work sitting in the checkout. This is the load-bearing half of "is the
 * template ahead of npm", and the version comparison below is not enough on its own:
 * between a feature merge and the Version Packages PR, package.json still says the
 * PUBLISHED version while the tree already holds the surface the template calls. That
 * is precisely the #812 state — `ctx.now()` in the template, kernel still 0.83.0 in
 * both places, and `ctx.now` in neither.
 */
function pendingChangesets() {
  if (!existsSync('.changeset')) return [];
  return readdirSync('.changeset').filter((f) => f.endsWith('.md') && f !== 'README.md');
}

/**
 * Every `@substrat-run/*` version in THIS checkout. The other half: during a Version
 * Packages PR the manifests ARE bumped and nothing is published yet, so a checkout
 * version above the resolved one is the same "ahead of npm" state by a different route.
 */
function checkoutVersions() {
  const map = new Map();
  for (const root of ['packages', 'engines']) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name?.startsWith('@substrat-run/')) map.set(pkg.name, pkg.version);
    }
  }
  return map;
}

/**
 * What the scaffold DECLARED against what npm actually gave it. A caret on 0.x locks
 * the minor, so a resolved version above the pin's floor is a patch that shipped after
 * the pin was written — the honest candidates for "the surface that moved".
 */
function resolvedVersions(dir) {
  const checkout = checkoutVersions();
  const declared = (() => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  })();
  const scope = join(dir, 'node_modules', '@substrat-run');
  const rows = [];
  for (const [name, range] of Object.entries(declared)) {
    if (!name.startsWith('@substrat-run/')) continue;
    const manifest = join(scope, name.slice('@substrat-run/'.length), 'package.json');
    const installed = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, 'utf8')).version
      : null;
    const floor = floorOf(range);
    const local = checkout.get(name) ?? null;
    rows.push({
      name,
      range,
      installed,
      checkout: local,
      moved: installed && floor ? compareSemver(installed, floor) > 0 : false,
      ahead: installed && local ? compareSemver(local, installed) > 0 : false,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function summarise(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
}

async function main() {
  const parent = mkdtempSync(join(tmpdir(), 'substrat-scaffold-'));
  const dir = join(parent, 'scaffold-check');
  let failed = false;

  try {
    // 1. Scaffold. From the registry by default: the artifact under test is the
    //    PUBLISHED one, and pinning the exact version doubles as proof the release
    //    actually landed rather than trusting `@latest` to have caught up.
    log(`# scaffold-check — create-substrat@${VERSION} (--from=${FROM})\n`);
    if (FROM === 'registry') {
      if (!(await waitForPublish(VERSION))) {
        log(`FAIL  create-substrat@${VERSION} is not on the registry.`);
        log('');
        log('      The checkout says that version; npm does not have it. This is a');
        log('      release that did not publish, not a broken scaffold — check the');
        log('      publish step in release.yml before looking at the template.');
        summarise([
          '### Scaffold check — release did not publish',
          '',
          `\`create-substrat@${VERSION}\` is in the checkout but not on the registry.`,
        ]);
        failed = true;
        return false;
      }
      const r = run(
        'npm',
        ['exec', '--yes', `--package=create-substrat@${VERSION}`, '--', 'create-substrat', dir],
        process.cwd(),
      );
      log(r.output.trimEnd());
      if (!r.ok) {
        log(`\nFAIL  the published scaffolder exited ${r.status}.`);
        failed = true;
        return false;
      }
    } else {
      const r = run('node', [join(PKG_DIR, 'index.js'), dir], process.cwd());
      log(r.output.trimEnd());
      if (!r.ok) {
        log(`\nFAIL  the local scaffolder exited ${r.status}.`);
        failed = true;
        return false;
      }
    }

    // 2. Install from the registry, with no workspace links — which also proves the
    //    emitted pins resolve at all. A caret on 0.x locks the minor, so a stale pin
    //    does not drift forward, it stops resolving.
    log('\n## npm install\n');
    const install = run('npm', ['install', '--no-audit', '--no-fund'], dir);
    log(install.output.trimEnd());
    if (!install.ok) {
      const unresolvable = [...install.output.matchAll(/No matching version found for (\S+)/g)].map(
        (m) => m[1],
      );
      log(`\nFAIL  npm install exited ${install.status}.`);
      log('');
      if (unresolvable.length) {
        log('      The emitted pins do not resolve:');
        for (const spec of unresolvable) log(`        ${spec}`);
        log('');
        log('      `pnpm lint:pins` writes that block from each package\'s own version');
        log('      and `version-packages` runs the write — so a pin naming a version');
        log('      nobody published means the release moved without the pins.');
      } else {
        log('      Not a pin-resolution failure — read the npm output above.');
      }
      summarise([
        '### Scaffold check — install failed',
        '',
        ...(unresolvable.length
          ? ['Unresolvable pins:', '', ...unresolvable.map((s) => `- \`${s}\``)]
          : ['`npm install` failed; see the job log.']),
      ]);
      failed = true;
      return false;
    }

    // 3. Every gate the scaffold ships with, all of them, so one run names the whole
    //    picture rather than the first thing that broke.
    const results = [];
    for (const gate of GATES) {
      log(`\n## ${gate.name}\n`);
      const r = run('npm', gate.argv, dir);
      log(r.output.trimEnd());
      results.push({ ...gate, ...r });
      if (!r.ok) failed = true;
    }

    // 4. The verdict, and — when red — the surface that moved.
    const rows = resolvedVersions(dir);
    log('\n## verdict\n');
    for (const r of results) log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.name}`);

    if (!failed) {
      log(`\n  The scaffold a user gets from create-substrat@${VERSION} is green.`);
      summarise([
        '### Scaffold check — green',
        '',
        `\`create-substrat@${VERSION}\` scaffolds, installs from npm, and passes all three gates.`,
      ]);
      return true;
    }

    const moved = rows.filter((r) => r.moved);
    const aheadRows = rows.filter((r) => r.ahead);
    const pending = pendingChangesets();
    const ahead = aheadRows.length > 0 || pending.length > 0;
    log('\n  Declared pin → resolved:\n');
    for (const r of rows) {
      const mark = r.moved
        ? '  ← moved since the pin'
        : r.ahead
          ? `  ← checkout has ${r.checkout}, unpublished`
          : '';
      log(`    ${r.name.padEnd(34)} ${String(r.range).padEnd(10)} → ${r.installed ?? 'MISSING'}${mark}`);
    }
    log('');
    if (ahead) {
      // The #812 shape, and the reason there is no `pull_request` trigger. Naming it
      // is the difference between "go fix the template" and "wait for the release".
      log('  The template is AHEAD of npm: this checkout holds work the registry has not');
      log('  seen, so the scaffold is compiling against a surface nobody has shipped yet.');
      log('  Between a merge that adds a surface and the release that publishes it, this');
      log('  red is expected and no fix belongs in the template.');
      log('');
      for (const r of aheadRows) log(`    ${r.name}  npm ${r.installed}  ·  checkout ${r.checkout}`);
      if (pending.length) {
        log(`    ${pending.length} unreleased changeset${pending.length === 1 ? '' : 's'}:`);
        for (const f of pending) log(`      .changeset/${f}`);
      }
      log('');
      log('  On a post-release run this must NOT appear — `version-packages` rewrites the');
      log('  pins in the same commit that publishes. If it does, the release moved without');
      log('  the pins, and `pnpm lint:pins` is the thing that failed.');
    } else if (moved.length) {
      log('  A published surface moved under a frozen template. The scaffolder did not');
      log('  change; these did, and they are where to look first:');
      for (const r of moved) log(`    ${r.name} ${r.range} → ${r.installed}`);
      log('');
      log('  The fix belongs in packages/create-substrat/template — a repair made in a');
      log('  scaffolded project never comes home.');
    } else {
      log('  Every @substrat-run pin resolved to exactly the version it was written');
      log('  against, and the checkout is no further ahead — so nothing of ours moved');
      log('  underneath it. The break is in the template itself, or in a non-Substrat');
      log('  dependency that drifted.');
      log('');
      log('  The fix belongs in packages/create-substrat/template — a repair made in a');
      log('  scaffolded project never comes home.');
    }

    summarise([
      '### Scaffold check — red',
      '',
      `\`create-substrat@${VERSION}\` scaffolds and installs, but does not pass its own gates.`,
      '',
      ...results.map((r) => `- ${r.ok ? '✅' : '❌'} \`${r.name}\``),
      '',
      '| package | pin | resolved | checkout |',
      '|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| \`${r.name}\` | \`${r.range}\` | ${r.installed ?? 'MISSING'}${r.moved ? ' ⚠️ moved' : ''} | ${r.checkout ?? '—'}${r.ahead ? ' ⚠️ unpublished' : ''} |`,
      ),
      '',
      ahead
        ? 'The template is **ahead of npm** — it uses a surface no release has published yet. Expected before the release; a `lint:pins` failure after one.'
        : moved.length
          ? 'A published surface moved under a frozen template.'
          : 'Nothing of ours moved — the break is in the template itself.',
    ]);

    return false;
  } catch (err) {
    // An unexpected throw is still a red run, and the scaffold it left behind is still
    // the evidence — never clean up on the path we understand least.
    log(`\nFAIL  scaffold-check threw: ${err?.stack ?? err}`);
    failed = true;
    return false;
  } finally {
    // Nothing to keep when the run died before anything was scaffolded — saying
    // "kept at" over an empty path sends the reader somewhere with no evidence in it.
    if ((KEEP || failed) && existsSync(dir)) {
      log(`\n  scaffold kept at ${dir}`);
    } else {
      rmSync(parent, { recursive: true, force: true });
    }
  }
}

// The exit code is set here, never inside the try — `process.exit()` does not run a
// `finally`, and every failure path needs the one above to say where it left the
// scaffold standing.
process.exit((await main()) ? 0 : 1);
