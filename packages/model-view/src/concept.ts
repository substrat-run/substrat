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
  /** The roles a person can be given. */
  readonly roles: readonly RoleRowView[];
  /**
   * The roles declared `holder: 'system'` (K-55): a platform host's standing principal, never a
   * person. Empty when the file has none, including one emitted before they existed.
   */
  readonly systemRoles: readonly RoleRowView[];
  readonly entityGrants: readonly { readonly entityType: string; readonly keys: readonly string[] }[];
  readonly descriptions: ReadonlyMap<string, string>;
  /** Keys the registry marks reserved to a system principal. Empty when it has no such column. */
  readonly reserved: ReadonlySet<string>;
  /**
   * Set when the Registry table is not the emitter's — the same shapes the bump classifier ranks
   * major ({@link readRegistryTable}). `descriptions` and `reserved` are then empty, never a guess.
   */
  readonly registryUnreadable?: string;
  /**
   * Operation → the keys it declares it checks and what the check narrows to (#2384). An
   * operation with no declared key has `keys: []` and `declared: false`. `undefined` when the
   * file has no Operations section — one emitted before it existed — never "no operations".
   */
  readonly operations?: ReadonlyMap<string, OperationCheckView>;
  /**
   * Set when the Operations heading is there but its table is not the emitter's — the same shapes
   * the bump classifier ranks major ({@link operationsTableProblem}). `operations` is then absent.
   */
  readonly operationsUnreadable?: string;
  /**
   * Modules registered as a bare manifest, whose operations are therefore not known: their
   * operations are missing from `operations` because nothing could list them, not because there
   * are none. Present (possibly empty) whenever `operations` is.
   */
  readonly operationsUnknownFor?: readonly string[];
}

/** One row of `PERMISSIONS.md`'s Operations section. */
export interface OperationCheckView {
  readonly keys: readonly string[];
  readonly checkedOn: string;
  readonly declared: boolean;
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

/** The rows of the one table in `text`, header and rule dropped. */
const tableRows = (text: string): string[][] =>
  text
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map(cells)
    .slice(2);

/**
 * The table rows under the `## <n>. <title>` heading whose title starts with `title`, header and
 * rule dropped; `undefined` when no such section exists. Found by TITLE, never by number:
 * `permission-diff` numbers everything after §3 by which sections a vertical has, so §4 is the
 * grant shapes in one file and the schedules in the next. Read up to the next heading of ANY
 * level, so a sub-section's table (§2's `### 2a.`) is never read as more rows of this one.
 */
function tableUnder(md: string, title: string): string[][] | undefined {
  const section = sectionUnder(md, title);
  return section === undefined ? undefined : tableRows(section.split(/^#+ /m)[0]!);
}

const OPERATIONS_HEADER = ['Operation', 'Key', 'Checked on', 'Declared by'];
const NO_OPERATIONS = '_No module here registers an operation._';

const UNKNOWN_LINE = /^Operations not readable for (.+): registered as a bare manifest, so its operations are not known here\.$/m;

/**
 * The modules whose operations the section says are NOT known (#2384): each registered as a bare
 * manifest, with no operation map to read. Sorted; empty when the line is absent. Shared by both
 * readers, like {@link operationsTableProblem}.
 */
export function operationsUnknownFor(section: string): string[] {
  const m = UNKNOWN_LINE.exec(section);
  return m ? [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).sort() : [];
}

/**
 * Why an Operations section's table is not the one `lint:permissions` writes, or `undefined` when
 * it is (#2384). `section` is the text under the heading. The ONE judgement both readers make —
 * this package's `parsePermissions` and the CLI's bump classifier — so `substrat plan` never renders
 * a table the classifier ranks major as unreadable.
 */
export function operationsTableProblem(section: string): string | undefined {
  const lines = section.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length === 0) {
    if (section.includes(NO_OPERATIONS) || operationsUnknownFor(section).length > 0) return undefined;
    return 'no table, and no line saying there are no operations or whose are not known';
  }
  const split = (l: string) => l.replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const header = split(lines[0]!);
  if (header.join('|') !== OPERATIONS_HEADER.join('|')) return `its header is not | ${OPERATIONS_HEADER.join(' | ')} |`;
  if (lines.length < 2 || !split(lines[1]!).every((c) => /^:?-+:?$/.test(c))) return 'its header has no separator row';
  const bad = lines.slice(2).find((l) => split(l).length !== OPERATIONS_HEADER.length);
  if (bad !== undefined) return `a row has ${split(bad).length} cells, not ${OPERATIONS_HEADER.length}`;
  if (lines.length === 2) return 'its table has no rows';
  return undefined;
}


/**
 * §1's two layouts. `lint:permissions` adds the last column only once some key is reserved to a
 * system principal (`holder: 'system'` on its declaration), so a table without it, from a vertical
 * with nothing reserved or from an emitter older than the column, reads as nothing reserved.
 */
export const REGISTRY_HEADER = ['Key', 'Description', 'Declared by'] as const;
export const RESERVED_COLUMN = 'Reserved to a system principal';

/** One row of `PERMISSIONS.md`'s Registry. */
export interface RegistryRowView {
  readonly key: string;
  /** The description and the declaring modules, as written. */
  readonly terms: readonly string[];
  readonly reserved: boolean;
}

/**
 * The Registry table (the text under its heading) read against its header: each row, or why it is
 * not the table `lint:permissions` writes. The ONE judgement both readers make — this package's
 * `parsePermissions` and the CLI's bump classifier — as {@link operationsTableProblem} is for
 * Operations, so `substrat plan` never renders a registry the classifier ranks unreadable.
 */
export function readRegistryTable(section: string): { rows: RegistryRowView[] } | { unreadable: string } {
  const lines = section.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const [header = [], ...rest] = lines.map(cells);
  const withColumn = header.join('|') === [...REGISTRY_HEADER, RESERVED_COLUMN].join('|');
  if (!withColumn && header.join('|') !== REGISTRY_HEADER.join('|')) {
    return { unreadable: `its header is not | ${REGISTRY_HEADER.join(' | ')} |, with or without | ${RESERVED_COLUMN} |` };
  }
  const rows: RegistryRowView[] = [];
  for (const row of rest.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)))) {
    const key = unquote(row[0] ?? '');
    // The reservation is the LAST cell, so a description's own pipe cannot move it.
    const mark = withColumn ? row.at(-1) : '—';
    if (mark !== 'yes' && mark !== '—') return { unreadable: `the reservation of ${key} is neither yes nor —` };
    rows.push({ key, terms: row.slice(1, withColumn ? -1 : undefined), reserved: mark === 'yes' });
  }
  return { rows };
}

