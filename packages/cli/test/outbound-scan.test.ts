import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOutboundDeclared, judgeOutbound, readSource, scanOutboundHosts } from '../src/outbound-scan.js';

/**
 * `push --check` warns when the code names a host `substrat.outbound` does not declare (#2193).
 * The egress worker refuses such a call at run time with `403 outbound refused`; the matcher
 * here is the one it enforces with, so "declared" cannot mean two things.
 */

function tree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'substrat-cli-outbound-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const hostsOf = (src: string) => readSource(src).hosts.map((h) => h.host);

describe('readSource — which hosts a file names', () => {
  it('reads a string literal, a template without ${}, and new URL(…)', () => {
    const src = [
      "const a = 'https://api.acme-one.com/v2/things';",
      'const b = `https://api.acme-two.com/x`;',
      "const c = new URL('/oauth', 'https://auth.acme-three.com');",
      "const d = new URL('http://plain.acme-four.com');",
    ].join('\n');
    expect(hostsOf(src)).toEqual(['api.acme-one.com', 'api.acme-two.com', 'auth.acme-three.com', 'plain.acme-four.com']);
  });

  it('reports the line, and lowercases the host', () => {
    expect(readSource("\n\nfetch('HTTPS://API.Acme.com/x');").hosts).toEqual([{ host: 'api.acme.com', line: 3 }]);
  });

  it('reads the static part of a template with a ${} — the host written out is still the host', () => {
    expect(hostsOf('fetch(`https://api.acme.com/users/${id}`);')).toEqual(['api.acme.com']);
  });

  it('does NOT guess a host built at runtime', () => {
    expect(hostsOf("fetch('https://' + host + '/x'); fetch(`https://${host}/x`); fetch(env.API_URL);")).toEqual([]);
  });

  it('a literal continued by host characters is a host cut short: not reported as the short host', () => {
    expect(readSource("fetch('https://api.acme' + '.com');")).toMatchObject({ hosts: [], dynamic: [] });
  });

  it('a literal continued by a delimiter, or by nothing, names its whole host (positive twins)', () => {
    expect(hostsOf("fetch('https://api.acme.com' + '/x');")).toEqual(['api.acme.com']);
    expect(hostsOf("fetch('https://api.acme.com' + '?q=1');")).toEqual(['api.acme.com']);
    expect(hostsOf("fetch('https://api.acme.com/' + path);")).toEqual(['api.acme.com']);
    expect(hostsOf('fetch(`https://cdn.acme.com/${id}`);')).toEqual(['cdn.acme.com']);
    expect(hostsOf('fetch(`https://api.acme.com?q=${q}`);')).toEqual(['api.acme.com']);
    expect(hostsOf('fetch(`https://cdn.acme.com:${port}/x`);')).toEqual(['cdn.acme.com']);
    expect(hostsOf("fetch('https://api.acme.com');")).toEqual(['api.acme.com']);
  });

  it('a host an expression may continue is a dynamic note: never dropped, never judged on a guess', () => {
    for (const code of ["fetch('https://api.acme.com' + path);", 'fetch(`https://api.acme.com${path}`);']) {
      const r = readSource(code);
      expect(r.hosts, code).toEqual([]);
      expect(r.dynamic, code).toEqual([{ url: 'https://api.acme.com', line: 1 }]);
    }
    expect(readSource("fetch('https://api.' + sub + '.acme.com');").dynamic).toHaveLength(1);
  });

  it('judges a fully-qualified host (trailing dot) as the host without it', () => {
    expect(hostsOf("fetch('https://api.acme.com./x');")).toEqual(['api.acme.com']);
  });

  it('never reads a comment', () => {
    expect(hostsOf("// see https://docs.acme.com/api\n/* https://old.acme.com */\nconst x = 1;")).toEqual([]);
  });

  it('skips names that can never be declared or are not a third party', () => {
    const urls = [
      'http://localhost:8787/x',
      'http://127.0.0.1/x',
      'https://peer.substrat.internal/x',
      'https://example.com/x',
      'https://api.example.org/x',
      'https://service.test/x',
      'http://www.w3.org/2000/svg',
    ];
    expect(hostsOf(urls.map((u) => `fetch('${u}');`).join('\n'))).toEqual([]);
  });

  it('reads TypeScript and finds relative imports, static and dynamic', () => {
    const src = "import type { T } from './t.js';\nexport * from './a';\nconst m = await import('./lazy.js');\nimport x from 'pkg';\n";
    expect(readSource(src).imports).toEqual(['./a', './lazy.js']);
  });

  it('does not follow an edge the build erases, and follows every one that survives', () => {
    const imports = (src: string) => readSource(src).imports;
    expect(imports("import { type T } from './t.js';")).toEqual([]);
    expect(imports("import { type T, type U } from './t.js';")).toEqual([]);
    expect(imports("export type { T } from './t.js';")).toEqual([]);
    expect(imports("export { type T } from './t.js';")).toEqual([]);
    expect(imports("import { type T, v } from './t.js';")).toEqual(['./t.js']);
    expect(imports("export { type T, v } from './t.js';")).toEqual(['./t.js']);
    expect(imports("import './t.js';")).toEqual(['./t.js']);
    expect(imports("import {} from './t.js';")).toEqual(['./t.js']);
    expect(imports("import d from './t.js';")).toEqual(['./t.js']);
    expect(imports("import * as ns from './t.js';")).toEqual(['./t.js']);
    expect(imports("export * from './t.js';")).toEqual(['./t.js']);
  });

  it('does not scan a file reached only by a type-only edge', () => {
    const dir = tree({
      'src/worker.ts': "import type { T } from './types.js';\nimport { type U } from './u.js';\nexport default 1;\n",
      'src/types.ts': "export type T = 'https://types-only.acme.com';\n",
      'src/u.ts': "export const u = 'https://also-types.acme.com';\n",
    });
    expect(scanOutboundHosts(dir, 'src/worker.ts').sightings).toEqual([]);
  });
});

