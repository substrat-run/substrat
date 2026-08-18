#!/usr/bin/env tsx
/**
 * The machine-readable-docs checkpoint (#751).
 *
 * `llms.txt`, `llms-full.txt` and the `.md` twins are emitted by the VitePress
 * build (`apps/docs/.vitepress/llms.mts`), so unlike `lint:permissions` or
 * `lint:model` there is no checked-in artifact to diff — the artifact *is* the
 * built site. What can rot without anything failing is the input, in three ways
 * this asserts directly. All three are cheap and need no build.
 *
 *   1. **A sidebar entry with no page.** A typo'd link renders a 404 in the nav
 *      and a dead URL in the index.
 *   2. **A page not in the sidebar.** This is the one that matters. The index is
 *      walked from the sidebar, so a page nobody added there is invisible to
 *      every agent — and invisible in a way no human notices, because the page
 *      itself is fine when you open it.
 *   3. **A page with no usable description.** The index line is derived from the
 *      page's first prose paragraph; a page that opens on a table or a container
 *      derives nothing, and `- [Domain model & invariants](…)` with no
 *      description tells an agent nothing about which of seven engines it is.
 *      The fix is a `description:` in the page's frontmatter.
 *
 *   pnpm lint:llms            # print the index as it will be published
 *   pnpm lint:llms --check    # CI: exit 1 on any of the three above
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifacts, describe, kernelVersion } from '../apps/docs/.vitepress/llms.mjs';
import { tableOfContents } from '../apps/docs/.vitepress/sidebar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'apps/docs');

/**
 * Files under the docs root that are not pages.
 *
 * `index.md` is the marketing landing page — a `<Marketing />` component with no
 * prose to twin. `CHANGELOG.md` is the package's own changelog, excluded from
 * the build in `config.mts` for the same reason it is excluded here.
 */
const NOT_A_PAGE = new Set(['index.md', 'CHANGELOG.md']);

/**
 * Below this, a description cannot be doing its job. The engine pages are why:
 * seven of them are titled "Events", and "Consumes nothing." does not tell an
 * agent which engine it is looking at.
 */
const MIN_DESCRIPTION = 60;

/** Every markdown file under the docs root that is meant to be a page. */
function sourcePages(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.vitepress' || entry === 'dist') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      const rel = relative(DOCS, path);
      if (!NOT_A_PAGE.has(rel)) found.push(rel);
    }
  };
  walk(DOCS);
  return found.sort();
}

const check = process.argv.includes('--check');
const problems: string[] = [];
const sections = tableOfContents();

// 1 + 2 — the sidebar and the filesystem must name the same set of pages.
const indexed = new Set(sections.flatMap((s) => s.pages.map((p) => p.file)));
const onDisk = new Set(sourcePages());

for (const file of indexed) {
  if (!onDisk.has(file)) problems.push(`sidebar names ${file}, which does not exist`);
}
for (const file of onDisk) {
  if (!indexed.has(file)) {
    problems.push(`${file} is not in the sidebar — it will not appear in llms.txt`);
  }
}

// 3 — every page must yield an index line worth reading.
for (const section of sections) {
  for (const page of section.pages) {
    if (!onDisk.has(page.file)) continue;
    const description = describe(readFileSync(join(DOCS, page.file), 'utf8'));
    const fix = 'Add a `description:` to its frontmatter.';
    if (!description) {
      problems.push(
        `${page.file}: no description — the page opens on a table, a container or a ` +
          `component, so there is no prose to derive one from. ${fix}`,
      );
    } else if (description.length > 200) {
      problems.push(`${page.file}: description is ${description.length} chars (max 200). ${fix}`);
    } else if (description.length < MIN_DESCRIPTION) {
      // "Consumes nothing." is true and tells an agent choosing between seven
      // identically-titled Events pages absolutely nothing.
      problems.push(
        `${page.file}: description is ${description.length} chars, too short to ` +
          `distinguish this page from its siblings ("${description}"). ${fix}`,
      );
    } else if (description.endsWith(':')) {
      // A line ending in a colon introduces the list or code block that follows.
      // It reads as a description right up until you notice it describes nothing.
      problems.push(
        `${page.file}: description is a lead-in, not a description ` +
          `("${description}"). ${fix}`,
      );
    }
  }
}

if (check) {
  if (problems.length) {
    console.error(`llms.txt index: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error('');
    process.exit(1);
  }
  // Actually emit. The three checks above read the inputs; this runs the same
  // code the VitePress build runs, so a page that crashes the twin generator
  // fails here rather than at deploy time, which is the only other place it
  // would ever run.
  const emitted = buildArtifacts(DOCS, ROOT);
  console.log(
    `llms.txt index: ${[...indexed].length} pages across ${sections.length} sections, ` +
      `describing kernel ${kernelVersion(ROOT)}. All indexed and described; ` +
      `${emitted.length} artifacts emit cleanly.`,
  );
  process.exit(0);
}

// No flag: print what will be published, so a human can read the index.
const artifacts = buildArtifacts(DOCS, ROOT);
const index = artifacts.find((a) => a.path === 'llms.txt')!;
const full = artifacts.find((a) => a.path === 'llms-full.txt')!;
console.log(index.contents);
console.log(
  `— ${artifacts.length - 3} markdown twins, ` +
    `llms-full.txt is ${Math.round(full.contents.length / 1024)} KB —`,
);
if (problems.length) {
  console.log(`\n${problems.length} problem(s) --check would fail on:`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
}