/** The text under the `## <n>. <title>` heading, up to the next `## `; `undefined` when absent. */
function sectionUnder(md: string, title: string): string | undefined {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^## \\d+\\.\\s+${title}\\b`).test(l));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

const unquote = (s: string): string => s.replace(/`/g, '');
const keysOf = (cell: string): string[] =>
  cell
    .split(',')
    .map((k) => unquote(k).trim())
    .filter((k) => k !== '' && !k.startsWith('—'));

/** One row of `PERMISSIONS.md`'s §2: a role and the keys it holds. */
export interface RoleRowView {
  readonly role: string;
  readonly keys: readonly string[];
}

const roleRows = (text: string): RoleRowView[] =>
  tableRows(text)
    .map(([role, keys]) => ({ role: unquote(role ?? ''), keys: keysOf(keys ?? '') }))
    .filter((r) => r.role !== '');

/**
 * The Roles section (the text under its heading) as `lint:permissions` writes it: the table of the
 * roles a person can be given, then, once some role is declared `holder: 'system'` (K-55), a
 * `### 2a. System-held roles` sub-section with a table of the same shape. Each table is read under
 * its own heading, so a system-held role is never a person's role and the second table's header is
 * never a role named `Role`. A sub-section this does not know is returned whole in `unknown`, by
 * its title: the bump classifier judges it, a view leaves it out. The ONE judgement both readers
 * make, as {@link readRegistryTable} is for the Registry.
 */
export function readRolesSection(section: string): {
  roles: RoleRowView[];
  systemRoles: RoleRowView[];
  unknown: Record<string, string>;
} {
  const [own = '', ...subs] = section.split(/^(?=### )/m);
  const systemRoles: RoleRowView[] = [];
  const unknown: Record<string, string> = {};
  for (const sub of subs) {
    const nl = sub.indexOf('\n');
    const title = (nl < 0 ? sub : sub.slice(0, nl)).replace(/^###\s+(\d+[a-z]?\.\s+)?/, '').trim();
    if (/^System-held roles\b/.test(title)) systemRoles.push(...roleRows(sub));
    else unknown[title] = nl < 0 ? '' : sub.slice(nl).trim();
  }
  return { roles: roleRows(own), systemRoles, unknown };
}

/**
 * Read the registry (§1), roles (§2, system-held ones apart) and entity-narrowed grant shapes (§4)
 * out of a `PERMISSIONS.md`. That file is `lint:permissions`' artifact of record, CI-gated against
 * the running code, so reading it keeps this package free of the verticals it describes.
 */
export function parsePermissions(md: string): PermissionsView {
  const registrySection = sectionUnder(md, 'Registry');
  const rolesSection = sectionUnder(md, 'Roles');
  if ((registrySection === undefined || rolesSection === undefined) && !/^## No permission surface/m.test(md)) {
    throw new PermissionsFormatError(
      `PERMISSIONS.md has no "${registrySection === undefined ? 'Registry' : 'Roles'}" section — regenerate it with \`pnpm lint:permissions\``,
    );
  }
  const registry = registrySection === undefined ? { rows: [] } : readRegistryTable(registrySection);
  const descriptions = new Map<string, string>();
  const reserved = new Set<string>();
  for (const r of 'rows' in registry ? registry.rows : []) {
    const description = r.terms[0];
    if (r.key && description) descriptions.set(r.key, description);
    if (r.reserved) reserved.add(r.key);
  }
  const registryView = { descriptions, reserved, ...('unreadable' in registry ? { registryUnreadable: registry.unreadable } : {}) };
  const { roles, systemRoles } = readRolesSection(rolesSection ?? '');
  const entityGrants = (tableUnder(md, 'Entity-narrowed grant shapes') ?? [])
    .map(([entityType, keys]) => ({ entityType: unquote(entityType ?? ''), keys: keysOf(keys ?? '') }))
    .filter((g) => g.entityType !== '');
  const opSection = sectionUnder(md, 'Operations');
  const operationsUnreadable = opSection === undefined ? undefined : operationsTableProblem(opSection);
  if (operationsUnreadable !== undefined) return { roles, systemRoles, entityGrants, ...registryView, operationsUnreadable };
  const opRows = tableUnder(md, 'Operations');
  const operations =
    opRows === undefined
      ? undefined
      : new Map(
          opRows
            // A row an older kernel's binder left "not readable" says nothing about the operation:
            // left out, as if unlisted, rather than read as "not declared".
            .filter(([op, keys = '']) => op !== undefined && op.startsWith('`') && !/not readable/.test(keys))
            .map(([op, keys = '', checkedOn = '']): [string, OperationCheckView] => {
              // A cell of prose ("— checked in code, not declared —") names no key; its commas are not a list.
              const prose = keys.trim().startsWith('—');
              return [unquote(op ?? ''), { keys: prose ? [] : keysOf(keys), checkedOn, declared: !/not declared/.test(keys) }];
            }),
        );
  return {
    roles,
    systemRoles,
    entityGrants,
    ...registryView,
    ...(operations === undefined ? {} : { operations, operationsUnknownFor: operationsUnknownFor(opSection ?? '') }),
  };
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
  if (view.registryUnreadable !== undefined) {
    throw new PermissionsFormatError(`PERMISSIONS.md's Registry cannot be read: ${view.registryUnreadable} — regenerate it with \`pnpm lint:permissions\``);
  }
  const out: string[] = [];
  if (view.roles.length === 0) {
    out.push('_No roles are defined._');
  } else {
    out.push('| Role | What they can do |', '| --- | --- |');
    for (const r of bySort(view.roles, (x) => x.role)) {
      out.push(`| \`${r.role}\` | ${renderKeys(r.keys, view.descriptions)} |`);
    }
  }
  if (view.systemRoles.length > 0) {
    out.push('', 'Held by a platform host, never given to a person:', '', '| Role | What it can do |', '| --- | --- |');
    for (const r of bySort(view.systemRoles, (x) => x.role)) {
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

const PLAIN_ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ATTRIBUTE_KEYWORD = /^(PK|FK|UK)$/i;

/**
 * An id Mermaid accepts for each field, distinct within the entity. A field that is already a
 * plain word keeps its name (claimed first, so no other field can take it); the rest are made
 * into words and suffixed `_2`, `_3`… on a clash, in sorted order so the result is stable. The
 * real name rides along as the attribute's quoted comment whenever the id differs from it.
 */
function attributeNames(fields: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...fields].sort();
  for (const f of sorted) {
    if (PLAIN_ATTRIBUTE.test(f) && !ATTRIBUTE_KEYWORD.test(f)) {
      out.set(f, f);
      taken.add(f);
    }
  }
  for (const f of sorted) {
    if (out.has(f)) continue;
    let base = f.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(base)) base = `f_${base}`;
    if (ATTRIBUTE_KEYWORD.test(base)) base = `${base}_`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    out.set(f, id);
    taken.add(id);
  }
  return out;
}

/**
 * The entity model as a Mermaid `erDiagram` block — the `entities` region of a concept document,
 * and each side of `substrat plan`'s before/after view, so both read with one alias scheme.
 */
export function entityDiagram(model: EmittedModel): string {
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
    const ids = attributeNames(Object.keys(props));
    const attrs = [...ids.keys()].sort().map((f) => {
      const id = ids.get(f);
      return `        ${attributeType(props[f])} ${id}${pk.has(f) ? ' PK' : ''}${id === f ? '' : ` ${label(f)}`}`;
    });
    nodes.push(`    ${alias.get(name)}[${label(name)}] {`, ...attrs, '    }');
  }
  // A parent no entity declares (the platform's `owner`, say) still gets its edge, as a bare box.
  for (const x of [...parents].sort()) nodes.push(`    ${alias.get(x)}[${label(x)}] {`, '    }');
  return ['```mermaid', 'erDiagram', ...edges, ...nodes, '```'].join('\n');
}

/** One declared lifecycle as a `### <entity>` heading over a Mermaid `stateDiagram-v2` block. */
export function lifecycleDiagram(entity: string, lc: EmittedLifecycle): string {
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
      return lc ? lifecycleDiagram(entity, lc) : '';
    })
    .join('\n\n');
}

const RENDER: Record<ConceptSection, (i: ConceptInputs) => string> = {
  roles: renderRoles,
  entities: ({ model }) => entityDiagram(model),
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
