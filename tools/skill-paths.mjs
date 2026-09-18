#!/usr/bin/env node
/**
 * A skill that cites a repo path cites one that exists.
 *
 * The two repo skills (`.claude/skills/*`) are what an agent reads before it builds a
 * vertical, and they teach by pointing: "read `demos/todo/src/module.ts` before designing
 * a share feature". A citation is the one part of that prose a machine can hold to the
 * tree — and nothing did. When #982 was filed, `new-vertical` sent its reader to
 * `demos/callout/src/api.ts` and `demos/callout/openapi.json`, neither of which existed,
 * and described an auth seam the platform had removed; the only tool that read a skill at
 * all was `playbook-sync`, which hashes one and never opens it. The skills were rewritten
 * by hand in #1457. This is what keeps the next removal from being found by an agent
 * following a dead pointer instead of by CI.
 *
 * It is the same check `lint:llms` makes for the docs sidebar, pointed at a different
 * reader: a list of paths a person maintains, asserted against the files it names.
 *
 * ## What counts as a citation
 *
 * A token inside CODE — an inline `` `span` `` or a fenced block — that begins with one of
 * the monorepo's top-level directories. Inside code, so that prose such as "the docs/ tree"
 * is not read as a claim; a token rather than the whole span, so that a command cites too:
 * `node tools/boundary-lint.mjs` names a file as surely as a bare path does, and a renamed
 * tool should be red here rather than a `MODULE_NOT_FOUND` in somebody's session.
 *
 * A trailing `:12` or `:12-40` is dropped, as is a `#anchor` and closing punctuation. The
 * line number itself is NOT judged: a line moves on every edit to the cited file, so that
 * half would be red weekly and teach everyone to ignore the gate.
 *
 * A placeholder — `demos/<name>/spec/concept.md`, `engines/*`, `connectors/…` — is judged
 * on the part written before it: `demos/` has to exist, the rest is the reader's to fill
 * in. Skipping such a citation whole would pass `packages/create-substrat/tmpl/<file>`
 * without anyone asking whether `tmpl/` is a directory.
 *
 * ## What it deliberately does not do
 *
 * - **No allowlist.** A missing path is red, not recorded. If a citation is wrong the fix
 *   is in the skill; if the file was removed the skill is teaching something that is gone,
 *   which is the defect. There is no opt-out comment either, until a case earns one.
 * - **No edit.** It reads the skills and never writes them.
 * - **No paths relative to a vertical.** `src/module.ts` means "in whichever demo this
 *   paragraph is about", which a line-level reader cannot resolve. Only rooted paths.
 * - **No markdown link targets.** Those resolve against the skill's own directory, not the
 *   repo root, and neither skill carries one.
 *
 * The plugin skills (`plugin/substrat/skills/*`) are read too, with one prefix withheld:
 * they run inside a SCAFFOLDED project, where `.claude/` is that project's directory and
 * not this repo's. Every other prefix names something only the monorepo has, so a plugin
 * skill citing one is making a claim about this tree and is held to it. They cite none
 * today; the walk is there so the first one that does is checked.
 *
 * Existence is judged case-sensitively, segment by segment, because macOS would otherwise
 * pass `demos/Todo/…` locally and leave CI to find it.
 *
 *   node tools/skill-paths.mjs                 # the repo
 *   node tools/skill-paths.mjs --root <dir>    # a scratch tree — how the red path is proven
 *
 * Text, not a markdown AST — a loud false positive beats a silent pass.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
if (rootFlag !== -1 && process.argv[rootFlag + 1] === undefined) {
  console.error('skill-paths: --root needs a directory.');
  process.exit(2);
}
const ROOT =
  rootFlag === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(process.argv[rootFlag + 1]);

/** The monorepo's top-level directories a skill may point into. */
const PREFIXES = [
  '.claude', '.github', 'apps', 'connectors', 'demos', 'docs', 'engines', 'examples',
  'packages', 'plugin', 'scripts', 'spikes', 'tools',
];
/** Where skills live, and the prefixes that mean something ELSE to that skill's reader. */
const SKILL_ROOTS = [
  { dir: '.claude/skills', withheld: [] },
  { dir: 'plugin/substrat/skills', withheld: ['.claude'] },
];

const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A rooted path token, with or without a leading `./`. The lookbehind is what keeps
 * `src/tools/x.ts`, `../docs/x.md`, `@substrat-run/docs/…` and `https://substrat.net/docs/…`
 * from being read as rooted.
 */
const citation = (prefixes) =>
  new RegExp(`(?<![\\w./@~-])(?:\\./)?(?:${prefixes.map(escaped).join('|')})/[^\\s'"\`,;()\\[\\]|]*`, 'g');

/** What marks a segment as the reader's to fill in rather than a name in the tree. */
const PLACEHOLDER = /[<>*{}$…]|\.\.\./;

/** The code on one line: the whole line inside a fence, the inline spans outside one. */
const codeOf = (line, fenced) =>
  fenced ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/**
 * Every citation on one line, as the path to test — line suffix, anchor and closing
 * punctuation gone, truncated ahead of the first placeholder segment.
 */
