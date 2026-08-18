#!/usr/bin/env node
/**
 * The docs-freshness checkpoint (#750).
 *
 * Every documented area is a page describing a directory of source. The page is
 * a second description of that source, and second descriptions rot — silently,
 * because nothing fails when they do. The other checkpoints in this repo
 * (`lint:permissions`, `lint:model`, `lint:api`) all work by re-emitting an
 * artifact and diffing it; a doc page cannot be re-emitted, so this one measures
 * the next best thing: **how much source has moved since the page last did**.
 *
 * Two questions, both mechanical:
 *
 *   1. **Coverage** — does every published package have a reference page at all?
 *      `@substrat-run/model-emit` shipped with zero docs and nobody noticed for a
 *      month. A missing page is a hard failure: it is unambiguous and one file
 *      fixes it.
 *   2. **Drift** — how many non-merge commits have touched the source since the
 *      page was last edited? A coarse proxy (a package can churn without its
 *      public surface moving), but the *ranking* is what the refresh order needs,
 *      and a page 100 commits behind its source is not describing that source.
 *
 * Thresholds are generous on purpose. This should go red when a page has rotted,
 * not on the Tuesday somebody lands their fortieth commit in `packages/kernel`.
 *
 *   node tools/docs-drift.mjs            # the table, always exit 0
 *   node tools/docs-drift.mjs --check    # CI: exit 1 on a missing page or a rotted one
 *   node tools/docs-drift.mjs --json     # the same data, for a script
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'apps/docs';

/** Warn in the table. Nothing fails. */
const WARN_AT = 30;
/** `--check` fails. Roughly "a quarter of churn went by without a re-read". */
const FAIL_AT = 75;

/**
 * Areas whose doc path and source path are not the same word.
 *
 * Everything else is derived by convention below, because a convention that
 * needs a list is not a convention — and a hand-list is the thing that would
 * silently omit the next package the way `model-emit` was omitted.
 */
const VERTICAL_DIRS = {
  callout: 'demos/callout',
  handlebar: 'demos/handlebar',
  manyfold: 'demos/manyfold',
  meridian: 'demos/meridian',
  rallypoint: 'demos/rally',
  shop: 'demos/shop',
};

/**
 * The prose pages. These describe an idea rather than a directory, so the source
 * they track is named by hand — and named *narrowly*, because pointing a concept
 * page at all of `packages/` would keep it permanently red and permanently
 * ignored.
 */
const PROSE = {
  'concepts/tenancy.md': ['packages/contracts/src/ids.ts', 'packages/kernel/src/scope-host.ts'],
  'concepts/platform.md': ['apps/control-plane', 'apps/router'],
  'concepts/scope-host.md': ['packages/kernel/src/scope-host.ts', 'packages/adapter-sqlite/src'],
  'concepts/permissions.md': [
    'packages/kernel/src/permission-checker.ts',
    'packages/contracts/src/permissions.ts',
  ],
  'concepts/identity.md': ['packages/vertical-auth/src', 'packages/oidc-rp/src'],
  'concepts/events.md': ['packages/contracts/src/events.ts', 'packages/kernel/src/events.ts'],
  'concepts/snapshots.md': ['apps/control-plane/src/snapshots.ts'],
  'concepts/deploying.md': ['packages/cli/src', 'apps/control-plane/src/versions.ts'],
  'concepts/reads.md': ['packages/adapter-cloudflare/src'],
  'concepts/model.md': ['packages/contracts/src/model.ts', 'packages/model-emit/src'],
  'concepts/modules.md': ['packages/contracts/src/module.ts'],
  'concepts/money.md': ['packages/contracts/src/money.ts'],
  'guide/getting-started.md': ['packages/create-substrat', 'packages/cli/src'],
  'guide/deploying.md': ['packages/cli/src'],
  'guide/environments-and-previews.md': ['apps/control-plane/src'],
  'guide/architecture.md': ['packages/kernel/src'],
};

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const JSON_OUT = args.includes('--json');

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

/** ISO date of the last commit touching any of `paths`, or null if never committed. */
function lastTouched(paths) {
  const out = git('log', '-1', '--format=%cI', '--', ...paths);
  return out || null;
}

/** Non-merge commits touching `paths` strictly after `since`. */
function commitsSince(paths, since) {
  if (!since) return 0;
  const out = git('rev-list', '--count', '--no-merges', `--since=${since}`, 'HEAD', '--', ...paths);
  return Number(out) || 0;
}

const dirsIn = (p) =>
  existsSync(join(ROOT, p))
    ? readdirSync(join(ROOT, p), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(ROOT, p, e.name, 'package.json')))
        .map((e) => e.name)
    : [];

const pkgName = (dir) =>
  JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));

/**
 * The code of a package, minus the noise. `src/` where there is one — a version
 * bump to CHANGELOG.md is not a reason to re-read a doc page — and the whole
 * directory where there isn't (`create-substrat` is an `index.js` and a template).
 */
const codeOf = (dir) => (existsSync(join(ROOT, dir, 'src')) ? [`${dir}/src`] : [dir]);

