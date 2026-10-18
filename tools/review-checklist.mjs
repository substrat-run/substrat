/**
 * The review checklist names only gates that exist and run (#2365).
 *
 * `plugin/substrat/review/checklist.md` is the rule set every review runner reads: the local
 * `review` skill today, a runner the platform hosts later. Each item says which mechanical gate
 * already refuses it, and a runner is told to run that gate and report its failure rather than
 * re-derive it. So a gate the checklist names and CI does not run is worse than none: the runner
 * reports it as covered, and nothing is.
 *
 * Every item (`### S<n> · …`) therefore carries exactly one machine-read line:
 *
 *     gates: `pnpm lint:model --check` · `npm run lint:boundaries` · judgement
 *
 * Each entry is a backticked command or the bare word `judgement`, which says that part of the
 * item is a reader's to decide because no script can. An item no script can decide at all says
 * `gates: judgement`. This refuses:
 *
 * - an item with no `gates:` line, or more than one;
 * - an entry that is neither a backticked command nor `judgement`, or `judgement` twice;
 * - a monorepo command that does not exist: `pnpm <script>` / `pnpm run <script>` naming no root
 *   `package.json` script, or `node <file>` naming no file;
 * - a monorepo command CI does not run: it must appear in `.github/workflows/ci.yml` with the same
 *   arguments (`pnpm X` and `pnpm run X` are one spelling; `<ref>` in the checklist stands for one
 *   argument CI computes, such as `--base "$base"`). A root script whose CI form is the recursive
 *   sweep it wraps (`pnpm test`, `pnpm typecheck`) counts when CI runs `pnpm -r … <script>`;
 * - a scaffold command (`npm test`, `npm run <script>`) that is not one of the gates a scaffolded
 *   project ships with — `tools/scaffold-gates.mjs`, the list `tools/scaffold-check.mjs` runs
 *   against a real scaffold.
 *
 * Exit 0: every item names real, running gates. 1: at least one does not (each printed).
 * 2: a file this reads is missing. Fixtures: `review-checklist.test.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, repoRoot } from './repo-path.mjs';
import { GATES } from './scaffold-gates.mjs';

const CHECKLIST = 'plugin/substrat/review/checklist.md';
const CI = '.github/workflows/ci.yml';

/** Each `### S<n>` item's heading line and its `gates:` lines. */
export function itemsOf(markdown) {
  const items = [];
  let current = null;
  markdown.split('\n').forEach((line, i) => {
    const heading = /^###\s+(S\d+)\b/.exec(line);
    if (heading) {
      current = { id: heading[1], line: i + 1, gates: [] };
      items.push(current);
      return;
    }
    if (/^#{1,3}\s/.test(line)) current = null;
    else if (current && /^gates:/.test(line)) current.gates.push({ line: i + 1, text: line.slice('gates:'.length).trim() });
  });
  return items;
}

/** One `gates:` value, split into commands and the judgement mark, or the reason it cannot be. */
export function parseGates(value) {
  const commands = [];
  let judgement = false;
  for (const raw of value.split('·').map((s) => s.trim())) {
    const command = /^`([^`]+)`$/.exec(raw);
    if (command) commands.push(command[1].trim());
    else if (raw === 'judgement') {
      if (judgement) return { error: '`judgement` is listed twice' };
      judgement = true;
    } else return { error: `'${raw}' is neither a backticked command nor \`judgement\`` };
  }
  if (commands.length === 0 && !judgement) return { error: 'names no gate and no `judgement`' };
  return { commands, judgement };
}

const words = (command) => command.trim().split(/\s+/);

/** `pnpm run X a` and `pnpm X a` are one command: the canonical form drops the `run`. */
function canonicalPnpm(tokens) {
  return tokens[0] === 'pnpm' && tokens[1] === 'run' ? ['pnpm', ...tokens.slice(2)] : tokens;
}

/**
 * The only conditions that still run a step on every PR: `always()`, `success()`, and one that
 * reads nothing but an earlier step's outputs (the scope count a PR's own diff decides). Anything
 * else — the event, the ref, a label, `false` — runs it only sometimes, so it is no PR gate.
 */
function everyPr(condition) {
  if (condition === null || condition === undefined) return true;
  const expr = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  if (/^(?:always|success)\(\)$/.test(expr)) return true;
  const rest = expr.replace(/\bsteps\.[\w-]+\.outputs\.[\w-]+\b/g, '').replace(/'[^']*'|\d+/g, '');
  return /\bsteps\./.test(expr) && /^[\s!=<>&|()]*$/.test(rest);
}

/**
 * The commands CI runs on a pull request, one token list per command (a multi-line `run: |` is
 * several). Read line by line, not as full YAML: a step's `run:` (inline, or a `|`, `|-`, `>` or
 * `>-` block), its `if:`, `continue-on-error:` and `working-directory:`, and a job's `if:`. A step
 * that may fail without failing the PR, runs under a condition other than `everyPr`'s, or runs in
 * another directory (another script) does not count.
 */
