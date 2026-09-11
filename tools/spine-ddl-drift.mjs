#!/usr/bin/env node
/**
 * The spine schema, checked for drift between the two adapters (#969).
 *
 * `_substrat_*` and the control-plane directory are the kernel's spine, and every adapter
 * has to build them. Today each one spells the whole thing out for itself: the pure adapter
 * in `adapter-sqlite/src/index.ts` (a scope `KERNEL_DDL` and a directory schema), the hosted
 * adapter in `scope-do.ts` and `control-plane-do.ts`. Those copies were in step when they
 * were written and nothing kept them so — a column added on one side only is a divergence
 * between "dev, CI, self-host and escrow" and production, found the way such things usually
 * are.
 *
 * This does not move any DDL. Where the spine should live is the migration checkpoint and a
 * human makes that call; this only refuses to let the copies part company, which is the half
 * that needs no decision. (Three fragments are kernel-owned and shared already —
 * `IMPERSONATION_DDL`, `OUTBOX_ENTITY_INDEX`, `IDEMPOTENCY_DDL` — and are resolved and
 * inlined here, so the comparison sees the schema each adapter actually builds.)
 *
 * Two things make the comparison mean something:
 *
 * 1. It compares the **effective** schema, not the `CREATE TABLE` text. A table's shape is
 *    the DDL block *plus* the columns each adapter ALTERs in afterwards for stores that
 *    predate them (`ensureColumn` on the pure side, `addColumn` on the DO side) — and those
 *    lists are hand-mirrored too, so they are exactly where drift hides. `scopes`
 *    `provisioned_version_id` is in the pure adapter's `CREATE TABLE` and in the DO's
 *    added-column list: same result, different route, and only an effective comparison
 *    reads that as the non-difference it is.
 * 2. It gets the effective schema by **executing** the DDL into an in-memory SQLite and
 *    reading it back, rather than diffing source text. Whitespace, comments, column order
 *    and statement order are then free to differ, as they legitimately do, and only the
 *    shape a query would actually meet is judged.
 *
 * A table on one side only is a note, not a failure: the two adapters really do partition
 * the spine differently — the DO adapter projects tenant tuples, roles and entitlements into
 * each scope, where the pure adapter keeps one shared directory. What must not differ is a
 * table both of them build.
 *
 * The extractors below read a handful of known call shapes. If one of them meets an
 * `ensureColumn`/`addColumn` call it does not understand it FAILS rather than quietly
 * comparing an incomplete schema — a gate that silently stops looking is worse than none.
 *
 * Usage: node tools/spine-ddl-drift.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const SQLITE = 'packages/adapter-sqlite/src/index.ts';
const SCOPE_DO = 'packages/adapter-cloudflare/src/scope-do.ts';
const CP_DO = 'packages/adapter-cloudflare/src/control-plane-do.ts';

/** The two stores, each built independently by each adapter. */
const PAIRS = [
  {
    name: 'scope',
    sides: [
      {
        label: 'adapter-sqlite KERNEL_DDL',
        file: SQLITE,
        anchor: /const KERNEL_DDL = `/,
        // `runtime()` ALTERs these into a scope db created before they existed.
        additions: [{ kind: 'ensureColumn', receiver: 'db' }],
      },
      {
        label: 'adapter-cloudflare ScopeDO KERNEL_DDL',
        file: SCOPE_DO,
        anchor: /const KERNEL_DDL = `/,
        // A ScopeDO that predates a column ALTERs it in on cold start, as whole statements:
        // DO SQLite restricts PRAGMA, so it attempts and tolerates rather than probing.
        additions: [{ kind: 'alterStatements' }],
      },
    ],
  },
  {
    name: 'directory',
    sides: [
      {
        label: 'adapter-sqlite applyDirectorySchema',
        file: SQLITE,
        anchor: /applyDirectorySchema\(\): void \{\s*this\.directory\.exec\(`/,
        additions: [{ kind: 'ensureColumn', receiver: 'this.directory' }],
      },
      {
        label: 'adapter-cloudflare ControlPlaneDO DIRECTORY_DDL',
        file: CP_DO,
        anchor: /const DIRECTORY_DDL = `/,
        additions: [{ kind: 'addColumn' }],
      },
    ],
  },
];

const KERNEL_SRC = path.join(ROOT, 'packages/kernel/src');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * Read a template literal starting just after its opening backtick, honouring `${...}`
 * nesting so an interpolation containing a brace or a nested template does not end it early.
 * Interpolations are left in place as `${NAME}` markers for `ddlFor` to resolve.
 */
function readTemplate(src, from, where) {
  let i = from;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '`') return out;
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  throw new Error(`unterminated template literal in ${where}`);
}

/** Every `export const NAME = <string>` under packages/kernel/src, by name. */
function kernelFragments() {
  const out = new Map();
  for (const entry of fs.readdirSync(KERNEL_SRC)) {
    if (!entry.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(KERNEL_SRC, entry), 'utf8');
    const re = /export const ([A-Z][A-Z0-9_]*) =\s*/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const at = m.index + m[0].length;
      const q = src[at];
      if (q === '`') out.set(m[1], readTemplate(src, at + 1, `${entry}:${m[1]}`));
      else if (q === "'" || q === '"') {
        const end = src.indexOf(q, at + 1);
        if (end !== -1) out.set(m[1], src.slice(at + 1, end));
      }
    }
  }
  return out;
}

