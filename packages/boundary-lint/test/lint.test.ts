import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lint, resolvePackages, declaredEngines, type Violation } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures: a standalone vertical with engines installed in node_modules, which
// is the shape the monorepo linter could never see. Engine ownership comes from
// the migration SQL in the package's shipped dist — exactly as npm delivers it.
// ---------------------------------------------------------------------------

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'boundary-lint-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

/** An installed engine: package.json + dist carrying its CREATE TABLEs. */
function engine(name: string, tables: string[]): Record<string, string> {
  const dir = `node_modules/@substrat-run/${name}`;
  return {
    [`${dir}/package.json`]: JSON.stringify({ name: `@substrat-run/${name}`, main: './dist/index.js' }),
    [`${dir}/dist/index.js`]: tables
      .map((t) => `export const m_${t} = { sql: \`CREATE TABLE ${t} (id TEXT PRIMARY KEY);\` };`)
      .join('\n'),
  };
}

const VERTICAL_PKG = JSON.stringify({ name: '@acme/bike-shop', type: 'module' });

function rules(vs: Violation[]): string[] {
  return vs.map((v) => v.rule);
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('standalone vertical (engines in node_modules)', () => {
  it('R5 fires on an engine table and stays quiet on the vertical’s own', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders', 'workorder_time_entries']),
      'src/module.ts': `
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_customers (id TEXT);\` }];
        export function own(ctx) { return ctx.sql.query('SELECT * FROM shop_customers'); }
        export function foreign(ctx) { return ctx.sql.query('SELECT * FROM workorder_time_entries'); }
      `,
    });

    const violations = lint(root);

    expect(rules(violations)).toEqual(['R5']);
    expect(violations[0]!.message).toContain('workorder_time_entries');
    expect(violations[0]!.message).toContain('@substrat-run/engine-workorder');
    // The vertical's own table is never a violation.
    expect(violations[0]!.message).not.toContain('shop_customers');
  });

  it('resolves ownership from the published dist, so the map is not empty', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-invoicing', ['invoicing_lines']),
      'src/module.ts': 'export const x = 1;',
    });

    const owners = resolvePackages(root).filter((p) => !p.lint).map((p) => p.name);
    expect(owners).toContain('@substrat-run/engine-invoicing');
  });

  // A workspace-linked engine (a monorepo linting its own scaffold template, #878)
  // points at the whole source tree rather than the npm payload, so `dist` is not
  // the only thing under the package. Ownership must still come from the shipped
  // code: an engine's own test suite saying "no CREATE TABLE for <name>" otherwise
  // registers a table called `for`, and every consumer whose SQL contains the word
  // `for` is then told it references a private table. Six such violations is what
  // this repo's template lint reported before the scan was narrowed.
  it('ignores CREATE TABLE outside the shipped dist', () => {
    const dir = 'node_modules/@substrat-run/engine-invoicing';
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-invoicing', ['invoicing_lines']),
      // Not shipped, and not a table declaration — an assertion message.
      [`${dir}/test/entities.test.ts`]:
        "expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();",
      // A `for` loop and an ordinary English `for` — R5 matches table names as whole
      // words anywhere on a line, so a phantom table called `for` flags both.
      'src/module.ts': `
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_jobs (id TEXT);\` }];
        /** Totals the jobs, one row for each. */
        export function ok(ctx) {
          let n = 0;
          for (const row of ctx.sql.query('SELECT * FROM shop_jobs')) n += 1;
          return n;
        }
      `,
    });

    expect(lint(root)).toEqual([]);
  });

  it('a clean vertical passes', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        import { listOrders } from '@substrat-run/engine-workorder';
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_bikes (id TEXT);\` }];
        export function ok(ctx) { return { a: listOrders(ctx), b: ctx.sql.query('SELECT * FROM shop_bikes') }; }
      `,
    });

    expect(lint(root)).toEqual([]);
  });
});

describe('the spine (R4)', () => {
  it('reads of _substrat_* are legal — timelines are projections', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        export function timeline(ctx) { return ctx.sql.query('SELECT type FROM _substrat_outbox'); }
      `,
    });

    expect(lint(root)).toEqual([]);
  });

  it('writes to _substrat_* are R4', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        export function forge(ctx) { ctx.sql.exec("INSERT INTO _substrat_outbox (id) VALUES ('x')"); }
      `,
    });

    expect(rules(lint(root))).toEqual(['R4']);
  });
});

