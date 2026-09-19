#!/usr/bin/env node
/**
 * A module that declares operations hands the host the schemas to parse them with.
 *
 * CLAUDE.md states the rule as settled: *"operation inputs go through Zod schemas at the
 * boundary — and the **host** is what applies them … a declared input that nobody parses is
 * no longer possible rather than merely discouraged."* The mechanism behind that sentence is
 * `ModuleRegistration.operationInputs`, and it is **optional**
 * (`packages/kernel/src/scope-host.ts`). A module that declares thirty Zod inputs in its
 * operation surface and forgets one line of registration compiles, registers, runs, and
 * parses nothing — the adapters only refuse an entry naming an operation nothing binds, never
 * a bound operation with no entry, because that combination is legal and means "nothing was
 * declared to parse".
 *
 * So "impossible" was prose. #953 found nine registrations short of it at once — both
 * CLAUDE.md reference demos, the scaffold every `npm create substrat` starts from, and four
 * of the seven engines — and the fleet stayed green the whole time, because a scenario suite
 * calls `invoke()` with an object its own TypeScript already agreed with. Wire input never
 * appears in a test.
 *
 * ## Why a gate rather than a required field
 *
 * Making the field non-optional would be the stronger fix and it is a kernel contract change,
 * which CLAUDE.md makes a human checkpoint. This is the half that can be held mechanically
 * today: the registrations are all in one place per module, and reading them is cheap.
 *
 * ## Scope
 *
 * The modules built from a **declared operation surface** — the `src` tree of every `demos/`
 * and `engines/` member, plus the scaffold template — which is what makes
 * `operationInputsOf(ops)` a one-liner rather
 * than a request to write a second copy of every schema. `apps/dashboard` registers a module
 * too and is deliberately out: it binds its operations by hand and declares no surface, so
 * there is nothing to derive from and the gate would be asking for something that does not
 * exist. A registration that genuinely has no surface opts out with a
 * `module-inputs-allow: <reason>` comment, and has to give the reason.
 *
 * Text, not an AST — a loud false positive beats a silent pass.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where a module built from a declared surface lives. The template is not a member, so it is named. */
const ROOTS = ['demos', 'engines'];
const TEMPLATE = 'packages/create-substrat/template';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler']);
/** A whole-file opt-out, and it has to give a reason. */
const ALLOW = /module-inputs-allow:\s*\S/;

/**
 * Comments gone and string CONTENTS blanked, so a `:` means a property and nothing else.
 *
 * String-aware on purpose: a naive `//`-to-end-of-line strip eats a `'http://…'` and takes the
 * rest of the file with it, which is the false NEGATIVE this check exists to avoid. Contents
 * are blanked rather than kept because nothing here needs them and a `'operations: none'` in
 * a message string must not read as a declaration.
 */
const flatten = (src) => {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      if (c === '\\') {
        out += 'XX';
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : 'X';
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
};

/** The text between the braces of the `{` at `start`, or null when it never closes. */
const braced = (src, start) => {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { body: src.slice(start + 1, i), end: i };
  }
  return null;
};

/**
 * The object's OWN properties, as `{ key, value }`.
 *
 * Depth-tracked across `{}`, `()` and `[]` so a nested `operations:` — one inside a consumer,
 * or inside another module's registration quoted in a comment-free example — cannot answer for
 * the registration itself, and so an arrow handler's argument commas do not split a property
 * in half.
 */
