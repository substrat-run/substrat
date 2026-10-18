/**
 * The semver bump a vertical's change calls for, computed from its artifacts of record (#2364).
 *
 * Choosing a bump is a judgement an agent makes with confidence and gets wrong, and a breaking
 * change marked `patch` looks exactly like a green release. A vertical already checks in every
 * fact the judgement needs — `model.json` (`lint:model`), `openapi.json` (`lint:api`) and
 * `PERMISSIONS.md` (`lint:permissions`), each held to the source by a `--check` re-emit — so the
 * bump is read off the diff of those three files instead of asked for.
 *
 * The rules, one level per change, the bump being the highest:
 *
 *   - **major**: something removed or narrowed. An operation, a field, an entity, a state, a
 *     transition, a response, an enum value; an input that became required, an output that became
 *     optional, a type that changed.
 *   - **minor**: something added. A new operation, field, entity, state or key; an input that
 *     became optional. Every permission change is at least minor, and a narrowing is FLAGGED for
 *     the human checkpoint (CLAUDE.md, "Two human checkpoints"). A widening is flagged as well,
 *     since a key gaining a role is the risk surface that checkpoint exists for.
 *   - **patch**: the artifacts differ only in what describes them (`description`, `summary`,
 *     `title`, `examples`, …).
 *
 * **What it cannot read is major.** A keyword, section or key this module does not know is
 * judged as a breaking change, never skipped. The CI check refuses a changeset that declares
 * LESS than this, so an unknown shape that read as "no change" would let a real break ship as a
 * patch. A false major costs a reviewed override line in the changeset; a false patch costs a
 * broken consumer. Teach this file the new shape instead.
 *
 * Pure: two texts in, a classification out. The filesystem and git half is `changeset.ts`. It
 * reads the artifacts, never the TypeScript, which is what keeps it valid across a change of
 * authoring notation (`tools/model-diff.mts`). The same classifier is what `substrat changeset`
 * writes, what `--check` holds a hand-written changeset to, and what a status line can show.
 */

export type Level = 'patch' | 'minor' | 'major';
export type Bump = 'none' | Level;
export type Artifact = 'model' | 'openapi' | 'permissions';

export interface Change {
  readonly level: Level;
  readonly artifact: Artifact;
  /** Where in the artifact, as a reader would name it (`POST /api/lists`, `entities.item.fields.text`). */
  readonly path: string;
  readonly detail: string;
  /** A permission change the human checkpoint must read, whatever the bump. */
  readonly flagged?: boolean;
}

export interface Classification {
  readonly bump: Bump;
  readonly changes: readonly Change[];
}

const ORDER: readonly Bump[] = ['none', 'patch', 'minor', 'major'];

export const rank = (b: Bump): number => ORDER.indexOf(b);
export const maxBump = (a: Bump, b: Bump): Bump => (rank(a) >= rank(b) ? a : b);
export const isBump = (s: string): s is Bump => (ORDER as readonly string[]).includes(s);

/** The highest level among the changes; `none` when there are none. */
function bumpOf(changes: readonly Change[]): Bump {
  return changes.reduce<Bump>((acc, c) => maxBump(acc, c.level), 'none');
}

const classification = (changes: Change[]): Classification => ({ bump: bumpOf(changes), changes });

// ─── JSON Schema ──────────────────────────────────────────────────────────────────────────────

/** Keywords that describe a schema without constraining it. A change to one is documentation. */
const ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', '$comment', 'default', 'deprecated', 'readOnly', 'writeOnly',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keywords whose keys are NAMES (a field called `title`), never keywords to strip. */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'schemas', 'responses', 'content']);

/** A value as a comparable string, keys sorted, optionally without annotations at any depth. */
function canon(v: unknown, stripAnnotations: boolean): string {
  const walk = (x: unknown, names = false): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (!isRecord(x)) return x;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort()) {
      if (!names && stripAnnotations && (ANNOTATIONS.has(k) || k.startsWith('x-'))) continue;
      out[k] = walk(x[k], !names && NAME_MAPS.has(k));
    }
    return out;
  };
  return JSON.stringify(walk(v)) ?? 'undefined';
}

/**
 * Every local `$ref` (`#/…`) replaced by its target, recursively, against `root`. Compared
 * unresolved, a break inside a shared component reads as an unchanged `{"$ref": …}` on both
 * sides. A reference that loops back is left as the reference.
 */
