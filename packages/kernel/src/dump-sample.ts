/**
 * A sampled copy of a scope (#3232): what a preview fork copies when the whole scope costs too much.
 *
 * A preview fork used to copy every row of its source, and each row copied is several rows written
 * at the destination (staged, loaded, indexed). A sample copies the newest rows instead, and stays a
 * scope the vertical's code can run against: nothing it copies points at something it left behind.
 *
 * The rules, all decided at the source in SQL, so nothing outside it ever holds a set of ids:
 *
 * - **Every table of the vertical's and its engines'** keeps its newest `rows` rows (by rowid),
 *   among the rows whose declared parents (`REFERENCES`, read with `pragma_foreign_key_list`) were
 *   kept. Parents are planned first, so children follow their parents: a row whose parent was left
 *   behind is left behind, however new. A null reference has no parent to follow.
 * - The newest rows are fixed when the copy starts (`floors`: the rowid each table's newest `rows`
 *   start at), so pages read later, and the capture's change batches, read the same sample. A row
 *   written while the copy runs is newer than the floor and is copied, if its parents were.
 * - A table read by offset (no rowid) has no newest rows, and a table in a reference cycle (one
 *   referring to itself included) has no order to plan in: each keeps every row whose parents
 *   outside the cycle were kept. A reference inside the cycle is not followed, and may be left
 *   pointing at a row the sample did not copy: the one place a sample does not hold by construction.
 * - **The spine follows the rows**, by id (entity ids are ULIDs, unique across tables): an outbox
 *   event or an attachment about a row the sample left behind is left behind, a delivery of such an
 *   event too, and a grant on such a row, or a link with such a row at either end. Every other spine
 *   table (roles, tuples on the scope, migrations, meta, the logs) is copied whole.
 *
 * The kernel imports no driver: an adapter hands in a {@link SampleReader} over its own SQL, and
 * applies the WHERE fragments {@link sampleFilters} answers to the reads it already makes.
 */
import { SCOPE_DUMP_SAMPLE_MAX_ROWS, substratError, type ScopeDumpSample } from '@substrat-run/contracts';

/** Read-only SQL over the scope, as an adapter answers it. */
export interface SampleReader {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
}

/** A table the dump reads, as the adapter's dump names it. */
export interface SampleTable {
  name: string;
  /** Read (and so sampled) by rowid. A `WITHOUT ROWID` table, or one with a column named rowid, is not. */
  byRowid: boolean;
}

interface Reference {
  parent: string;
  from: string[];
  to: string[];
}

interface SampleNode {
  name: string;
  byRowid: boolean;
  /** The primary key's columns, with their declared types, in key order. */
  pk: { name: string; type: string }[];
  references: Reference[];
  /** The tables of its reference cycle, itself included; empty when it is in none. */
  cycle: ReadonlySet<string>;
}

/** The dumped tables of the vertical and its engines, their references, and an order parents-first. */
export interface SampleGraph {
  readonly nodes: ReadonlyMap<string, SampleNode>;
  /** Parents before children: the order a plan reads floors in. */
  readonly order: readonly string[];
  /** The spine tables the dump reads, which the sample filters by the rows it left behind. */
  readonly spine: ReadonlySet<string>;
}

const SPINE_PREFIX = '_substrat_';
const isSpine = (name: string): boolean => name.startsWith(SPINE_PREFIX);

/** A table or column name quoted for SQL. */
const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Read the references between the dumped tables. A reference to a table the dump does not read (a
 * spine table, or one that is gone) is not followed: there is nothing sampled to follow it to.
 */
export function sampleGraph(reader: SampleReader, tables: readonly SampleTable[]): SampleGraph {
  const data = tables.filter((t) => !isSpine(t.name));
  const names = new Set(data.map((t) => t.name));
  const pkOf = (name: string) =>
    reader
      .all(`SELECT name, type, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`, name)
      .map((r) => ({ name: String(r['name']), type: String(r['type'] ?? '') }));
  const nodes = new Map<string, SampleNode>();
  for (const t of data) {
    const grouped = new Map<number, { parent: string; from: string[]; to: (string | null)[] }>();
    for (const r of reader.all(`SELECT id, seq, "table" AS parent, "from" AS col, "to" AS ref FROM pragma_foreign_key_list(?) ORDER BY id, seq`, t.name)) {
      const id = Number(r['id']);
      const ref = grouped.get(id) ?? { parent: String(r['parent']), from: [], to: [] };
      ref.from.push(String(r['col']));
      ref.to.push(r['ref'] === null || r['ref'] === undefined ? null : String(r['ref']));
      grouped.set(id, ref);
    }
    const references: Reference[] = [];
    for (const ref of grouped.values()) {
      if (!names.has(ref.parent)) continue;
      // `REFERENCES parent` with no column names the parent's primary key (its rowid, when it has none).
      const implied = ref.to.some((c) => c === null) ? pkOf(ref.parent).map((c) => c.name) : [];
      const to = ref.to.map((c, i) => c ?? implied[i] ?? 'rowid');
      references.push({ parent: ref.parent, from: ref.from, to });
    }
    nodes.set(t.name, { name: t.name, byRowid: t.byRowid, pk: pkOf(t.name), references, cycle: new Set() });
  }
  // Tarjan over child → parent: a component is finished only after every one it reaches, so the
  // components come out parents first.
  const order: string[] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const visit = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter++;
    stack.push(name);
    onStack.add(name);
    for (const { parent } of nodes.get(name)!.references) {
      if (!index.has(parent)) {
        visit(parent);
        low.set(name, Math.min(low.get(name)!, low.get(parent)!));
      } else if (onStack.has(parent)) {
        low.set(name, Math.min(low.get(name)!, index.get(parent)!));
      }
    }
    if (low.get(name) !== index.get(name)) return;
    const component: string[] = [];
    for (;;) {
      const top = stack.pop()!;
      onStack.delete(top);
      component.push(top);
      if (top === name) break;
    }
    const self = nodes.get(name)!.references.some((r) => r.parent === name);
    if (component.length > 1 || self) {
      const cycle = new Set(component);
      for (const member of component) nodes.get(member)!.cycle = cycle;
    }
    order.push(...component.sort());
  };
  for (const name of [...nodes.keys()].sort()) if (!index.has(name)) visit(name);
  return { nodes, order, spine: new Set(tables.filter((t) => isSpine(t.name)).map((t) => t.name)) };
}

