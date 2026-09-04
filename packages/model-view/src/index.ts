import type { EmittedEntity, EmittedLifecycle, EmittedModel } from '@substrat-run/contracts';

/**
 * The emitted entity model, rendered as something a human can look at.
 *
 * This is the PURE half of `substrat model view` (#756), extracted so the dashboard's
 * Model tab (#1214) renders the same page from the same artifact: it takes an already-read
 * `model.json` — the artifact of record (#697), never the TypeScript — and returns one
 * self-contained HTML string. No filesystem, no `node:*` imports, no DOM: it runs in the
 * CLI, in a worker, and in a browser bundle unchanged.
 *
 * The output references NOTHING external: inline CSS, inline SVG, no script, no CDN.
 * That is what makes it openable from a file path or an iframe `srcdoc` — with no server
 * and no network — and the property is asserted by the suite.
 */

/** What `renderModelHtml` needs to say where a view came from. */
export interface ModelViewSource {
  /** The `model.json` this was rendered from, as the caller wants it displayed —
   *  a file path in the CLI, a `slug@version` coordinate in the dashboard. */
  readonly source: string;
  /** The `<title>` subject. Defaults to the source path's parent directory name. */
  readonly title?: string;
}

/**
 * Validate a parsed `model.json`, refusing anything that is not one rather than rendering
 * an empty page. `sourceLabel` prefixes every refusal so it names the artifact, not the
 * renderer. Structural, mirroring the `emittedModel` schema in contracts — the renderer
 * keeps its own copy because its error messages are the user-facing product here, and a
 * malformed input that got past this would surface as a TypeError from inside the layout,
 * which reads as a bug in the renderer instead of as a malformed input.
 */
export function parseModel(parsed: unknown, sourceLabel: string): EmittedModel {
  const entities = (parsed as { entities?: unknown } | null)?.entities;
  if (!entities || typeof entities !== 'object' || Array.isArray(entities)) {
    throw new Error(`${sourceLabel} has no 'entities' object — is it a model.json?`);
  }
  for (const [name, entity] of Object.entries(entities as Record<string, unknown>)) {
    if (!entity || typeof entity !== 'object' || typeof (entity as { table?: unknown }).table !== 'string') {
      throw new Error(`${sourceLabel}: entity '${name}' declares no table — is it a model.json?`);
    }
    for (const listed of ['parents', 'primaryKey', 'key', 'erasable'] as const) {
      const value = (entity as Record<string, unknown>)[listed];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(
          `${sourceLabel}: entity '${name}' declares '${listed}' as something other than a list of field names`,
        );
      }
    }
  }
  const lifecycles = (parsed as { lifecycles?: unknown }).lifecycles;
  if (lifecycles !== undefined) {
    if (!lifecycles || typeof lifecycles !== 'object' || Array.isArray(lifecycles)) {
      throw new Error(`${sourceLabel}: 'lifecycles' is not an object keyed by entity`);
    }
    for (const [entity, lc] of Object.entries(lifecycles as Record<string, unknown>)) {
      const states = (lc as { states?: unknown } | null)?.states;
      if (!lc || typeof lc !== 'object' || !states || typeof states !== 'object' || Array.isArray(states)) {
        throw new Error(`${sourceLabel}: the lifecycle for '${entity}' declares no states map`);
      }
      for (const field of ['field', 'initial'] as const) {
        if (typeof (lc as Record<string, unknown>)[field] !== 'string') {
          throw new Error(`${sourceLabel}: the lifecycle for '${entity}' declares '${field}' as something other than a name`);
        }
      }
      for (const [state, def] of Object.entries(states as Record<string, unknown>)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) {
          throw new Error(`${sourceLabel}: state '${state}' of the '${entity}' lifecycle is not an object`);
        }
        const on = (def as { on?: unknown }).on;
        if (on !== undefined) {
          if (!on || typeof on !== 'object' || Array.isArray(on)) {
            throw new Error(
              `${sourceLabel}: state '${state}' of the '${entity}' lifecycle declares 'on' as something other than a map`,
            );
          }
          // The targets too, not only the container: a transition to `1` renders as a
          // TypeError out of `escapeHtml`, which is the same failure one level down.
          for (const [op, target] of Object.entries(on as Record<string, unknown>)) {
            if (typeof target !== 'string') {
              throw new Error(
                `${sourceLabel}: transition '${op}' from state '${state}' of the '${entity}' lifecycle names no target state`,
              );
            }
          }
        }
      }
    }
  }
  return parsed as EmittedModel;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The field names of an entity, in declaration order — the order the model reads in. */