const citationsOn = (line, fenced, prefixes) => {
  const out = [];
  for (const code of codeOf(line, fenced)) {
    for (const [raw] of code.matchAll(citation(prefixes))) {
      const bare = raw
        .replace(/^\.\//, '')
        .replace(/#.*$/, '')
        .replace(/[.:!?]+$/, '')
        .replace(/:\d+(?:[-–]\d+)?$/, '');
      const segments = bare.split('/').filter((s) => s !== '');
      const stop = segments.findIndex((s) => PLACEHOLDER.test(s));
      out.push({
        raw,
        path: (stop === -1 ? segments : segments.slice(0, stop)).join('/'),
        truncated: stop !== -1,
      });
    }
  }
  return out;
};

/** `existsSync`, but each segment must be spelled the way the directory spells it. */
const existsExactly = (root, path) => {
  let dir = root;
  for (const segment of path.split('/')) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    if (!readdirSync(dir).includes(segment)) return false;
    dir = join(dir, segment);
  }
  return true;
};

/**
 * The extraction, judged against every shape it exists to tell apart, on every run and
 * before a skill is read — the same reason `lint:vite-proxy` carries one. A text rule
 * drifts silently when a regex is tidied, and a check that has stopped checking is green.
 */
const SELF_CHECK = [
  ['read `demos/todo/src/module.ts` first', false, ['demos/todo/src/module.ts']],
  ['see `demos/todo/src/module.ts:33` and `packages/kernel/src/scope-host.ts:12-40`.', false,
    ['demos/todo/src/module.ts', 'packages/kernel/src/scope-host.ts']],
  ['run `node tools/boundary-lint.mjs` before pushing', false, ['tools/boundary-lint.mjs']],
  ['the `demos/todo/test/` directory', false, ['demos/todo/test']],
  ['lands in `demos/<name>/spec/concept.md`', false, ['demos']],
  ['every `demos/*/app` is private', false, ['demos']],
  ['under `packages/create-substrat/template/<file>`', false, ['packages/create-substrat/template']],
  ['`docs/architecture/observability.md#3`', false, ['docs/architecture/observability.md']],
  // Rooted only: a path relative to a vertical, a scope, or a URL is not a claim about the tree.
  ['`src/tools/emit.mts`, `@substrat-run/docs/x`, `https://substrat.net/docs/guide`', false, []],
  ['`../docs/x.md` is relative; `./tools/boundary-lint.mjs` is rooted', false, ['tools/boundary-lint.mjs']],
  ['`src/module.ts` and `app/src/api.generated.ts`', false, []],
  // Prose is not code; a fenced line is.
  ['the docs/architecture/nothing.md tree, in prose', false, []],
  ['pnpm exec tsx demos/todo/tools/emit-migrations.mts --check', true, ['demos/todo/tools/emit-migrations.mts']],
  ["import { x } from 'packages/kernel/src/index.ts';", true, ['packages/kernel/src/index.ts']],
  // `.claude/` belongs to the scaffolded project when a plugin skill says it.
  ['`.claude/skills/substrat/SKILL.md`', false, ['.claude/skills/substrat/SKILL.md']],
];
const pathsOn = (line, fenced, prefixes) => citationsOn(line, fenced, prefixes).map((c) => c.path);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const drift = SELF_CHECK.filter(([line, fenced, want]) => !same(pathsOn(line, fenced, PREFIXES), want));
const withheldLeak = citationsOn('`.claude/skills/x/SKILL.md`', false, PREFIXES.filter((p) => p !== '.claude'));
if (drift.length > 0 || withheldLeak.length > 0) {
  console.error('skill-paths: the extraction no longer tells its own cases apart — fix it before trusting a run:');
  for (const [line, fenced, want] of drift) {
    console.error(`  expected [${want.join(', ')}], got [${pathsOn(line, fenced, PREFIXES).join(', ')}]: ${line}`);
  }
  if (withheldLeak.length > 0) console.error('  a withheld prefix was still read as a citation');
  process.exit(2);
}

const skills = [];
for (const { dir, withheld } of SKILL_ROOTS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs).sort()) {
    const file = join(dir, name, 'SKILL.md');
    if (existsSync(join(ROOT, file))) {
      skills.push({ file, prefixes: PREFIXES.filter((p) => !withheld.includes(p)) });
    }
  }
}
if (skills.length === 0) {
  console.error(`skill-paths: no SKILL.md found under ${SKILL_ROOTS.map((r) => `${r.dir}/`).join(' or ')} — the check would pass by scanning nothing.`);
  process.exit(2);
}

let cited = 0;
const misses = [];
for (const { file, prefixes } of skills) {
  let fenced = false;
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    for (const { raw, path, truncated } of citationsOn(line, fenced, prefixes)) {
      cited++;
      if (existsExactly(ROOT, path)) continue;
      // A placeholder citation was judged on its written part; say which part that was.
      misses.push(`${file}:${i + 1} → ${raw}${truncated ? ` (looked for ${path}/)` : ''}`);
    }
  });
}

if (misses.length > 0) {
  console.error('skill-paths: a skill cites a path that is not in the repo (#982).');
  console.error('  An agent follows these before it writes anything. Fix the citation in the skill, or —');
  console.error('  if the file was removed on purpose — rewrite the passage that still teaches it.');
  for (const m of misses) console.error(`  ${m}`);
  process.exit(1);
}
if (cited === 0) {
  console.error(`skill-paths: ${skills.length} skills read and not one citation found — the extraction has stopped matching, or the skills stopped pointing at the repo. Either is worth a look before this goes green.`);
  process.exit(2);
}
console.log(`skill-paths: ok (${cited} citations across ${skills.length} skills, all present)`);
