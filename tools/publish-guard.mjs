#!/usr/bin/env node
/**
 * The `prepublishOnly` of every public package: refuse a publish pnpm is not running.
 *
 * `pnpm publish` rewrites `workspace:` and `catalog:` specifiers in the manifest it packs;
 * `npm publish` ships the source manifest as it stands, and npm cannot resolve either
 * protocol for anyone who installs it. That is how `@substrat-run/control-plane-client@0.1.0`
 * reached the registry and `npx @substrat-run/cli` stopped installing. Both publishers run
 * `prepublishOnly`, so the refusal sits at the one step every publish goes through —
 * including a package's first version, which is published by hand before its trusted
 * publisher can be configured.
 *
 * The publisher is read from `npm_execpath`, which each one sets to its own binary. NOT from
 * `npm_config_user_agent`: npm reads every `npm_config_*` variable as configuration, so an
 * `npm publish` started under a pnpm script inherits pnpm's user agent and would pass.
 *
 * `tools/publish-manifests.mjs` refuses a public package that does not declare this hook,
 * so a new package cannot opt out by omission.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The script every public package declares as `prepublishOnly` (each sits at `<dir>/<name>/`). */
export const PUBLISH_GUARD = 'node ../../tools/publish-guard.mjs';

/**
 * pnpm's entry points: the standalone binary (`pnpm`, and `pnpm.exe` on Windows — the winget and
 * standalone installs), or `pnpm.cjs` / `pnpm.js` under node (corepack, npm -g). Case-blind, as
 * Windows names files. Without `.exe` here, `pnpm release` on such a machine refused itself.
 */
const PNPM = /^pnpm(\.exe|\.c?js)?$/i;

/** Why a publish run by `execpath` (the `npm_execpath` value) must not proceed, or `null`. */
export function publisherProblem(execpath) {
  // Either separator: a Windows path's file name is read the same on every OS.
  const bin = execpath ? (execpath.split(/[\\/]/).pop() ?? '') : '';
  if (PNPM.test(bin)) return null;
  return (
    `refusing to publish with ${bin || 'an unknown client'}: only \`pnpm publish\` rewrites the workspace: ` +
    'and catalog: specifiers in package.json, and npm cannot resolve them for anyone who installs this ' +
    'package. Publish with `pnpm publish` from the package directory (or `pnpm release` from the root).'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problem = publisherProblem(process.env.npm_execpath);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
