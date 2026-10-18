/**
 * Every module registration in the repo that carries migrations, grouped by the package that
 * ships it: each `demos/*` and `apps/*` that declares `substrat.permissions`, every engine on its
 * own (an engine composed by no vertical is still shipped), and — when asked — the scaffold
 * template, materialized the way `lint:schedule-sweeper` does.
 *
 * Shared by `lint:migration-fence` (replays them) and `lint:migration-ledger` (records what each
 * one authored), so the two gates judge the same set. Exits 2 on a registration it cannot load.
 *
 * Needs the build: it imports each engine from `dist`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReplayModule } from '../packages/kernel/dist/index.js';
import { syncTemplate } from './template-sync.mjs';

export type Registration = ReplayModule & { manifest: { id: string } };

export const isRegistration = (m: unknown): m is Registration =>
  typeof m === 'object' && m !== null && typeof (m as Registration).manifest?.id === 'string';

/** The template's permissions entry: it has no committed package.json (see lint:schedule-sweeper). */
const TEMPLATE_PERMISSIONS_ENTRY = 'src/provision.ts';

/** One package's registrations: `label` is its repo path (`demos/todo`), or `template`. */
export interface PackageRegistrations {
  readonly label: string;
  /** The file they were read from, relative to the package. */
  readonly entry: string;
  readonly modules: Registration[];
}

export async function registrations(tool: string, { template = true } = {}): Promise<PackageRegistrations[]> {
  const out: PackageRegistrations[] = [];
  const load = async (label: string, dir: string, entry: string): Promise<void> => {
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as { permissions?: { modules?: unknown[] } };
    const modules = mod.permissions?.modules;
    if (!Array.isArray(modules)) {
      console.error(`${tool}: ${join(dir, entry)} exports no \`permissions.modules\`; cannot read ${label}.`);
      process.exit(2);
    }
    out.push({ label, entry, modules: modules.filter(isRegistration) });
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
    out.push({ label: `engines/${name}`, entry: 'src/index.ts', modules: Object.values(mod).filter(isRegistration) });
  }
  if (template) await load('template', syncTemplate(), TEMPLATE_PERMISSIONS_ENTRY);
  return out;
}
