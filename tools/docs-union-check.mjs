#!/usr/bin/env node
/**
 * Architecture sketch union gate (#1585). No compilation or whole-interface equality.
 *
 * Reads top-level named interfaces and object type aliases in ts/typescript fences
 * in docs/architecture/*.md. Direct string literals (even one), unions and parentheses
 * are supported; null is compared too. Other field types are outside this gate.
 *
 * Convention: Type.field -> exported lowerCamelType schema's field in contracts/src.
 * The field leads to the actual z.enum; no second list of enum values is maintained.
 * Exceptions use a trailing field comment:
 *   // docs-union-source: tenancy.ts#scope.status
 * Deliberate omissions use `// subset: <nonempty reason>`; invented values/null never
 * pass. A sketch with no contract counterpart must say on the field:
 *   // docs-union-local: <nonempty reason>
 * That escape is refused when the conventional schema exists. Markers are field-local,
 * on the final line of the declaration; use separate // comments to combine markers.
 *
 * Source syntax is deliberately bounded: same-file const aliases, z.object/z.enum
 * literals, nullable/nullish/optional/default/brand/readonly wrappers, and object
 * strict/strip/passthrough/superRefine wrappers. Unknown expressions fail with location
 * and mapping, rather than being evaluated or guessed. Required/optional parity,
 * nested/anonymous doc objects, inherited fields, mixed unions (ModuleId | 'vertical')
 * and nonliteral aliases are not checked. Refinement predicates are not evaluated;
 * superRefine preserves the enum vocabulary being described, not every accepted object.
 *
 * node tools/docs-union-check.mjs [--check] — advisory by default, refusal with --check.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 exposes no standalone JS parser. Babel's stable TypeScript parser
// is already in the lockfile; this root dependency makes its use explicit.
import { parse as parseTypeScript } from '@babel/parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parse = (text) => parseTypeScript(text, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
const nameOf = (node) => node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : undefined;
const is = (node, type) => node?.type === type;
const fail = (message) => { throw new Error(message); };

function sourceIndex(root) {
  return readdirSync(join(root, 'packages/contracts/src')).filter((f) => f.endsWith('.ts')).map((file) => {
    const ast = parse(readFileSync(join(root, 'packages/contracts/src', file), 'utf8'));
    const declarations = new Map();
    const exported = new Set();
    for (const statement of ast.program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (!is(declaration, 'VariableDeclaration')) continue;
      for (const d of declaration.declarations) {
        if (!is(d.id, 'Identifier')) continue;
        declarations.set(d.id.name, d.init);
        if (statement.type === 'ExportNamedDeclaration') exported.add(d.id.name);
      }
    }
    return { file, declarations, exported };
  });
}

function resolveSchema(source, expression, kind, seen = new Set()) {
  if (!expression) fail('missing source initializer');
  if (is(expression, 'Identifier')) {
    if (seen.has(expression.name)) fail(`cyclic source alias ${expression.name}`);
    return resolveSchema(source, source.declarations.get(expression.name), kind, new Set([...seen, expression.name]));
  }
  if (!is(expression, 'CallExpression') || !is(expression.callee, 'MemberExpression') || expression.callee.computed) {
    fail(`unsupported source expression ${expression.type}`);
  }
  const { object: receiver, property } = expression.callee;
  const method = nameOf(property);
  const arg = expression.arguments[0];
  if (is(receiver, 'Identifier') && receiver.name === 'z' && method === kind) {
    if (kind === 'object' && arg && is(arg, 'ObjectExpression')) return arg;
    if (kind === 'enum' && arg && is(arg, 'ArrayExpression') && arg.elements.length && arg.elements.every((e) => is(e, 'StringLiteral'))) {
      return new Set(arg.elements.map((e) => JSON.stringify(e.value)));
    }
    fail(`expected literal z.${kind} argument`);
  }
  const wrappers = kind === 'object'
    ? ['strict', 'strip', 'passthrough', 'superRefine']
    : ['nullable', 'nullish', 'optional', 'default', 'brand', 'readonly'];
  if (!wrappers.includes(method)) fail(`unsupported ${kind} wrapper ${method}`);
  const result = resolveSchema(source, receiver, kind, seen);
  if (kind === 'enum' && ['nullable', 'nullish'].includes(method)) result.add('null');
  return result;
}

function literals(type) {
  if (is(type, 'TSParenthesizedType')) return literals(type.typeAnnotation);
  if (is(type, 'TSUnionType')) return type.types.flatMap(literals);
  if (is(type, 'TSLiteralType') && is(type.literal, 'StringLiteral')) return [JSON.stringify(type.literal.value)];
  if (is(type, 'TSNullKeyword')) return ['null'];
  fail(`unsupported sketch union member ${type?.type}; use direct string literals and null`);
}
function isCandidate(type) {
  try { return literals(type).some((v) => v !== 'null'); }
  catch { return false; } // Mixed/nonliteral fields (e.g. ModuleId | 'vertical') are outside this gate.
}

// CommonMark fences may close with more delimiters than they opened with.
function* fences(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(lines[i]);
    if (!opening) continue;
    const start = i + 1;
    const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
    while (++i < lines.length && !closing.test(lines[i])) { /* consume this fence */ }
    yield { language: opening[2].trim(), code: lines.slice(start, i).join('\n'), offset: start };
  }
}

