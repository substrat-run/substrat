#!/usr/bin/env tsx
/**
 * The platform's entry module (#1893) — what the control plane uploads in FRONT of every
 * vertical's bundle, so every deployed request is stamped by the platform rather than by
 * each vertical remembering to mount `invocationLog`.
 *
 * The bundle a vertical pushes is already built, so the entry cannot import the kernel at
 * run time: it has to be a self-contained module. It is built HERE, from the kernel's own
 * `withInvocationLog`, so there is one definition of the stamp — and emitted as a string
 * constant into `packages/control-plane-api/src/platform-entry.generated.ts`, which the
 * uploader writes into the upload with the vertical's entry name filled in.
 *
 * Beside it, the scope sweeper the uploader supplies to a vertical that declares schedules
 * and exports no sweeper of its own (#1902), built the same way from adapter-cloudflare's
 * `defineScopeSweeperDO`.
 *
 *   pnpm lint:platform-entry            re-emit from the kernel source
 *   pnpm lint:platform-entry --check    CI: exit 1 on drift (a kernel change not re-emitted)
 *
 * Kept small on purpose: the kernel files it pulls in import nothing at run time beyond
 * each other (`routed-node.ts` checks ids with a pattern rather than the contracts schemas
 * for exactly this reason), and a size ceiling below refuses a bundle that grew a runtime
 * dependency by accident — every byte here is added to every vertical's upload.
 */
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'packages/control-plane-api/src/platform-entry.generated.ts';
const SOURCE = 'packages/kernel/src/invocation-log.ts';
const PLACEHOLDER = '__SUBSTRAT_VERTICAL_ENTRY__';
const SWEEPER_SOURCE = 'packages/adapter-cloudflare/src/scope-sweeper-do.ts';
const SWEEP_HOST_SOURCE = 'packages/vertical-host/src/scope-sweep-host.ts';
/** The export the template and both hosted demos gave their own sweeper (#1902). */
const SWEEPER_CLASS = 'SweeperDO';
const SWEEPER_INTERVAL_MS = 120_000;
/** Refuse a bundle past this: it would mean a runtime dependency crept in. */
const CEILING_BYTES = 32_000;

const check = process.argv.includes('--check');

/** Bundle one self-contained ESM module from `contents`, with `external` left as imports. */
async function bundle(contents: string, sourcefile: string, external: string[]): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    external,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

function underCeiling(name: string, js: string, source: string): void {
  if (js.length <= CEILING_BYTES) return;
  console.error(
    `platform-entry: the ${name} bundles to ${js.length} bytes, past the ${CEILING_BYTES}-byte ceiling.\n` +
      `  Every byte is added to every vertical's upload. Something in ${source}'s import graph\n` +
      `  gained a runtime dependency — make it a type-only import, or keep it out of the platform's module.`,
  );
  process.exit(1);
}

const js = await bundle(
  [
    `import { withInvocationLog } from './${SOURCE}';`,
    `import * as vertical from '${PLACEHOLDER}';`,
    `export * from '${PLACEHOLDER}';`,
    // The same two answers every vertical gives \`readRoutedNode\`: the router's secret, which
    // the platform puts on every pushed script, and the local dev opt-out.
    `export default withInvocationLog(vertical.default, {`,
    `  routerSecret: (env) => env.ROUTER_SECRET,`,
    `  allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',`,
    `});`,
  ].join('\n'),
  'substrat-platform-entry.ts',
  [PLACEHOLDER],
);
underCeiling('entry', js, SOURCE);
if (!js.includes(PLACEHOLDER)) {
  console.error(`platform-entry: the bundle no longer names ${PLACEHOLDER}, so the uploader cannot fill it in.`);
  process.exit(2);
}

/**
 * The scope sweeper the platform supplies (#1902) to a vertical that declares schedules and
 * exports no sweeper of its own: adapter-cloudflare's `defineScopeSweeperDO`, with the same
 * interval and version accessor the template wired by hand, and the one thing it cannot be
 * given at build time — the vertical's host — read from the registry the vertical's own
 * `mountPlatformSurface` fills (`packages/vertical-host/src/scope-sweep-host.ts`).
 */
