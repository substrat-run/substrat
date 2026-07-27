/**
 * The API-surface checkpoint (design/api-surface.md §2.4) — the D-22 "emitted
 * OAS, checked in, CI-diffed" promise, given the same mechanical home as the
 * permission diff.
 *
 * Renders each vertical's OpenAPI 3.1 document — built from its exported
 * operation catalog, which references the SAME Zod schemas its handlers parse —
 * into a checked-in `<vertical>/openapi.json`. CI re-emits with `--check` and
 * fails on drift, so an API-shape change cannot merge without appearing in the
 * PR diff.
 *
 * A vertical opts in by having `src/api.ts` export `API_DOCUMENT` (see
 * demos/meridian/src/api.ts — the reference). Opt-in, unlike the permission
 * tool's every-vertical sweep, because the fleet adopts incrementally
 * (api-surface.md §3); a vertical without a catalog simply is not documented
 * yet. The catalog/registration parity check lives in each api.ts itself and
 * runs at import — an undocumented operation fails HERE, not just at review.
 *
 * Deterministic by construction: the document is a pure function of the
 * catalog (no timestamp, no ULID), which is what lets string equality be the
 * drift check. Exit codes follow boundary-lint's: 0 = fine, 1 = drift,
 * 2 = the tool could not do its job.
 */
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const check = process.argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`api-diff: ${message}\n`);
  process.exit(2);
}

const verticals: { rel: string; dir: string }[] = [];
for (const group of ['demos', 'apps']) {
  const groupDir = join(root, group);
  let entries: string[];
  try {
    entries = readdirSync(groupDir);
  } catch {
    continue;
  }
  for (const n of entries) {
    const dir = join(groupDir, n);
    if (statSync(dir).isDirectory() && existsSync(join(dir, 'src/api.ts'))) {
      verticals.push({ rel: `${group}/${n}`, dir });
    }
  }
}
verticals.sort((a, b) => a.rel.localeCompare(b.rel));

if (verticals.length === 0) {
  cannot(
    `no vertical has a src/api.ts under demos/ or apps/.\n` +
      `  At least one (demos/meridian) is expected to export an operation catalog —\n` +
      `  a checkpoint that checks nothing must never print a green light.`,
  );
}

const drifted: string[] = [];
for (const { rel, dir } of verticals) {
  const mod = (await import(pathToFileURL(join(dir, 'src/api.ts')).href)) as {
    API_DOCUMENT?: Record<string, unknown>;
  };
  const doc = mod.API_DOCUMENT;
  if (!doc || doc['openapi'] !== '3.1.0') {
    cannot(
      `${rel}/src/api.ts exports no API_DOCUMENT (or not an OpenAPI 3.1 document).\n` +
        `  Remedy: export the buildOpenApiDocument(...) result as API_DOCUMENT —\n` +
        `  see demos/meridian/src/api.ts.`,
    );
  }
  const paths = doc['paths'] as Record<string, unknown> | undefined;
  if (!paths || Object.keys(paths).length === 0) {
    cannot(`${rel}: API_DOCUMENT has no paths — a spec over nothing is a green light over nothing.`);
  }

  const content = JSON.stringify(doc, null, 2) + '\n';
  const artifact = join(dir, 'openapi.json');

  if (!check) {
    writeFileSync(artifact, content);
    console.log(`api-diff: wrote ${rel}/openapi.json (${Object.keys(paths).length} operations)`);
    continue;
  }
  if (!existsSync(artifact)) {
    cannot(
      `${rel}/openapi.json does not exist.\n` +
        `  A missing artifact is a broken setup, not drift.\n` +
        `  Remedy: run \`pnpm lint:api\` and commit the result.`,
    );
  }
  if (readFileSync(artifact, 'utf8') !== content) drifted.push(rel);
}

if (check) {
  if (drifted.length) {
    console.error(
      `api-diff: API surface drift in ${drifted.join(', ')}.\n` +
        `  The exported operation catalog no longer matches the checked-in openapi.json.\n` +
        `  Run \`pnpm lint:api\` and commit the diff — that diff IS the review artifact.`,
    );
    process.exit(1);
  }
  console.log(`api-diff: ${verticals.length} vertical(s) clean`);
}