/** Whether `node` keeps every row its parents allow: it has no newest rows to keep. */
const unordered = (node: SampleNode): boolean => !node.byRowid || node.cycle.size > 0;

/**
 * The condition a row of `node` (named `ref` in the SQL) meets when the sample keeps it: at or above
 * its table's floor, and every non-null reference outside its cycle met by a kept parent row.
 * `'1'` when it keeps every row. `depth` names the aliases, so nested parents never shadow.
 */
function keepCondition(graph: SampleGraph, node: SampleNode, ref: string, floors: ScopeDumpSample['floors'], depth: number): string {
  const parts: string[] = [];
  if (!unordered(node)) {
    const floor = floors?.[node.name];
    if (typeof floor === 'number') parts.push(`${ref}.rowid >= ${floor}`);
  }
  for (const reference of node.references) {
    if (node.cycle.has(reference.parent)) continue;
    const parent = graph.nodes.get(reference.parent)!;
    const alias = `s${depth}`;
    const match = reference.from.map((col, i) => `${alias}.${q(reference.to[i]!)} = ${ref}.${q(col)}`);
    const kept = keepCondition(graph, parent, alias, floors, depth + 1);
    const exists = `EXISTS (SELECT 1 FROM ${q(parent.name)} AS ${alias} WHERE ${[...match, ...(kept === '1' ? [] : [kept])].join(' AND ')})`;
    parts.push(`(${[...reference.from.map((col) => `${ref}.${q(col)} IS NULL`), exists].join(' OR ')})`);
  }
  return parts.length === 0 ? '1' : parts.join(' AND ');
}

/** Refuse a sample a copier could not have asked for. */
function assertSample(sample: ScopeDumpSample): void {
  if (!Number.isSafeInteger(sample.rows) || sample.rows < 1 || sample.rows > SCOPE_DUMP_SAMPLE_MAX_ROWS) {
    throw substratError('validation_failed', `a sample keeps 1 to ${SCOPE_DUMP_SAMPLE_MAX_ROWS} rows per table (got ${sample.rows})`);
  }
}

/**
 * Plan a sample of `rows` rows per table: read each table's floor, parents first, so a child's newest
 * rows are counted among those whose parents the sample keeps. Reads only. The plan is what every
 * later page and change batch of the copy reads under, so a copier hands it back unchanged.
 */
export function planDumpSample(reader: SampleReader, graph: SampleGraph, rows: number): Required<ScopeDumpSample> {
  assertSample({ rows });
  const floors: Record<string, number | null> = {};
  for (const name of graph.order) {
    const node = graph.nodes.get(name)!;
    if (unordered(node)) continue;
    const table = q(name);
    const kept = keepCondition(graph, node, table, floors, 1);
    const [row] = reader.all(`SELECT ${table}.rowid AS r FROM ${table} WHERE ${kept} ORDER BY ${table}.rowid DESC LIMIT 1 OFFSET ?`, rows - 1);
    floors[name] = row ? Number(row['r']) : null;
  }
  return { rows, floors };
}

/**
 * Per table, the WHERE fragment a sampled read ANDs onto its own, naming the table by its quoted
 * name (the dump reads `FROM "<table>"` unaliased). A table the sample copies whole has none.
 */
