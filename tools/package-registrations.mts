/**
 * Every module registration in the repo, grouped by the package that ships it: each `demos/*`
 * and `apps/*` that declares `substrat.permissions`, every engine on its own (an engine composed
 * by no vertical is still shipped), and — when asked — the scaffold template, materialized the
 * way `lint:schedule-sweeper` does.
 *
 * The one loader the gates that judge a package's registrations share — `lint:migration-fence`,
 * `lint:migration-ledger`, `lint:operation-tests`, `lint:entity-check-adoption` — so they judge
 * the same set, and agree which package owns a module. Exits 2 on a registration it cannot load.
 *
 * Needs the build: it imports each engine from `dist`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReplayModule } from '../packages/kernel/dist/index.js';
import { baseCommit } from './export-schema-diff.mts';
import { syncTemplate } from './template-sync.mjs';

export type Registration = ReplayModule & { manifest: { id: string } };

const isRegistration = (m: unknown): m is Registration =>
  typeof m === 'object' && m !== null && typeof (m as Registration).manifest?.id === 'string';

/** The template's permissions entry: it has no committed package.json (see lint:schedule-sweeper). */
const TEMPLATE_PERMISSIONS_ENTRY = 'src/provision.ts';

/** One package's registrations: `label` is its repo path (`demos/todo`), or `template`. */
export interface PackageRegistrations {
  readonly label: string;
  /** The file they were read from, relative to the package. */
  readonly entry: string;
  /** Every module it registers, composed engines included, in host order. */
  readonly modules: Registration[];
  /**
   * The modules the package itself ships: for a vertical, its registrations less every module an
   * engine ships (those belong to the engine's package); for an engine, all of them.
   */
  readonly own: Registration[];
}

export async function registrations(tool: string, { template = true } = {}): Promise<PackageRegistrations[]> {
  const loaded: { label: string; entry: string; modules: Registration[] }[] = [];
  const load = async (label: string, dir: string, entry: string): Promise<void> => {
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as { permissions?: { modules?: unknown[] } };
    const modules = mod.permissions?.modules;
    if (!Array.isArray(modules)) {
      console.error(`${tool}: ${join(dir, entry)} exports no \`permissions.modules\`; cannot read ${label}.`);
      process.exit(2);
    }
    loaded.push({ label, entry, modules: modules.filter(isRegistration) });
  };
  for (const root of ['demos', 'apps']) {
    for (const name of readdirSync(root).sort()) {
      const pkg = join(root, name, 'package.json');
      if (!existsSync(pkg)) continue;
      const entry = (JSON.parse(readFileSync(pkg, 'utf8')) as { substrat?: { permissions?: unknown } }).substrat?.permissions;
      if (typeof entry === 'string' && entry.trim() !== '') await load(`${root}/${name}`, join(process.cwd(), root, name), entry);
    }
  }
  for (const name of readdirSync('engines').sort()) {
    const dist = join(process.cwd(), 'engines', name, 'dist', 'index.js');
    if (!existsSync(dist)) {
      console.error(`${tool}: engines/${name} is not built (${dist}); run the build first.`);
      process.exit(2);
    }
    const mod = (await import(pathToFileURL(dist).href)) as Record<string, unknown>;
    loaded.push({ label: `engines/${name}`, entry: 'src/index.ts', modules: Object.values(mod).filter(isRegistration) });
  }
  if (template) await load('template', syncTemplate(), TEMPLATE_PERMISSIONS_ENTRY);
  const isEngine = (label: string): boolean => label.startsWith('engines/');
  const engineModules = new Set(loaded.filter((p) => isEngine(p.label)).flatMap((p) => p.modules.map((m) => m.manifest.id)));
  return loaded.map((p) => ({ ...p, own: isEngine(p.label) ? p.modules : p.modules.filter((m) => !engineModules.has(m.manifest.id)) }));
}

const TEST_FILE = /\.(?:test|spec)\.[mc]?[jt]sx?$/;

/** Every test file under `dir`: a `*.test.*` / `*.spec.*` anywhere, or any source under `test/`. */
export function testFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, underTest: boolean): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, underTest || ['test', 'tests', '__tests__'].includes(entry.name));
      else if (TEST_FILE.test(entry.name) || (underTest && /\.[mc]?[jt]sx?$/.test(entry.name))) out.push(full);
    }
  };
  walk(dir, false);
  return out;
}

/**
 * The `--base <ref>` a gate was given, resolved to its merge-base with HEAD (`baseCommit`, the
 * rule `lint:export-schemas` judges by): `undefined` without the flag, exit 2 when the ref is
 * missing or not in this checkout. The merge-base, not the ref's tip, so a commit the base gained
 * after this branch left it is never read as something this branch removed.
 */
export function baseFromArgv(tool: string, argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--base');
  if (at === -1) return undefined;
  const ref = argv[at + 1];
  try {
    if (!ref || ref.startsWith('--')) throw new Error('--base needs a ref');
    return baseCommit(ref, process.cwd());
  } catch (err) {
    console.error(`${tool}: cannot run — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
