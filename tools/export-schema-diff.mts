#!/usr/bin/env tsx
/**
 * D-22's breaking-change rule, for exported events (#1705 PR 3).
 *
 * An exported event is a contract with ANOTHER team's deployed code: a consumer vertical parses
 * its payload with its own schema, for the (type, schemaVersion) it declares. Each model's
 * checked-in `model.json` carries every exported type's payload as JSON Schema (`exports`, held
 * to the declaration by `lint:model --check`). This compares it with the same file on the base
 * branch. For an exported type whose schemaVersion did NOT change, it refuses:
 *
 *   - a field REMOVED: the consumer reads a field the producer stopped sending;
 *   - a field RETYPED: the consumer's parse rejects the new shape, or accepts it wrongly;
 *   - a field NEWLY REQUIRED: events already in the outbox at this version lack it, and a
 *     consumer backfilling or replaying them (#1705's watermark starts at the beginning) would
 *     reject history its own version is supposed to accept;
 *   - a field NO LONGER REQUIRED: the producer may now omit what the consumer relies on;
 *   - a schemaVersion that went DOWN.
 *
 * A bumped schemaVersion is the explicit break, and passes: K-39 makes it a replace, and a
 * consumer on the old version gets it withheld as `version` rather than mis-parsed. An export
 * dropped outright also passes here. That is the promote gate's concern, since only the platform
 * knows who imports it. A NEW export, or a new optional field, is additive.
 *
 * Usage: tsx tools/export-schema-diff.mts --base <ref> [--root <checkout>]
 *
 * The base is the merge-base of <ref> and HEAD, so a branch behind its base is not charged with
 * what the base changed since. It must be in the checkout. A base that cannot be read is exit 2,
 * never a pass: read as "no model.json at base", it would let every export through as new, which
 * is the silent pass this check exists to prevent. On a shallow clone the error says so.
 *
 * Exit 0: no breaking change. 1: at least one (each printed). 2: could not run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One exported type as `model.json` carries it. */