function fieldNames(entity: EmittedEntity): readonly string[] {
  const props = (entity.fields as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props ? Object.keys(props) : [];
}

/** A field's JSON-Schema type, rendered short. `string`, `number | null`, `object`. */
function fieldType(entity: EmittedEntity, field: string): string {
  const props = (entity.fields as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const schema = props[field] as Record<string, unknown> | undefined;
  if (!schema) return '';
  const t = schema['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string').join(' | ');
  if (Array.isArray(schema['anyOf'])) {
    const parts = (schema['anyOf'] as Record<string, unknown>[]).map((s) =>
      typeof s['type'] === 'string' ? (s['type'] as string) : '…',
    );
    return [...new Set(parts)].join(' | ');
  }
  if (schema['enum']) return 'enum';
  return '';
}

const primaryKeyOf = (entity: EmittedEntity): readonly string[] => entity.primaryKey ?? ['id'];

/**
 * Depth of each entity: 0 for one with no parents, else one past its deepest parent.
 *
 * `parents` is an allowlist and a diamond is normal (a reservation hangs off both a
 * resource and a member), so this is a longest-path layering, not a tree. A cycle would
 * make that non-terminating — the kernel does not forbid one — so a node already on the
 * current path is treated as depth 0 and the layout stays a drawing rather than a hang.
 */
export function layerDepths(entities: Record<string, EmittedEntity>): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (name: string, path: ReadonlySet<string>): number => {
    const cached = depths.get(name);
    if (cached !== undefined) return cached;
    if (path.has(name)) return 0;
    const parents = (entities[name]?.parents ?? []).filter((p) => p in entities);
    const next = new Set([...path, name]);
    const depth = parents.length === 0 ? 0 : Math.max(...parents.map((p) => walk(p, next))) + 1;
    depths.set(name, depth);
    return depth;
  };
  for (const name of Object.keys(entities)) walk(name, new Set());
  return depths;
}

interface Box {
  readonly name: string;
  readonly table: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const BOX_H = 46;
const ROW_GAP = 104;
const COL_GAP = 28;
const PAD = 20;
/** Where a depth band wraps — near enough a laptop's window that the labels stay readable. */
const MAX_WIDTH = 1080;

/**
 * The ER diagram, as inline SVG with no `xmlns` — inside HTML it is parsed as SVG already,
 * and the attribute's value is a URL, which the "nothing external" assertion reads as a
 * reference whether a browser would fetch it or not.
 */
function renderDiagram(entities: Record<string, EmittedEntity>): string {
  const names = Object.keys(entities);
  if (names.length === 0) return '<p class="empty">This model declares no entities.</p>';

  const depths = layerDepths(entities);
  const rows: string[][] = [];
  for (const name of names) {
    const d = depths.get(name) ?? 0;
    (rows[d] ??= []).push(name);
  }

  // A depth band wider than MAX_WIDTH wraps onto further lines rather than growing the
  // canvas: the SVG is scaled to the page width, so one 20-entity row would render every
  // label too small to read. A wrapped line stays inside its band, and depth strictly
  // increases along a parent edge, so an arrow still always points at an earlier line.
  const boxes = new Map<string, Box>();
  let width = 0;
  let line = 0;
  rows.forEach((row) => {
    let x = PAD;
    row.forEach((name, i) => {
      const label = Math.max(name.length, (entities[name]?.table ?? '').length);
      const w = Math.max(132, label * 8 + 28);
      if (i > 0 && x + w + PAD > MAX_WIDTH) {
        line += 1;
        x = PAD;
      }
      boxes.set(name, { name, table: entities[name]?.table ?? '', x, y: PAD + line * ROW_GAP, w, h: BOX_H });
      x += w + COL_GAP;
      width = Math.max(width, x - COL_GAP + PAD);
    });
    line += 1;
  });
  const height = PAD * 2 + (line - 1) * ROW_GAP + BOX_H;

  const edges: string[] = [];
  for (const name of names) {
    const child = boxes.get(name);
    if (!child) continue;
    for (const parentName of entities[name]?.parents ?? []) {
      const parent = boxes.get(parentName);
      if (!parent) continue; // a parent outside this model — the entity list below still names it
      const x1 = child.x + child.w / 2;
      const y1 = child.y;
      const x2 = parent.x + parent.w / 2;
      const y2 = parent.y + parent.h;
      const mid = (y1 + y2) / 2;
      edges.push(
        `<path class="edge" d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" marker-end="url(#arrow)">` +
          `<title>${escapeHtml(name)} hangs off ${escapeHtml(parentName)}</title></path>`,
      );
    }
  }

  const nodes = [...boxes.values()].map(
    (b) =>
      `<g class="node"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" />` +
      `<text class="node-name" x="${b.x + b.w / 2}" y="${b.y + 20}">${escapeHtml(b.name)}</text>` +
      `<text class="node-table" x="${b.x + b.w / 2}" y="${b.y + 36}">${escapeHtml(b.table)}</text></g>`,
  );

  return (
    `<svg class="er" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" ` +
    `aria-label="Entity relationship diagram">` +
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>` +
    `${edges.join('')}${nodes.join('')}</svg>`
  );
}

/** One entity's fields, with the primary key, the natural key and the erasable fields marked. */
function renderEntity(name: string, entity: EmittedEntity): string {
  const pk = new Set(primaryKeyOf(entity));
  const key = new Set(entity.key ?? []);
  const erasable = new Set(entity.erasable ?? []);
  // `fields` is carried as opaque JSON Schema, so `required` is not shape-checked by
  // `parseModel` the way the entity-level lists are — guard it here: a malformed value
  // renders every field as optional rather than throwing from inside the renderer.
  const requiredRaw = (entity.fields as { required?: unknown } | undefined)?.required;
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((f): f is string => typeof f === 'string') : [],
  );

  const rows = fieldNames(entity).map((field) => {
    const marks = [
      pk.has(field) ? '<span class="mark pk" title="primary key">PK</span>' : '',
      key.has(field) ? '<span class="mark key" title="natural key">KEY</span>' : '',
      erasable.has(field) ? '<span class="mark erasable" title="reachable by an erasure">ERASABLE</span>' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      `<tr><td class="field">${escapeHtml(field)}${required.has(field) ? '' : '<span class="opt">?</span>'}</td>` +
      `<td class="type">${escapeHtml(fieldType(entity, field))}</td><td class="marks">${marks}</td></tr>`
    );
  });

  const parents = (entity.parents ?? []).map((p) => `<span class="pill">${escapeHtml(p)}</span>`).join(' ');
  const meta = [
    `<span class="meta-item">table <code>${escapeHtml(entity.table)}</code></span>`,
    `<span class="meta-item">primary key <code>${escapeHtml(primaryKeyOf(entity).join(', '))}</code></span>`,
    entity.key ? `<span class="meta-item">key <code>${escapeHtml(entity.key.join(', '))}</code></span>` : '',
    parents ? `<span class="meta-item">hangs off ${parents}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  return (
    `<section class="entity" id="entity-${escapeHtml(name)}"><h3>${escapeHtml(name)}</h3>` +
    `<div class="meta">${meta}</div>` +
    `<table class="fields"><tbody>${rows.join('')}</tbody></table></section>`
  );
}

/** The declared state machines, when the model carries any (#844). */
function renderLifecycles(lifecycles: Record<string, EmittedLifecycle>): string {
  const blocks = Object.entries(lifecycles).map(([entity, lc]) => {
    const states = Object.entries(lc.states).map(([state, def]) => {
      const edges = Object.entries((def as { on?: Record<string, string> }).on ?? {}).map(
        ([op, target]) => `<li><code>${escapeHtml(op)}</code> → ${escapeHtml(target)}</li>`,
      );
      const initial = state === lc.initial ? '<span class="mark pk" title="initial state">INITIAL</span>' : '';
      return (
        `<div class="state"><h4>${escapeHtml(state)} ${initial}</h4>` +
        `${edges.length ? `<ul>${edges.join('')}</ul>` : '<p class="empty">terminal</p>'}</div>`
      );
    });
    return (
      `<section class="entity"><h3>${escapeHtml(entity)}<span class="opt"> · ${escapeHtml(lc.field)}</span></h3>` +
      `<div class="states">${states.join('')}</div></section>`
    );
  });
  return `<h2>Lifecycles</h2><div class="entities">${blocks.join('')}</div>`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #16181d; --dim: #5b6272; --line: #d7dbe3; --bg: #fbfbfd;
        --card: #ffffff; --accent: #2f5bd7; --warn: #b2542b; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8eaf0; --dim: #9aa3b5; --line: #333844; --bg: #14161b; --card: #1b1e25;
          --accent: #7fa2ff; --warn: #e2986a; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px; background: var(--bg); color: var(--fg);
       font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { margin-bottom: 24px; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 32px 0 12px; font-size: 16px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
h3 { margin: 0 0 8px; font-size: 15px; }
h4 { margin: 0 0 4px; font-size: 13px; }
.sub { color: var(--dim); font-size: 13px; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.diagram { overflow-x: auto; padding: 8px 0; }
svg.er { max-width: 100%; height: auto; }
.er rect { fill: var(--card); stroke: var(--line); stroke-width: 1.5; }
.er text { text-anchor: middle; fill: var(--fg); font: 13px ui-sans-serif, system-ui, sans-serif; }
.er .node-table { fill: var(--dim); font: 11px ui-monospace, Menlo, monospace; }
.er .edge { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.er marker path { fill: var(--accent); }
.entities { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.entity { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.meta { color: var(--dim); font-size: 12px; margin-bottom: 10px; }
.meta-item { display: inline-block; margin-right: 12px; }
.pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
table.fields { width: 100%; border-collapse: collapse; }
table.fields td { border-top: 1px solid var(--line); padding: 4px 0; vertical-align: top; }
td.field { font: 12px ui-monospace, Menlo, monospace; }
td.type { color: var(--dim); font: 12px ui-monospace, Menlo, monospace; width: 30%; }
td.marks { text-align: right; white-space: nowrap; }
.opt { color: var(--dim); }
.mark { font-size: 10px; letter-spacing: .06em; border-radius: 4px; padding: 1px 5px; margin-left: 4px;
        border: 1px solid var(--line); color: var(--dim); }
.mark.pk { color: var(--accent); border-color: var(--accent); }
.mark.erasable { color: var(--warn); border-color: var(--warn); }
.states { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.state ul { margin: 0; padding-left: 16px; }
.empty { color: var(--dim); }
footer { margin-top: 32px; color: var(--dim); font-size: 12px; }
`;

/** The default `<title>` subject: the source path's parent directory name, as the CLI shows it. */
function defaultTitle(source: string): string {
  const parts = source.split('/');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';
}

/** Render the whole view. Pure — reading and writing files is the caller's half. */
export function renderModelHtml(model: EmittedModel, opts: ModelViewSource): string {
  const entities = model.entities;
  const names = Object.keys(entities);
  const cards = names.map((name) => renderEntity(name, entities[name] as EmittedEntity));
  const lifecycles = model.lifecycles && Object.keys(model.lifecycles).length ? renderLifecycles(model.lifecycles) : '';
  const erasable = names.filter((n) => (entities[n]?.erasable ?? []).length > 0).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Entity model — ${escapeHtml(opts.title ?? (defaultTitle(opts.source) || 'substrat'))}</title>
<style>${STYLE}</style>
</head>
<body>
<!-- Rendered by @substrat-run/model-view from ${escapeHtml(opts.source)} — regenerate, do not edit. -->
<header>
<h1>Entity model</h1>
<p class="sub">${names.length} entities · ${erasable} with erasable fields · from <code>${escapeHtml(opts.source)}</code></p>
</header>
<div class="diagram">${renderDiagram(entities)}</div>
<h2>Entities</h2>
<div class="entities">${cards.join('')}</div>
${lifecycles}
<footer>An arrow points from an entity to a parent it may hang off — the allowlist <code>ctx.link</code> checks.
Marks: PK primary key · KEY natural key · ERASABLE reachable by an erasure. <code>?</code> marks an optional field.</footer>
</body>
</html>
`;
}