describe('scanOutboundHosts — the entry and what it imports', () => {
  it('follows relative imports, once each, and reports the file relative to the vertical', () => {
    const dir = tree({
      'src/worker.ts': "import { sync } from './integrations/sync.js';\nexport default { sync };\n",
      'src/integrations/sync.ts': "import './worker.js';\nexport const sync = () => fetch('https://api.acme.com/sync');\n",
      'src/unused.ts': "export const u = 'https://not-imported.acme.com';\n",
    });
    expect(scanOutboundHosts(dir, 'src/worker.ts').sightings).toEqual([{ host: 'api.acme.com', file: 'src/integrations/sync.ts', line: 2 }]);
  });
});

describe('scanOutboundHosts — a file it cannot use never ends the check', () => {
  it('does not read a .sql, .json or .md import as code, and still reports the entry', () => {
    const dir = tree({
      'src/worker.ts': "import s from './schema.sql';\nimport d from './data.json';\nimport n from './notes.md';\nfetch('https://good.acme.com');\n",
      'src/schema.sql': 'CREATE TABLE t (id TEXT);',
      'src/data.json': '{"url": "https://in-json.acme.com"}',
      'src/notes.md': '# see https://in-md.acme.com',
    });
    const r = scanOutboundHosts(dir, 'src/worker.ts');
    expect(r.sightings.map((s) => s.host)).toEqual(['good.acme.com']);
    expect(r.unread).toEqual([]);
  });

  it('keeps what it collected when one file does not parse, and says which file it skipped', () => {
    const dir = tree({
      'src/worker.ts': "import './bad.js';\nimport './ok.js';\nfetch('https://first.acme.com');\n",
      'src/bad.ts': 'export const = ;;; {{{',
      'src/ok.ts': "fetch('https://second.acme.com');\n",
    });
    const r = scanOutboundHosts(dir, 'src/worker.ts');
    expect(r.sightings.map((s) => s.host).sort()).toEqual(['first.acme.com', 'second.acme.com']);
    expect(r.unread).toEqual(['src/bad.ts']);
  });

  it('a missing entry is an unread file', () => {
    expect(scanOutboundHosts(tree({}), 'src/nope.ts').unread).toEqual(['src/nope.ts']);
  });
});

describe('judgeOutbound — against the same matcher the egress worker uses', () => {
  const seen = (host: string) => ({ host, file: 'src/a.ts', line: 1 });

  it('an exact entry matches exactly; a *. entry matches any depth but never the apex', () => {
    const r = judgeOutbound(
      [seen('api.acme.com'), seen('a.b.acme.org'), seen('acme.org'), seen('other.com')],
      ['api.acme.com', '*.acme.org'],
    );
    expect(r.undeclared.map((u) => u.host)).toEqual(['acme.org', 'other.com']);
  });

  it('names a host once, at its first sighting', () => {
    const r = judgeOutbound([{ host: 'x.com', file: 'a.ts', line: 1 }, { host: 'x.com', file: 'b.ts', line: 9 }], []);
    expect(r.undeclared).toEqual([{ host: 'x.com', file: 'a.ts', line: 1 }]);
  });

  it('a declared entry nothing names is stale; a wildcard is kept alive by any match', () => {
    const r = judgeOutbound([seen('a.acme.org')], ['*.acme.org', 'gone.acme.com']);
    expect(r.stale).toEqual(['gone.acme.com']);
  });
});

