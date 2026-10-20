import { realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { relative, resolve } from 'node:path';
import { build } from 'esbuild';

const NODE_COMPAT = new Set(['nodejs_compat', 'nodejs_compat_v2']);
const ALS = new Set(['node:async_hooks', 'async_hooks']);
const BUILTINS = new Set(builtinModules);

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
      if ((item.kind === 'import-statement' || item.kind === 'dynamic-import') &&
          (item.path.startsWith('node:') || BUILTINS.has(item.path)) && !allowed.has(item.path)) {
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
  const display = (path: string) => path.startsWith('node:') || BUILTINS.has(path) ? path : relative(root, resolve(path));
  return `Worker ${display(entry)} with compatibility flags ${JSON.stringify(flags)} imports unsupported Node builtins: ${found.refused.join(', ')}\n` +
    found.importPaths.map((path) => `  ${path.map(display).join(' -> ')}`).join('\n') +
    '\nRemove the dependency on Node builtins or declare nodejs_compat for this Worker.';
}

export async function assertWorkerNodeImports(entry: string, flags: readonly string[]): Promise<void> {
  const offence = workerNodeImportOffence(entry, flags, await refusedBuiltins(entry, flags));
  if (offence) throw new Error(offence);
}
