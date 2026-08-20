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
/**
 * Engines declare entities too, and since #844 they declare LIFECYCLES — the
 * state machines that used to live as hand-written guards in operation bodies.
 * A changed edge is exactly as consequential as a changed table, so it belongs
 * in the same reviewed artifact.
 *
 * Engines OPT IN by exporting an emitted model (`src/model.ts`). One that does
 * not is reported at the end rather than skipped in silence — the tool's whole
 * posture is that a checkpoint which checked nothing must never print green.
 */
const ENGINES = 'engines';
const check = process.argv.includes('--check');

interface EmittedModel {
  entities: Record<string, { table: string; fields: unknown }>;
  lifecycles?: Record<string, unknown>;
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
  let lifecycles = 0;

  for (const demo of demos) {
    // `spec/model.ts` is where a vertical built through the model phase declares
    // its entities; `src/entities.ts` is where the verticals that predate it do.
    // Looking only at the second silently skipped every vertical built the new
    // way — CI green over an entity model nobody reviewed, which is the failure
    // this tool exists to prevent.
    const candidates = [join(DEMOS, demo, 'spec', 'model.ts'), join(DEMOS, demo, 'src', 'entities.ts')];
    const src = candidates.find((c) => existsSync(c));
    if (!src) {
      // Same guard permission-diff carries: a directory that is clearly a
      // vertical but exposes no model must fail loudly, never be skipped.
      if (existsSync(join(DEMOS, demo, 'src', 'seed.ts'))) {
        console.error(
          `model-diff: ${DEMOS}/${demo} looks like a vertical (has src/seed.ts) but declares\n` +
            '  neither spec/model.ts nor src/entities.ts — it would be skipped and CI would go\n' +
            '  green over an entity model nobody reviewed.\n' +
            '  Remedy: declare its entities with `defineEntities` and export `emitModel(...)`.',
        );
        return 2;
      }
      continue; // not a vertical
    }

    const mod = (await import(pathToFileURL(join(process.cwd(), src)).href)) as Record<string, unknown>;
    const models = emittedModelIn(mod);
    if (models.length !== 1) {
      console.error(`model-diff: ${src} exports ${models.length} emitted models, expected exactly 1`);
      return 2;
    }

    lifecycles += Object.keys(models[0]?.lifecycles ?? {}).length;
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

  // Engines, same emit-and-diff, opting in through `src/model.ts`.
  const skipped: string[] = [];
  for (const engine of readdirSync(ENGINES).filter((d) => statSync(join(ENGINES, d)).isDirectory())) {
    const src = join(ENGINES, engine, 'src', 'model.ts');
    if (!existsSync(src)) {
      skipped.push(engine);
      continue;
    }
    const mod = (await import(pathToFileURL(join(process.cwd(), src)).href)) as Record<string, unknown>;
    const models = emittedModelIn(mod);
    if (models.length !== 1) {
      console.error(`model-diff: ${src} exports ${models.length} emitted models, expected exactly 1`);
      return 2;
    }
    lifecycles += Object.keys(models[0]?.lifecycles ?? {}).length;
    const rendered = `${JSON.stringify(models[0], null, 2)}\n`;
    const target = join(ENGINES, engine, 'model.json');
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
  if (skipped.length > 0) {
    // Named, not silent. These are the engines whose entities and state machines
    // are still described only in TypeScript nobody re-emits.
    console.log(`model-diff: ${skipped.length} engine(s) declare no src/model.ts — ${skipped.join(', ')}`);
  }

  if (emitted === 0) {
    // The whole point of the checkpoint is to be read. One that scanned nothing
    // and printed green would be worse than absent.
    console.error('model-diff: no vertical declares src/entities.ts — nothing to check');
    return 2;
  }

  if (drift > 0) return 1;
  console.log(
    `model-diff: ${emitted} model${emitted === 1 ? '' : 's'} ${check ? 'up to date' : 'emitted'}` +
      `, ${lifecycles} lifecycle${lifecycles === 1 ? '' : 's'}`,
  );
  return 0;
}

process.exit(await main());
