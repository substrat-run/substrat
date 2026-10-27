import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWrangler, wranglerEnv } from '../src/push.js';
import { FAKE_WRANGLER_VERSION, installFakeWrangler } from './fake-wrangler.js';

/**
 * `substrat push` builds the Worker with the project's own wrangler, run as `node <bin>` with no
 * shell (push.ts `resolveWrangler`). Before, it spawned `npx wrangler …`, which on Windows is
 * `npx.cmd`: `execFileSync` finds no `npx` there, so every push failed with
 * `spawnSync npx ENOENT` before it built anything.
 *
 * The paths are the awkward ones on purpose. The project directory and the temp directory the
 * build writes to both hold a space and a non-ASCII letter, which is what a home directory named
 * after a person looks like, and what a shell-quoting fix gets wrong. On Windows the temp
 * directory is also reached through its 8.3 short name, as `os.tmpdir()` reports it there.
 */

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const built = existsSync(cli);

/** A directory whose path holds a space and a non-ASCII letter. */
function awkwardDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix} å `)));
}

/** The 8.3 short form of `path` on Windows (`C:\Users\JOHANS~1\…`), or `path` where there is none. */
function shortPath(path: string): string {
  if (process.platform !== 'win32') return path;
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const short = (r.stdout ?? '').trim();
  return short && existsSync(short) ? short : path;
}

/**
 * The smallest vertical `push --check` builds: `--check` runs wrangler only for a declared build
 * command, and a derived (runtimeNeeds) config is what makes the push pass `--config`. The build
 * command leaves a marker, so the real-wrangler case can tell it ran in the project directory.
 */
function vertical(dir: string, build = 'node build.mjs'): string {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@acme/board', version: '1.0.0', type: 'module', substrat: { slug: 'board', permissions: 'perms.mjs', runtimeNeeds: { entry: 'src/worker.ts', build } } }),
  );
  writeFileSync(join(dir, 'perms.mjs'), 'export const permissions = { modules: [], roles: [] };\n');
  writeFileSync(join(dir, 'build.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('built.txt', 'ok');\n");
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'worker.ts'), 'export default { fetch: () => new Response("ok") };\n');
  return dir;
}

function check(dir: string, env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GITHUB_ACTIONS: '', WRANGLER_SEND_METRICS: 'false', ...env };
  delete childEnv.SUBSTRAT_CP_URL;
  delete childEnv.SUBSTRAT_SERVICE_TOKEN;
  const r = spawnSync(process.execPath, [cli, 'push', dir, '--check', '--skip-lint'], { encoding: 'utf8', env: childEnv });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** TMP for every OS: `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows. */
const tempEnv = (dir: string): NodeJS.ProcessEnv => ({ TMPDIR: dir, TEMP: dir, TMP: dir });

