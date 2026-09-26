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
 * ## The output half (#959), engines only
 *
 * Parsing the input is half of "the handler agrees with its declaration". The other half is
 * a type, `OperationHandlersFor<typeof ops>` from `@substrat-run/kernel`, applied to the map
 * with `satisfies` — and a `satisfies` is the one kind of check no test can see removed. So an
 * `engines/` registration is also held to a map bound that way, with no cast on an entry and
 * bound to the same declaration it parses with (see `unbound`). Engines, because their
 * surfaces are published and composed by verticals that cannot read the handler; the demos
 * and the scaffold are the next case along, and are named in #959 rather than silently judged.
 *
 * Text, not an AST — a loud false positive beats a silent pass.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where a module built from a declared surface lives. The template is not a member, so it is named. */
const ROOTS = ['demos', 'engines'];
const TEMPLATE = 'packages/create-substrat/template';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler']);
/**
 * A whole-file opt-out, and it has to give a reason.
 *
 * Read from the file's COMMENTS alone, never from its source: a marker inside a string
 * literal is a mention, not a decision, and letting one skip the file would hand anybody a
 * way past the gate by writing about it. The comment delimiters are stripped before this is
 * tested, so a marker followed by nothing but the end of its block comment is refused as the
 * empty reason it is, rather than reading the closing star as one.
 */
const ALLOW = /module-inputs-allow:[^\S\n]*\S/;

/**
 * The file, split into code, string, comment and regular-expression tokens.
 *
 * A text rule needs exactly this much of a lexer and no more. All three of the things that
 * hide structure from it live here:
 *
 * - a `'http://…'` whose `//` a naive comment strip would read as the start of one, taking the
 *   rest of the file with it — the false NEGATIVE this check exists to avoid;
 * - a regular-expression literal, whose `{`, `}` and quotes are ordinary characters to it and
 *   structure to a brace counter. Whether a `/` opens one is decided the way every JavaScript
 *   lexer decides it: by what came before. After a value — an identifier, a `)`, a `]` — it is
 *   division; after an operator, a delimiter or a keyword it is a literal;
 * - a comment, which is where the opt-out has to live and nowhere else.
 */
const VALUE_BEFORE = /[\w$)\]]$/;
const KEYWORD_BEFORE = /\b(?:return|typeof|instanceof|in|of|case|new|delete|void|do|else|yield|await)$/;
const tokens = (src) => {
  const out = [];
  let code = '';
  let tail = ''; // the last few code characters, for the "is this `/` a regex?" decision
  let i = 0;
  const flushCode = () => {
    if (code !== '') out.push({ kind: 'code', text: code });
    code = '';
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      flushCode();
      const from = i + 2;
      while (i < src.length && src[i] !== '\n') i++;
      out.push({ kind: 'comment', text: src.slice(from, i) });
      continue;
    }
    if (c === '/' && next === '*') {
      flushCode();
      const from = i + 2;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      out.push({ kind: 'comment', text: src.slice(from, i) });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      flushCode();
      const from = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === c) break;
        else i++;
      }
      i++;
      out.push({ kind: 'string', text: src.slice(from, Math.min(i, src.length)) });
      tail = (tail + 'X').slice(-24);
      continue;
    }
    if (c === '/') {
      // Division or a regular-expression literal, decided by what came before: after a value —
      // an identifier, a `)`, a `]` — it divides; after an operator, a delimiter, the start of
      // the file, or a keyword that takes an expression, it opens a literal.
      const before = tail.trimEnd();
      if (!VALUE_BEFORE.test(before) || KEYWORD_BEFORE.test(before)) {
        flushCode();
        const from = i;
        i++;
        let inClass = false;
        while (i < src.length && src[i] !== '\n') {
          if (src[i] === '\\') i += 2;
          else if (src[i] === '[') (inClass = true), i++;
          else if (src[i] === ']') (inClass = false), i++;
          else if (src[i] === '/' && !inClass) break;
          else i++;
        }
        i++;
        out.push({ kind: 'regex', text: src.slice(from, Math.min(i, src.length)) });
        tail = (tail + 'X').slice(-24);
        continue;
      }
    }
    code += c;
    tail = (tail + c).slice(-24);
    i++;
  }
  flushCode();
  return out;
};

