import type { EmittedLifecycle, EmittedModel } from '@substrat-run/contracts';

/**
 * `spec/concept.md`, split by owner (#2362).
 *
 * A concept document is the readable description of a vertical for the people who own it,
 * and nothing used to keep it in step with the code: the entity model in prose drifted the
 * first time an agent added a field. So three of its sections are GENERATED, between
 * markers, from the artifacts of record, and everything around them is authored:
 *
 * ```
 * <!-- substrat:roles -->     roles and permissions   (PERMISSIONS.md, from `lint:permissions`)
 * <!-- substrat:entities -->  a Mermaid `erDiagram`   (model.json)
 * <!-- substrat:processes --> a Mermaid `stateDiagram-v2` per declared lifecycle (model.json)
 * ```
 *
 * Each region is closed by `<!-- /substrat:<name> -->`. The markers stay; the text between
 * them is rewritten whole by {@link syncConcept}, so a hand edit inside one is overwritten
 * and a stale one is caught by comparing {@link syncConcept}'s output with the file.
 *
 * Pure and deterministic: no clock, no path, no ordering that depends on declaration
 * order — entities, states and roles are sorted — so the same inputs give byte-identical
 * output on every run. Reading the files is the caller's half (the CLI, `lint:concept`).
 * Like the rest of this package it imports no `node:*`, so it runs in a browser bundle too.
 */

/** The generated regions, in the order a concept document carries them. */
export const CONCEPT_SECTIONS = ['roles', 'entities', 'processes'] as const;
export type ConceptSection = (typeof CONCEPT_SECTIONS)[number];

const open = (s: ConceptSection): string => `<!-- substrat:${s} -->`;
const close = (s: ConceptSection): string => `<!-- /substrat:${s} -->`;

/** What the generated regions are rendered from. */
export interface ConceptInputs {
  /** The vertical's emitted `model.json`. */
  readonly model: EmittedModel;
  /**
   * The vertical's checked-in `PERMISSIONS.md` text, when it has one. Absent for a project
   * that has not run `lint:permissions` yet, which renders a note instead of an empty table.
   */
  readonly permissionsMd?: string;
}

/** The parts of a `PERMISSIONS.md` a concept document shows. */
export interface PermissionsView {
  readonly roles: readonly { readonly role: string; readonly keys: readonly string[] }[];
  readonly entityGrants: readonly { readonly entityType: string; readonly keys: readonly string[] }[];
  readonly descriptions: ReadonlyMap<string, string>;
}

/** Split one markdown table row on its unescaped pipes. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * A `PERMISSIONS.md` that is not the artifact `lint:permissions` writes: a section this reader
 * depends on is gone. Refusing beats rendering "no roles" for a file whose layout moved.
 */
export class PermissionsFormatError extends Error {}

/**
 * The table rows under the `## <n>. <title>` heading whose title starts with `title`, header and
 * rule dropped; `undefined` when no such section exists. Found by TITLE, never by number:
 * `permission-diff` numbers everything after §3 by which sections a vertical has, so §4 is the
 * grant shapes in one file and the schedules in the next.
 */
function tableUnder(md: string, title: string): string[][] | undefined {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^## \\d+\\.\\s+${title}\\b`).test(l));
  if (at < 0) return undefined;
  const rows: string[][] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('## ')) break;
    if (line.trim().startsWith('|')) rows.push(cells(line));
  }
  return rows.slice(2);
}

const unquote = (s: string): string => s.replace(/`/g, '');
const keysOf = (cell: string): string[] =>
  cell
    .split(',')
    .map((k) => unquote(k).trim())
    .filter((k) => k !== '' && !k.startsWith('—'));

/**
 * Read the registry (§1), roles (§2) and entity-narrowed grant shapes (§4) out of a
 * `PERMISSIONS.md`. That file is `lint:permissions`' artifact of record, CI-gated against the
 * running code, so reading it keeps this package free of the verticals it describes.
 */
export function parsePermissions(md: string): PermissionsView {
  const registry = tableUnder(md, 'Registry');
  const roleRows = tableUnder(md, 'Roles');
  if ((registry === undefined || roleRows === undefined) && !/^## No permission surface/m.test(md)) {
    throw new PermissionsFormatError(
      `PERMISSIONS.md has no "${registry === undefined ? 'Registry' : 'Roles'}" section — regenerate it with \`pnpm lint:permissions\``,
    );
  }
  const descriptions = new Map<string, string>();
  for (const [key, description] of registry ?? []) {
    if (key && description) descriptions.set(unquote(key), description);
  }
  const roles = (roleRows ?? [])
    .map(([role, keys]) => ({ role: unquote(role ?? ''), keys: keysOf(keys ?? '') }))
    .filter((r) => r.role !== '');
  const entityGrants = (tableUnder(md, 'Entity-narrowed grant shapes') ?? [])
    .map(([entityType, keys]) => ({ entityType: unquote(entityType ?? ''), keys: keysOf(keys ?? '') }))
    .filter((g) => g.entityType !== '');
  return { roles, entityGrants, descriptions };
}