export function ciCommands(yaml) {
  const out = [];
  let jobIf = null;
  let step = null;
  let block = null;
  const flush = () => {
    if (step && !step.wd && !step.mayFail && everyPr(step.if) && everyPr(jobIf)) out.push(...step.runs);
    step = null;
  };
  const key = (k, value, keyIndent) => {
    if (k === 'run') {
      if (/^[|>][-+]?$/.test(value)) block = keyIndent;
      else step.runs.push(value.trim());
    } else if (k === 'if') step.if = value;
    else if (k === 'continue-on-error') step.mayFail = value.trim() !== 'false';
    else if (k === 'working-directory') step.wd = value;
  };
  for (const line of yaml.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() === '' || indent > block) {
        if (line.trim()) step.runs.push(line.trim());
        continue;
      }
      block = null;
    }
    if (/^ {2}[\w-]+:\s*$/.test(line)) {
      flush();
      jobIf = null;
      continue;
    }
    const jobKey = /^ {4}if:\s*(.*)$/.exec(line);
    if (jobKey && !step) {
      jobIf = jobKey[1];
      continue;
    }
    const dash = /^(\s*)-\s+([\w-]+):\s*(.*)$/.exec(line);
    if (dash) {
      flush();
      step = { indent: dash[1].length, if: null, wd: null, runs: [] };
      key(dash[2], dash[3], dash[1].length + 2);
      continue;
    }
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (kv && step && kv[1].length === step.indent + 2) key(kv[2], kv[3], kv[1].length);
  }
  flush();
  return out.filter((c) => !c.startsWith('#')).map((c) => canonicalPnpm(words(c)));
}

/** Does CI run `want`? `<…>` in `want` stands for exactly one argument. */
function ciRuns(want, ci) {
  const target = canonicalPnpm(want);
  return ci.some((have) => have.length === target.length && target.every((t, i) => /^<[^>]+>$/.test(t) || t === have[i]));
}

/** The recursive sweep a root script wraps: CI runs `pnpm -r [filters…] <script>`. */
function ciRunsRecursive(script, ci) {
  return ci.some((have) => have[0] === 'pnpm' && have[1] === '-r' && have[have.length - 1] === script);
}

/**
 * Every offence in a checklist, judged against what exists: `scripts` (root package.json),
 * `ci` (from `ciCommands`), `scaffold` (the scaffold's gate names) and `fileExists(path)`.
 */
export function findOffences(markdown, { scripts, ci, scaffold, fileExists }) {
  const offences = [];
  const items = itemsOf(markdown);
  if (items.length === 0) return [`${CHECKLIST}: no \`### S<n>\` items found`];
  for (const item of items) {
    const at = (line) => `${CHECKLIST}:${line} (${item.id})`;
    if (item.gates.length !== 1) {
      offences.push(`${at(item.line)}: has ${item.gates.length} \`gates:\` lines; every item has exactly one`);
      continue;
    }
    const { line, text } = item.gates[0];
    const parsed = parseGates(text);
    if (parsed.error) {
      offences.push(`${at(line)}: ${parsed.error}`);
      continue;
    }
    for (const command of parsed.commands) {
      const tokens = words(command);
      if (tokens[0] === 'npm') {
        if (!scaffold.has(command)) offences.push(`${at(line)}: \`${command}\` is not a gate a scaffolded project ships with (tools/scaffold-gates.mjs)`);
        continue;
      }
      if (tokens[0] === 'node') {
        if (!tokens[1] || !fileExists(tokens[1])) offences.push(`${at(line)}: \`${command}\` names no file`);
        else if (!ciRuns(tokens, ci)) offences.push(`${at(line)}: \`${command}\` is not run by ${CI}`);
        continue;
      }
      if (tokens[0] !== 'pnpm') {
        offences.push(`${at(line)}: \`${command}\` is neither a pnpm, node nor npm command`);
        continue;
      }
      const canonical = canonicalPnpm(tokens);
      const script = canonical[1];
      if (!script || !(script in scripts)) {
        offences.push(`${at(line)}: \`${command}\` names no root package.json script`);
        continue;
      }
      const recursive = canonical.length === 2 && ciRunsRecursive(script, ci);
      if (!ciRuns(tokens, ci) && !recursive) offences.push(`${at(line)}: \`${command}\` is not run by ${CI}`);
    }
  }
  return offences;
}

function main() {
  const root = repoRoot(import.meta.url);
  const read = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      console.error(`review-checklist: missing ${rel}`);
      process.exit(2);
    }
    return readFileSync(abs, 'utf8');
  };
  const offences = findOffences(read(CHECKLIST), {
    scripts: JSON.parse(read('package.json')).scripts ?? {},
    ci: ciCommands(read(CI)),
    scaffold: new Set(GATES.map((g) => g.name)),
    fileExists: (rel) => existsSync(join(root, rel)),
  });
  if (offences.length > 0) {
    console.error(`review-checklist: ${offences.length} item gate(s) name something that does not exist or does not run:\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error(`\nEach item's \`gates:\` line names commands CI runs, or \`judgement\` for what no script decides.`);
    process.exit(1);
  }
  console.log(`review-checklist: every item names gates that exist and run.`);
}

if (isMainModule(import.meta.url)) main();
