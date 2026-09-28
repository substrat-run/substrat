#!/usr/bin/env tsx
/**
 * The scaffold-pin checkpoint — `create-substrat` asks npm for what we actually ship.
 *
 * `packages/create-substrat/index.js` writes dependency ranges into every scaffolded
 * project. Those ranges are hand-typed copies of numbers that already live in each
 * package's own `package.json`, and changesets moves the originals on every release
 * without telling the copies. So they go stale, and they have twice:
 *
 *   1. Resolving nothing — pinned `^0.3.37` after workorder moved to 0.4.x, so a
 *      freshly scaffolded project could not install. Loud, and fixed quickly.
 *   2. Resolving fine — pinned `^0.71.0`/`^0.4.3` while we shipped 0.75.0/0.6.2. This
 *      is the worse one. Everything installs, so nothing complains, and the template
 *      sits frozen against packages nobody runs. Its own scenario test stayed green
 *      for four minors while the engine surface moved underneath it (invoicing split
 *      line provenance, vertical-host retyped its provision hooks) — and the session
 *      hook then pointed every new project at a docs slice that 404s, because the
 *      kernel it installed was four minors old.
 *
 * A caret on 0.x pins the MINOR, which is what makes both failures possible: the
 * range never drifts forward on its own, so a stale constant is a decision nobody
 * remembers making.
 *
 * §6 of design/agent-surface.md picks the guard: two copies that must read
 * identically get a regenerate-and-diff, like lint:launch, lint:agent-rules and
 * lint:plugin. The source is each package's `version`; the constant is emitted.
 *
 * ## Where the write runs
 *
 * `changeset version` is the moment the numbers move, so `version-packages` runs this
 * straight after it and the Version-packages PR carries both. CI's `--check` then only
 * fires when someone edits the block by hand. When the write moves a pin and the release
 * did not already bump create-substrat, it patch-bumps it too — otherwise the new pins
 * sit in a package changesets never publishes (#1876).
 *
 * ## What this does NOT check
 *
 * Whether the template still COMPILES against the versions it names. It cannot: that
 * needs the scaffold built and tested against published packages, which is a separate
 * job. Honest pins and a working template are two different questions, and this
 * answers the first one only.
 *
 * Both halves of the second question now have a home, and neither is here:
 * `lint:scaffold` (#797) installs from the registry post-release, and
 * `packages/template-check` (#878) compiles the template against the WORKSPACE on
 * every PR. The second one exists because of what this file does automatically —
 * advancing a pin across a minor in the same PR as the bump means the template
 * silently adopts a new surface, and #811 is what that costs when nobody compiles it.
 *
 *   pnpm lint:pins            re-emit the pin block from the workspace versions
 *   pnpm lint:pins --check    CI: exit 1 on drift
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const check = process.argv.includes('--check');

const SCAFFOLDER = 'packages/create-substrat/index.js';
const CHANGESETS = '.changeset/config.json';

/**
 * Each constant, and the workspace package whose version it must carry.
 *
 * `SUBSTRAT` names one member of the changesets `fixed` group; the whole group is
 * verified to agree below, because "one constant is right for all of them" is only
 * true while that grouping holds.
 */
const PINS = [
  { constant: 'SUBSTRAT', pkg: 'packages/kernel', fixedGroup: true },
  { constant: 'ENGINE_WORKORDER', pkg: 'engines/workorder', fixedGroup: false },
  { constant: 'ENGINE_INVOICING', pkg: 'engines/invoicing', fixedGroup: false },
  { constant: 'BOUNDARY_LINT', pkg: 'packages/boundary-lint', fixedGroup: false },
  { constant: 'DEV_ISSUER', pkg: 'packages/dev-issuer', fixedGroup: false },
] as const;

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`pins: ${message}\n`);
  process.exit(2);
}

function readJson(rel: string): Record<string, any> {
  const absolute = join(ROOT, rel);
  if (!existsSync(absolute)) cannot(`missing: ${rel}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return cannot(`not valid JSON: ${rel}`);
  }
}

function versionOf(pkgDir: string): string {
  const version = readJson(join(pkgDir, 'package.json')).version;
  if (typeof version !== 'string' || !version) {
    cannot(`${pkgDir}/package.json has no version — nothing to pin to.`);
  }
  return version;
}

// ── The fixed group really is fixed ──────────────────────────────────────────
//
// One SUBSTRAT constant covers seven packages. If the group is ever split, six of
// them silently get a range that describes a seventh — the same class of bug as a
// single ENGINES constant, and quieter, because they would still resolve.

const fixed: string[][] = readJson(CHANGESETS).fixed ?? [];
const group = fixed.find((g) => g.includes('@substrat-run/kernel'));
if (!group) {
  cannot(
    `@substrat-run/kernel is not in a changesets \`fixed\` group (${CHANGESETS}).\n` +
      `  SUBSTRAT is one range for every runtime package, which is only correct while\n` +
      `  they version together. Give each its own pin, or restore the group.`,
  );
}

const groupVersions = new Map<string, string>();
for (const name of group) {
  const dir = ['packages', 'engines', 'connectors']
    .map((base) => join(base, name.replace('@substrat-run/', '')))
    .find((candidate) => existsSync(join(ROOT, candidate, 'package.json')));
  if (!dir) cannot(`cannot locate the workspace package for ${name}.`);
  groupVersions.set(name, versionOf(dir));
}