const bySort = <T>(xs: Iterable<T>, by: (x: T) => string): T[] =>
  [...xs].sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderKeys(keys: readonly string[], descriptions: ReadonlyMap<string, string>): string {
  if (keys.length === 0) return '—';
  return bySort(keys, (k) => k)
    .map((k): string => {
      const d = descriptions.get(k);
      return d ? `\`${k}\` — ${escapeCell(d)}` : `\`${k}\``;
    })
    .join('<br>');
}

function renderRoles({ permissionsMd }: ConceptInputs): string {
  if (permissionsMd === undefined) {
    return '_No `PERMISSIONS.md` beside `model.json`, so no roles are listed. A vertical in the Substrat repository gets one from `pnpm lint:permissions`; a scaffolded project has no such command yet, so describe its roles in prose until it has._';
  }
  const view = parsePermissions(permissionsMd);
  const out: string[] = [];
  if (view.roles.length === 0) {
    out.push('_No roles are defined._');
  } else {
    out.push('| Role | What they can do |', '| --- | --- |');
    for (const r of bySort(view.roles, (x) => x.role)) {
      out.push(`| \`${r.role}\` | ${renderKeys(r.keys, view.descriptions)} |`);
    }
  }
  if (view.entityGrants.length > 0) {
    out.push(
      '',
      'Shared one record at a time, without a role:',
      '',
      '| Record | What the person it is shared with can do |',
      '| --- | --- |',
    );
    for (const g of bySort(view.entityGrants, (x) => x.entityType)) {
      out.push(`| \`${g.entityType}\` | ${renderKeys(g.keys, view.descriptions)} |`);
    }
  }
  return out.join('\n');
}

/** A JSON Schema property's type, as an ER diagram attribute type (a single word). */
function attributeType(schema: unknown): string {
  const s = (schema ?? {}) as { type?: unknown; anyOf?: unknown };
  const types = new Set<string>();
  if (typeof s.type === 'string') types.add(s.type);
  if (Array.isArray(s.anyOf)) {
    for (const branch of s.anyOf) {
      const t = (branch as { type?: unknown } | null)?.type;
      if (typeof t === 'string' && t !== 'null') types.add(t);
    }
  }
  if (types.size !== 1) return 'json';
  const [t] = [...types];
  return t === 'integer' ? 'number' : t === 'array' || t === 'object' ? 'json' : (t ?? 'json');
}

/** Mermaid's escape for a double quote inside a quoted label. */
const label = (text: string): string => `"${text.replace(/"/g, '#quot;').replace(/\s+/g, ' ')}"`;

/** An ER attribute name Mermaid accepts: word characters only, and not one of its key words. */
const attributeName = (field: string): string => {
  const word = field.replace(/[^A-Za-z0-9_]/g, '_');
  return /^(PK|FK|UK)$/i.test(word) ? `${word}_` : word;
};