describe('resolveWrangler — the project’s own wrangler, never one npx would download', () => {
  it('finds the bin the project’s wrangler names, and its version', () => {
    const dir = awkwardDir('substrat-wrangler');
    installFakeWrangler(dir);
    const w = resolveWrangler(dir);
    expect(w.version).toBe(FAKE_WRANGLER_VERSION);
    expect(w.bin).toBe(resolve(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  });

  it('finds one a workspace hoisted to a parent directory, as Node would', () => {
    const root = awkwardDir('substrat-workspace');
    installFakeWrangler(root);
    const pkg = join(root, 'verticals', 'board');
    mkdirSync(pkg, { recursive: true });
    expect(resolveWrangler(pkg).bin).toBe(resolve(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  });

  it('reads a string `bin` as well as the map form', () => {
    const dir = awkwardDir('substrat-wrangler-bin');
    installFakeWrangler(dir);
    const pkgJson = join(dir, 'node_modules', 'wrangler', 'package.json');
    writeFileSync(pkgJson, JSON.stringify({ name: 'wrangler', version: '9.9.9', bin: './bin/wrangler.js' }));
    expect(resolveWrangler(dir)).toEqual({ bin: resolve(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), version: '9.9.9' });
  });

  it('refuses a project without wrangler, saying how to add it', () => {
    const dir = awkwardDir('substrat-no-wrangler');
    expect(() => resolveWrangler(dir)).toThrow(/wrangler is not installed in this project[\s\S]*devDependency[\s\S]*npm install --save-dev wrangler/);
    // Yarn Plug'n'Play installs no node_modules: said, rather than left to look like a missing install.
    expect(() => resolveWrangler(dir)).toThrow(/nodeLinker: node-modules/);
  });
});

describe('wranglerEnv — the PATH npx used to give the build', () => {
  it('puts the project’s bins first, nearest first, then Node’s own directory, then the caller’s PATH', () => {
    const dir = join(awkwardDir('substrat-env'), 'verticals', 'board');
    const parts = wranglerEnv(dir, { PATH: 'caller-path' }).PATH!.split(delimiter);
    expect(parts[0]).toBe(join(dir, 'node_modules', '.bin'));
    expect(parts[1]).toBe(join(dirname(dir), 'node_modules', '.bin'));
    expect(parts.slice(-2)).toEqual([dirname(process.execPath), 'caller-path']);
  });

  it('keeps the key Windows spells `Path` as the only one, rather than adding a second', () => {
    const env = wranglerEnv(awkwardDir('substrat-env'), { Path: 'caller-path', OTHER: 'kept' });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(env.Path!.endsWith(`${delimiter}caller-path`)).toBe(true);
    expect(env.OTHER).toBe('kept');
  });
});

describe.runIf(built)('push --check builds through the project’s wrangler, on paths with a space and a non-ASCII letter', () => {
  it('hands wrangler the build directory and the derived config as one argument each, unchanged', () => {
    const dir = vertical(awkwardDir('substrat-project'));
    installFakeWrangler(dir);
    const temp = shortPath(awkwardDir('substrat-temp'));
    const record = join(awkwardDir('substrat-argv'), 'argv.json');

    const r = check(dir, { ...tempEnv(temp), FAKE_WRANGLER_ARGV: record });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`with wrangler ${FAKE_WRANGLER_VERSION}`);
    const { argv, cwd, path } = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string; path: string };
    // What npx used to give it: the project's own bins first, so its build command finds them.
    expect(path.split(delimiter)[0]).toBe(join(dir, 'node_modules', '.bin'));
    expect(argv.slice(0, 2)).toEqual(['deploy', '--dry-run']);
    const out = argv[argv.indexOf('--outdir') + 1]!;
    expect(out.startsWith(join(temp, 'substrat-build-')), out).toBe(true);
    expect(argv[argv.indexOf('--config') + 1]).toBe(join(dir, '.wrangler.substrat.json'));
    expect(realpathSync(cwd)).toBe(dir);
    // The build directory and the derived config are both cleaned up.
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(dir, '.wrangler.substrat.json'))).toBe(false);
  });

  it('refuses a project without wrangler before writing anything, instead of downloading one', () => {
    const dir = vertical(awkwardDir('substrat-project'));
    const temp = awkwardDir('substrat-temp');

    const r = check(dir, tempEnv(temp));

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('wrangler is not installed in this project');
    expect(r.stderr).toContain('npm install --save-dev wrangler');
    expect(readdirSync(temp)).toEqual([]);
    expect(existsSync(join(dir, '.wrangler.substrat.json'))).toBe(false);
  });
});

/**
 * The real thing: the wrangler this repository pins, linked into a fixture vertical the way a
 * project's node_modules holds it, building a Worker. The smoke test the Windows CI job relies on.
 * A junction, not a symlink: a directory symlink on Windows needs admin or Developer Mode.
 */
const repoWrangler = fileURLToPath(new URL('../../../node_modules/wrangler', import.meta.url));
describe.runIf(built && existsSync(join(repoWrangler, 'package.json')))('push --check with the real wrangler', () => {
  it('builds the Worker on paths with a space and a non-ASCII letter', () => {
    const dir = vertical(awkwardDir('substrat-project'));
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(repoWrangler, join(dir, 'node_modules', 'wrangler'), 'junction');
    const temp = shortPath(awkwardDir('substrat-temp'));

    const r = check(dir, tempEnv(temp));

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/building Worker with wrangler \d+\.\d+\.\d+/);
    expect(existsSync(join(dir, 'built.txt')), 'the project’s build command ran in its directory').toBe(true);
    expect(existsSync(join(dir, '.wrangler.substrat.json'))).toBe(false);
  }, 120_000);

  /**
   * A build command naming a tool the project installs: found in its `node_modules/.bin`, as
   * `npx` made it, though the PATH the CLI starts with holds nothing but Node and the system.
   * That is a globally installed CLI, or one started from a repository root.
   */
  it('runs a build command that names a bin only the project installs', () => {
    const dir = vertical(awkwardDir('substrat-project'), 'make-built');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(repoWrangler, join(dir, 'node_modules', 'wrangler'), 'junction');
    // Both forms, so the one this OS's shell runs is there: a shell script, and a .cmd for cmd.exe.
    writeFileSync(join(dir, 'node_modules', '.bin', 'make-built'), '#!/bin/sh\nnode build.mjs\n', { mode: 0o755 });
    writeFileSync(join(dir, 'node_modules', '.bin', 'make-built.cmd'), '@node build.mjs\r\n');
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const system = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];

    const r = check(dir, { ...tempEnv(awkwardDir('substrat-temp')), [pathKey]: [dirname(process.execPath), ...system].join(delimiter) });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(dir, 'built.txt')), 'the build found the project’s own bin').toBe(true);
  }, 120_000);
});
