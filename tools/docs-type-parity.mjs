#!/usr/bin/env node
/**
 * Architecture sketch member parity gate (#1585) — the second half of the union gate
 * (`tools/docs-union-check.mjs`), for the fields that are not string-literal unions.
 *
 * docs/architecture/*.md sketch real types in fenced ts blocks — `Tenant`, `Scope`,
 * `ScopeHost`, `OperationContext` … — and nothing held those sketches to the types they
 * mirror. The union gate covers the vocabulary of literal fields; this covers the rest
 * of what a reader takes from a sketch: that a member it names EXISTS, and whether it
 * is OPTIONAL or NULLABLE.
 *
 * What it deliberately does not do (the issue's "What NOT to build"): demand that a
 * sketch compile, or list every member. A sketch may OMIT any member — omission is the
 * simplification that makes the document readable. What it may not do is state
 * something false about a member it does name:
 *
 *   1. presence — a named member exists on the real type (inherited members count);
 *   2. optionality — `foo?:` in the sketch iff the real member is optional
 *      (`foo?:` on an interface; `.optional()`/`.nullish()` on a Zod field, which is
 *      what `z.infer` makes optional — `.default()` is required on the way out);
 *   3. nullability — `| null` in the sketch iff the real member admits null. Fields
 *      whose sketch type is a string-literal union are left to the union gate, which
 *      already compares `null` as a member of the set.
 *
 * A sketch is a MIRROR when its declared name is an exported type in
 * packages/contracts/src or packages/kernel/src — by name, no marker needed. That is
 * the whole of the 13 mirrored names #1585 lists; the test pins the count so a rename
 * on either side shows up as lost coverage rather than silence. A sketch naming nothing
 * real (`AttachmentApi`) is not checked here. Real types resolve from two shapes:
 * an exported interface or object type literal (following `extends` within the
 * indexed files), and `export type X = z.infer<typeof schema>` (following `.extend`,
 * aliases and object wrappers). Anything else refuses with the location rather than
 * guessing.
 *
 * Deliberate departures are written on the member's final line, with a reason, and are
 * refused when they are not needed — so a marker cannot outlive the drift it excused:
 *   // docs-parity-local: <reason>   the member does not exist on the real type
 *   // docs-parity-shape: <reason>   optionality/nullability deliberately differ
 *
 * Nested and anonymous objects (`events: { emits; consumes }`), parameter lists and
 * return types are not compared: a signature sketch is the simplification the document
 * is allowed, and comparing it would need the type checker this tool does not carry.
 *
 * node tools/docs-type-parity.mjs [--check] — advisory by default, refusal with --check.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fences, isCandidate, parse } from './docs-union-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['packages/contracts/src', 'packages/kernel/src'];
const is = (node, type) => node?.type === type;
const nameOf = (node) => (is(node, 'Identifier') ? node.name : is(node, 'StringLiteral') ? node.value : undefined);
const fail = (message) => { throw new Error(message); };

// Zod methods that keep a field's presence and nullability as the receiver had them.
const TRANSPARENT = new Set([
  'min', 'max', 'length', 'regex', 'int', 'positive', 'nonnegative', 'negative', 'nonpositive',
  'gt', 'gte', 'lt', 'lte', 'finite', 'brand', 'describe', 'meta', 'readonly', 'refine',
  'superRefine', 'check', 'trim', 'toLowerCase', 'toUpperCase', 'email', 'url', 'uuid',
  'startsWith', 'endsWith', 'includes', 'nonempty', 'strict', 'strip', 'passthrough',
  'overwrite', 'datetime', 'date', 'time', 'duration', 'ip', 'cidr', 'base64', 'jwt', 'multipleOf',
]);
// Zod methods that produce a new, required, non-null value whatever the receiver was.
const STRUCTURAL = new Set(['array', 'extend', 'pick', 'omit', 'partial', 'required', 'merge', 'keyof']);

function sourceIndex(root) {
  const consts = new Map(); // name -> [{ file, init }]
  const imports = new Map(); // `${file}#${local}` -> { file, name } for relative imports
  const types = new Map(); // exported name -> [{ file, decl }]
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const dir of SOURCE_DIRS) {
    let files;
    try { files = readdirSync(join(root, dir)); } catch { continue; }
    for (const name of files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('.test.')).sort()) {
      const file = `${dir}/${name}`;
      const ast = parse(readFileSync(join(root, file), 'utf8'));
      for (const statement of ast.program.body) {
        if (is(statement, 'ImportDeclaration') && statement.source.value.startsWith('.')) {
          const target = `${dir}/${statement.source.value.replace(/^\.\//, '').replace(/\.js$/, '')}.ts`;
          for (const s of statement.specifiers) {
            if (is(s, 'ImportSpecifier')) imports.set(`${file}#${s.local.name}`, { file: target, name: nameOf(s.imported) });
          }
          continue;
        }
        const exported = statement.type === 'ExportNamedDeclaration';
        const declaration = exported ? statement.declaration : statement;
        if (is(declaration, 'VariableDeclaration')) {
          for (const d of declaration.declarations) if (is(d.id, 'Identifier')) push(consts, d.id.name, { file, init: d.init });
        } else if (exported && (is(declaration, 'TSInterfaceDeclaration') || is(declaration, 'TSTypeAliasDeclaration'))) {
          push(types, declaration.id.name, { file, decl: declaration });
        }
      }
    }
  }
  return { consts, imports, types };
}

const nullable = (type) => {
  if (is(type, 'TSParenthesizedType')) return nullable(type.typeAnnotation);
  return is(type, 'TSNullKeyword') || (is(type, 'TSUnionType') && type.types.some(nullable));
};

// The declaration a name means inside `file`: its own const, else what its relative
// import names, else the one const of that name in the indexed sources.
function resolveConst(index, file, name) {
  const all = index.consts.get(name) ?? [];
  const local = all.filter((c) => c.file === file);
  if (local.length) return local[0];
  const imported = index.imports.get(`${file}#${name}`);
  if (imported) {
    const target = (index.consts.get(imported.name) ?? []).find((c) => c.file === imported.file);
    if (target) return target;
  }
  const candidates = all;
  if (candidates.length !== 1) fail(`cannot uniquely resolve source schema ${name}`);
  return candidates[0];
}

// The presence/nullability a Zod field expression has in `z.infer` (the output type).
function zodShape(index, file, expr, seen = new Set()) {
  if (is(expr, 'Identifier')) {
    if (seen.has(expr.name)) fail(`cyclic source alias ${expr.name}`);
    const c = resolveConst(index, file, expr.name);
    return zodShape(index, c.file, c.init, new Set([...seen, expr.name]));
  }
  if (!is(expr, 'CallExpression') || !is(expr.callee, 'MemberExpression') || expr.callee.computed) {
    fail(`unsupported source field expression ${expr?.type}`);
  }
  const { object: receiver } = expr.callee;
  const method = nameOf(expr.callee.property);
  if (is(receiver, 'Identifier') && receiver.name === 'z') {
    if (method === 'optional') return { optional: true, nullable: zodShape(index, file, expr.arguments[0], seen).nullable };
    if (method === 'nullable') return { optional: zodShape(index, file, expr.arguments[0], seen).optional, nullable: true };
    if (method === 'nullish') return { optional: true, nullable: true };
    if (method === 'null') return { optional: false, nullable: true };
    if (method === 'union') {
      const members = expr.arguments[0]?.elements ?? fail('expected literal z.union array');
      const shapes = members.map((m) => zodShape(index, file, m, seen));
      return { optional: shapes.some((s) => s.optional), nullable: shapes.some((s) => s.nullable) };
    }
    return { optional: false, nullable: false };
  }
  if (method === 'optional') return { optional: true, nullable: zodShape(index, file, receiver, seen).nullable };
  if (method === 'nullish') return { optional: true, nullable: true };
  if (method === 'nullable') return { optional: zodShape(index, file, receiver, seen).optional, nullable: true };
  if (['default', 'prefault', 'catch'].includes(method)) return { optional: false, nullable: zodShape(index, file, receiver, seen).nullable };
  if (TRANSPARENT.has(method)) return zodShape(index, file, receiver, seen);
  if (STRUCTURAL.has(method)) return { optional: false, nullable: false };
  fail(`unsupported source wrapper ${method}`);
}

// The z.object properties behind a schema expression, following aliases and `.extend`.
function zodProperties(index, file, expr, seen = new Set()) {
  if (is(expr, 'Identifier')) {
    if (seen.has(expr.name)) fail(`cyclic source alias ${expr.name}`);
    const c = resolveConst(index, file, expr.name);
    return zodProperties(index, c.file, c.init, new Set([...seen, expr.name]));
  }
  if (!is(expr, 'CallExpression') || !is(expr.callee, 'MemberExpression') || expr.callee.computed) {
    fail(`unsupported source schema expression ${expr?.type}`);
  }
  const { object: receiver } = expr.callee;
  const method = nameOf(expr.callee.property);
  const own = (arg) => {
    if (!is(arg, 'ObjectExpression')) fail(`expected literal object argument to ${method}`);
    if (arg.properties.some((p) => !is(p, 'ObjectProperty') || p.computed)) fail('object spreads, methods and computed keys are unsupported');
    return arg.properties.map((p) => ({ name: nameOf(p.key), file, expr: p.value }));
  };
  if (is(receiver, 'Identifier') && receiver.name === 'z' && method === 'object') return own(expr.arguments[0]);
  if (method === 'extend') {
    const added = own(expr.arguments[0]);
    const names = new Set(added.map((p) => p.name));
    return [...zodProperties(index, file, receiver, seen).filter((p) => !names.has(p.name)), ...added];
  }
  if (['strict', 'strip', 'passthrough', 'superRefine', 'refine', 'readonly', 'describe', 'meta'].includes(method)) {
    return zodProperties(index, file, receiver, seen);
  }
  fail(`unsupported source schema wrapper ${method}`);
}

// name -> () => { optional, nullable } for one exported real type.
function realMembers(index, name, seen = new Set()) {
  if (seen.has(name)) fail(`cyclic extends ${name}`);
  const entries = index.types.get(name) ?? [];
  if (entries.length !== 1) fail(`cannot uniquely resolve real type ${name} (${entries.length} exported declarations)`);
  const { file, decl } = entries[0];
  const members = new Map();
  const fromSignatures = (body) => {
    for (const m of body) {
      if (!is(m, 'TSPropertySignature') && !is(m, 'TSMethodSignature')) continue;
      const key = nameOf(m.key);
      if (key === undefined || m.computed) continue;
      const shape = {
        optional: !!m.optional,
        nullable: is(m, 'TSPropertySignature') && nullable(m.typeAnnotation?.typeAnnotation),
      };
      members.set(key, () => shape);
    }
  };
  if (is(decl, 'TSInterfaceDeclaration')) {
    for (const heritage of decl.extends ?? []) {
      const parent = nameOf(heritage.expression);
      if (!parent) fail(`${file}#${name}: unsupported extends clause`);
      for (const [k, v] of realMembers(index, parent, new Set([...seen, name])).members) members.set(k, v);
    }
    fromSignatures(decl.body.body);
    return { file, members };
  }
  const t = decl.typeAnnotation;
  if (is(t, 'TSTypeLiteral')) { fromSignatures(t.members); return { file, members }; }
  const inferred = is(t, 'TSTypeReference') && is(t.typeName, 'TSQualifiedName') && nameOf(t.typeName.left) === 'z'
    && ['infer', 'output'].includes(nameOf(t.typeName.right));
  const query = inferred ? t.typeParameters?.params?.[0] : undefined;
  if (!is(query, 'TSTypeQuery') || !is(query.exprName, 'Identifier')) {
    fail(`${file}#${name}: unsupported real type shape (expected an interface, an object type literal or z.infer<typeof schema>)`);
  }
  // Resolved per member on demand: an exotic field nobody sketches cannot fail the type.
  for (const p of zodProperties(index, file, query.exprName)) {
    members.set(p.name, () => zodShape(index, p.file, p.expr));
  }
  return { file, members };
}

export function checkParity(root = ROOT) {
  const index = sourceIndex(root);
  const diagnostics = [];
  const types = [];
  let members = 0;
  for (const file of readdirSync(join(root, 'docs/architecture')).filter((f) => f.endsWith('.md')).sort()) {
    const path = `docs/architecture/${file}`;
    const text = readFileSync(join(root, path), 'utf8');
    for (const { language, code, offset } of fences(text)) {
      if (!['ts', 'typescript'].includes(language)) continue;
      if (!/\b(?:interface|type)\s+[\w$]+/.test(code)) continue;
      const ast = parse(code);
      if (ast.errors.length) continue; // the union gate reports unreadable sketches
      for (const statement of ast.program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        const body = is(declaration, 'TSInterfaceDeclaration') ? declaration.body.body
          : is(declaration, 'TSTypeAliasDeclaration') && is(declaration.typeAnnotation, 'TSTypeLiteral') ? declaration.typeAnnotation.members
          : undefined;
        if (!body) continue;
        const typeName = declaration.id.name;
        if (!index.types.has(typeName)) continue; // not a mirror
        const at = (line) => `${path}:${offset + line}`;
        let real;
        try { real = realMembers(index, typeName); }
        catch (error) { diagnostics.push(`${at(declaration.loc.start.line)}: ${typeName}: ${error.message}`); continue; }
        types.push(typeName);
        for (const m of body) {
          if (!is(m, 'TSPropertySignature') && !is(m, 'TSMethodSignature')) continue;
          const key = nameOf(m.key);
          const label = `${typeName}.${key ?? '<computed>'}`;
          const eol = code.indexOf('\n', m.end);
          const rest = code.slice(m.end, eol < 0 ? code.length : eol);
          const tail = /^\s*\/\//.test(rest) ? rest : '';
          try {
            if (key === undefined || m.computed) fail('computed sketch members are unsupported');
            const marker = (name) => {
              const found = [...tail.matchAll(new RegExp(`//\\s*${name}:([^\\n]*?)(?=//|$)`, 'g'))];
              if (found.length > 1) fail(`duplicate ${name} marker`);
              if (!found.length) return undefined;
              if (!found[0][1].trim()) fail(`${name} needs a nonempty reason`);
              return found[0][1].trim();
            };
            if (/docs-parity-(?!local:|shape:)/.test(tail)) fail('unknown docs-parity marker');
            const local = marker('docs-parity-local');
            const shape = marker('docs-parity-shape');
            const resolveShape = real.members.get(key);
            if (!resolveShape) {
              if (!local) fail(`not a member of ${typeName} in ${real.file}; drop it, or mark a deliberate sketch with // docs-parity-local: <reason>`);
              if (shape) fail('docs-parity-shape on a docs-parity-local member compares nothing');
              continue;
            }
            if (local) fail(`docs-parity-local, but ${real.file} declares ${key}; remove the marker`);
            const actual = resolveShape();
            const problems = [];
            if (!!m.optional !== actual.optional) {
              problems.push(actual.optional ? `optional in ${real.file}, required in the sketch` : `required in ${real.file}, optional in the sketch`);
            }
            const type = m.typeAnnotation?.typeAnnotation;
            if (is(m, 'TSPropertySignature') && !isCandidate(type) && nullable(type) !== actual.nullable) {
              problems.push(actual.nullable ? `nullable in ${real.file}, not in the sketch` : `not nullable in ${real.file}, nullable in the sketch`);
            }
            if (problems.length && !shape) fail(`${problems.join('; ')} (or mark a deliberate difference with // docs-parity-shape: <reason>)`);
            if (!problems.length && shape) fail(`docs-parity-shape, but the sketch matches ${real.file}; remove the marker`);
            members++;
          } catch (error) { diagnostics.push(`${at(m.loc.start.line)}: ${label}: ${error.message}`); }
        }
      }
    }
  }
  return { diagnostics, types, members };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { diagnostics, types, members } = checkParity();
  for (const message of diagnostics) console.error(message);
  console.log(`docs-parity: ${types.length} mirrored types, ${members} members checked, ${diagnostics.length} problems`);
  if (process.argv.includes('--check') && diagnostics.length) process.exitCode = 1;
}