export function sampleFilters(graph: SampleGraph, sample: ScopeDumpSample): Map<string, string> {
  assertSample(sample);
  if (!sample.floors) throw substratError('validation_failed', 'a sample is read under the floors its plan answered');
  const filters = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    const kept = keepCondition(graph, node, q(node.name), sample.floors, 1);
    if (kept !== '1') filters.set(node.name, kept);
  }
  // The rows a sample can leave behind, by a single-column text key: an entity's id. An integer key
  // is a rowid, which another table's id can equal, so it never names an entity here.
  const droppable = [...graph.nodes.values()].filter(
    (n) => n.pk.length === 1 && !/INT/i.test(n.pk[0]!.type) && filters.has(n.name),
  );
  if (droppable.length === 0) return filters;
  const leftBehind = (id: string): string =>
    droppable
      .map((n) => `EXISTS (SELECT 1 FROM ${q(n.name)} AS d WHERE d.${q(n.pk[0]!.name)} = ${id} AND NOT (${keepCondition(graph, n, 'd', sample.floors, 1)}))`)
      .join(' OR ');
  const refId = (column: string): string => `substr(${column}, instr(${column}, ':') + 1)`;
  const spine: Record<string, string> = {
    _substrat_outbox: `NOT (${leftBehind(`${q('_substrat_outbox')}.entity_id`)})`,
    _substrat_attachments: `NOT (${leftBehind(`${q('_substrat_attachments')}.entity_id`)})`,
    _substrat_deliveries:
      `NOT EXISTS (SELECT 1 FROM ${q('_substrat_outbox')} AS o WHERE o.id = ${q('_substrat_deliveries')}.event_id AND (${leftBehind('o.entity_id')}))`,
    // A grant names its entity as the object; a link (`parent`) names its child as the subject too.
    _substrat_tuples:
      `NOT (${leftBehind(refId(`${q('_substrat_tuples')}.object`))}) AND ` +
      `(${q('_substrat_tuples')}.relation <> 'parent' OR NOT (${leftBehind(refId(`${q('_substrat_tuples')}.subject`))}))`,
  };
  for (const [name, filter] of Object.entries(spine)) if (graph.spine.has(name)) filters.set(name, filter);
  return assertFiltersFit(filters);
}

/**
 * The longest filter a sample hands a read (#3232), in UTF-8 bytes. A Durable Object refuses a
 * statement over 100 000 (`DO_SQL_LIMITS.statementBytes`), and a read wraps the filter in its own
 * text and a capture's `IN` list. A filter repeats each parent's condition inside its child's, so
 * only a deep schema of many-parent tables reaches this; the largest vertical in this repository
 * stays near 10 000.
 */
export const SAMPLE_FILTER_MAX_BYTES = 80_000;

const utf8Bytes = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

/** Refuse a sample whose filters a Durable Object could not run, by name, rather than as an SQL error. */
function assertFiltersFit(filters: Map<string, string>): Map<string, string> {
  for (const [name, filter] of filters) {
    if (utf8Bytes(filter) > SAMPLE_FILTER_MAX_BYTES) {
      throw substratError(
        'validation_failed',
        `this scope cannot be copied as a sample: the references that ${name} follows are too deep to read in one statement ` +
          `(${utf8Bytes(filter)} bytes, over ${SAMPLE_FILTER_MAX_BYTES}). Copy it whole (#3232).`,
      );
    }
  }
  return filters;
}

/** A filtered table up to this many rows is counted exactly; a larger one on a probe of its rows. */
export const SAMPLE_COUNT_EXACT_ROWS = 50_000;
/** About how many rows a probe reads. */
const SAMPLE_PROBE_ROWS = 20_000;

/**
 * How many rows a copy would move (#3232), per table: everything, or what `filters` keeps. A table
 * with no filter, one bounded by its floor, or one small enough is counted exactly; a larger one
 * read under a filter is counted on every k-th rowid and scaled, so the count fits one turn.
 * `base` is the adapter's own per-table filter (rows its dump never carries).
 */
export function countDumpRows(
  reader: SampleReader,
  tables: readonly SampleTable[],
  opts: {
    filters?: ReadonlyMap<string, string>;
    sample?: ScopeDumpSample;
    base?: (name: string) => { where: string; bindings: unknown[] };
  } = {},
): { rows: number; tables: { name: string; rows: number; estimated?: true }[] } {
  const out: { name: string; rows: number; estimated?: true }[] = [];
  for (const t of tables) {
    const { where, bindings } = opts.base?.(t.name) ?? { where: '1', bindings: [] };
    const table = q(t.name);
    const count = (cond: string): number =>
      Number(reader.all(`SELECT COUNT(*) AS n FROM ${table} WHERE (${where}) AND (${cond})`, ...bindings)[0]?.['n'] ?? 0);
    const filter = opts.filters?.get(t.name);
    const total = count('1');
    if (!filter) {
      out.push({ name: t.name, rows: total });
      continue;
    }
    const floored = typeof opts.sample?.floors?.[t.name] === 'number';
    if (total <= SAMPLE_COUNT_EXACT_ROWS || floored || !t.byRowid) {
      out.push({ name: t.name, rows: count(filter) });
      continue;
    }
    const k = Math.ceil(total / SAMPLE_PROBE_ROWS);
    const probed = count(`${table}.rowid % ${k} = 0`);
    const kept = count(`${table}.rowid % ${k} = 0 AND (${filter})`);
    out.push({ name: t.name, rows: probed === 0 ? 0 : Math.round((total * kept) / probed), estimated: true });
  }
  return { rows: out.reduce((n, t) => n + t.rows, 0), tables: out };
}
