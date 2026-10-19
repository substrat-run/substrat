/**
 * Paths a tool can use on Windows.
 *
 * `new URL('..', import.meta.url).pathname` is `/C:/...` there, and `existsSync`
 * on it is false, so a gate that roots itself that way scans nothing and passes.
 * `path.relative` returns backslashes, which never equal a forward-slash path
 * written in source.
 */
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, for a module that lives in `tools/`. */
export function repoRoot(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), '..');
}

/** Forward slashes, so a path compares with one written in source. */
export function toPosix(path) {
  return String(path).replaceAll('\\', '/');
}

/**
 * Was this module the script node was asked to run? Compared by real path on both sides: node
 * resolves the main module through symlinks, `process.argv[1]` keeps the path it was given, so a
 * plain compare is false through a symlinked checkout and the tool silently does nothing.
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}
