/**
 * The entity model, made a reviewable artifact (#697).
 *
 * Renders each demo vertical's declared entities into a checked-in
 * `demos/<name>/model.json`. CI re-emits with `--check` and fails on drift, so a
 * changed table, a renamed field or a moved parent edge has to appear in the PR
 * diff rather than in a console nobody opens. Same shape as
 * `tools/permission-diff.mts`, and for the same reason.
 *
 * It reads the SAME object the manifest reads — each vertical exports
 * `calloutEntities`-shaped registries consumed by `manifestEntities` — so the
 * artifact cannot drift from what the vertical actually declares.
 *
 * **`model.json` is the artifact of record.** Everything downstream should read
 * it rather than the TypeScript: that is what keeps the authoring notation
 * swappable (#680), since a later change of authoring layer becomes a new
 * emitter writing this same file and nothing downstream notices.
 *
 * Deterministic by construction: `emitModel` sorts entities and their key and
 * erasable lists, and no ULID, timestamp or path can reach the output because
 * none is ever read.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint
 * firing), 2 = the tool could not do its job. A checkpoint that checked nothing
 * must never print a green light.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEMOS = 'demos';
const check = process.argv.includes('--check');

interface EmittedModel {
  entities: Record<string, { table: string; fields: unknown }>;
}

/**
 * The module's emitted model — the export shaped `{ entities: { <name>: { table,
 * fields } } }`. Read structurally, so this tool never imports the packages it
 * inspects (same rule as `tools/permission-diff.mts`, same reason: a cycle).
 */
function emittedModelIn(mod: Record<string, unknown>): EmittedModel[] {
  const out: EmittedModel[] = [];
  for (const value of Object.values(mod)) {
    if (!value || typeof value !== 'object') continue;
    const entities = (value as EmittedModel).entities;
    if (!entities || typeof entities !== 'object') continue;
    const rows = Object.values(entities);
    if (rows.length === 0) continue;
    if (rows.every((e) => !!e && typeof e === 'object' && typeof e.table === 'string' && 'fields' in e)) {
      out.push(value as EmittedModel);
    }
  }
  return out;
}

async function main(): Promise<number> {
  if (!existsSync(DEMOS)) {
    console.error(`model-diff: no ${DEMOS}/ directory — run from the repo root`);
    return 2;
  }

  const demos = readdirSync(DEMOS).filter((d) => statSync(join(DEMOS, d)).isDirectory());
  let drift = 0;
  let emitted = 0;

  for (const demo of demos) {
    const src = join(DEMOS, demo, 'src', 'entities.ts');
    if (!existsSync(src)) continue; // has not adopted the registry yet

    const mod = (await import(pathToFileURL(join(process.cwd(), src)).href)) as Record<string, unknown>;
    const models = emittedModelIn(mod);
    if (models.length !== 1) {
      console.error(`model-diff: ${src} exports ${models.length} emitted models, expected exactly 1`);
      return 2;
    }

    const rendered = `${JSON.stringify(models[0], null, 2)}\n`;
    const target = join(DEMOS, demo, 'model.json');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    emitted += 1;

    if (check) {
      if (current !== rendered) {
        console.error(`model-diff: ${target} is stale — re-run \`pnpm lint:model\` and commit the diff`);
        drift += 1;
      }
      continue;
    }
    if (current !== rendered) {
      writeFileSync(target, rendered);
      console.log(`model-diff: wrote ${target}`);
    }
  }

  if (emitted === 0) {
    // The whole point of the checkpoint is to be read. One that scanned nothing
    // and printed green would be worse than absent.
    console.error('model-diff: no vertical declares src/entities.ts — nothing to check');
    return 2;
  }

  if (drift > 0) return 1;
  console.log(`model-diff: ${emitted} model${emitted === 1 ? '' : 's'} ${check ? 'up to date' : 'emitted'}`);
  return 0;
}

process.exit(await main());
