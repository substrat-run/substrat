/**
 * Paths a tool can use on Windows.
 *
 * `new URL('..', import.meta.url).pathname` is `/C:/...` there, and `existsSync`
 * on it is false, so a gate that roots itself that way scans nothing and passes.
 * `path.relative` returns backslashes, which never equal a forward-slash path
 * written in source.
 */
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
