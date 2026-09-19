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
 * `--root <dir>` emits ONE project's `model.json` instead of the sweep (#684). A
 * vertical the builder studio generates lives under `.builder/projects/*` — its
 * own repo, not a member of `demos/`, so the sweep never sees it and its entity
 * model existed only as TypeScript nobody could render. Same sources, same
 * deterministic render, same 0/1/2: the only difference is where the tool looks.
 * Deliberately mirrors `permission-diff --root` and `boundary-lint --root`, which
 * solved the same monorepo-sweep-versus-one-project problem first. The engine
 * sweep and the composition check are the sweep's business and do not run in this
 * mode — a standalone project has no `engines/` to read.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint
 * firing), 2 = the tool could not do its job. A checkpoint that checked nothing
 * must never print a green light.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEMOS = 'demos';

/**
 * Where a vertical declares its entities, in the order the tool prefers.
 *
 * `spec/model.ts` is where a vertical built through the model phase declares
 * them; `src/entities.ts` is where the verticals that predate it do. `src/model.ts`
 * sits between the two: a vertical whose emitted model carries a LIFECYCLE cannot
 * emit from `src/entities.ts`, because the lifecycle is declared beside the
 * operation map that imports the entities (#844).
 */
const MODEL_SOURCES = ['spec/model.ts', 'src/model.ts', 'src/entities.ts'] as const;

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
const argv = process.argv.slice(2);
const check = argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`model-diff: ${message}\n`);
  process.exit(2);
}

const rootFlag = argv.indexOf('--root');
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && (!rootArg || rootArg.startsWith('--'))) {
  cannot('--root needs a directory.\n  Usage: model-diff [--root <dir>] [--check]');
}

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

/**
 * Emit — or, under `--check`, compare — ONE artifact: import `src`, take its
 * single emitted model, and render it to `target`.
 *
 * `regenerate` is the command the drift diagnostic tells a reader to run, and it
 * is a fact about where the artifact sits rather than about how this run was
 * invoked: a repo vertical always says `pnpm lint:model`, a project outside the
 * sweep says the `--root` form.
 */
async function emitArtifact(
  src: string,
  target: string,
  regenerate: string,
): Promise<{ drifted: boolean; lifecycles: number }> {
  const mod = (await import(pathToFileURL(resolve(src)).href)) as Record<string, unknown>;
  const models = emittedModelIn(mod);
  if (models.length !== 1) {
    cannot(`${src} exports ${models.length} emitted models, expected exactly 1`);
  }
  const model = models[0]!;
  const lifecycles = Object.keys(model.lifecycles ?? {}).length;
  const rendered = `${JSON.stringify(model, null, 2)}\n`;
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;

  if (check) {
    if (current !== rendered) {
      console.error(`model-diff: ${target} is stale — re-run \`${regenerate}\` and commit the diff`);
      return { drifted: true, lifecycles };
    }
    return { drifted: false, lifecycles };
  }
  if (current !== rendered) {
    writeFileSync(target, rendered);
    console.log(`model-diff: wrote ${target}`);
  }
  return { drifted: false, lifecycles };
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
 *
 * Any block comment counts — `/*` as well as the JSDoc `/**` every engine
 * happens to use today. The rule is about the mode being stated where a reader
 * meets it, not about which comment syntax states it, and a gate that refused
 * a plain block comment would be refusing something the rule permits.
 */
function headerOf(source: string): string | null {
  const body = source.replace(/^#!.*\n/, '').trimStart();
  if (!body.startsWith('/*')) return null;
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

/**
 * `--root <dir>`: exactly one project, named by the path the caller gave. No
 * sweep, so there is no "skipped silently" hazard to guard — the caller asked for
 * THIS one, and every way it cannot be rendered is an exit 2.
 */
async function one(rel: string): Promise<number> {
  const dir = resolve(rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    cannot(`--root ${rel} is not a directory.`);
  }
  const src = MODEL_SOURCES.map((c) => join(dir, c)).find((c) => existsSync(c));
  if (!src) {
    cannot(
      `${rel} declares no entity model — none of ${MODEL_SOURCES.join(', ')} exists there.\n` +
        '  Emitting nothing and exiting 0 would be a green light over an entity model nobody reviewed.\n' +
        '  Remedy: declare the entities with `defineEntities` and export `emitModel(...)` from spec/model.ts.',
    );
  }
  const { drifted, lifecycles } = await emitArtifact(
    src,
    join(dir, 'model.json'),
    `pnpm exec tsx tools/model-diff.mts --root ${rel}`,
  );
  if (drifted) return 1;
  console.log(
    `model-diff: ${rel} model ${check ? 'up to date' : 'emitted'}` +
      `, ${lifecycles} lifecycle${lifecycles === 1 ? '' : 's'}`,
  );
  return 0;
}

async function main(): Promise<number> {
  // One project, before any of the sweep's repo-root assumptions: a standalone
  // vertical has no demos/ and no engines/, and holding it to their existence
  // would refuse exactly the project this mode exists to serve.
  if (rootArg !== undefined) return await one(rootArg);

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
    // Looking only at `src/entities.ts` silently skipped every vertical built the
    // new way — CI green over an entity model nobody reviewed, which is the
    // failure this tool exists to prevent. See MODEL_SOURCES for the order.
    const src = MODEL_SOURCES.map((c) => join(DEMOS, demo, c)).find((c) => existsSync(c));
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

    const out = await emitArtifact(src, join(DEMOS, demo, 'model.json'), 'pnpm lint:model');
    lifecycles += out.lifecycles;
    emitted += 1;
    if (out.drifted) drift += 1;
  }

  // Engines, same emit-and-diff, opting in through `src/model.ts`.
  const skipped: string[] = [];
  for (const engine of readdirSync(ENGINES).filter((d) => statSync(join(ENGINES, d)).isDirectory())) {
    const src = join(ENGINES, engine, 'src', 'model.ts');
    if (!existsSync(src)) {
      skipped.push(engine);
      continue;
    }
    const out = await emitArtifact(src, join(ENGINES, engine, 'model.json'), 'pnpm lint:model');
    lifecycles += out.lifecycles;
    emitted += 1;
    if (out.drifted) drift += 1;
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