const distinct = [...new Set(groupVersions.values())];
if (distinct.length > 1) {
  console.error(
    `pins: the runtime packages are meant to version together, but they do not:\n\n` +
      [...groupVersions].map(([n, v]) => `  ${v.padEnd(10)} ${n}`).join('\n') +
      `\n\n  SUBSTRAT is a single range for all of them, so this makes it wrong for\n` +
      `  every package not on the majority version. Reconcile the release, or give\n` +
      `  each package its own pin here and in ${SCAFFOLDER}.\n`,
  );
  process.exit(1);
}

// ── Emit ─────────────────────────────────────────────────────────────────────

const absolute = join(ROOT, SCAFFOLDER);
if (!existsSync(absolute)) cannot(`missing: ${SCAFFOLDER}`);

const current = readFileSync(absolute, 'utf8');
let next = current;
const wrong: string[] = [];
/** The same moves, for a changelog reader: package names, not constant names. */
const moved: string[] = [];

for (const { constant, pkg } of PINS) {
  const want = `^${versionOf(pkg)}`;
  const pattern = new RegExp(`(const ${constant} = ')([^']*)(';)`);
  const found = current.match(pattern);
  if (!found) {
    cannot(
      `${SCAFFOLDER} declares no \`const ${constant} = '…';\`.\n` +
        `  This tool rewrites that exact shape. Restore it, or drop ${constant} from PINS.`,
    );
  }
  if (found[2] !== want) {
    wrong.push(`  ${constant.padEnd(18)} ${found[2]}  →  ${want}`);
    const name = readJson(join(pkg, 'package.json')).name;
    moved.push(constant === 'SUBSTRAT' ? `\`${name}\` and the runtime packages versioned with it: \`${want}\`` : `\`${name}\`: \`${want}\``);
  }
  next = next.replace(pattern, `$1${want}$3`);
}

if (next === current) {
  console.log(`pins: ${SCAFFOLDER} pins the versions this workspace ships.`);
  process.exit(0);
}

if (check) {
  console.error(
    `pins: ${SCAFFOLDER} pins versions this workspace no longer ships.\n\n` +
      `${wrong.join('\n')}\n\n` +
      `  Every scaffolded project gets these ranges, and a caret on 0.x locks the minor —\n` +
      `  so a stale pin does not drift forward, it freezes new projects on old packages.\n` +
      `  Run \`pnpm lint:pins\` and commit the result.\n\n` +
      `  If the bump crosses a minor, check the template still builds against it before\n` +
      `  you ship: honest pins and a working template are different questions, and this\n` +
      `  checkpoint only answers the first.\n`,
  );
  process.exit(1);
}

writeFileSync(absolute, next);
console.log(`pins: updated ${SCAFFOLDER}\n${wrong.join('\n')}`);

// ── The new pins have to ship ────────────────────────────────────────────────
//
// Rewriting index.js is half the job: npm serves the create-substrat that was last
// PUBLISHED, and changesets only publishes a package whose version moved. No changeset
// names create-substrat when the runtime packages release, so the Version-packages PR
// carried fresh pins in a package it never bumped — #1876 moved every pin to ^0.126.0
// while npm kept serving 0.10.0 pinned at ^0.124.0, and engine-workorder 0.12.10
// (kernel ^0.126.0) then installed a second kernel into every new scaffold, which
// failed its own typecheck. So when the pins move and this release did not already
// bump create-substrat, bump it here, with a changelog entry saying why.

const SCAFFOLDER_PKG = 'packages/create-substrat/package.json';
const SCAFFOLDER_CHANGELOG = 'packages/create-substrat/CHANGELOG.md';

let committed: string;
try {
  committed = JSON.parse(
    execFileSync('git', ['show', `HEAD:${SCAFFOLDER_PKG}`], { cwd: ROOT, encoding: 'utf8' }),
  ).version;
} catch {
  cannot(
    `cannot read ${SCAFFOLDER_PKG} at HEAD, so cannot tell whether this release already\n` +
      `  bumps create-substrat. Run inside the git checkout the release is cut from.`,
  );
}

const scaffolderPkg = readJson(SCAFFOLDER_PKG);
if (scaffolderPkg.version !== committed) {
  console.log(`pins: create-substrat already moves ${committed} → ${scaffolderPkg.version} in this release.`);
  process.exit(0);
}

const parts = String(committed).split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  cannot(`${SCAFFOLDER_PKG} version '${committed}' is not major.minor.patch.`);
}
const bumped = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const pkgText = readFileSync(join(ROOT, SCAFFOLDER_PKG), 'utf8');
writeFileSync(
  join(ROOT, SCAFFOLDER_PKG),
  pkgText.replace(`"version": "${committed}"`, `"version": "${bumped}"`),
);
if (readJson(SCAFFOLDER_PKG).version !== bumped) {
  cannot(`could not rewrite the version in ${SCAFFOLDER_PKG}; bump create-substrat by hand.`);
}

const entry =
  `## ${bumped}\n\n### Patch Changes\n\n` +
  `- A new project now installs the package versions released alongside this one:\n` +
  moved.map((line) => `  - ${line}\n`).join('');
const changelogPath = join(ROOT, SCAFFOLDER_CHANGELOG);
const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# create-substrat\n';
const heading = changelog.match(/^# .*\n+/);
writeFileSync(
  changelogPath,
  heading ? heading[0] + entry + '\n' + changelog.slice(heading[0].length) : `# create-substrat\n\n${entry}\n${changelog}`,
);
console.log(`pins: bumped create-substrat ${committed} → ${bumped} so the new pins are published.`);