const sweeper = await bundle(
  [
    `import { defineScopeSweeperDO } from './${SWEEPER_SOURCE}';`,
    `import { registeredScopeSweepHost } from './${SWEEP_HOST_SOURCE}';`,
    `export const ${SWEEPER_CLASS} = defineScopeSweeperDO({`,
    `  intervalMs: ${SWEEPER_INTERVAL_MS},`,
    `  versionId: (env) => env.SUBSTRAT_VERSION_ID ?? null,`,
    `  host(env) {`,
    `    const hostFor = registeredScopeSweepHost();`,
    `    if (!hostFor) {`,
    `      throw new Error('this bundle registered no scope host for the platform sweeper: mount mountPlatformSurface from a current @substrat-run/vertical-host');`,
    `    }`,
    `    return hostFor(env);`,
    `  },`,
    // A pass that failed, or failed a unit, says so in the script's logs: nobody else is
    // watching a sweeper the vertical never wrote.
    `  onPass(outcome) {`,
    `    if ('error' in outcome || outcome.errors.length > 0) {`,
    `      console.error(JSON.stringify({ substrat: 'scope-sweep', ...outcome }));`,
    `    }`,
    `  },`,
    `});`,
  ].join('\n'),
  'substrat-platform-sweeper.ts',
  ['cloudflare:workers'],
);
underCeiling('sweeper', sweeper, SWEEPER_SOURCE);

const generated = `// GENERATED by tools/platform-entry-emit.mts from ${SOURCE} and ${SWEEPER_SOURCE} — do not edit by hand.
// Re-emit with \`pnpm lint:platform-entry\`; CI runs it with \`--check\`.

/**
 * The platform's entry module (#1893): uploaded in front of a vertical's bundle and made its
 * \`main_module\`, so every request the vertical serves is stamped (\`withInvocationLog\`) before
 * the vertical sees it. \`${PLACEHOLDER}\` is replaced with the bundle's own entry; its default
 * export is wrapped and every named export (Durable Object classes, entrypoints) passes through.
 */
export const PLATFORM_ENTRY_MODULE = 'substrat-platform-entry.js';

/** The import specifier the uploader replaces with \`./<the bundle's entry>\`. */
export const PLATFORM_ENTRY_PLACEHOLDER = '${PLACEHOLDER}';

/** The entry itself — ${js.length} bytes of ESM. */
export const PLATFORM_ENTRY_SOURCE: string = ${JSON.stringify(js)};

/**
 * The scope sweeper the platform supplies (#1902) — uploaded beside the entry, which
 * re-exports its class, when a vertical declares schedules and brings no sweeper of its own.
 */
export const PLATFORM_SWEEPER_MODULE = 'substrat-platform-sweeper.js';

/** The class it exports — the name the template and the demos always used, so a vertical that
 *  drops its own keeps the same Durable Object namespace, roster and alarm. */
export const PLATFORM_SWEEPER_CLASS = '${SWEEPER_CLASS}';

/** The sweeper itself — ${sweeper.length} bytes of ESM. */
export const PLATFORM_SWEEPER_SOURCE: string = ${JSON.stringify(sweeper)};
`;

const outPath = join(ROOT, OUT);
const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
if (current === generated) {
  console.log(`platform-entry: ${OUT} is current (entry ${js.length} bytes, sweeper ${sweeper.length} bytes).`);
  process.exit(0);
}
if (check) {
  console.error(
    `platform-entry: ${OUT} is not what ${SOURCE} builds to.\n` +
      `  The stamp or the sweeper the platform deploys verticals with changed without being re-emitted.\n` +
      `  Run \`pnpm lint:platform-entry\` and commit the result.`,
  );
  process.exit(1);
}
writeFileSync(outPath, generated);
console.log(`platform-entry: wrote ${OUT} (entry ${js.length} bytes, sweeper ${sweeper.length} bytes).`);
