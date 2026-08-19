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
 * fires when someone edits the block by hand.
 *
 * ## What this does NOT check
 *
 * Whether the template still COMPILES against the versions it names. It cannot: that
 * needs the scaffold built and tested against published packages, which is a separate
 * job. Honest pins and a working template are two different questions, and this
 * answers the first one only.
 *
 *   pnpm lint:pins            re-emit the pin block from the workspace versions
 *   pnpm lint:pins --check    CI: exit 1 on drift
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
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
  if (found[2] !== want) wrong.push(`  ${constant.padEnd(18)} ${found[2]}  →  ${want}`);
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