export function checkUnions(root = ROOT) {
  const sources = sourceIndex(root);
  const diagnostics = [];
  let checked = 0;
  for (const file of readdirSync(join(root, 'docs/architecture')).filter((f) => f.endsWith('.md')).sort()) {
    const path = `docs/architecture/${file}`;
    const text = readFileSync(join(root, path), 'utf8');
    for (const { language, code, offset } of fences(text)) {
      if (!['ts', 'typescript'].includes(language)) continue;
      // Many fences are illustrative expressions or ellipses, not declarations.
      if (!/\b(?:interface|type)\s+[\w$]+/.test(code)) continue;
      let ast;
      try {
        ast = parse(code);
        if (ast.errors.length) throw ast.errors[0];
      }
      catch (error) {
        diagnostics.push(`${path}:${offset + (error.loc?.line ?? 1)}: cannot parse TypeScript sketch: ${error.message}`);
        continue;
      }
      for (const statement of ast.program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        const members = is(declaration, 'TSInterfaceDeclaration') ? declaration.body.body
          : is(declaration, 'TSTypeAliasDeclaration') && is(declaration.typeAnnotation, 'TSTypeLiteral') ? declaration.typeAnnotation.members : [];
        for (const field of members) {
          if (!is(field, 'TSPropertySignature')) continue;
          const fieldType = field.typeAnnotation?.typeAnnotation;
          const restOfLine = code.slice(field.end, code.indexOf('\n', field.end) < 0 ? code.length : code.indexOf('\n', field.end));
          const tail = /^\s*\/\//.test(restOfLine) ? restOfLine : '';
          const marked = /\/\/\s*(?:docs-union-|subset:)/.test(tail);
          if (!isCandidate(fieldType) && !marked) continue;
          const location = `${path}:${offset + field.loc.start.line}`;
          const label = `${declaration.id.name}.${nameOf(field.key) ?? '<computed>'}`;
          try {
            if (field.computed) fail('computed sketch fields are unsupported');
            const marker = (key) => {
              const matches = [...tail.matchAll(new RegExp(`//\\s*${key}:([^\\n]*?)(?=//|$)`, 'g'))];
              if (matches.length > 1) fail(`duplicate ${key} marker`);
              if (!matches.length) return undefined;
              if (!matches[0][1].trim()) fail(`${key} needs a nonempty value/reason`);
              return matches[0][1].trim();
            };
            const sourceMarker = marker('docs-union-source');
            const subset = marker('subset');
            const local = marker('docs-union-local');
            if (/docs-union-(?!source:|local:)/.test(tail)) fail('unknown docs-union marker');
            const conventional = lowerFirst(declaration.id.name);
            const conventionalSources = sources.filter((s) => s.exported.has(conventional));
            if (local) {
              if (sourceMarker || subset || conventionalSources.length) fail('docs-union-local requires no contract counterpart and no other markers');
              continue;
            }
            let schema = conventional;
            let key = nameOf(field.key);
            let matches = conventionalSources;
            if (sourceMarker) {
              const match = /^([\w-]+\.ts)#(\w+)\.(\w+)$/.exec(sourceMarker);
              if (!match) fail('docs-union-source must be file.ts#exportedSchema.field');
              [, , schema, key] = match;
              matches = sources.filter((s) => s.file === match[1] && s.exported.has(schema));
            }
            if (matches.length !== 1) fail(`cannot uniquely resolve ${sourceMarker ?? `${schema}.${key}`}; add docs-union-source: file.ts#exportedSchema.field, or docs-union-local: reason for a sketch without a counterpart`);
            const source = matches[0];
            const mapping = `${source.file}#${schema}.${key}`;
            try {
              const object = resolveSchema(source, source.declarations.get(schema), 'object');
              if (object.properties.some((p) => is(p, 'SpreadElement'))) fail('object spreads are unsupported');
              const properties = object.properties.filter((p) => nameOf(p.key) === key);
              if (properties.length !== 1) fail(`missing or ambiguous schema field ${key}`);
              const p = properties[0];
              const expr = is(p, 'ObjectProperty') && !p.computed ? p.value : undefined;
              const expected = resolveSchema(source, expr, 'enum');
              const actual = new Set(literals(fieldType));
              const extra = [...actual].filter((v) => !expected.has(v));
              const missing = [...expected].filter((v) => !actual.has(v));
              if (extra.length || (!subset && missing.length)) fail(`union drift; extra [${extra.join(', ')}], missing [${missing.join(', ')}]; expected ${[...expected].join(' | ')}${subset ? ' (subset permits omissions only)' : ''}`);
              checked++;
            } catch (error) { fail(`${mapping}: ${error.message}`); }
          } catch (error) { diagnostics.push(`${location}: ${label}: ${error.message}`); }
        }
      }
    }
  }
  return { diagnostics, checked };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { diagnostics, checked } = checkUnions();
  for (const message of diagnostics) console.error(message);
  console.log(`docs-union: ${checked} fields checked, ${diagnostics.length} problems`);
  if (process.argv.includes('--check') && diagnostics.length) process.exitCode = 1;
}