interface Exported {
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export interface Violation {
  file: string;
  type: string;
  rule: 'removed' | 'retyped' | 'newly-required' | 'no-longer-required' | 'version-down';
  field: string | null;
  detail: string;
}

/** Keys that describe a schema without constraining it. A changed description is not a break. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment', 'default', 'deprecated', 'readOnly', 'writeOnly']);

/** A schema with its annotations stripped and its keys sorted, as a comparable string. */
function shape(schema: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (ANNOTATIONS.has(k)) continue;
      out[k] = strip((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(strip(schema));
}

/**
 * The schema with every local `$ref` (`#/$defs/…`, `#/definitions/…`) replaced by what it points
 * at, recursively, and the definitions dropped. `z.toJSONSchema` moves a schema used more than once
 * into `$defs`. Compared unresolved, a break INSIDE a definition would read as an unchanged
 * `{"$ref": …}` on both sides and pass. A reference that loops back on itself is left as the
 * reference (its target is compared where it is first inlined).
 */
export function resolveRefs(schema: unknown, root: unknown = schema, seen: readonly string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((v) => resolveRefs(v, root, seen));
  if (schema === null || typeof schema !== 'object') return schema;
  const obj = schema as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/') && !seen.includes(ref)) {
    let target: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      target = target !== null && typeof target === 'object' ? (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    if (target !== undefined) {
      const { $ref: _ref, ...siblings } = obj;
      const resolved = resolveRefs(target, root, [...seen, ref]) as Record<string, unknown>;
      return Object.keys(siblings).length ? { ...resolved, ...(resolveRefs(siblings, root, seen) as object) } : resolved;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$defs' || k === 'definitions') continue;
    out[k] = resolveRefs(v, root, seen);
  }
  return out;
}

const propertiesOf = (s: Record<string, unknown>): Record<string, unknown> =>
  s.properties !== null && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : {};
const requiredOf = (s: Record<string, unknown>): Set<string> =>
  new Set(Array.isArray(s.required) ? (s.required as unknown[]).filter((x): x is string => typeof x === 'string') : []);

/**
 * The rule itself, over two parsed `exports` maps (a missing side is `{}`). Pure, so the test
 * holds each clause without a repository.
 */
export function classifyExports(
  file: string,
  base: Record<string, Exported>,
  head: Record<string, Exported>,
): Violation[] {
  const out: Violation[] = [];
  for (const type of Object.keys(base).sort()) {
    const b = base[type]!;
    const h = head[type];
    if (!h) continue; // dropped: the promote gate's concern (it knows who imports it)
    if (h.schemaVersion < b.schemaVersion) {
      out.push({
        file,
        type,
        rule: 'version-down',
        field: null,
        detail: `schemaVersion went from ${b.schemaVersion} to ${h.schemaVersion}`,
      });
      continue;
    }
    if (h.schemaVersion !== b.schemaVersion) continue; // the explicit break (K-39)
    const bs = resolveRefs(b.payload) as Record<string, unknown>;
    const hs = resolveRefs(h.payload) as Record<string, unknown>;
    const bp = propertiesOf(bs);
    const hp = propertiesOf(hs);
    const isObject = (s: Record<string, unknown>) => s.type === 'object' || 'properties' in s;
    if (!isObject(bs) || !isObject(hs)) {
      if (shape(bs) !== shape(hs)) {
        out.push({ file, type, rule: 'retyped', field: null, detail: 'the payload schema changed' });
      }
      continue;
    }
    for (const field of Object.keys(bp).sort()) {
      if (!(field in hp)) {
        out.push({ file, type, rule: 'removed', field, detail: `'${field}' is no longer in the payload` });
      } else if (shape(bp[field]) !== shape(hp[field])) {
        out.push({ file, type, rule: 'retyped', field, detail: `'${field}' changed from ${shape(bp[field])} to ${shape(hp[field])}` });
      }
    }
    const br = requiredOf(bs);
    const hr = requiredOf(hs);
    for (const field of [...hr].sort()) {
      if (!br.has(field)) {
        out.push({
          file,
          type,
          rule: 'newly-required',
          field,
          detail: `'${field}' is required now, and events already sent at v${b.schemaVersion} do not carry it`,
        });
      }
    }
    for (const field of [...br].sort()) {
      if (!hr.has(field) && field in hp) {
        out.push({ file, type, rule: 'no-longer-required', field, detail: `'${field}' may now be omitted` });
      }
    }
  }
  return out;
}

class CannotRun extends Error {}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The base commit: the merge-base of `ref` and HEAD, or a refusal that says why it is missing. */
export function baseCommit(ref: string, cwd: string): string {
  const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  if (resolved.status !== 0) {
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' }).stdout.trim();
    throw new CannotRun(
      `the base '${ref}' is not in this checkout` +
        (shallow === 'true' ? ' (a shallow clone: fetch it, or check out with full history)' : ' (fetch it first)') +
        ' — without it every export would read as new, and nothing would be compared',
    );
  }
  const mb = spawnSync('git', ['merge-base', resolved.stdout.trim(), 'HEAD'], { cwd, encoding: 'utf8' });
  if (mb.status !== 0) {
    throw new CannotRun(`no merge-base between '${ref}' and HEAD — the history between them is not in this checkout`);
  }
  return mb.stdout.trim();
}

/** The file at the base commit: its text, or `null` when the base genuinely has no such file. */
export function atBase(commit: string, path: string, cwd: string): string | null {
  // `ls-tree` answers "absent" with empty output and exit 0. Any error (a missing object in a
  // partial clone, a corrupt pack) is exit 2 upstream, never an absence.
  const listed = spawnSync('git', ['ls-tree', '--name-only', commit, '--', path], { cwd, encoding: 'utf8' });
  if (listed.status !== 0) throw new CannotRun(`cannot list ${path} at ${commit}: ${listed.stderr.trim()}`);
  if (listed.stdout.trim() === '') return null;
  return git(['show', `${commit}:${path}`], cwd);
}

/** Every tracked `model.json` at HEAD, and every one the base had (a deleted file is still compared). */
function modelFiles(commit: string, cwd: string): string[] {
  const isModel = (p: string) => p.endsWith('/model.json') && !p.startsWith('.builder/') && !p.includes('node_modules/');
  const head = git(['ls-files'], cwd).split('\n').filter(isModel);
  const base = git(['ls-tree', '-r', '--name-only', commit], cwd).split('\n').filter(isModel);
  return [...new Set([...head, ...base])].sort();
}

const exportsIn = (text: string | null, where: string): Record<string, Exported> => {
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as { exports?: Record<string, Exported> };
    return parsed.exports ?? {};
  } catch (err) {
    throw new CannotRun(`${where} does not parse as JSON: ${(err as Error).message}`);
  }
};

export function run(ref: string, cwd: string = ROOT): Violation[] {
  const commit = baseCommit(ref, cwd);
  const out: Violation[] = [];
  for (const file of modelFiles(commit, cwd)) {
    const head = existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), 'utf8') : null;
    out.push(
      ...classifyExports(file, exportsIn(atBase(commit, file, cwd), `${file} at ${ref}`), exportsIn(head, file)),
    );
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const ref = arg('--base');
  const root = arg('--root') ?? ROOT;
  if (!ref) {
    console.error('export-schema-diff: --base <ref> is required (the branch this change merges into)');
    process.exit(2);
  }
  try {
    const found = run(ref, root);
    if (found.length === 0) {
      console.log(`export-schema-diff: no breaking change to an exported event's payload against ${ref}`);
      process.exit(0);
    }
    for (const v of found) {
      console.error(`${v.file}: '${v.type}' ${v.rule}${v.field ? ` (${v.field})` : ''} — ${v.detail}`);
    }
    console.error(
      `\nexport-schema-diff: ${found.length} breaking change(s) to exported payloads at an unchanged schemaVersion. ` +
        'Another vertical parses these. Bump the schemaVersion (a K-39 replace), or keep the field as it was.',
    );
    process.exit(1);
  } catch (err) {
    console.error(`export-schema-diff: cannot run — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
