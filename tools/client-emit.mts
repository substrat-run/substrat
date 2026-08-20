#!/usr/bin/env tsx
/**
 * The browser-client checkpoint — a vertical's typed fetch client, emitted from its
 * model instead of written beside it.
 *
 * This file is the repo entry point: it finds the verticals that opted in, resolves the
 * exports their `package.json` names, writes or diffs the artifact. The rendering —
 * every Zod schema turned into a TypeScript type — lives in `@substrat-run/model-emit`
 * as `renderClient`, where it can be tested against schemas directly. `--check` catches
 * a client that fell behind its model; only a test catches a printer that has been
 * mis-spelling a union inside an array since the day it was written.
 *
 * ## What this replaces
 *
 * `demos/todo/app/src/api.ts` was 91 hand-written lines, and every fact in it already
 * existed in `spec/model.ts`. It was a second description of a declared thing, which is
 * the defect this repo already refuses everywhere else — the route table
 * (`mountOperations`), the OpenAPI document (`lint:api`), the permission surface
 * (`lint:permissions`), the migrations.
 *
 * It drifted the way a second description does. #811 declared `todo/list-items` paged
 * and #827 added two search reads; the client learned about none of them, so the app
 * rendered the first twenty items of a list as though that were the list, and shipped no
 * search at all. Nothing was red. Nothing could be — there was no gate over a file a
 * person maintained by remembering to.
 *
 * ## Opting in
 *
 * ```json
 * "substrat": {
 *   "client": {
 *     "model": "spec/model.ts",
 *     "entities": "todoEntities",
 *     "operations": "todoOperations",
 *     "out": "app/src/api.generated.ts",
 *     "name": "Todo"
 *   }
 * }
 * ```
 *
 * `model`, `entities` and `operations` also take lists — a vertical may split its model
 * across files, and one that composes engines names their operation bags and entities
 * too. A `model` entry that is not a path is a package specifier, resolved from the
 * VERTICAL's directory so pnpm's layout still refuses an undeclared import.
 *
 * Named rather than discovered by shape: two exports that both look like a bag of
 * entities is a coin flip, and a generator that guesses is one whose output nobody
 * trusts.
 *
 *   pnpm lint:client            re-emit every opted-in client
 *   pnpm lint:client --check    CI: exit 1 if an emitted client has drifted
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift, 2 = cannot run.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ClientEmitError,
  renderClient,
  type ClientConfig,
} from '../packages/model-emit/src/emit-client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`client-emit: ${message}\n`);
  process.exit(2);
}

/** What the emitter reads off an operation — a `defineOperations` entry or an `ApiCatalog` doc. */
interface HttpOp {
  readonly http?: { readonly method: string; readonly path: string };
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------


const opted: { rel: string; dir: string; config: ClientConfig }[] = [];
for (const group of ['demos', 'apps']) {
  const groupDir = join(ROOT, group);
  let names: string[];
  try {
    names = readdirSync(groupDir);
  } catch {
    continue;
  }
  for (const n of names.sort()) {
    const dir = join(groupDir, n);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      substrat?: { client?: Partial<ClientConfig> };
    };
    const client = pkg.substrat?.client;
    if (!client) continue;
    for (const field of ['model', 'entities', 'operations', 'out', 'name'] as const) {
      if (!client[field]) cannot(`${group}/${n}: substrat.client is missing \`${field}\``);
    }
    if (Array.isArray(client.operations) && client.operations.length === 0) {
      cannot(`${group}/${n}: substrat.client.operations is an empty list`);
    }
    opted.push({ rel: `${group}/${n}`, dir, config: client as ClientConfig });
  }
}

if (opted.length === 0) {
  cannot(
    `no vertical declares \`substrat.client\` in its package.json.\n` +
      `  demos/todo is expected to — a checkpoint that checks nothing must never print a green light.`,
  );
}