function renderEntities({ model }: ConceptInputs): string {
  const names = Object.keys(model.entities).sort();
  if (names.length === 0) return '_No entities are declared._';
  // Every box is an alias with the real name as its label, so a name with a hyphen, a space or a
  // quote — or one Mermaid reads as a key word — is still the diagram that was meant.
  const known = new Set(names);
  const parents = new Set<string>();
  for (const name of names) for (const p of model.entities[name]?.parents ?? []) if (!known.has(p)) parents.add(p);
  const alias = new Map([...names, ...[...parents].sort()].map((n, i) => [n, `e${i + 1}`] as const));
  const edges: string[] = [];
  const nodes: string[] = [];
  for (const name of names) {
    const e = model.entities[name];
    if (!e) continue;
    for (const parent of [...(e.parents ?? [])].sort()) edges.push(`    ${alias.get(parent)} ||--o{ ${alias.get(name)} : has`);
    const props = ((e.fields as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
    const pk = new Set(e.primaryKey ?? ['id']);
    const attrs = Object.keys(props)
      .sort()
      .map((f) => `        ${attributeType(props[f])} ${attributeName(f)}${pk.has(f) ? ' PK' : ''}`);
    nodes.push(`    ${alias.get(name)}[${label(name)}] {`, ...attrs, '    }');
  }
  // A parent no entity declares (the platform's `owner`, say) still gets its edge, as a bare box.
  for (const x of [...parents].sort()) nodes.push(`    ${alias.get(x)}[${label(x)}] {`, '    }');
  return ['```mermaid', 'erDiagram', ...edges, ...nodes, '```'].join('\n');
}

function renderLifecycle(entity: string, lc: EmittedLifecycle): string {
  const states = lc.states as Record<string, { on?: Record<string, string>; terminal?: boolean }>;
  // A state is any value of the field's enum, so its spelling is not Mermaid's to restrict:
  // `in-progress` is a parse error as an id. Each is declared once, as an alias with its name as the label.
  const names = [...new Set([lc.initial, ...Object.keys(states), ...Object.values(states).flatMap((d) => Object.values(d.on ?? {}))])].sort();
  const id = new Map(names.map((n, i) => [n, `s${i + 1}`] as const));
  const lines = ['stateDiagram-v2', ...names.map((n) => `    state ${label(n)} as ${id.get(n)}`), `    [*] --> ${id.get(lc.initial)}`];
  for (const state of Object.keys(states).sort()) {
    const def = states[state] ?? {};
    const targets = Object.entries(def.on ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [op, target] of targets) lines.push(`    ${id.get(state)} --> ${id.get(target)} : ${op.replace(/\s+/g, ' ')}`);
    if (def.terminal || targets.length === 0) lines.push(`    ${id.get(state)} --> [*]`);
  }
  return [`### ${entity}`, '', `Moves through its \`${lc.field}\`.`, '', '```mermaid', ...lines, '```'].join('\n');
}

function renderProcesses({ model }: ConceptInputs): string {
  const lifecycles = model.lifecycles ?? {};
  const entities = Object.keys(lifecycles).sort();
  if (entities.length === 0) return '_No lifecycle is declared: nothing here moves through stages._';
  return entities
    .map((entity) => {
      const lc = lifecycles[entity];
      return lc ? renderLifecycle(entity, lc) : '';
    })
    .join('\n\n');
}

const RENDER: Record<ConceptSection, (i: ConceptInputs) => string> = {
  roles: renderRoles,
  entities: renderEntities,
  processes: renderProcesses,
};

/** A concept document whose markers cannot be read: one region missing, doubled or mis-ordered. */
export class ConceptMarkerError extends Error {}

/** Where a region's body sits in the text: between the end of its open marker and the start of its close. */
function regionOf(md: string, section: ConceptSection): { from: number; to: number } {
  const o = open(section);
  const c = close(section);
  const from = md.indexOf(o);
  if (from < 0) throw new ConceptMarkerError(`no ${o} marker`);
  if (md.indexOf(o, from + 1) >= 0) throw new ConceptMarkerError(`${o} appears more than once`);
  const to = md.indexOf(c, from);
  if (to < 0) throw new ConceptMarkerError(`${o} is never closed — add ${c} after it`);
  return { from: from + o.length, to };
}

/**
 * Rewrite the generated regions of a concept document. Everything outside the markers is
 * returned untouched, byte for byte. Throws {@link ConceptMarkerError} when a region is
 * missing, doubled or unclosed — a sync that quietly skipped one would print green for a
 * section it never wrote.
 */
export function syncConcept(markdown: string, inputs: ConceptInputs): string {
  let out = markdown;
  for (const section of CONCEPT_SECTIONS) {
    let region: { from: number; to: number };
    try {
      region = regionOf(out, section);
    } catch (err) {
      if (err instanceof ConceptMarkerError) throw new ConceptMarkerError(`concept.md: ${err.message}`);
      throw err;
    }
    out = `${out.slice(0, region.from)}\n\n${RENDER[section](inputs)}\n\n${out.slice(region.to)}`;
  }
  return out;
}

/** The `## …Decisions log…` section's text — what an author appends to on every model change. */
export function decisionsLog(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => /^##\s+(\d+\.\s*)?decisions log\b/i.test(l));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}