// ---------------------------------------------------------------------------
// Build the area list: conventions first, prose second.
// ---------------------------------------------------------------------------

/** @type {{area: string, docs: string[], src: string[], missing?: string}[]} */
const areas = [];
/** @type {{pkg: string, dir: string, expected: string}[]} */
const uncovered = [];

for (const dir of dirsIn('packages')) {
  const pkg = pkgName(`packages/${dir}`);
  if (pkg.private) continue; // private packages are ours to read, not to document
  const page = `${DOCS}/reference/${dir}.md`;
  if (!existsSync(join(ROOT, page))) {
    uncovered.push({ pkg: pkg.name, dir: `packages/${dir}`, expected: `reference/${dir}.md` });
    continue;
  }
  areas.push({ area: `reference/${dir}`, docs: [page], src: codeOf(`packages/${dir}`) });
}

for (const dir of dirsIn('engines')) {
  const pkg = pkgName(`engines/${dir}`);
  if (pkg.private) continue;
  const pageDir = `${DOCS}/engines/${dir}`;
  if (!existsSync(join(ROOT, pageDir))) {
    uncovered.push({ pkg: pkg.name, dir: `engines/${dir}`, expected: `engines/${dir}/` });
    continue;
  }
  areas.push({ area: `engine/${dir}`, docs: [pageDir], src: codeOf(`engines/${dir}`) });
}

for (const dir of dirsIn('connectors')) {
  const pkg = pkgName(`connectors/${dir}`);
  if (pkg.private) continue;
  const page = `${DOCS}/connectors/${dir}.md`;
  if (!existsSync(join(ROOT, page))) {
    uncovered.push({ pkg: pkg.name, dir: `connectors/${dir}`, expected: `connectors/${dir}.md` });
    continue;
  }
  areas.push({ area: `connector/${dir}`, docs: [page], src: codeOf(`connectors/${dir}`) });
}

for (const [slug, dir] of Object.entries(VERTICAL_DIRS)) {
  const page = `${DOCS}/verticals/${slug}.md`;
  if (!existsSync(join(ROOT, page)) || !existsSync(join(ROOT, dir))) continue;
  areas.push({ area: `vertical/${slug}`, docs: [page], src: codeOf(dir) });
}

for (const [page, src] of Object.entries(PROSE)) {
  const present = src.filter((p) => existsSync(join(ROOT, p)));
  if (!present.length) continue;
  areas.push({ area: page.replace(/\.md$/, ''), docs: [`${DOCS}/${page}`], src: present });
}

// ---------------------------------------------------------------------------
// Measure.
// ---------------------------------------------------------------------------

const rows = areas
  .map(({ area, docs, src }) => {
    const docDate = lastTouched(docs);
    const srcDate = lastTouched(src);
    return {
      area,
      doc: docDate?.slice(0, 10) ?? '—',
      src: srcDate?.slice(0, 10) ?? '—',
      behind: commitsSince(src, docDate),
      srcPaths: src,
    };
  })
  .sort((a, b) => b.behind - a.behind);

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, uncovered, warnAt: WARN_AT, failAt: FAIL_AT }, null, 2));
  process.exit(uncovered.length || rows.some((r) => r.behind > FAIL_AT) ? (CHECK ? 1 : 0) : 0);
}

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(4, ...rows.map((r) => r.area.length));

console.log(`\n${pad('area', w)}  doc         src         behind`);
console.log('-'.repeat(w + 34));
for (const r of rows) {
  const flag = r.behind > FAIL_AT ? ' ✗' : r.behind > WARN_AT ? ' !' : '';
  console.log(`${pad(r.area, w)}  ${r.doc}  ${r.src}  ${String(r.behind).padStart(6)}${flag}`);
}

const rotted = rows.filter((r) => r.behind > FAIL_AT);
const warned = rows.filter((r) => r.behind > WARN_AT && r.behind <= FAIL_AT);

console.log(
  `\n${rows.length} areas · ${rotted.length} over ${FAIL_AT} (✗) · ${warned.length} over ${WARN_AT} (!)`,
);

if (uncovered.length) {
  console.log('\nPublished with no page:');
  for (const u of uncovered) console.log(`  ${u.pkg}  →  write ${DOCS}/${u.expected}`);
}

if (!CHECK) {
  console.log('\n(advisory — run with --check for the CI exit code)');
  process.exit(0);
}

if (uncovered.length || rotted.length) {
  console.error('\ndocs-drift: FAILED');
  if (uncovered.length)
    console.error(
      `  ${uncovered.length} published package(s) with no reference page. A package the ` +
        'world can `npm install` and cannot read about is not shipped.',
    );
  if (rotted.length)
    console.error(
      `  ${rotted.length} page(s) more than ${FAIL_AT} commits behind their source: ` +
        `${rotted.map((r) => r.area).join(', ')}.\n` +
        '  Re-read the page against the source, fix what has moved, and commit it. If the\n' +
        '  page is genuinely still correct, say so in the commit — the counter resets on\n' +
        '  any edit to the page, and "I read it and it was fine" is a real edit to make.',
    );
  process.exit(1);
}

console.log('\ndocs-drift: ok');