const ownProperties = (body) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  const props = [];
  for (const part of parts) {
    const m = /^\s*(['"`])?([A-Za-z_$][\w$]*)\1?\s*:/.exec(part);
    if (m) props.push({ key: m[2], value: part.slice(m[0].length) });
    else if (/^\s*\.\.\./.test(part)) props.push({ key: '...', value: part });
  }
  return props;
};

/**
 * Every offence in one file's source, as a list of sentences.
 *
 * A registration is judged on three things, in the order they go wrong:
 *
 * 1. Can this check read it at all? Only `const x: ModuleRegistration = { … }` is legible to a
 *    text rule. A registration returned from a function, held in an array, or spread from
 *    somewhere else is REFUSED rather than skipped — passing something it did not read is the
 *    failure mode the gate exists to avoid, and the same call `lint:vite-proxy` makes about a
 *    `proxy:` it cannot see.
 * 2. Does it declare `operations:` at all? A registration that is only a manifest, migrations
 *    and consumers has no invocation surface and nothing to parse.
 * 3. Does it hand over `operationInputs:`, DERIVED from the declared surface? A hand-written
 *    map is refused for the reason the kernel's own doc-comment gives about a name binding
 *    nothing: it reads as coverage while covering whatever someone remembered to type. Any
 *    value mentioning `operationInputsOf(` is accepted, so a vertical composing two
 *    declarations can still merge them.
 */
const judge = (source) => {
  const src = flatten(source);
  const found = [];
  let judged = 0;
  const annotation = /:\s*ModuleRegistration\b/g;
  let m;
  while ((m = annotation.exec(src)) !== null) {
    judged++;
    const head = src.slice(Math.max(0, m.index - 160), m.index);
    const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*$/.exec(head);
    const rest = src.slice(m.index + m[0].length);
    // Optional type arguments — `ModuleRegistration<[ProtocolEvents]>` — then `= {`.
    const opens = /^\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*=\s*\{/.exec(rest);
    if (declared === null || opens === null) {
      const where =
        declared === null
          ? `\`${(head.trim().split('\n').pop() ?? '').trim()} : ModuleRegistration…\``
          : `\`${declared[1]}\``;
      found.push(
        `a ModuleRegistration this check cannot read — ${where}. Only ` +
          '`const x: ModuleRegistration = { … }` is legible to a text rule; write it as a plain ' +
          'object literal, or opt the file out with a `module-inputs-allow: <reason>` comment',
      );
      continue;
    }
    const name = declared[1];
    // `opens` matched at the start of `rest` and ends on the `{`, so that is where the body opens.
    const body = braced(rest, opens[0].length - 1);
    if (body === null) {
      found.push(`${name}: the registration object never closes — this check cannot read it`);
      continue;
    }
    annotation.lastIndex = m.index + m[0].length + body.end + 1;
    const props = ownProperties(body.body);
    if (props.some((p) => p.key === '...')) {
      found.push(
        `${name}: spreads another object into the registration — this check cannot tell what ` +
          'that contributes, so it refuses rather than guesses',
      );
      continue;
    }
    if (!props.some((p) => p.key === 'operations')) continue; // no invocation surface to parse
    const inputs = props.find((p) => p.key === 'operationInputs');
    if (inputs === undefined) {
      found.push(
        `${name}: declares \`operations:\` and no \`operationInputs:\` — the Zod inputs in its ` +
          'declared surface are compile-time only, and every invocation reaches the guards and ' +
          'the handler unparsed. Add `operationInputs: operationInputsOf(ops)`',
      );
      continue;
    }
    if (!/operationInputsOf\s*\(/.test(inputs.value)) {
      found.push(
        `${name}: \`operationInputs\` is written by hand rather than derived — it reads as ` +
          'coverage while covering only what someone remembered to type. Use ' +
          '`operationInputsOf(ops)`, the same declaration the manifest and the routes come from',
      );
    }
  }
  return { judged, offences: found };
};

/** The offences alone — what the self-check below and the reporting loop compare. */
const offences = (source) => judge(source).offences;

/**
 * The predicate, judged against every shape it exists to tell apart, on every run and before
 * the tree is read — the same guard `lint:vite-proxy` and `lint:bound-fetch` carry. A text rule
 * drifts silently when a regex is tidied, and a check that has stopped checking is green.
 */
const OPS = "operations: { 'a/b': h }";
const SELF_CHECK = [
  [`const m: ModuleRegistration = { manifest: x, ${OPS} };`, 1],
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: operationInputsOf(ops) };`, 0],
  // Derived, but merged from two declarations — still derived.
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: { ...operationInputsOf(a), ...operationInputsOf(b) } };`, 0],
  // Present and hand-written: coverage in appearance only.
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: { 'a/b': schema } };`, 1],
  // No invocation surface — nothing to parse, and nothing to demand.
  ["const m: ModuleRegistration = { manifest: x, consumers: { 'e.t': handler } };", 0],
  // Type arguments do not hide the declaration.
  [`const m: ModuleRegistration<[ProtocolEvents]> = { manifest: x, ${OPS} };`, 1],
  // A nested `operations:` is not the registration's own.
  ["const m: ModuleRegistration = { manifest: x, consumers: { 'e.t': { operations: 1 } } };", 0],
  // Comments are stripped, so a commented-out line is not a hand-over…
  [`const m: ModuleRegistration = { manifest: x, // operationInputs: operationInputsOf(ops)\n  ${OPS} };`, 1],
  // …and neither is a string that happens to spell one.
  [`const m: ModuleRegistration = { manifest: x, note: 'operationInputs: operationInputsOf(ops)', ${OPS} };`, 1],
  // A `//` inside a string must not eat the rest of the file (the false negative).
  [`const url = 'http://x/y';\nconst m: ModuleRegistration = { manifest: x, ${OPS} };`, 1],
  // Shapes this check cannot read are refused, not skipped.
  ['function make(): ModuleRegistration { return { manifest: x }; }', 1],
  ['const mods: ModuleRegistration[] = [a, b];', 1],
  ['const m: ModuleRegistration = makeModule();', 1],
  [`const m: ModuleRegistration = { ...base, ${OPS}, operationInputs: operationInputsOf(ops) };`, 1],
  // An arrow handler's own commas do not split the property list.
  [
    `const m: ModuleRegistration = { manifest: x, consumers: { 'e.t': async (ctx, event) => { await ctx.sql('a', [1, 2]); } }, ${OPS} };`,
    1,
  ],
  // Two registrations in one file are both judged, not just the first.
  [
    `const a: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: operationInputsOf(ops) };\nconst b: ModuleRegistration = { manifest: y, ${OPS} };`,
    1,
  ],
  ['const notAModule = { operations: 1 };', 0],
  // The `as ModuleRegistration['operations']` cast four demos write is not a second
  // registration — and it does not hide the missing hand-over either.
  [`const m: ModuleRegistration = { manifest: x, operations: ops as ModuleRegistration['operations'] };`, 1],
];
const drift = SELF_CHECK.filter(([src, want]) => offences(src).length !== want);
if (drift.length > 0) {
  console.error('module-inputs: the rule no longer tells its own cases apart — fix the predicate before trusting a run:');
  for (const [src, want] of drift) {
    console.error(`  expected ${want} offence(s), got ${offences(src).length}: ${src.replace(/\n/g, ' ')}`);
  }
  process.exit(2);
}

// The count the final line reports is held too: "ok" over a file whose second registration
// was never read would be the quietest way for this to stop checking anything.
const pair = judge(
  `const a: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: operationInputsOf(ops) };\n` +
    `const b: ModuleRegistration = { manifest: y, ${OPS}, operationInputs: operationInputsOf(ops) };`,
);
if (pair.judged !== 2) {
  console.error(`module-inputs: read ${pair.judged} of 2 registrations in one file — the scan stops early.`);
  process.exit(2);
}

/** Every `.ts` file under the `src/` of a module-owning directory. */
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
};

const sources = [];
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) walk(join(root, name, 'src'), sources);
}
walk(join(TEMPLATE, 'src'), sources);

const offenders = [];
let registrations = 0;
let files = 0;
let skipped = 0;
for (const file of sources) {
  const source = readFileSync(file, 'utf8');
  if (!/:\s*ModuleRegistration\b/.test(source)) continue;
  if (ALLOW.test(source)) {
    skipped++;
    continue;
  }
  const verdict = judge(source);
  registrations += verdict.judged;
  files++;
  for (const why of verdict.offences) offenders.push(`${file}: ${why}`);
}

if (registrations === 0) {
  console.error('module-inputs: found no module registration — the check would pass by scanning nothing.');
  process.exit(2);
}

if (offenders.length > 0) {
  console.error('module-inputs: a declared operation input would reach the handler unparsed (#953).');
  console.error('  `ModuleRegistration.operationInputs` is optional, so the host parses only what a module hands it:');
  console.error('    operations: { … },');
  console.error('    operationInputs: operationInputsOf(ops),   // from `@substrat-run/contracts`');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  `module-inputs: ok (${registrations} registration(s) across ${files} file(s)` +
    `${skipped > 0 ? `, ${skipped} file(s) opted out` : ''})`,
);
