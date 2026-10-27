import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const NODE_COMPAT = new Set(['nodejs_compat', 'nodejs_compat_v2']);
const ALS = new Set(['node:async_hooks', 'async_hooks']);
const BUILTINS = new Set(builtinModules);
// esbuild's module-loading kinds. `require-resolve` only asks for a path; CSS import kinds
// and URL tokens do not load a JavaScript builtin in a Worker.
const LOAD_KINDS = new Set(['import-statement', 'dynamic-import', 'require-call']);
// Each entry is an exact package/file/import match, never a general guarded-import policy.
const KNOWN_DEAD_WORKER_REQUIRES = [
  { packageName: 'tweetnacl', file: 'nacl-fast.js', builtin: 'crypto', kind: 'require-call' },
] as const;
// tweetnacl takes self.crypto first. Its Node PRNG fallback is unreachable in workerd;
// refuse this allowance if that source shape changes or another crypto require appears.
const TWEETNACL_WORKER_CRYPTO = /var crypto = typeof self !== 'undefined' \? \(self\.crypto \|\| self\.msCrypto\) : null;\s*if \(crypto && crypto\.getRandomValues\) \{/;
const TWEETNACL_GUARD = /} else if \(typeof require !== 'undefined'\) \{\s*\/\/ Node\.js\.\s*crypto = require\('crypto'\);/;

function isKnownDeadWorkerRequire(importer: string, builtin: string, kind: string): boolean {
  const candidate = KNOWN_DEAD_WORKER_REQUIRES.find((row) => row.builtin === builtin && row.kind === kind);
  if (!candidate) return false;
  const sourcePath = realpathSync(resolve(importer));
  if (!sourcePath.split(sep).includes('node_modules')) return false;
  let packageDir = dirname(sourcePath);
  while (!existsSync(join(packageDir, 'package.json'))) {
    const parent = dirname(packageDir);
    if (parent === packageDir) return false;
    packageDir = parent;
  }
  let name: unknown;
  try {
    name = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
  } catch {
    return false;
  }
  if (name !== candidate.packageName || relative(packageDir, sourcePath) !== candidate.file) return false;
  const source = readFileSync(sourcePath, 'utf8');
  const workerBranch = TWEETNACL_WORKER_CRYPTO.exec(source);
  const nodeBranch = TWEETNACL_GUARD.exec(source);
  return Boolean(workerBranch && nodeBranch && workerBranch.index < nodeBranch.index) &&
    (source.match(/\brequire\s*\(\s*['"]crypto['"]\s*\)/g)?.length ?? 0) === 1;
}

export function builtinsAllowedBy(flags: readonly string[]): 'all' | ReadonlySet<string> {
  if (flags.some((flag) => NODE_COMPAT.has(flag))) return 'all';
  return flags.includes('nodejs_als') ? ALS : new Set<string>();
}

export interface RefusedWorkerImports {
  refused: string[];
  /** Each path starts at the entry and ends at the builtin specifier. */
  importPaths: string[][];
}

/** Resolve the same workerd export branches as a Worker build, then inspect every reachable import. */
export async function refusedBuiltins(entry: string, flags: readonly string[]): Promise<RefusedWorkerImports> {
  const allowed = builtinsAllowedBy(flags);
  if (allowed === 'all') return { refused: [], importPaths: [] };
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*', ...builtinModules],
    loader: { '.html': 'text', '.txt': 'text', '.md': 'text', '.css': 'text', '.svg': 'text', '.wasm': 'binary' },
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const inputs = result.metafile.inputs;
  const entryPath = realpathSync(entry);
  const first = Object.keys(inputs).find((file) => realpathSync(resolve(file)) === entryPath);
  if (!first) throw new Error(`the Worker entry ${entry} was absent from its bundle graph`);

  const paths = new Map<string, string[]>([[first, [first]]]);
  const pending = [first];
  const refused = new Set<string>();
  const importPaths: string[][] = [];
  for (const file of pending) {
    for (const item of inputs[file]!.imports) {
      if (LOAD_KINDS.has(item.kind) &&
          (item.path.startsWith('node:') || BUILTINS.has(item.path)) && !allowed.has(item.path) &&
          !isKnownDeadWorkerRequire(file, item.path, item.kind)) {
        refused.add(item.path);
        importPaths.push([...paths.get(file)!, item.path]);
      } else if (!item.external && inputs[item.path] && !paths.has(item.path)) {
        paths.set(item.path, [...paths.get(file)!, item.path]);
        pending.push(item.path);
      }
    }
  }
  return { refused: [...refused].sort(), importPaths };
}

/** Shared diagnostic for repo lint, push, and push --check. */
export function workerNodeImportOffence(entry: string, flags: readonly string[], found: RefusedWorkerImports): string | undefined {
  if (!found.refused.length) return undefined;
  const root = process.cwd();
  // `/` on every OS, so the chain reads `src/worker.ts -> lib/x.js` in a Windows log too.
  const display = (path: string) =>
    path.startsWith('node:') || BUILTINS.has(path) ? path : relative(root, resolve(path)).split(sep).join('/');
  return `Worker ${display(entry)} with compatibility flags ${JSON.stringify(flags)} imports unsupported Node builtins: ${found.refused.join(', ')}\n` +
    found.importPaths.map((path) => `  ${path.map(display).join(' -> ')}`).join('\n') +
    '\nRemove the import or declare nodejs_compat for this Worker. Guarded imports have no general exception.';
}

export async function assertWorkerNodeImports(entry: string, flags: readonly string[]): Promise<void> {
  const offence = workerNodeImportOffence(entry, flags, await refusedBuiltins(entry, flags));
  if (offence) throw new Error(offence);
}