/** One side's DDL block, with every kernel fragment it names inlined. */
function ddlFor(side, src, fragments) {
  const m = src.match(side.anchor);
  if (!m) throw new Error(`${side.label}: anchor ${side.anchor} matched nothing in ${side.file}`);
  const body = readTemplate(src, m.index + m[0].length, side.label);
  return body.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_whole, name) => {
    const frag = fragments.get(name);
    if (frag === undefined) {
      throw new Error(
        `${side.label}: interpolates \${${name}}, which is not an exported string constant under ` +
          `packages/kernel/src. Export it there — as the three shared spine fragments already ` +
          `are — so both adapters and this check read the same text.`,
      );
    }
    return frag;
  });
}

/**
 * Single-quoted strings in an array literal, in order.
 *
 * Comments are stripped first, and that is not cosmetic: one apostrophe in prose — a
 * `KERNEL_DDL's` in the ScopeDO's ALTER list — re-pairs every quote after it and silently
 * drops five of eight columns from the comparison. The array elements are SQL and column
 * DDL, neither of which contains `//`.
 */
const quoted = (block) =>
  [...block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').matchAll(/'([^']*)'/g)].map(
    (m) => m[1],
  );

/**
 * The columns a side ALTERs in after its DDL block. Each match records the source range it
 * consumed, so `assertEveryCallSiteRead` can prove nothing was missed.
 */
function additionsFor(side, src) {
  const out = [];
  const ranges = [];
  const take = (m, table, ddl) => {
    out.push({ table, ddl });
    ranges.push([m.index, m.index + m[0].length]);
  };

  for (const spec of side.additions) {
    if (spec.kind === 'ensureColumn') {
      const recv = spec.receiver.replace(/\./g, '\\.');
      // this.ensureColumn(<recv>, 'table', 'column', 'ddl')  — may wrap across lines.
      const lit = new RegExp(
        `this\\.ensureColumn\\(\\s*${recv}\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,?\\s*\\)`,
        'g',
      );
      for (const m of src.matchAll(lit)) take(m, m[1], m[3]);

      // for (const [col, ddl] of [ ['c','c TEXT'], … ] as const) { this.ensureColumn(<recv>, 'table', col, ddl); }
      const loop = new RegExp(
        `for \\(const \\[col, ddl\\] of \\[([\\s\\S]*?)\\] as const\\) \\{\\s*` +
          `this\\.ensureColumn\\(${recv}, '([^']+)', col, ddl\\);\\s*\\}`,
        'g',
      );
      for (const m of src.matchAll(loop)) {
        const pairs = quoted(m[1]);
        for (let i = 1; i < pairs.length; i += 2) take(m, m[2], pairs[i]);
      }

      // The one addition path that does not go through the helper: a probe-then-ALTER loop
      // over `scopes`, the pure adapter's mirror of the DO adapter's SCOPE_COLUMNS_ADDED.
      const rawLoop = new RegExp(
        `for \\(const \\[column, ddl\\] of \\[([\\s\\S]*?)\\] as const\\) \\{\\s*` +
          `if \\(!existing\\.has\\(column\\)\\)\\s*${recv}\\.exec\\(\`ALTER TABLE (\\w+) ADD COLUMN \\$\\{ddl\\}\`\\);\\s*\\}`,
        'g',
      );
      for (const m of src.matchAll(rawLoop)) {
        const pairs = quoted(m[1]);
        for (let i = 1; i < pairs.length; i += 2) take(m, m[2], pairs[i]);
      }
    } else if (spec.kind === 'alterStatements') {
      // A ScopeDO cannot probe (DO SQLite restricts PRAGMA), so it attempts a list of whole
      // ALTER statements and tolerates the duplicate. Same eight columns the pure adapter
      // reaches through `ensureColumn`, expressed as SQL rather than as arguments.
      for (const m of src.matchAll(/for \(const alter of \[([\s\S]*?)\]\) \{/g)) {
        for (const stmt of quoted(m[1])) {
          const parsed = stmt.match(/^ALTER TABLE (\w+) ADD COLUMN (.+)$/);
          if (parsed) take(m, parsed[1], parsed[2]);
        }
      }
    } else if (spec.kind === 'addColumn') {
      // this.addColumn('table', 'ddl')
      for (const m of src.matchAll(/this\.addColumn\('([^']+)',\s*'([^']+)'\)/g)) {
        take(m, m[1], m[2]);
      }
      // for (const ddl of NAMED_ARRAY) { this.addColumn('table', ddl); }
      const loop = /for \(const ddl of ([A-Z][A-Z0-9_]*)\) \{\s*this\.addColumn\('([^']+)', ddl\);\s*\}/g;
      for (const m of src.matchAll(loop)) {
        const decl = src.match(new RegExp(`const ${m[1]} = \\[([\\s\\S]*?)\\] as const;`));
        if (!decl) throw new Error(`${side.label}: cannot resolve the column list ${m[1]}`);
        for (const ddl of quoted(decl[1])) take(m, m[2], ddl);
      }
    }
  }
  return { additions: out, ranges };
}

/**
 * Refuse if a file adds a column by a route no extractor consumed — whether through the
 * `ensureColumn`/`addColumn` helpers or as a raw `ALTER TABLE <name> ADD COLUMN`. The
 * alternative is a check that quietly compares an incomplete schema and reports success.
 *
 * The two helpers' own bodies are the one thing this must not flag: they ALTER an
 * interpolated `${table}`, and every call site that reaches them is accounted for above. A
 * literal table name is what marks an addition that bypasses them.
 */
function assertEveryCallSiteRead(file, src, ranges) {
  const covered = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const missed = [];
  const shapes = [
    [/this\.(ensureColumn|addColumn)\(/g, (m) => m[1]],
    [/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN/g, (m) => `ALTER TABLE ${m[1]}`],
  ];
  for (const [re, name] of shapes) {
    for (const m of src.matchAll(re)) {
      if (!covered(m.index)) {
        missed.push(`${file}:${src.slice(0, m.index).split('\n').length} — ${name(m)}`);
      }
    }
  }
  if (missed.length > 0) {
    throw new Error(
      `spine-ddl-drift cannot read ${missed.length} column-addition call site(s):\n` +
        missed.map((s) => `  - ${s}`).join('\n') +
        `\nThe effective schema would be compared with those columns missing, so this refuses ` +
        `instead. Teach the extractors in tools/spine-ddl-drift.mjs the new call shape.`,
    );
  }
}

/** Execute DDL + ALTERs and read back the shape a query would actually meet. */
function schemaOf(ddl, additions, label) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl);
  } catch (err) {
    throw new Error(`${label}: the DDL does not execute — ${err.message}`);
  }
  for (const { table, ddl: col } of additions) {
    // Both adapters tolerate a duplicate — the steady state once the column is also in the
    // CREATE TABLE. Anything else is a real error in the addition list.
    try {
      db.exec(`ALTER TABLE ${JSON.stringify(table)} ADD COLUMN ${col}`);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) {
        throw new Error(`${label}: cannot add ${table}.${col} — ${err.message}`);
      }
    }
  }
  const tables = new Map();
  const indexes = new Map();
  const fks = new Map();
  for (const { name } of db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()) {
    tables.set(
      name,
      db
        .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
        .all()
        .map((c) => ({
          name: c.name,
          type: (c.type || '').toUpperCase(),
          notnull: Number(c.notnull),
          dflt: c.dflt_value === null ? null : String(c.dflt_value),
          pk: Number(c.pk),
        })),
    );

    // Indexes, read through PRAGMA rather than from `sqlite_master.sql`, so the comparison
    // is of what the planner actually has and not of how the two files happen to spell it.
    // `index_list` includes the ones SQLite creates for itself: `origin` is 'c' for a
    // CREATE INDEX, 'u' for a UNIQUE constraint and 'pk' for a primary key — which is how
    // a UNIQUE that exists on one side only gets caught, since `table_info` cannot see one.
    indexes.set(
      name,
      db
        .prepare(`PRAGMA index_list(${JSON.stringify(name)})`)
        .all()
        .map((ix) => ({
          // An auto-index is named positionally (`sqlite_autoindex_<table>_1`), so its name
          // is not a fact worth comparing — its columns are. A named index is the reverse:
          // the name is how the two sides refer to the same index at all.
          name: String(ix.origin) === 'c' ? ix.name : `«${ix.origin}»`,
          unique: Number(ix.unique),
          partial: Number(ix.partial),
          columns: db
            .prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`)
            .all()
            .map((c) => (c.name === null ? '<expr>' : c.name))
            .join(', '),
        })),
    );

    fks.set(
      name,
      db
        .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
        .all()
        .map((f) => `${f.from} → ${f.table}.${f.to} (on delete ${f.on_delete})`),
    );
  }
  db.close();
  return { tables, indexes, fks };
}

const describe = (c) =>
  `${c.type || 'BLOB'}${c.notnull ? ' NOT NULL' : ''}` +
  `${c.dflt === null ? '' : ` DEFAULT ${c.dflt}`}${c.pk ? ` PK(${c.pk})` : ''}`;

/** Column-level drift between one table built two ways. */
function tableDrift(a, b) {
  const out = [];
  const byName = (cols) => new Map(cols.map((c) => [c.name, c]));
  const [ma, mb] = [byName(a), byName(b)];
  for (const [name, ca] of ma) {
    const cb = mb.get(name);
    if (!cb) out.push(`column '${name}' (${describe(ca)}) is built by the first side only`);
    else if (describe(ca) !== describe(cb)) {
      out.push(`column '${name}' differs — first ${describe(ca)}, second ${describe(cb)}`);
    }
  }
  for (const [name, cb] of mb) {
    if (!ma.has(name)) out.push(`column '${name}' (${describe(cb)}) is built by the second side only`);
  }
  return out;
}

const describeIndex = (ix) =>
  `${ix.unique ? 'UNIQUE ' : ''}${ix.name}(${ix.columns})${ix.partial ? ' PARTIAL' : ''}`;

/**
 * Index-level drift between one table built two ways.
 *
 * Compared as a SET rather than by name, because the two halves of the identity differ:
 * a named index is the same index on both sides when the name matches, while an auto-index
 * from a UNIQUE constraint has a positional name that means nothing across files. Matching
 * on the rendered description covers both — and for a named index whose columns moved, it
 * reports the pair, which is the readable form of "this index is not the same index".
 */
function indexDrift(a, b) {
  const out = [];
  const [sa, sb] = [new Set(a.map(describeIndex)), new Set(b.map(describeIndex))];
  for (const d of sa) if (!sb.has(d)) out.push(`index ${d} is built by the first side only`);
  for (const d of sb) if (!sa.has(d)) out.push(`index ${d} is built by the second side only`);
  return out;
}

/** Foreign-key drift between one table built two ways. */
function fkDrift(a, b) {
  const out = [];
  const [sa, sb] = [new Set(a), new Set(b)];
  for (const d of sa) if (!sb.has(d)) out.push(`foreign key ${d} is declared by the first side only`);
  for (const d of sb) if (!sa.has(d)) out.push(`foreign key ${d} is declared by the second side only`);
  return out;
}

/**
 * Prove the comparison still refuses, on every run, before trusting it to pass.
 *
 * A drift gate that has quietly become a no-op reads exactly like a gate over a codebase
 * that never drifts, and this one has more than the usual room to rot that way: it reads
 * source with regexes, and the perturbation it is looking for is a single column. So it
 * perturbs a real extracted schema and requires each perturbation to be caught. This costs
 * nothing — the schemas are already in memory — and it fails loudly rather than passing.
 *
 * Every dimension the gate compares is perturbed here, and that is the rule rather than a
 * courtesy: a comparison with no perturbation behind it is the shape this whole function
 * exists to catch. The index cases arrived with the comparison itself (#969 review) —
 * before it, a one-sided CREATE INDEX or UNIQUE passed a green run.
 */
function proveItRefuses(reference) {
  const cols = [...reference.tables.values()].find((c) => c.length > 1);
  if (!cols) throw new Error('spine-ddl-drift self-check: no table with two columns to perturb');
  const ixs = [...reference.indexes.values()].find((i) => i.length > 0);
  if (!ixs) throw new Error('spine-ddl-drift self-check: no indexed table to perturb');
  const probeIx = { name: '__probe_ix', unique: 0, partial: 0, columns: 'a, b' };

  const cases = [
    ['a dropped column', () => tableDrift(cols, cols.slice(1))],
    [
      'an added column',
      () => tableDrift(cols, [...cols, { name: '__probe', type: 'TEXT', notnull: 0, dflt: null, pk: 0 }]),
    ],
    ['a retyped column', () => tableDrift(cols, [{ ...cols[0], type: 'INTEGER' }, ...cols.slice(1)])],
    [
      'a widened column',
      () => tableDrift(cols, [{ ...cols[0], notnull: cols[0].notnull ? 0 : 1 }, ...cols.slice(1)]),
    ],
    ['a dropped index', () => indexDrift(ixs, ixs.slice(1))],
    ['an added index', () => indexDrift(ixs, [...ixs, probeIx])],
    ['an index over different columns', () => indexDrift([probeIx], [{ ...probeIx, columns: 'b, a' }])],
    ['an index that stopped being UNIQUE', () => indexDrift([{ ...probeIx, unique: 1 }], [probeIx])],
    ['a dropped foreign key', () => fkDrift(['x → y.z (on delete NO ACTION)'], [])],
  ];
  for (const [what, run] of cases) {
    if (run().length === 0) {
      throw new Error(
        `spine-ddl-drift self-check: ${what} was NOT reported as drift. The comparison has ` +
          `stopped working — a green run would mean nothing.`,
      );
    }
  }
  const copy = (xs) => xs.map((x) => ({ ...x }));
  if (tableDrift(cols, copy(cols)).length !== 0) {
    throw new Error('spine-ddl-drift self-check: an identical table was reported as drift');
  }
  if (indexDrift(ixs, copy(ixs)).length !== 0) {
    throw new Error('spine-ddl-drift self-check: an identical index set was reported as drift');
  }
  return cases.length;
}

function main() {
  const fragments = kernelFragments();
  const sources = new Map();
  const rangesByFile = new Map();
  const sideSchemas = new Map();

  // Read every side first, so the call-site accounting sees all of a file's extractors
  // (adapter-sqlite carries both the scope side and the directory side).
  for (const pair of PAIRS) {
    for (const side of pair.sides) {
      if (!sources.has(side.file)) sources.set(side.file, read(side.file));
      const src = sources.get(side.file);
      const { additions, ranges } = additionsFor(side, src);
      rangesByFile.set(side.file, [...(rangesByFile.get(side.file) ?? []), ...ranges]);
      sideSchemas.set(side, { ddl: ddlFor(side, src, fragments), additions });
    }
  }
  for (const [file, src] of sources) {
    assertEveryCallSiteRead(file, src, rangesByFile.get(file) ?? []);
  }

  const failures = [];
  const notes = [];
  let proved = 0;

  for (const pair of PAIRS) {
    const [sideA, sideB] = pair.sides;
    const build = (side) => {
      const { ddl, additions } = sideSchemas.get(side);
      return schemaOf(ddl, additions, side.label);
    };
    const [a, b] = [build(sideA), build(sideB)];
    proved = proveItRefuses(a);

    const shared = [...a.tables.keys()].filter((t) => b.tables.has(t)).sort();
    if (VERBOSE) {
      const n = (side) => sideSchemas.get(side).additions.length;
      const ixCount = (x) => [...x.indexes.values()].reduce((t, i) => t + i.length, 0);
      console.log(
        `\n${pair.name}\n` +
          `  ${sideA.label}: ${a.tables.size} tables, ${ixCount(a)} indexes (+${n(sideA)} added columns)\n` +
          `  ${sideB.label}: ${b.tables.size} tables, ${ixCount(b)} indexes (+${n(sideB)} added columns)\n` +
          `  ${shared.length} built by both, compared column by column and index by index`,
      );
    }

    for (const table of shared) {
      const lines = [
        ...tableDrift(a.tables.get(table), b.tables.get(table)),
        ...indexDrift(a.indexes.get(table), b.indexes.get(table)),
        ...fkDrift(a.fks.get(table), b.fks.get(table)),
      ];
      for (const line of lines) {
        failures.push(
          `${pair.name}/${table}: ${line}\n      first:  ${sideA.label}\n      second: ${sideB.label}`,
        );
      }
    }
    for (const [only, side, other] of [
      [[...a.tables.keys()].filter((t) => !b.tables.has(t)).sort(), sideA, sideB],
      [[...b.tables.keys()].filter((t) => !a.tables.has(t)).sort(), sideB, sideA],
    ]) {
      for (const table of only) {
        notes.push(`${pair.name}/${table}: built by ${side.label}, not by ${other.label}`);
      }
    }
  }

  if (VERBOSE && notes.length > 0) {
    console.log(`\nOne-sided tables (${notes.length}) — reported, not failed:`);
    for (const n of notes) console.log(`  - ${n}`);
  }

  if (failures.length > 0) {
    console.error(
      `\nSpine schema drift — ${failures.length} difference${failures.length === 1 ? '' : 's'} ` +
        `in a table both adapters build:\n`,
    );
    for (const f of failures) console.error(`  ✖ ${f}\n`);
    console.error(
      `The pure adapter is what dev, CI, self-host and escrow run; the Durable-Object adapter is\n` +
        `production. A column or an index on one and not the other is a bug that only appears in\n` +
        `one of them — and the index case is the quiet one: the same query, correct on both, that\n` +
        `only plans a scan in production.\n` +
        `Add it to both, or move the table into a kernel-owned fragment both import (as\n` +
        `IMPERSONATION_DDL and IDEMPOTENCY_DDL under packages/kernel/src already are).\n`,
    );
    process.exit(1);
  }

  console.log(
    `spine schema: ${PAIRS.length} stores built two ways, no column, index or foreign-key drift ` +
      `in any table both adapters build` +
      (notes.length > 0 ? ` (${notes.length} one-sided tables, by design)` : '') +
      `; ${proved} perturbations re-checked as still caught`,
  );
}

main();