describe('checkOutboundDeclared — the report', () => {
  const dir = () =>
    tree({ 'src/worker.ts': "export default { f: () => fetch('https://wb.acme.com/x') };\n" });

  it('warns with the file, the line and the exact line to add, and says it is best effort', () => {
    const out: string[] = [];
    checkOutboundDeclared(dir(), 'src/worker.ts', ['api.acme.com'], { log: (m) => out.push(m) });
    expect(out.join('\n')).toContain('wb.acme.com  (src/worker.ts:1)');
    expect(out.join('\n')).toContain('"outbound": ["api.acme.com","wb.acme.com"]');
    expect(out.join('\n')).toContain('not a guarantee');
    expect(out.join('\n')).toContain('note: substrat.outbound declares api.acme.com');
  });

  it('is an error under strict — the same text, thrown', () => {
    expect(() => checkOutboundDeclared(dir(), 'src/worker.ts', [], { strict: true })).toThrow(/error: .*wb\.acme\.com/s);
  });

  it('prints a dynamic URL as a note and a count, and does not fail strict on it', () => {
    const d = tree({ 'src/worker.ts': "export default { f: (p: string) => fetch('https://api.acme.com' + p) };\n" });
    const out: string[] = [];
    checkOutboundDeclared(d, 'src/worker.ts', [], { strict: true, log: (m) => out.push(m) });
    expect(out).toEqual([
      'note: https://api.acme.com… is built dynamically, its host may continue; check it is declared (src/worker.ts:1)',
      'note: 1 dynamically built URL(s) were not judged against substrat.outbound.',
    ]);
  });

  it('a declaration a dynamic URL starts with is not called stale', () => {
    const d = tree({ 'src/worker.ts': "export default { f: (p: string) => fetch('https://api.acme.com' + p) };\n" });
    const out: string[] = [];
    checkOutboundDeclared(d, 'src/worker.ts', ['api.acme.com', 'gone.acme.com'], { log: (m) => out.push(m) });
    expect(out.join('\n')).toContain('is built dynamically');
    expect(out.join('\n')).toContain('declares gone.acme.com,');
    expect(out.join('\n')).not.toMatch(/declares [^\n]*api\.acme\.com/);
  });

  it('is silent when every host is declared, and a stale entry alone never throws', () => {
    const out: string[] = [];
    checkOutboundDeclared(dir(), 'src/worker.ts', ['wb.acme.com'], { strict: true, log: (m) => out.push(m) });
    expect(out).toEqual([]);
    checkOutboundDeclared(dir(), 'src/worker.ts', ['wb.acme.com', 'old.acme.com'], { strict: true, log: (m) => out.push(m) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^note:/);
  });

  it('does nothing without an entry', () => {
    expect(() => checkOutboundDeclared(dir(), undefined, [], { strict: true })).not.toThrow();
  });

  it('under strict, an unreadable file is a note beside the host that was found — never a silent pass', () => {
    const d = tree({
      'src/worker.ts': "import s from './bad.js';\nfetch('https://wb.acme.com/x');\n",
      'src/bad.ts': 'export const = ;;;',
    });
    const out: string[] = [];
    expect(() => checkOutboundDeclared(d, 'src/worker.ts', ['wb.acme.com'], { strict: true, log: (m) => out.push(m) })).not.toThrow();
    expect(out).toEqual(['note: could not read src/bad.ts, its hosts were not checked.']);
    expect(() => checkOutboundDeclared(d, 'src/worker.ts', [], { strict: true })).toThrow(/wb\.acme\.com/);
  });
});

describe.runIf(existsSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url))))(
  'substrat push --check — the outbound report',
  () => {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const PERMS = `export const permissions = ${JSON.stringify({
      modules: [{ manifest: { id: 'leave', permissions: [{ key: 'leave:read', description: 'Read leave' }] } }],
      roles: [],
    })};\n`;
    const vertical = (outbound: string[]) =>
      tree({
        'package.json': JSON.stringify({
          name: '@acme/leave',
          version: '1.0.0',
          substrat: { permissions: 'perms.mjs', runtimeNeeds: { entry: 'src/worker.ts', stores: [] }, outbound },
        }),
        'perms.mjs': PERMS,
        'src/worker.ts': "export default { f: () => fetch('https://wb.acme.com/x') };\n",
      });

    function check(dir: string, ...args: string[]) {
      const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      const r = spawnSync(process.execPath, [cli, 'push', dir, '--check', '--skip-lint', ...args], { env, encoding: 'utf8' });
      return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }

    it('warns and still passes by default, refuses under --strict, and is quiet once declared', () => {
      const warned = check(vertical([]));
      expect(warned.stdout).toContain('wb.acme.com');
      expect(warned.status, warned.stderr).toBe(0);
      const strict = check(vertical([]), '--strict');
      expect(strict.status).not.toBe(0);
      expect(strict.stderr).toContain('wb.acme.com');
      const clean = check(vertical(['wb.acme.com']), '--strict');
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout).not.toContain('outbound refused');
    }, 15_000);
  },
);