export function resolveRefs(node: unknown, root: unknown = node, seen: readonly string[] = []): unknown {
  if (Array.isArray(node)) return node.map((v) => resolveRefs(v, root, seen));
  if (!isRecord(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/') && !seen.includes(ref)) {
    let target: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      target = isRecord(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    if (target !== undefined) {
      const { $ref: _ref, ...siblings } = node;
      const resolved = resolveRefs(target, root, [...seen, ref]);
      return Object.keys(siblings).length && isRecord(resolved)
        ? { ...resolved, ...(resolveRefs(siblings, root, seen) as object) }
        : resolved;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$defs' || k === 'definitions') continue;
    out[k] = resolveRefs(v, root, seen);
  }
  return out;
}

/**
 * Which way a schema's values travel. An `input` is what a caller SENDS: requiring more of it
 * breaks the caller, accepting more does not. An `output` is what a caller READS (a response, a
 * stored row, an event payload): promising less of it breaks the reader, promising more does not.
 */
export type Direction = 'input' | 'output';

/**
 * Numeric limits, and which way is tighter. A lower bound rising or an upper bound falling
 * accepts less: that breaks a caller sending it (input) and is safe for a reader (output).
 */
const LOWER_BOUNDS = new Set(['minLength', 'minItems', 'minProperties', 'minimum', 'exclusiveMinimum']);
const UPPER_BOUNDS = new Set(['maxLength', 'maxItems', 'maxProperties', 'maximum', 'exclusiveMaximum']);
const COMPOSITIONS = ['anyOf', 'oneOf', 'allOf'] as const;

/** The keywords `compareSchema` judges on their meaning. Any other constraint change is major. */
const UNDERSTOOD = new Set([
  'type', 'enum', 'properties', 'required', 'additionalProperties', 'items',
  ...LOWER_BOUNDS, ...UPPER_BOUNDS, ...COMPOSITIONS,
]);

const requiredOf = (s: Record<string, unknown>): Set<string> =>
  new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : []);
const propertiesOf = (s: Record<string, unknown>): Record<string, unknown> =>
  isRecord(s.properties) ? s.properties : {};

/**
 * One schema against its base, keyword by keyword, pushing a change for each difference. `push`
 * carries the artifact; `path` names the place for a reader. Both schemas must be resolved.
 */
function compareSchema(
  push: (level: Level, path: string, detail: string) => void,
  dir: Direction,
  path: string,
  base: unknown,
  head: unknown,
): void {
  if (canon(base, false) === canon(head, false)) return;
  if (canon(base, true) === canon(head, true)) {
    push('patch', path, 'documentation only');
    return;
  }
  if (!isRecord(base) || !isRecord(head)) {
    push('major', path, `changed from ${canon(base, true)} to ${canon(head, true)}`);
    return;
  }

  // The safety net, checked at the end: the two schemas differ in more than documentation, so
  // if no rule below ranked anything, the difference is one this classifier did not read (a
  // `required` naming a property declared in another `allOf` branch, say) — and that is major.
  const outer = push;
  let ranked = false;
  push = (level, at, detail) => {
    ranked = true;
    outer(level, at, detail);
  };

  if (canon(base.type, false) !== canon(head.type, false)) {
    push('major', path, `type changed from ${canon(base.type, false)} to ${canon(head.type, false)}`);
  }

  if (Array.isArray(base.enum) || Array.isArray(head.enum)) {
    if (!Array.isArray(base.enum) || !Array.isArray(head.enum)) {
      // An enum appearing narrows the values to a list; one disappearing loses the promise.
      push('major', path, Array.isArray(head.enum) ? 'is now restricted to an enum' : 'is no longer an enum');
    } else {
      const b = new Set(base.enum.map((v) => canon(v, false)));
      const h = new Set(head.enum.map((v) => canon(v, false)));
      const removed = [...b].filter((v) => !h.has(v));
      const added = [...h].filter((v) => !b.has(v));
      if (removed.length) push('major', path, `enum value(s) removed: ${removed.join(', ')}`);
      if (added.length) push('minor', path, `enum value(s) added: ${added.join(', ')}`);
    }
  }

  const bp = propertiesOf(base);
  const hp = propertiesOf(head);
  const br = requiredOf(base);
  const hr = requiredOf(head);
  const at = (field: string) => (path ? `${path}.${field}` : field);
  for (const field of Object.keys(bp).sort()) {
    if (!(field in hp)) push('major', at(field), 'removed');
    else compareSchema(push, dir, at(field), bp[field], hp[field]);
  }
  for (const field of Object.keys(hp).sort()) {
    if (field in bp) continue;
    if (dir === 'input' && hr.has(field)) push('major', at(field), 'added as a required input — a caller that omits it is refused');
    else push('minor', at(field), 'added');
  }
  for (const field of [...hr].sort()) {
    if (br.has(field) || !(field in bp) || !(field in hp)) continue;
    push(dir === 'input' ? 'major' : 'minor', at(field), 'is now required');
  }
  for (const field of [...br].sort()) {
    if (hr.has(field) || !(field in hp)) continue;
    push(dir === 'input' ? 'minor' : 'major', at(field), dir === 'input' ? 'is now optional' : 'may now be omitted');
  }

  const ba = base.additionalProperties;
  const ha = head.additionalProperties;
  if (canon(ba, false) !== canon(ha, false)) {
    if (isRecord(ba) && isRecord(ha)) {
      compareSchema(push, dir, `${path}[*]`, ba, ha);
    } else if (dir === 'input' && ha === false) {
      push('major', path, 'no longer accepts properties it does not name');
    } else if (isRecord(ba) || isRecord(ha)) {
      push('major', `${path}[*]`, `value schema changed from ${canon(ba, true)} to ${canon(ha, true)}`);
    } else {
      push('minor', path, `additionalProperties changed from ${canon(ba, false)} to ${canon(ha, false)}`);
    }
  }

  if (base.items !== undefined || head.items !== undefined) {
    if (base.items === undefined || head.items === undefined) push('major', `${path}[]`, 'items changed');
    else compareSchema(push, dir, `${path}[]`, base.items, head.items);
  }

  for (const k of [...LOWER_BOUNDS, ...UPPER_BOUNDS]) {
    const bv = base[k];
    const hv = head[k];
    if (bv === hv) continue;
    if ((bv !== undefined && typeof bv !== 'number') || (hv !== undefined && typeof hv !== 'number')) {
      push('major', path, `'${k}' changed from ${canon(bv, false)} to ${canon(hv, false)}`);
      continue;
    }
    // An absent bound is no limit at all: the loosest value there is.
    const lower = LOWER_BOUNDS.has(k);
    const loose = lower ? -Infinity : Infinity;
    const b = (bv as number | undefined) ?? loose;
    const h = (hv as number | undefined) ?? loose;
    const tighter = lower ? h > b : h < b;
    const breaks = dir === 'input' ? tighter : !tighter;
    push(breaks ? 'major' : 'minor', path, `'${k}' ${tighter ? 'tightened' : 'loosened'} from ${bv ?? 'none'} to ${hv ?? 'none'}`);
  }

  // Alternatives are compared position by position: the emitter writes them in declaration
  // order, so `[X, null]` stays `[X, null]` while X changes. A different count is judged whole.
  for (const k of COMPOSITIONS) {
    const ba = base[k];
    const ha = head[k];
    if (ba === undefined && ha === undefined) continue;
    if (!Array.isArray(ba) || !Array.isArray(ha) || ba.length !== ha.length) {
      if (canon(ba, true) !== canon(ha, true)) push('major', path, `'${k}' alternatives changed`);
      continue;
    }
    ba.forEach((branch, i) => compareSchema(push, dir, `${path}|${k}[${i}]`, branch, ha[i]));
  }

  for (const k of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    if (UNDERSTOOD.has(k) || ANNOTATIONS.has(k) || k.startsWith('x-')) continue;
    if (canon(base[k], true) !== canon(head[k], true)) {
      push('major', path, `'${k}' changed — not a change this classifier can rank, so judged as breaking`);
    }
  }
  if (!ranked) outer('major', path, 'changed in a way no rule here reads, so judged as breaking');
}

// ─── shared helpers ───────────────────────────────────────────────────────────────────────────

type Push = (level: Level, path: string, detail: string, flagged?: boolean) => void;

function pusher(artifact: Artifact, out: Change[]): Push {
  return (level, path, detail, flagged) =>
    out.push({ level, artifact, path, detail, ...(flagged ? { flagged: true } : {}) });
}

/** Removed keys → `removed`, added → `added`, both sides present → `both`. Sorted. */
function keyed<T>(
  base: Record<string, T>,
  head: Record<string, T>,
  on: { removed: (k: string, b: T) => void; added: (k: string, h: T) => void; both: (k: string, b: T, h: T) => void },
): void {
  for (const k of Object.keys(base).sort()) {
    if (!(k in head)) on.removed(k, base[k]!);
    else on.both(k, base[k]!, head[k]!);
  }
  for (const k of Object.keys(head).sort()) if (!(k in base)) on.added(k, head[k]!);
}

const recordOf = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** A value judged whole: annotations → patch, anything else → major. The unrecognised fallback. */
function wholeValue(push: Push, path: string, base: unknown, head: unknown, what = 'changed'): void {
  if (canon(base, false) === canon(head, false)) return;
  if (canon(base, true) === canon(head, true)) push('patch', path, 'documentation only');
  else push('major', path, `${what} (not a shape this classifier reads, so judged as breaking)`);
}

function setDiff(base: unknown, head: unknown): { removed: string[]; added: string[] } {
  const b = new Set(Array.isArray(base) ? base.map(String) : []);
  const h = new Set(Array.isArray(head) ? head.map(String) : []);
  return { removed: [...b].filter((x) => !h.has(x)).sort(), added: [...h].filter((x) => !b.has(x)).sort() };
}

function parseJson(text: string | null, what: string): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} does not parse as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${what} is not a JSON object`);
  return parsed;
}

/**
 * The artifact appearing or disappearing, judged before its contents: a vertical gaining its
 * first `openapi.json` adds a surface (minor), one losing it removes one (major).
 */
function presence(artifact: Artifact, base: unknown, head: unknown, out: Change[]): boolean {
  if (base === null && head === null) return true;
  const file = { model: 'model.json', openapi: 'openapi.json', permissions: 'PERMISSIONS.md' }[artifact];
  if (base === null) {
    out.push({ level: 'minor', artifact, path: file, detail: 'added', ...(artifact === 'permissions' ? { flagged: true } : {}) });
    return true;
  }
  if (head === null) {
    out.push({ level: 'major', artifact, path: file, detail: 'removed', ...(artifact === 'permissions' ? { flagged: true } : {}) });
    return true;
  }
  return false;
}

// ─── model.json ───────────────────────────────────────────────────────────────────────────────

/** Top-level `model.json` keys this classifier reads. Any other key changing is judged major. */
const MODEL_KEYS = new Set(['entities', 'lifecycles', 'handlers', 'exports', 'version']);
/** Entity keys read on their meaning. */
const ENTITY_KEYS = new Set([
  'table', 'fields', 'erasable', 'erasure', 'parents', 'key', 'primaryKey', 'archive', 'trash', 'stamps', 'outsideText',
]);

export function classifyModel(baseText: string | null, headText: string | null): Classification {
  const out: Change[] = [];
  const base = parseJson(baseText, 'model.json (base)');
  const head = parseJson(headText, 'model.json');
  if (presence('model', base, head, out)) return classification(out);
  const push = pusher('model', out);
  const b = base!;
  const h = head!;

  const baseEntities = recordOf(b.entities);
  keyed(baseEntities, recordOf(h.entities), {
    removed: (name) => push('major', `entities.${name}`, 'entity removed'),
    added: (name) => push('minor', `entities.${name}`, 'entity added'),
    both: (name, be, he) => classifyEntity(push, `entities.${name}`, recordOf(be), recordOf(he)),
  });

  keyed(recordOf(b.lifecycles), recordOf(h.lifecycles), {
    removed: (name) => push('major', `lifecycles.${name}`, 'lifecycle removed — its states are no longer enforced'),
    // A state machine on an entity that existed without one refuses operations it used to accept.
    added: (name) =>
      name in baseEntities
        ? push('major', `lifecycles.${name}`, 'an existing entity gained a lifecycle, which refuses transitions it used to allow')
        : push('minor', `lifecycles.${name}`, 'lifecycle added with its entity'),
    both: (name, bl, hl) => classifyLifecycle(push, `lifecycles.${name}`, recordOf(bl), recordOf(hl)),
  });

  keyed(recordOf(b.handlers), recordOf(h.handlers), {
    removed: (op) => push('major', `handlers.${op}`, 'derived handler removed'),
    added: (op) => push('minor', `handlers.${op}`, 'derived handler added'),
    both: (op, bh, hh) => {
      if (canon(bh, false) === canon(hh, false)) return;
      // `authored` holds the reason a handler is written by hand. Two reasons are prose.
      const authored = (v: unknown) => isRecord(v) && Object.keys(v).length === 1 && typeof v.authored === 'string';
      if (authored(bh) && authored(hh)) push('patch', `handlers.${op}`, 'documentation only');
      // The same operation answered by a different implementation: todo's `list-shares` went
      // from answering a missing list with a 404 to answering it with an empty page this way.
      else push('major', `handlers.${op}`, `implementation changed from ${canon(bh, false)} to ${canon(hh, false)}`);
    },
  });

  keyed(recordOf(b.exports), recordOf(h.exports), {
    removed: (type) => push('major', `exports.${type}`, 'exported event removed'),
    added: (type) => push('minor', `exports.${type}`, 'exported event added'),
    both: (type, bx, hx) => {
      const be = recordOf(bx);
      const he = recordOf(hx);
      if (be.schemaVersion !== he.schemaVersion) {
        // K-39: a bump is a replace, and a consumer on the old version stops receiving it.
        push('major', `exports.${type}`, `schemaVersion changed from ${String(be.schemaVersion)} to ${String(he.schemaVersion)}`);
        return;
      }
      compareSchema(push, 'output', `exports.${type}.payload`, resolveRefs(be.payload), resolveRefs(he.payload));
      const { schemaVersion: _a, payload: _b, ...bRest } = be;
      const { schemaVersion: _c, payload: _d, ...hRest } = he;
      wholeValue(push, `exports.${type}`, bRest, hRest);
    },
  });

  // `version` is an engine's manifest version: the RESULT of a bump, never a reason for one.
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (!MODEL_KEYS.has(k)) wholeValue(push, k, b[k], h[k]);
  }
  return classification(out);
}

function classifyEntity(push: Push, path: string, b: Record<string, unknown>, h: Record<string, unknown>): void {
  if (b.table !== h.table) push('major', `${path}.table`, `table renamed from ${String(b.table)} to ${String(h.table)}`);
  compareSchema(push, 'output', `${path}.fields`, resolveRefs(b.fields), resolveRefs(h.fields));

  const erasable = setDiff(b.erasable, h.erasable);
  if (erasable.added.length) push('minor', `${path}.erasable`, `now erasable: ${erasable.added.join(', ')}`);
  if (erasable.removed.length) {
    push('minor', `${path}.erasable`, `no longer erasable — a subject erasure stops reaching: ${erasable.removed.join(', ')}`, true);
  }
  if (canon(b.erasure, false) !== canon(h.erasure, false)) push('minor', `${path}.erasure`, 'subject erasure declaration changed');

  const parents = setDiff(b.parents, h.parents);
  if (parents.removed.length) push('major', `${path}.parents`, `parent edge removed: ${parents.removed.join(', ')}`);
  if (parents.added.length) push('minor', `${path}.parents`, `parent edge added: ${parents.added.join(', ')}`);

  for (const k of ['key', 'primaryKey'] as const) {
    if (canon(b[k], false) !== canon(h[k], false)) push('major', `${path}.${k}`, `${k} changed`);
  }
  for (const k of ['archive', 'trash'] as const) {
    if (b[k] === undefined && h[k] !== undefined) push('minor', `${path}.${k}`, `${k} declared`);
    else if (b[k] !== undefined && h[k] === undefined) push('major', `${path}.${k}`, `${k} no longer declared`);
    // Its permission, its purge horizon or its purge floor: each decides who loses what, when.
    else if (canon(b[k], false) !== canon(h[k], false)) {
      push('major', `${path}.${k}`, `${k} terms changed from ${canon(b[k], false)} to ${canon(h[k], false)}`);
    }
  }

  // Columns the kernel fills: a new one is a fact added, a dropped or re-pointed one is taken away.
  keyed(recordOf(b.stamps), recordOf(h.stamps), {
    removed: (col) => push('major', `${path}.stamps.${col}`, 'no longer stamped'),
    added: (col) => push('minor', `${path}.stamps.${col}`, 'stamped by the kernel'),
    both: (col, bs, hs) => {
      if (bs !== hs) push('major', `${path}.stamps.${col}`, `stamp changed from ${String(bs)} to ${String(hs)}`);
    },
  });
  // Who wrote a field's text: a declaration about provenance, which keeps the field off events.
  const outside = setDiff(b.outsideText, h.outsideText);
  if (outside.added.length || outside.removed.length) {
    push('minor', `${path}.outsideText`, `outside-written text: +[${outside.added.join(', ')}] -[${outside.removed.join(', ')}]`);
  }
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (!ENTITY_KEYS.has(k)) wholeValue(push, `${path}.${k}`, b[k], h[k]);
  }
}

const LIFECYCLE_KEYS = new Set(['field', 'initial', 'states']);
const STATE_KEYS = new Set(['on', 'allow', 'terminal']);

function classifyLifecycle(push: Push, path: string, b: Record<string, unknown>, h: Record<string, unknown>): void {
  if (b.field !== h.field) push('major', `${path}.field`, `state field changed from ${String(b.field)} to ${String(h.field)}`);
  if (b.initial !== h.initial) push('major', `${path}.initial`, `initial state changed from ${String(b.initial)} to ${String(h.initial)}`);
  keyed(recordOf(b.states), recordOf(h.states), {
    removed: (s) => push('major', `${path}.states.${s}`, 'state removed'),
    added: (s) => push('minor', `${path}.states.${s}`, 'state added'),
    both: (s, bs, hs) => {
      const at = `${path}.states.${s}`;
      const bS = recordOf(bs);
      const hS = recordOf(hs);
      keyed(recordOf(bS.on), recordOf(hS.on), {
        removed: (op) => push('major', `${at}.on.${op}`, 'transition removed'),
        added: (op) => push('minor', `${at}.on.${op}`, 'transition added'),
        both: (op, bt, ht) => {
          if (bt !== ht) push('major', `${at}.on.${op}`, `now leads to ${String(ht)} instead of ${String(bt)}`);
        },
      });
      const allow = setDiff(bS.allow, hS.allow);
      if (allow.removed.length) push('major', `${at}.allow`, `no longer allowed here: ${allow.removed.join(', ')}`);
      if (allow.added.length) push('minor', `${at}.allow`, `now allowed here: ${allow.added.join(', ')}`);
      if (!!bS.terminal !== !!hS.terminal) {
        push(hS.terminal ? 'major' : 'minor', `${at}.terminal`, hS.terminal ? 'became terminal' : 'is no longer terminal');
      }
      for (const k of [...new Set([...Object.keys(bS), ...Object.keys(hS)])].sort()) {
        if (!STATE_KEYS.has(k)) wholeValue(push, `${at}.${k}`, bS[k], hS[k]);
      }
    },
  });
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (!LIFECYCLE_KEYS.has(k)) wholeValue(push, `${path}.${k}`, b[k], h[k]);
  }
}

// ─── openapi.json ─────────────────────────────────────────────────────────────────────────────

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
/** Operation keys that only describe it. `operationId` is NOT one: a generated client is named by it. */
const OP_DOCS = new Set(['summary', 'description', 'tags', 'externalDocs', 'deprecated']);
const OP_KEYS = new Set([...OP_DOCS, 'parameters', 'requestBody', 'responses', 'operationId']);

export function classifyOpenApi(baseText: string | null, headText: string | null): Classification {
  const out: Change[] = [];
  const base = parseJson(baseText, 'openapi.json (base)');
  const head = parseJson(headText, 'openapi.json');
  if (presence('openapi', base, head, out)) return classification(out);
  const push = pusher('openapi', out);
  const b = base!;
  const h = head!;

  /** Each operation, refs resolved, plus whatever else a path item carries (path-level parameters). */
  const surface = (doc: Record<string, unknown>) => {
    const ops: Record<string, Record<string, unknown>> = {};
    const extras: Record<string, Record<string, unknown>> = {};
    for (const [p, item] of Object.entries(recordOf(doc.paths))) {
      for (const [m, op] of Object.entries(recordOf(resolveRefs(item, doc)))) {
        if (METHODS.includes(m)) ops[`${m.toUpperCase()} ${p}`] = recordOf(resolveRefs(op, doc));
        else (extras[p] ??= {})[m] = op;
      }
    }
    return { ops, extras };
  };
  const bs = surface(b);
  const hs = surface(h);

  keyed(bs.ops, hs.ops, {
    removed: (op) => push('major', op, 'operation removed'),
    added: (op) => push('minor', op, 'operation added'),
    both: (op, bo, ho) => classifyOperation(push, op, bo, ho),
  });
  for (const p of [...new Set([...Object.keys(bs.extras), ...Object.keys(hs.extras)])].sort()) {
    wholeValue(push, p, bs.extras[p], hs.extras[p]);
  }

  // `info` describes the document. `paths` was judged above, and `components` is judged where
  // it is referenced (an unreferenced component reaches no caller), except its security schemes,
  // which change how every call authenticates.
  if (canon(b.info, false) !== canon(h.info, false)) push('patch', 'info', 'documentation only');
  wholeValue(push, 'components.securitySchemes', recordOf(b.components).securitySchemes, recordOf(h.components).securitySchemes);
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (k === 'paths' || k === 'components' || k === 'info') continue;
    wholeValue(push, k, b[k], h[k]);
  }
  return classification(out);
}

function classifyOperation(push: Push, op: string, b: Record<string, unknown>, h: Record<string, unknown>): void {
  if (b.operationId !== h.operationId) {
    push('major', `${op} operationId`, `renamed from ${String(b.operationId)} to ${String(h.operationId)}`);
  }
  for (const k of OP_DOCS) {
    if (canon(b[k], false) !== canon(h[k], false)) push('patch', `${op} ${k}`, 'documentation only');
  }

  // Parameters, keyed by where they travel and their name.
  const params = (o: Record<string, unknown>): Record<string, Record<string, unknown>> => {
    const found: Record<string, Record<string, unknown>> = {};
    for (const p of Array.isArray(o.parameters) ? o.parameters : []) {
      const r = recordOf(p);
      found[`${String(r.in)} ${String(r.name)}`] = r;
    }
    return found;
  };
  keyed(params(b), params(h), {
    removed: (p) => push('major', `${op} parameter ${p}`, 'removed'),
    added: (p, hp) =>
      hp.required === true
        ? push('major', `${op} parameter ${p}`, 'added as required — a caller that omits it is refused')
        : push('minor', `${op} parameter ${p}`, 'added'),
    both: (p, bp, hp) => {
      const at = `${op} parameter ${p}`;
      if (!!bp.required !== !!hp.required) push(hp.required ? 'major' : 'minor', at, hp.required ? 'is now required' : 'is now optional');
      compareSchema(push, 'input', at, bp.schema, hp.schema);
      const { schema: _a, required: _b, ...bRest } = bp;
      const { schema: _c, required: _d, ...hRest } = hp;
      wholeValue(push, at, bRest, hRest);
    },
  });

  // The request body: what the caller sends.
  const bb = b.requestBody === undefined ? undefined : recordOf(b.requestBody);
  const hb = h.requestBody === undefined ? undefined : recordOf(h.requestBody);
  const body = `${op} requestBody`;
  if (bb && !hb) push('major', body, 'removed');
  else if (!bb && hb) push(hb.required ? 'major' : 'minor', body, hb.required ? 'added as required' : 'added');
  else if (bb && hb) {
    if (!!bb.required !== !!hb.required) push(hb.required ? 'major' : 'minor', body, hb.required ? 'is now required' : 'is now optional');
    classifyContent(push, 'input', body, bb.content, hb.content);
    const { content: _a, required: _b, ...bRest } = bb;
    const { content: _c, required: _d, ...hRest } = hb;
    wholeValue(push, body, bRest, hRest);
  }

  // Responses: what the caller reads.
  keyed(recordOf(b.responses), recordOf(h.responses), {
    removed: (status) => push('major', `${op} ${status}`, 'response removed'),
    added: (status) => push('minor', `${op} ${status}`, 'response added'),
    both: (status, br, hr) => {
      const at = `${op} ${status}`;
      const bR = recordOf(br);
      const hR = recordOf(hr);
      classifyContent(push, 'output', at, bR.content, hR.content);
      const { content: _a, ...bRest } = bR;
      const { content: _b, ...hRest } = hR;
      wholeValue(push, at, bRest, hRest);
    },
  });

  for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (!OP_KEYS.has(k)) wholeValue(push, `${op} ${k}`, b[k], h[k]);
  }
}

function classifyContent(push: Push, dir: Direction, at: string, base: unknown, head: unknown): void {
  keyed(recordOf(base), recordOf(head), {
    removed: (type) => push('major', `${at} ${type}`, 'media type removed'),
    added: (type) => push('minor', `${at} ${type}`, 'media type added'),
    both: (type, bm, hm) => {
      const bM = recordOf(bm);
      const hM = recordOf(hm);
      compareSchema(push, dir, `${at} ${type}`, bM.schema, hM.schema);
      const { schema: _a, ...bRest } = bM;
      const { schema: _b, ...hRest } = hM;
      wholeValue(push, `${at} ${type}`, bRest, hRest);
    },
  });
}

// ─── PERMISSIONS.md ───────────────────────────────────────────────────────────────────────────

/**
 * The parts of `PERMISSIONS.md` that carry a fact: one map per section, from a row's first
 * cell (a key, a role, an entity type, a scheduled operation) to the row.
 */
export interface PermissionSnapshot {
  /** Permission key → its description and declaring module. */
  readonly registry: Record<string, string[]>;
  /** Role → the keys it holds. */
  readonly roles: Record<string, string[]>;
  /** Entity type → keys granted per entity, then its remaining cells as written. */
  readonly grantShapes: Record<string, { keys: string[]; terms: string[] }>;
  /** Scheduled operation → the keys its system principal holds, then the remaining cells. */
  readonly schedules: Record<string, { keys: string[]; terms: string[] }>;
  /** Sections this parser does not read, by heading, with their text: judged whole. */
  readonly unread: Record<string, string>;
}

/**
 * Sections whose content is derived from, or says nothing beyond, the ones read above: §3
 * Coverage is §2 inverted, and the "not covered" notes are prose about the artifact itself.
 */
const DERIVED_SECTIONS = [/^Coverage\b/, /^Not covered by this artifact/, /^No permission surface/];

const codesIn = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();

function rowsOf(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator
    rows.push(cells);
  }
  return rows.slice(1); // the header row
}

/**
 * Parse a `PERMISSIONS.md` that `tools/permission-diff.mts` emitted. Sections are found by
 * their heading's words, not their number: the numbering shifts with which sections a vertical
 * has (§4 is grant shapes in one file and "not covered" in another).
 */
export function parsePermissions(text: string): PermissionSnapshot {
  const snap = {
    registry: {} as Record<string, string[]>,
    roles: {} as Record<string, string[]>,
    grantShapes: {} as Record<string, { keys: string[]; terms: string[] }>,
    schedules: {} as Record<string, { keys: string[]; terms: string[] }>,
    unread: {} as Record<string, string>,
  };
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf('\n');
    const heading = (nl === -1 ? section : section.slice(0, nl)).replace(/^\d+\.\s*/, '').trim();
    // The FIRST code span names the row: a schedule's cell reads "`op` — purges a trashed `list`".
    const firstKey = (cells: string[]) => /`([^`]+)`/.exec(cells[0] ?? '')?.[1] ?? cells[0] ?? '';
    if (/^Registry\b/.test(heading)) {
      for (const cells of rowsOf(section)) snap.registry[firstKey(cells)] = cells.slice(1);
    } else if (/^Roles\b/.test(heading)) {
      for (const cells of rowsOf(section)) snap.roles[firstKey(cells)] = codesIn(cells[1] ?? '');
    } else if (/^Entity-narrowed grant shapes\b/.test(heading)) {
      for (const cells of rowsOf(section)) snap.grantShapes[firstKey(cells)] = { keys: codesIn(cells[1] ?? ''), terms: cells.slice(2) };
    } else if (/^Scheduled work\b/.test(heading)) {
      // | Operation | Cadence | System principal | Permissions |
      for (const cells of rowsOf(section)) {
        snap.schedules[firstKey(cells)] = { keys: codesIn(cells[cells.length - 1] ?? ''), terms: cells.slice(0, -1) };
      }
    } else if (!DERIVED_SECTIONS.some((re) => re.test(heading))) {
      snap.unread[heading] = section.slice(nl === -1 ? section.length : nl).trim();
    }
  }
  return snap;
}

export function classifyPermissions(baseText: string | null, headText: string | null): Classification {
  const out: Change[] = [];
  if (presence('permissions', baseText, headText, out)) return classification(out);
  const b = parsePermissions(baseText!);
  const h = parsePermissions(headText!);
  const push = pusher('permissions', out);
  // Every permission change is at least minor and flagged: the human checkpoint reads both ways.
  const flag = (path: string, detail: string) => push('minor', path, detail, true);

  keyed(b.registry, h.registry, {
    removed: (k) => flag(`key ${k}`, 'removed from the registry — whoever held it loses what it gated'),
    added: (k) => flag(`key ${k}`, 'added to the registry'),
    both: (k, bd, hd) => {
      if (canon(bd, false) !== canon(hd, false)) push('patch', `key ${k}`, 'description or declaring module changed');
    },
  });

  const holders = (what: string, base: Record<string, string[]>, head: Record<string, string[]>) =>
    keyed(base, head, {
      removed: (name, keys) => flag(`${what} ${name}`, `removed (held: ${keys.join(', ') || 'nothing'}) — narrowing`),
      added: (name, keys) => flag(`${what} ${name}`, `added (holds: ${keys.join(', ') || 'nothing'}) — widening`),
      both: (name, bk, hk) => {
        const d = setDiff(bk, hk);
        if (d.removed.length) flag(`${what} ${name}`, `no longer holds ${d.removed.join(', ')} — narrowing`);
        if (d.added.length) flag(`${what} ${name}`, `now holds ${d.added.join(', ')} — widening`);
      },
    });
  holders('role', b.roles, h.roles);
  const keysOf = (m: Record<string, { keys: string[] }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.keys]));
  holders('entity grant shape', keysOf(b.grantShapes), keysOf(h.grantShapes));
  holders('scheduled operation', keysOf(b.schedules), keysOf(h.schedules));
  for (const [what, bm, hm] of [
    ['entity grant shape', b.grantShapes, h.grantShapes],
    ['scheduled operation', b.schedules, h.schedules],
  ] as const) {
    for (const name of Object.keys(bm)) {
      if (name in hm && canon(bm[name]!.terms, false) !== canon(hm[name]!.terms, false)) {
        flag(`${what} ${name}`, 'its terms changed (how it is given, bound or scheduled)');
      }
    }
  }

  for (const heading of [...new Set([...Object.keys(b.unread), ...Object.keys(h.unread)])].sort()) {
    if (b.unread[heading] !== h.unread[heading]) {
      push('major', `section "${heading}"`, 'changed (not a section this classifier reads, so judged as breaking)', true);
    }
  }
  if (out.length === 0 && baseText !== headText) push('patch', 'PERMISSIONS.md', 'prose only');
  return classification(out);
}

// ─── the three together ───────────────────────────────────────────────────────────────────────

/** One vertical's three artifacts as text, `null` where the file does not exist. */
export interface Artifacts {
  readonly model: string | null;
  readonly openapi: string | null;
  readonly permissions: string | null;
}

export function classify(base: Artifacts, head: Artifacts): Classification {
  const changes = [
    ...classifyModel(base.model, head.model).changes,
    ...classifyOpenApi(base.openapi, head.openapi).changes,
    ...classifyPermissions(base.permissions, head.permissions).changes,
  ];
  return classification(changes);
}
