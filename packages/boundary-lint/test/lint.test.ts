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

// ---------------------------------------------------------------------------
// R7 — catching an engine error outside ctx.atomic (#786)
//
// An engine in-scope function is composed inside the vertical's own transaction
// and has no boundary of its own, so a bare `catch` around it commits the rows
// the engine's invariants were protecting. `ctx.atomic` is the boundary; these
// fixtures pin exactly which shapes need it.
// ---------------------------------------------------------------------------

/** A vertical importing an engine, with `body` as its module code. */
function verticalWith(body: string): Record<string, string> {
  return {
    'package.json': VERTICAL_PKG,
    ...engine('engine-workorder', ['workorder_orders']),
    'src/module.ts': body,
  };
}

describe('R7 — engine errors and ctx.atomic', () => {
  it('a bare catch around an engine call is a violation, anchored at the call', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await completeWorkOrder(ctx, { orderId: id, billable: true });
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R7']);
    // The actionable place is the call, not the catch.
    expect(violations[0]!.line).toBe(5);
    expect(violations[0]!.message).toContain('completeWorkOrder');
    expect(violations[0]!.message).toContain('ctx.atomic');
  });

  it('the same call inside ctx.atomic passes', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await ctx.atomic(() => completeWorkOrder(ctx, { orderId: id, billable: true }));
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('atomic reached through a destructured alias still counts', () => {
    // `const { atomic } = ctx` is the same boundary; the rule matches the call,
    // not the receiver.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          const { atomic } = ctx;
          try {
            await atomic(async () => {
              await completeWorkOrder(ctx, { orderId: id });
            });
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('a re-throwing catch passes — the transaction still rolls back (question 3)', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch (e) {
            ctx.sql.exec('INSERT INTO shop_audit (note) VALUES (?)', ['failed']);
            throw e;
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('rethrowing a WRAPPED error passes too — the operation still fails', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch (e) {
            throw new Error(\`could not complete \${id}: \${(e).message}\`);
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('a destructured catch binding is not mistaken for the catch block', () => {
    // `catch ({ message })` is legal, and its brace is not the block's. Reading
    // the binding as the body makes a rethrowing catch look like a swallow.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch ({ message }) {
            throw new Error(message);
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('a catch that only SOMETIMES throws is still a violation', () => {
    // The throw is nested in an `if` block, so there is a path that swallows —
    // and that path is the #770 bug.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch (e) {
            if (fatal(e)) {
              throw e;
            }
            return { ok: false };
          }
        }
      `),
    );

    expect(rules(lint(root))).toEqual(['R7']);
  });

  it('try/finally with no catch passes — it swallows nothing (question 2)', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id, done) {
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } finally {
            done();
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('resolves an aliased import to the local name', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder as finish } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await finish(ctx, { orderId: id });
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R7']);
    expect(violations[0]!.message).toContain('finish');
  });

  it('resolves a namespace import', () => {
    const root = project(
      verticalWith(`
        import * as wo from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            await wo.completeWorkOrder(ctx, { orderId: id });
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    expect(rules(lint(root))).toEqual(['R7']);
  });

  it('a type-only import binds no callable — nothing to catch', () => {
    const root = project(
      verticalWith(`
        import type { WorkOrder } from '@substrat-run/engine-workorder';
        export function summarize(ctx, order) {
          try {
            return JSON.parse(order.payload);
          } catch {
            return undefined;
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('an inline `type` specifier is not a callable either', () => {
    const root = project(
      verticalWith(`
        import { type WorkOrder, PERM } from '@substrat-run/engine-workorder';
        export function summarize(ctx, order) {
          try {
            return JSON.parse(order.payload);
          } catch {
            return { perm: PERM };
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('catching the vertical’s OWN error is not R7 — only engine calls are', () => {
    // The vertical's own writes are already inside the operation's transaction;
    // if it throws, everything rolls back. R7 is about the engine seam only.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        function resolveDiscount(ctx, code) { throw new Error(code); }
        export function quote(ctx, code) {
          try {
            return resolveDiscount(ctx, code);
          } catch {
            return null;
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('constructing an engine error class is not calling into the engine', () => {
    const root = project(
      verticalWith(`
        import { SlotUnavailable } from '@substrat-run/engine-workorder';
        export function book(ctx, slot) {
          try {
            if (!slot) throw new SlotUnavailable('gone');
            return slot;
          } catch (e) {
            return e instanceof SlotUnavailable ? null : undefined;
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('one guarded call does not excuse an unguarded sibling in the same try', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder, cancelWorkOrder } from '@substrat-run/engine-workorder';
        export async function finish(ctx, id) {
          try {
            await ctx.atomic(() => completeWorkOrder(ctx, { orderId: id }));
            await cancelWorkOrder(ctx, { orderId: id });
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R7']);
    expect(violations[0]!.message).toContain('cancelWorkOrder');
    expect(violations[0]!.line).toBe(6);
  });

  it('fires on each offending try separately', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function a(ctx, id) {
          try { await completeWorkOrder(ctx, { orderId: id }); } catch { return 1; }
        }
        export async function b(ctx, id) {
          try { await completeWorkOrder(ctx, { orderId: id }); } catch { return 2; }
        }
      `),
    );

    expect(rules(lint(root))).toEqual(['R7', 'R7']);
  });

  it('an outer catch is a violation even when an inner one rethrows', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          try {
            try {
              await completeWorkOrder(ctx, { orderId: id });
            } catch (e) {
              throw e;
            }
          } catch {
            return { ok: false };
          }
        }
      `),
    );

    // The inner catch is clean; the outer one still swallows the engine error.
    expect(rules(lint(root))).toEqual(['R7']);
  });

  it('harness code is exempt, as it is for every other rule', () => {
    const swallow = `
      import { completeWorkOrder } from '@substrat-run/engine-workorder';
      export async function complete(ctx, id) {
        try {
          await completeWorkOrder(ctx, { orderId: id });
        } catch {
          return { ok: false };
        }
      }
    `;
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/seed.ts': swallow,
      'src/module.ts': 'export const x = 1;',
    });

    expect(lint(root)).toEqual([]);
  });

  it('there is no escape hatch — an allow block does not silence it', () => {
    // Deliberate (#786 question 4): unlike R5's one-time data handoff, there is
    // no legitimate reason to swallow an engine error unprotected.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export async function complete(ctx, id) {
          // boundary-lint-allow R7 — wishful thinking
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch {
            return { ok: false };
          }
          // boundary-lint-end R7
        }
      `),
    );

    expect(rules(lint(root))).toEqual(['R7']);
  });
});

describe('R7 — the masking pass', () => {
  it('a comment or a string mentioning the call is not the call', () => {
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        export function describeIt(ctx) {
          /* Do not write: try { completeWorkOrder(ctx, x) } catch { swallow } */
          try {
            return ctx.sql.query('SELECT * FROM shop_notes WHERE body = ?', ['completeWorkOrder(x)']);
          } catch {
            return [];
          }
        }
      `),
    );

    expect(lint(root)).toEqual([]);
  });

  it('braces inside a regex or a template literal do not break brace matching', () => {
    // If the mask mis-reads either, the try block's extent is wrong and the rule
    // silently stops finding anything — the failure mode worth a fixture.
    const root = project(
      verticalWith(`
        import { completeWorkOrder } from '@substrat-run/engine-workorder';
        const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
        export async function complete(ctx, id, when) {
          const label = \`order {\${id}} on \${when}\`;
          if (!DATE.test(when)) return label;
          try {
            await completeWorkOrder(ctx, { orderId: id });
          } catch {
            return label;
          }
        }
      `),
    );

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R7']);
    expect(violations[0]!.line).toBe(8);
  });

  it('an engine call inside a template expression still counts', () => {
    const root = project(
      verticalWith(`
        import { getReportedLines } from '@substrat-run/engine-workorder';
        export function summary(ctx, id) {
          try {
            return \`lines: \${getReportedLines(ctx, id).length}\`;
          } catch {
            return 'lines: ?';
          }
        }
      `),
    );

    expect(rules(lint(root))).toEqual(['R7']);
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
