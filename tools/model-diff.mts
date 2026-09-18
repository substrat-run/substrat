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
 * It also holds one rule that is not an artifact at all: every engine states its
 * COMPOSITION MODE in its own header (#976). See `checkEngineComposition` below
 * for why that lives here.
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
 *
 * The composition-mode header (#976) is NOT opt-in: every engine states it, and
 * `checkEngineComposition` refuses the ones that do not.
 */
const ENGINES = 'engines';
const check = process.argv.includes('--check');

interface EmittedModel {
  /**
   * An engine's `manifest.version` (#976). This artifact is the field's reader:
   * a bump appears in the checked-in `model.json`, so `--check` gates it the way
   * it gates a changed table. Verticals declare none and emit none.
   */
  version?: string;
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

/** The two spellings CLAUDE.md gives, and the only two an engine may state. */
const MODES = ['composed **by call**', 'composed **by event**'] as const;

/**
 * The header of a source file — its leading block comment, and nothing else.
 *
 * Read narrowly on purpose: "state it in the engine's header" is a claim a
 * reader meets on line 2, so a mention buried three hundred lines down beside
 * one operation does not satisfy it. Returns null when the file does not open
 * with a block comment, which is itself the violation.
 */
function headerOf(source: string): string | null {
  const body = source.replace(/^#!.*\n/, '').trimStart();
  if (!body.startsWith('/**')) return null;
  const end = body.indexOf('*/');
  return end === -1 ? null : body.slice(0, end + 2);
}

/**
 * Every engine states whether it is composed **by call** or **by event**, in its
 * own `src/index.ts` header (#976).
 *
 * CLAUDE.md has said so since the mode became a rule — *"Which mode an engine
 * is, is a fact about its exports; state it in the engine's header so an absence
 * reads as intent rather than an omission."* #1078 made all seven agree, and
 * then nothing held them there: the eighth engine could omit it and every gate
 * in the repo would stay green, which by this repo's own reckoning makes the
 * rule a defect rather than a convention.
 *
 * It lives in this tool rather than in one of its own because this is already
 * the checkpoint that reads every engine directory and already rides
 * `pnpm lint:model` in CI — a new gate would be a new workflow step for a rule
 * that fits inside an existing sweep.
 *
 * What it does NOT judge: which mode is the right one. That is a fact about the
 * engine's exports, and reading it off them would mean importing every engine
 * here (the cycle `emittedModelIn` exists to avoid). The gate holds the weaker,
 * mechanical half — the claim is present, and it is exactly one of the two — so
 * that an absence can never again read as an oversight.
 *
 * Returns one line per offending engine, plus how many engines were read —
 * which the summary prints, so a sweep that found no engines at all cannot look
 * the same as one that checked seven.
 */
function checkEngineComposition(): { checked: number; problems: string[] } {
  const problems: string[] = [];
  let checked = 0;
  for (const engine of readdirSync(ENGINES).filter((d) => statSync(join(ENGINES, d)).isDirectory())) {
    // A directory under `engines/` is an engine when it carries a package.json.
    // Anything else there is not one, and refusing it would be this tool
    // inventing a layout rule it has no business holding.
    if (!existsSync(join(ENGINES, engine, 'package.json'))) continue;
    checked += 1;
    const index = join(ENGINES, engine, 'src', 'index.ts');
    if (!existsSync(index)) {
      problems.push(`${ENGINES}/${engine} is an engine (has package.json) but declares no src/index.ts`);
      continue;
    }
    const header = headerOf(readFileSync(index, 'utf8'));
    if (header === null) {
      problems.push(`${index} opens with no header comment, so it can state no composition mode`);
      continue;
    }
    const stated = MODES.filter((m) => header.includes(m));
    if (stated.length === 1) continue;
    problems.push(
      stated.length === 0
        ? `${index} states no composition mode — its header must say ${MODES.join(' or ')}`
        : `${index} states BOTH ${MODES.join(' and ')} — an engine is one or the other`,
    );
  }
  return { checked, problems };
}

async function main(): Promise<number> {
  if (!existsSync(DEMOS)) {
    console.error(`model-diff: no ${DEMOS}/ directory — run from the repo root`);
    return 2;
  }
  // The engine sweep below has always assumed this; now that the composition
  // check reads the directory first, say so rather than throwing an ENOENT
  // stack at someone who ran the tool from the wrong place.
  if (!existsSync(ENGINES)) {
    console.error(`model-diff: no ${ENGINES}/ directory — run from the repo root`);
    return 2;
  }

  // Before anything is emitted: a rule violation is not drift, and re-running
  // the emitter cannot fix it, so it refuses with 2 the way "looks like a
  // vertical but declares no model" does — and it refuses in emit mode too,
  // because `pnpm lint:model` with no flag must not quietly write files over a
  // tree that breaks the rule the same command is about to be trusted for.
  const composition = checkEngineComposition();
  if (composition.problems.length > 0) {
    console.error(
      `model-diff: ${composition.problems.length} engine(s) do not state their composition mode (#976).\n` +
        composition.problems.map((p) => `  ${p}`).join('\n') +
        '\n  Remedy: open the engine header with e.g. `engine-<name> — composed **by call**, not by event.`\n' +
        '  Which one it is, is a fact about its exports: in-scope exports a vertical calls = by call;\n' +
        '  no in-scope exports, consumers only = by event (CLAUDE.md, "Module code rules").',
    );
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
    // `src/model.ts` sits between the two: a vertical whose emitted model carries
    // a LIFECYCLE cannot emit from `src/entities.ts`, because the lifecycle is
    // declared beside the operation map that imports the entities (#844).
    const candidates = [
      join(DEMOS, demo, 'spec', 'model.ts'),
      join(DEMOS, demo, 'src', 'model.ts'),
      join(DEMOS, demo, 'src', 'entities.ts'),
    ];
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
      `, ${lifecycles} lifecycle${lifecycles === 1 ? '' : 's'}` +
      `, ${composition.checked} engine composition mode${composition.checked === 1 ? '' : 's'} stated`,
  );
  return 0;
}

process.exit(await main());