/**
 * The source with comments and regular-expression literals blanked, and every STRUCTURAL
 * character inside a string neutralised — so a `{`, a `,` or a `:` means what it looks like.
 *
 * String contents are kept otherwise, which is the part that matters: a quoted property name —
 * `"operations": ops` — is valid TypeScript and has to be read as the key it is, while a
 * message that happens to spell `'operations: none'` must not read as a declaration. Blanking
 * the delimiters and keeping the letters gets both, because the colon that makes a key is
 * outside the quotes and the one inside is not.
 */
const STRUCTURAL = new Set(['{', '}', '(', ')', '[', ']', ',', ':', ';', '/', '*', '\\']);
const blank = (text) => text.replace(/[^\n]/g, ' ');
const flatten = (source) =>
  tokens(source)
    .map((t) => {
      if (t.kind === 'code') return t.text;
      if (t.kind === 'comment' || t.kind === 'regex') return blank(t.text);
      const quote = t.text[0];
      const inner = t.text.slice(1, t.text.length - 1).replace(/[^\n]/g, (c) => (STRUCTURAL.has(c) ? 'X' : c));
      return quote + inner + (t.text.length > 1 ? quote : '');
    })
    .join('');

/** What the comments said — where an opt-out has to live, and the only place it is read from. */
const comments = (source) =>
  tokens(source)
    .filter((t) => t.kind === 'comment')
    .map((t) => t.text)
    .join('\n');

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
 * Is this `operationInputs` value derived from the declared surface?
 *
 * A direct `operationInputsOf(ops)` call, or an object whose entries are ALL spreads of such
 * calls — which is how a vertical composing two declarations merges them. Nothing else: a
 * hand-written entry, mixed in or alone, covers whatever someone remembered to type while the
 * map as a whole reads as coverage, and `ModuleRegistration` lets a bound operation have no
 * entry at all, so the operation it forgets reaches the guards and the handler unparsed. That
 * is the failure this gate is named after, one level further in.
 */
