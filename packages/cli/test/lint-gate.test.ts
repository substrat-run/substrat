import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLayerRules, push } from '../src/push.js';

/**
 * The push gate (#955).
 *
 * Before this, every mechanical rule the platform advertises ran in exactly two places:
 * this repo's CI and the builder studio. A vertical developed anywhere else — which is
 * every real customer — was built, uploaded and admitted having been checked by nothing,
 * so R2's ambient-env ban, R5's private tables and R6's clock were advisory for the code
 * that actually reaches production. These tests are about WHERE the rules run, not about
 * what they say: boundary-lint's own suite owns the rules.
 */

/** A minimal vertical tree: a package.json and one module file. */
function vertical(module: string, pkg: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-lint-gate-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@acme/crm', version: '1.0.0', ...pkg }),
  );
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'module.ts'), module);
  return dir;
}

const CLEAN = `
export const operations = {
  createTicket: async (ctx: any, input: { title: string }) => {
    await ctx.sql\`INSERT INTO tickets (id, title, created_at) VALUES (\${input.title}, \${ctx.now()})\`;
  },
};
`;

/** R2 (a node builtin in module code) and R6 (the wall clock) — two rules, one file. */
const DIRTY = `
import { readFileSync } from 'node:fs';
export const operations = {
  createTicket: async (ctx: any) => {
    const at = new Date();
    await ctx.sql\`INSERT INTO tickets (id, created_at) VALUES ('x', \${at.toISOString()})\`;
    return readFileSync('/etc/hosts', 'utf8');
  },
};
`;

const logs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  logs.length = 0;
});
function captureLog(): void {
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
}

describe('assertLayerRules — the layer rules, run on the way out', () => {
  it('passes a clean vertical and says what it checked', () => {
    captureLog();
    expect(() => assertLayerRules(vertical(CLEAN))).not.toThrow();
    expect(logs.join('\n')).toContain('all layer rules hold');
  });

  it('refuses a vertical whose module code breaks them, naming file, line and rule', () => {
    captureLog();
    let message = '';
    try {
      assertLayerRules(vertical(DIRTY));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('layer-rule violation');
    expect(message).toContain('src/module.ts');
    expect(message).toContain('R2');
    expect(message).toContain('R6');
    // The refusal has to teach the way past it, or the next person deletes the gate.
    expect(message).toContain('--skip-lint');
  });

  it('--skip-lint pushes ungated, and SAYS the push was ungated', () => {
    captureLog();
    expect(() => assertLayerRules(vertical(DIRTY), true)).not.toThrow();
    expect(logs.join('\n')).toContain('ungated');
  });

  /**
   * boundary-lint's own CLI exits 2 here, and is right to — invoked directly and unable to
   * find the tree it was told to check, it has failed at its job. A push has not: the
   * layout may simply not be one auto-detection knows, and refusing would make `substrat
   * push` unusable for a project whose only fault is an unusual directory. It has to be
   * VISIBLE, though — a silent pass is what makes a linter worth less than none.
   */
  it('notes rather than refuses when there is no module code to check', () => {
    captureLog();
    const dir = mkdtempSync(join(tmpdir(), 'substrat-lint-gate-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/empty' }));
    expect(() => assertLayerRules(dir)).not.toThrow();
    expect(logs.join('\n')).toContain('no module code');
  });

  it('notes when engines are declared but unresolvable — R5 checked nothing', () => {
    captureLog();
    const dir = vertical(CLEAN, { dependencies: { '@substrat-run/engine-workorder': '^0.1.0' } });
    expect(() => assertLayerRules(dir)).not.toThrow();
    expect(logs.join('\n')).toContain('R5');
  });
});

describe('push() — the gate is ON the push path, before anything is built', () => {
  it('rejects a violating tree without building or uploading', async () => {
    captureLog();
    // No wrangler is spawned and no fetch is made: the refusal lands first, which is the
    // point — a violation costs a second, not a whole build the platform would refuse.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      push({
        dir: vertical(DIRTY, { substrat: { runtimeNeeds: { entry: 'src/worker.ts' } } }),
        slug: 'crm',
        version: '1.0.0',
        controlPlaneUrl: 'http://cp',
        authHeader: {},
      }),
    ).rejects.toThrow(/layer-rule violation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The same join the `usesModels` test below in push.test.ts pins, for the same reason: a
 * flag typed on the options, honoured by `push()`, and never read from argv is a flag that
 * does nothing. Both push call sites in cli.ts are real pushes of real code.
 */
describe('cli.ts — --skip-lint reaches both push call sites', () => {
  it('is read from argv at push and at preview create', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const sites = src.match(/^\s*skipLint: argv\.includes\('--skip-lint'\),$/gm) ?? [];
    expect(sites.length).toBe(2);
  });
});