const drifted: string[] = [];
for (const { rel, dir, config } of opted) {
  const models = typeof config.model === 'string' ? [config.model] : config.model;
  /** Each model module, kept SEPARATE — see `resolve` below for why. */
  const loadedModules: { label: string; exports: Record<string, unknown> }[] = [];
  for (const relPath of models) {
    // A relative path is a file in this vertical; anything else is a package specifier,
    // which is how an engine's published schemas are reached. An engine declares its own
    // types and a vertical restating them is the defect this tool exists to remove, so
    // importing them is the only honest option.
    const isPath = relPath.startsWith('.') || relPath.startsWith('/') || /\.[mc]?tsx?$/.test(relPath);
    let loaded: Record<string, unknown>;
    if (isPath) {
      const modelPath = join(dir, relPath);
      if (!existsSync(modelPath)) {
        cannot(`${rel}: substrat.client.model names ${relPath}, which does not exist`);
      }
      loaded = (await import(pathToFileURL(modelPath).href)) as Record<string, unknown>;
    } else {
      try {
        // Resolved from the VERTICAL's directory, not this tool's. pnpm's symlinked
        // layout means a package is reachable only from something that declared it,
        // which is the property that makes an undeclared import fail here rather than
        // resolve off a hoisted copy at the root.
        const require = createRequire(join(dir, 'package.json'));
        loaded = (await import(pathToFileURL(require.resolve(relPath)).href)) as Record<string, unknown>;
      } catch (err) {
        cannot(
          `${rel}: substrat.client.model names the package '${relPath}', which would not import.\n` +
            `  ${(err as Error).message}\n` +
            `  Remedy: declare it as a dependency, or build it first.`,
        );
      }
    }
    loadedModules.push({ label: relPath, exports: loaded });
  }
  const modelLabel = models.join(' + ');

  /**
   * One configured export, found across the model modules.
   *
   * Deliberately NOT a merged namespace. Five modules share plenty of incidental
   * names — callout and engine-protocol both export an `instantiateProtocolInput`,
   * and they are genuinely different objects (callout pins `entityType` to the
   * literal `'workorder'`; the engine takes an `EntityRef`). A merge would have to
   * pick a winner for a name nobody asked about. So only the names the config
   * actually NAMES are resolved, and only those are refused when ambiguous — which
   * is where an ambiguity would really change the output.
   */
  const resolve = (name: string): unknown => {
    const hits = loadedModules.filter((m) => name in m.exports);
    if (hits.length === 0) return undefined;
    const first = hits[0]!;
    const conflicting = hits.slice(1).filter((m) => m.exports[name] !== first.exports[name]);
    if (conflicting.length) {
      cannot(
        `${rel}: '${name}' is exported by ${[first, ...conflicting].map((m) => m.label).join(' and ')}, ` +
          `with different values.\n` +
          `  Remedy: import it from one place, or rename one — a generated client must not\n` +
          `  depend on which module was read last.`,
      );
    }
    return first.exports[name];
  };
  const mod = new Proxy({} as Record<string, unknown>, { get: (_t, k: string) => resolve(k) });
  const entityBags = typeof config.entities === 'string' ? [config.entities] : config.entities;
  const entities: Record<string, unknown> = {};
  for (const bagName of entityBags) {
    const bag = mod[bagName] as Record<string, unknown> | undefined;
    if (!bag || typeof bag !== 'object') cannot(`${rel}: ${modelLabel} exports no \`${bagName}\``);
    for (const [name, def] of Object.entries(bag)) {
      if (entities[name] !== undefined && entities[name] !== def) {
        cannot(
          `${rel}: entity '${name}' is declared by two bags in substrat.client.entities.\n` +
            `  Remedy: name it once — an interface generated from whichever was read last is\n` +
            `  not a type anyone can rely on.`,
        );
      }
      entities[name] = def;
    }
  }

  // One bag or several, merged in declaration order. A name claimed twice is refused
  // rather than resolved: two bags disagreeing about one operation is a fact about the
  // model, and picking a winner here would hide it.
  const bags = typeof config.operations === 'string' ? [config.operations] : config.operations;
  const operations: Record<string, unknown> = {};
  const from = new Map<string, string>();
  for (const bagName of bags) {
    const bag = mod[bagName] as Record<string, unknown> | undefined;
    if (!bag || typeof bag !== 'object') cannot(`${rel}: ${modelLabel} exports no \`${bagName}\``);
    for (const [operation, op] of Object.entries(bag)) {
      const claimed = from.get(operation);
      if (claimed) {
        cannot(
          `${rel}: '${operation}' appears in both \`${claimed}\` and \`${bagName}\`.\n` +
            `  Remedy: bind it in one of them — two bindings for one operation is a route\n` +
            `  table that depends on which bag was read last.`,
        );
      }
      from.set(operation, bagName);
      operations[operation] = op;
    }
  }

  let content: string;
  try {
    content = renderClient(rel, config, modelLabel, entities, operations, mod);
  } catch (err) {
    // The library raises for anything the caller must fix — an unprintable schema, a
    // colliding method name, a stale override. It has no opinion about exit codes.
    if (err instanceof ClientEmitError) cannot(err.message);
    throw err;
  }
  const artifact = join(dir, config.out);

  if (!check) {
    writeFileSync(artifact, content);
    const count = Object.values(operations).filter((op) => (op as HttpOp)?.http).length;
    console.log(`client-emit: wrote ${rel}/${config.out} (${count} operations)`);
    continue;
  }
  if (!existsSync(artifact)) {
    cannot(
      `${rel}/${config.out} does not exist.\n` +
        `  A missing artifact is a broken setup, not drift.\n` +
        `  Remedy: run \`pnpm lint:client\` and commit the result.`,
    );
  }
  if (readFileSync(artifact, 'utf8') !== content) drifted.push(rel);
}

if (check) {
  if (drifted.length) {
    console.error(
      `client-emit: client drift in ${drifted.join(', ')}.\n` +
        `  The model no longer matches the checked-in client — this is the exact drift that\n` +
        `  left demos/todo's app unable to page or search after #811 and #827.\n` +
        `  Run \`pnpm lint:client\` and commit the diff.`,
    );
    process.exit(1);
  }
  console.log(`client-emit: ${opted.length} client(s) clean`);
}