const derived = (value) => {
  const trimmed = value.trim();
  if (/^operationInputsOf\s*\(/.test(trimmed)) return true;
  if (!trimmed.startsWith('{')) return false;
  const inner = braced(trimmed, 0);
  if (inner === null) return false;
  const entries = ownProperties(inner.body);
  return entries.length > 0 && entries.every((e) => e.key === '...' && /operationInputsOf\s*\(/.test(e.value));
};

/**
 * The top-level entries of an object body, split on the commas at depth 0 — each entry's key
 * and value, whatever the key is spelled with. `ownProperties` reads only identifier-shaped
 * keys, which is right for a registration and wrong for a handler map, whose keys are
 * `'workorder/report-time'`: a hyphen would make it skip the very entry it has to read.
 */
const entriesOf = (body) => {
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
  return parts
    .filter((p) => p.trim() !== '')
    .map((p) => {
      if (/^\s*\.\.\./.test(p)) return { key: '...', value: p };
      const m = /^\s*(?:(['"`])[^'"`\n]*\1|[A-Za-z_$][\w$]*)\s*:/.exec(p);
      return m ? { key: m[0], value: p.slice(m[0].length) } : { key: p.trim(), value: '' };
    });
};

/** A value with everything inside its brackets blanked — what is left is what applies to it. */
const surface = (value) => {
  let out = '';
  let depth = 0;
  for (const c of value) {
    if (c === '{' || c === '(' || c === '[') depth++;
    if (depth === 0) out += c;
    if (c === '}' || c === ')' || c === ']') depth--;
  }
  return out;
};

/**
 * Is an engine's `operations:` map bound to its declaration (#959)?
 *
 * `ModuleRegistration.operations` is `OperationHandler<never, unknown>`, because the host does
 * not know a module's declaration, so nothing makes a handler agree with what its operation
 * declares unless the MAP says so: `{ … } satisfies OperationHandlersFor<typeof ops>`. That
 * clause is invisible to every test — deleting it, or casting one entry `as never`, compiles
 * and passes exactly like the bound map does — which is why it is held here rather than hoped
 * for. Three things are refused:
 *
 * - a map with no `satisfies OperationHandlersFor<typeof …>` behind it, inline or on the
 *   `const` the registration names;
 * - a cast on an entry. `as never` and `as any` are assignable to anything and pass the
 *   `satisfies` silently; the other casts fail it, and are refused anyway because the only
 *   reason to write one is to erase the handler's type;
 * - a binding to a DIFFERENT declaration from the one `operationInputsOf` parses with — the
 *   handler would be checked against one surface while the host parses another.
 *
 * Returns the sentence to report, or null when the map is bound.
 */
const unbound = (src, operationsValue, inputsValue) => {
  const fix =
    'Bind the map to its declaration: `{ … } satisfies OperationHandlersFor<typeof ops>` ' +
    '(`OperationHandlersFor` from `@substrat-run/kernel`), with no cast on any entry';
  let value = operationsValue.trim();
  const named = /^([A-Za-z_$][\w$]*)$/.exec(value);
  if (named !== null) {
    // `operations: OPERATIONS` — the map is the initializer of that const, in this file.
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${named[1].replace(/\$/g, '\\$')}\\s*=\\s*\\{`).exec(src);
    if (decl === null) {
      return `\`operations: ${named[1]}\` names no object literal in this file — this check cannot read the map it has to judge. ${fix}`;
    }
    const open = decl.index + decl[0].length - 1;
    const body = braced(src, open);
    if (body === null) return `the handler map \`${named[1]}\` never closes — this check cannot read it`;
    value = src.slice(open, src.indexOf(';', body.end) === -1 ? src.length : src.indexOf(';', body.end));
  }
  if (!value.startsWith('{')) return `\`operations:\` is not an object literal, so it cannot be bound. ${fix}`;
  const map = braced(value, 0);
  if (map === null) return 'the handler map never closes — this check cannot read it';
  const clause = /^\s*satisfies\s+OperationHandlersFor\s*<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>/.exec(
    value.slice(map.end + 1),
  );
  if (clause === null) {
    return `the \`operations:\` map is not bound to its declaration, so a handler returning the wrong shape compiles. ${fix}`;
  }
  for (const entry of entriesOf(map.body)) {
    if (entry.key === '...') {
      return `the handler map spreads another object — this check cannot see whether what it contributes was cast. ${fix}`;
    }
    if (/\bas\b/.test(surface(entry.value))) {
      return `the handler map entry ${entry.key.replace(/:\s*$/, '')} is cast — \`as never\` and \`as any\` pass the \`satisfies\` silently, and any other cast exists to erase the handler's type. ${fix}`;
    }
  }
  const parsed = /^operationInputsOf\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*$/.exec(inputsValue.trim());
  if (parsed !== null && parsed[1] !== clause[1]) {
    return `the handler map is bound to \`${clause[1]}\` while the host parses \`${parsed[1]}\` — the handlers are checked against one surface and invoked with another. Bind both to the same declaration`;
  }
  return null;
};

/**
 * Every offence in one file's source, as a list of sentences.
 *
 * A registration is judged on three things, in the order they go wrong:
 *
 * 1. Can this check read it at all? Only an object literal carrying the annotation is legible
 *    to a text rule. A registration returned from a function, held in an array, or spread from
 *    somewhere else is REFUSED rather than skipped — passing something it did not read is the
 *    failure mode the gate exists to avoid, and the same call `lint:vite-proxy` makes about a
 *    `proxy:` it cannot see.
 * 2. Does it declare `operations:` at all? A registration that is only a manifest, migrations
 *    and consumers has no invocation surface and nothing to parse.
 * 3. Does it hand over `operationInputs:`, DERIVED from the declared surface? See `derived`.
 *
 * Both spellings of the annotation are read — `const x: ModuleRegistration = { … }` and
 * `const x = { … } satisfies ModuleRegistration` — because a registration the check walks past
 * is a registration it passes, and `satisfies` is the idiom a new module is most likely to
 * reach for.
 */
const judge = (source, { bound = false } = {}) => {
  const src = flatten(source);
  const found = [];
  let judged = 0;

  /** One registration body, once this check has managed to find it. */
  const judgeBody = (name, body) => {
    const props = ownProperties(body);
    if (props.some((p) => p.key === '...')) {
      found.push(
        `${name}: spreads another object into the registration — this check cannot tell what ` +
          'that contributes, so it refuses rather than guesses',
      );
      return;
    }
    const operations = props.find((p) => p.key === 'operations');
    if (operations === undefined) return; // no invocation surface to parse
    const inputs = props.find((p) => p.key === 'operationInputs');
    if (bound) {
      const why = unbound(src, operations.value, inputs?.value ?? '');
      if (why !== null) found.push(`${name}: ${why}`);
    }
    if (inputs === undefined) {
      found.push(
        `${name}: declares \`operations:\` and no \`operationInputs:\` — the Zod inputs in its ` +
          'declared surface are compile-time only, and every invocation reaches the guards and ' +
          'the handler unparsed. Add `operationInputs: operationInputsOf(ops)`',
      );
      return;
    }
    if (!derived(inputs.value)) {
      found.push(
        `${name}: \`operationInputs\` is not derived from the declared surface — a hand-written ` +
          'entry covers only what someone remembered to type while the map reads as coverage. ' +
          'Write `operationInputsOf(ops)`, or an object of nothing but spreads of such calls',
      );
    }
  };

  const unreadable = (where) =>
    found.push(
      `a ModuleRegistration this check cannot read — ${where}. Only ` +
        '`const x: ModuleRegistration = { … }` and `const x = { … } satisfies ModuleRegistration` ' +
        'are legible to a text rule; write it as one of those, or opt the file out with a ' +
        '`module-inputs-allow: <reason>` comment',
    );

  // `const x: ModuleRegistration = { … }`, type arguments and all.
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
      unreadable(
        declared === null
          ? `\`${(head.trim().split('\n').pop() ?? '').trim()} : ModuleRegistration…\``
          : `\`${declared[1]}\``,
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
    judgeBody(name, body.body);
  }

  // `const x = { … } satisfies ModuleRegistration` — the object is BEHIND the keyword, so it is
  // found by balancing braces backwards from the `}` the keyword follows.
  const satisfies = /\bsatisfies\s+ModuleRegistration\b/g;
  while ((m = satisfies.exec(src)) !== null) {
    judged++;
    let end = m.index - 1;
    while (end >= 0 && /\s/.test(src[end])) end--;
    let open = -1;
    if (end >= 0 && src[end] === '}') {
      let depth = 0;
      for (let i = end; i >= 0; i--) {
        if (src[i] === '}') depth++;
        else if (src[i] === '{' && --depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open === -1) {
      unreadable('`… satisfies ModuleRegistration`, with no object literal in front of it');
      continue;
    }
    const before = src.slice(Math.max(0, open - 160), open);
    const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
    judgeBody(declared === null ? 'a `satisfies ModuleRegistration` object' : declared[1], src.slice(open + 1, end));
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
  // A QUOTED property name is the same property. Blanking string contents wholesale hid this
  // one: the registration read as having no operations at all, and passed.
  ['const m: ModuleRegistration = { manifest: x, "operations": ops };', 1],
  [`const m: ModuleRegistration = { manifest: x, 'operations': ops, 'operationInputs': operationInputsOf(o) };`, 0],
  // `satisfies` is the other spelling of the annotation, and the object is behind it.
  [`const m = { manifest: x, ${OPS} } satisfies ModuleRegistration;`, 1],
  [`const m = { manifest: x, ${OPS}, operationInputs: operationInputsOf(ops) } satisfies ModuleRegistration;`, 0],
  ['const m = makeModule() satisfies ModuleRegistration;', 1],
  // A map that is PART derived and part hand-written is not derived: the entries nobody wrote
  // are the operations that reach the handler unparsed.
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: { hand: s, ...operationInputsOf(o) } };`, 1],
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: {} };`, 1],
  [`const m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: someMap };`, 1],
  // A regular-expression literal is a literal: its braces and quotes are not structure, and it
  // must not swallow the registration that follows it.
  [`const re = /[{'"]/;\nconst m: ModuleRegistration = { manifest: x, ${OPS} };`, 1],
  [`const m: ModuleRegistration = { manifest: x, slug: s.replace(/[^a-z{]/g, ''), ${OPS} };`, 1],
  // …and a `/` after a value is division, not the start of one that would eat the rest.
  [`const half = total / 2;\nconst m: ModuleRegistration = { manifest: x, ${OPS} };`, 1],
  [`const ratio = (a + b) / c;\nconst m: ModuleRegistration = { manifest: x, ${OPS}, operationInputs: operationInputsOf(o) };`, 0],
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

// The opt-out skips a whole file, so it is held to being a DECISION — written in a comment,
// carrying a reason. A marker inside a string is somebody writing about the gate, and a marker
// with nothing after it is not a reason however the comment ends.
const OPT_OUT = [
  ['// module-inputs-allow: this module declares no operation surface', true],
  ['/* module-inputs-allow: the same, in a block comment */', true],
  ['/* module-inputs-allow: */', false],
  ['// module-inputs-allow:\nconst x = 1;', false],
  ["const note = 'module-inputs-allow: written about, not decided';", false],
];
// The #959 half: an engine's handler map is bound to its declaration. Judged with `bound`, as
// every `engines/` file is. Each refusal has its accepted twin, so a rule that has stopped
// telling them apart fails here rather than passing the tree.
const REG = (ops, inputs = 'operationInputsOf(xOps)') =>
  `const m: ModuleRegistration = { manifest: x, operationInputs: ${inputs}, operations: ${ops} };`;
const BOUND = 'satisfies OperationHandlersFor<typeof xOps>';
const BOUND_CHECK = [
  // The converted form, inline and on a named const — both accepted.
  [REG(`{ 'x/get': getOp, 'x/report-time': reportOp } ${BOUND}`), 0],
  [`const OPS = { 'x/get': getOp } ${BOUND};\n${REG('OPS')}`, 0],
  // No join at all: the map every engine carried before #959.
  [REG("{ 'x/get': getOp }"), 1],
  [`const OPS = { 'x/get': getOp };\n${REG('OPS')}`, 1],
  // Bound, with one entry cast — each spelling the tree has used, including the two that pass
  // the `satisfies` silently. The hyphenated key is the one an identifier-only key reader skips.
  [REG(`{ 'x/get': getOp, 'x/report-time': reportOp as never } ${BOUND}`), 1],
  [REG(`{ 'x/get': getOp as any } ${BOUND}`), 1],
  [REG(`{ 'x/get': getOp as OperationHandler<never, unknown> } ${BOUND}`), 1],
  [REG(`{ 'x/get': getOp as unknown as OperationHandler<never, unknown> } ${BOUND}`), 1],
  [`const OPS = { 'x/get': getOp, 'x/list': listOp as never } ${BOUND};\n${REG('OPS')}`, 1],
  // A cast INSIDE a handler's own body is the handler's business, not the map's.
  [REG(`{ 'x/get': async (ctx, input) => { return input as Thing; } } ${BOUND}`), 0],
  // Bound to a different declaration from the one the host parses with.
  [REG(`{ 'x/get': getOp } ${BOUND}`, 'operationInputsOf(yOps)'), 1],
  // A spread contributes entries this check cannot see.
  [REG(`{ ...others, 'x/get': getOp } ${BOUND}`), 1],
  // A map this check cannot find is refused, not passed.
  [REG('makeHandlers()'), 1],
  [REG('OPS'), 1],
  // The generic registration rules still hold on a bound file.
  [`const m: ModuleRegistration = { manifest: x, operations: { 'x/get': getOp } ${BOUND} };`, 1],
];
const boundDrift = BOUND_CHECK.filter(([src, want]) => judge(src, { bound: true }).offences.length !== want);
// …and the join is demanded of engines alone: an unbound map outside `engines/` is not refused.
if (judge(REG("{ 'x/get': getOp as never }")).offences.length !== 0) boundDrift.push([REG("{ 'x/get': getOp as never }"), 0]);
if (boundDrift.length > 0) {
  console.error('module-inputs: the handler-map rule no longer tells its own cases apart — fix the predicate before trusting a run:');
  for (const [src, want] of boundDrift) {
    console.error(`  expected ${want} offence(s): ${src.replace(/\n/g, ' ')}`);
  }
  process.exit(2);
}

const optDrift = OPT_OUT.filter(([src, want]) => ALLOW.test(comments(src)) !== want);
if (optDrift.length > 0) {
  console.error('module-inputs: the opt-out no longer tells a reasoned comment from the rest:');
  for (const [src, want] of optDrift) console.error(`  expected ${want}: ${src.replace(/\n/g, ' ')}`);
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
/** Does this file name the type at all? Judged on the raw text, before anything is stripped. */
const NAMES_TYPE = /\bModuleRegistration\b/;
for (const file of sources) {
  const source = readFileSync(file, 'utf8');
  if (!NAMES_TYPE.test(source)) continue;
  if (ALLOW.test(comments(source))) {
    skipped++;
    continue;
  }
  // An engine's handler map is also bound to its declaration (#959) — see `unbound`.
  const verdict = judge(source, { bound: file.split(/[\\/]/)[0] === 'engines' });
  if (verdict.judged === 0) {
    // The raw file names the type and the scan then found nothing to judge. Either the mention
    // is only a `type` import or an indexed access — harmless, and the common case — or the
    // tokenizer lost its place, which is the one way a text rule fails silently. Telling the
    // two apart needs a real type checker, so the cheap half is done here: a file that also
    // spells a registration-shaped `operations:` is reported rather than passed.
    if (/\boperations\s*:/.test(source)) {
      offenders.push(
        `${file}: names ModuleRegistration and declares \`operations:\`, and this check read no ` +
          'registration in it — so it did not read the file the way TypeScript does. It refuses ' +
          'rather than passing something it could not see',
      );
    }
    continue;
  }
  registrations += verdict.judged;
  files++;
  for (const why of verdict.offences) offenders.push(`${file}: ${why}`);
}

if (registrations === 0) {
  console.error('module-inputs: found no module registration — the check would pass by scanning nothing.');
  process.exit(2);
}

if (offenders.length > 0) {
  console.error('module-inputs: a registration disagrees with its declared operation surface.');
  console.error('  The host parses only what a module hands it (#953), and an engine\'s handlers are bound to');
  console.error('  what they declare only by the map saying so (#959):');
  console.error('    operationInputs: operationInputsOf(ops),                          // `@substrat-run/contracts`');
  console.error('    operations: { … } satisfies OperationHandlersFor<typeof ops>,     // `@substrat-run/kernel`, engines');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  `module-inputs: ok (${registrations} registration(s) across ${files} file(s)` +
    `${skipped > 0 ? `, ${skipped} file(s) opted out` : ''})`,
);