describe('R2 / R3', () => {
  it('flags raw data access, platform escapes, and network', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        import Database from 'better-sqlite3';
        import { readFileSync } from 'node:fs';
        import axios from 'axios';
        export function bad() { void fetch('https://example.com'); return [Database, readFileSync, axios]; }
      `,
    });

    expect(rules(lint(root)).sort()).toEqual(['R2', 'R2', 'R3', 'R3']);
  });

  it('flags the ambient env import, and only in module code', () => {
    // `import { env } from 'cloudflare:workers'` is one line, passes types, and
    // hands module code every binding the script declares — including its own
    // SCOPE namespace, which reaches ANOTHER scope's storage. `ctx.sql` cannot.
    const ambient = `
      import { env } from 'cloudflare:workers';
      export function reach(scopeId) { return env.SCOPE.get(env.SCOPE.idFromName(scopeId)); }
    `;
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': ambient,
    });

    expect(rules(lint(root))).toEqual(['R2']);

    // Harness code is where DurableObject legitimately comes from — same
    // exemption `node:*` already has, or every *-do.ts in the repo goes red.
    const root2 = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/worker.ts': ambient,
      'src/module.ts': 'export const x = 1;',
    });

    expect(lint(root2)).toEqual([]);
  });
});

describe('harness exemption', () => {
  it('server.ts may touch node and the adapter; module code may not', () => {
    const harnessSrc = `
      import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
      import { readFileSync } from 'node:fs';
      export const host = new SqliteScopeHost({ dir: './data' });
      export const cfg = readFileSync('./cfg.json', 'utf8');
    `;
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/server.ts': harnessSrc,
      'src/module.ts': 'export const x = 1;',
    });

    expect(lint(root)).toEqual([]);

    // The same code under a non-harness name is module code, and is not exempt.
    const root2 = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/ops.ts': harnessSrc,
    });
    expect(rules(lint(root2)).sort()).toEqual(['R2', 'R2']);
  });

  it('config-do.ts may import the DurableObject base; module code may not', () => {
    // The per-instance CONFIG store `create-substrat` scaffolds. Its
    // `cloudflare:workers` import is the DO base class workerd requires, not a reach
    // for the ambient env — the same class as auth-do.ts. It was missing from the
    // list, so every scaffolded project failed its own R2 gate on minute one while
    // the violation message was busy advertising `*-do.ts` as harness.
    const configDo = `
      import { DurableObject } from 'cloudflare:workers';
      export class ConfigDO extends DurableObject {
        get(scope) { return this.ctx.storage.sql.exec('SELECT 1'); }
      }
    `;
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/config-do.ts': configDo,
      'src/module.ts': 'export const x = 1;',
    });
    expect(lint(root)).toEqual([]);

    // The exemption is the NAME, not the import: the same file as module code is R2.
    const root2 = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/config.ts': configDo,
    });
    expect(rules(lint(root2))).toEqual(['R2']);
  });
});

describe('R5 escape hatch (decision 27)', () => {
  it('an explicit allow block suppresses R5, and only within the block', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_time_entries']),
      'src/module.ts': `
        export function extract(ctx) {
          // boundary-lint-allow R5 — one-time extraction handoff
          const old = ctx.sql.query('SELECT * FROM workorder_time_entries');
          // boundary-lint-end R5
          const sneaky = ctx.sql.query('SELECT * FROM workorder_time_entries');
          return [old, sneaky];
        }
      `,
    });

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R5']);
    // Only the line outside the block is reported (line 1 is the template's
    // leading newline, so `sneaky` lands on 6).
    expect(violations[0]!.line).toBe(6);
  });
});

describe('zero-engine verticals (agent-loop-008)', () => {
  // A vertical may own its whole domain and compose nothing — reaching an engine
  // by event imports it not at all. R5 is then inert because there is nothing to
  // protect, which is a fact about the project, not a broken linter. The first
  // cut conflated "no engines declared" with "engines unresolvable" and made this
  // shape unlintable; the monorepo hid it, since there engines are linted
  // packages rather than externals.
  it('declares nothing → R5 is inert, and that is not an error', () => {
    const root = project({
      'package.json': JSON.stringify({ name: '@acme/shop', dependencies: { hono: '^4' } }),
      'src/module.ts': `
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_orders (id TEXT);\` }];
        export function list(ctx) { return ctx.sql.query('SELECT * FROM shop_orders'); }
      `,
    });

    expect(declaredEngines(root)).toEqual([]);
    expect(lint(root)).toEqual([]);
  });

  it('declares an engine → it is reported, so the CLI can refuse a green light it has not earned', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: '@acme/shop',
        dependencies: { '@substrat-run/engine-workorder': '^0.3.0' },
      }),
      'src/module.ts': 'export const x = 1;',
      // …but node_modules is absent, so nothing resolves.
    });

    expect(declaredEngines(root)).toEqual(['@substrat-run/engine-workorder']);
    expect(resolvePackages(root).filter((p) => !p.lint)).toEqual([]);
  });

  it('finds engines in devDependencies too', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: '@acme/shop',
        devDependencies: { '@substrat-run/engine-invoicing': '^0.2.0' },
      }),
      'src/module.ts': 'export const x = 1;',
    });

    expect(declaredEngines(root)).toEqual(['@substrat-run/engine-invoicing']);
  });
});

describe('config', () => {
  it('honours explicit packages and externals', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      'boundary-lint.config.json': JSON.stringify({
        packages: [{ name: '@acme/thing', src: 'lib' }],
        externals: ['vendor/engine-thing'],
      }),
      'vendor/engine-thing/package.json': JSON.stringify({ name: '@acme/engine-thing' }),
      'vendor/engine-thing/dist/index.js': 'export const m = { sql: `CREATE TABLE thing_rows (id TEXT);` };',
      'lib/module.ts': `export function f(ctx) { return ctx.sql.query('SELECT * FROM thing_rows'); }`,
    });

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R5']);
    expect(violations[0]!.message).toContain('@acme/engine-thing');
  });
});
