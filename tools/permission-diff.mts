/**
 * The permission-diff human checkpoint (CLAUDE.md), made mechanical.
 *
 * Renders each demo vertical's permission surface — key → description → which
 * roles hold it — into a checked-in `demos/<name>/PERMISSIONS.md`. CI re-emits
 * with `--check` and fails on drift, so an agent that widens a role must show it
 * in the PR diff rather than in a console nobody opens.
 *
 * It reads the SAME objects the running host does: each vertical exports
 * `MODULES` (what `buildHost` registers) and `ROLES` (what `seed` defines), so
 * the artifact cannot drift from what is actually enforced. That is
 * `tools/boundary-lint.mjs`'s principle — the repo checks itself with the code
 * it ships — applied to permissions.
 *
 * Nothing here boots a host. Roles are tenant-agnostic constants and manifests
 * are exported consts, so the whole artifact is a pure function of code. That is
 * also why it is deterministic: no ULID, timestamp, or path can reach the output
 * because none is ever read.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint firing),
 * 2 = the tool could not do its job. A checkpoint that checked nothing must never
 * print a green light.
 *
 * `--root <dir>` targets ONE project instead of the sweep (#628). A vertical the
 * builder studio generates lives under `.builder/projects/*` — its own repo, not
 * a member of `demos/` or `apps/` — so the sweep never sees it, and the studio's
 * standalone permission gate was declared-and-skipped rather than run. Same
 * discovery (`substrat.permissions` in package.json), same render, same
 * string-equality drift check, same 0/1/2: the only difference is where the tool
 * looks. Deliberately mirrors `boundary-lint --root`, which solved the same
 * monorepo-sweep-versus-one-project problem first.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Structural shapes — deliberately not imported from the kernel. The tool needs
// four fields, and depending on the packages it inspects would be a cycle.
interface PermissionDecl {
  key: string;
  description: string;
}
interface ScheduleLike {
  operation: string;
  cadence?: { everyMinutes: number };
  permissions?: string[];
}
interface ModuleLike {
  manifest: { id: string; permissions: PermissionDecl[]; schedules?: ScheduleLike[] };
}
interface RoleLike {
  key: string;
  permissions: string[];
  source?: string; // moduleId | 'vertical' — required by roleDefinition; guarded below
}
interface EntityGrantLike {
  entityType: string;
  permissions: string[];
}
/** The normalised surface render()/collectRegistry() consume — unchanged by the discovery move. */
interface Surface {
  MODULES?: ModuleLike[];
  ROLES?: RoleLike[];
  ENTITY_GRANTS?: EntityGrantLike[];
}
/** What a vertical's declared entry (`substrat.permissions`) exports: a definePermissions() result. */
interface PermissionsLike {
  modules?: ModuleLike[];
  roles?: RoleLike[];
  entityGrants?: EntityGrantLike[];
}
interface VerticalModule {
  permissions?: PermissionsLike;
}

const root = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const check = argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`permission-diff: ${message}\n`);
  process.exit(2);
}

const rootFlag = argv.indexOf('--root');
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && (!rootArg || rootArg.startsWith('--'))) {
  cannot(`--root needs a directory.\n  Usage: permission-diff [--root <dir>] [--check]`);
}
/** Absolute path of the one project to render, or undefined for the demos/+apps/ sweep. */
const projectDir = rootArg === undefined ? undefined : resolve(rootArg);

/**
 * The command that regenerates ONE artifact — a fact about where that project
 * sits, deliberately NOT about how this run was invoked.
 *
 * `pnpm lint:permissions` is the demos/+apps/ sweep and does not reach a project
 * outside it, so printing it in a standalone project's PERMISSIONS.md would name
 * a remedy that regenerates every OTHER vertical and leaves this one drifted. But
 * keying it off the `--root` flag instead would make `--root demos/todo` render a
 * different header than the sweep does for the same vertical — a self-inflicted
 * drift report. Location it is: a repo vertical always says `pnpm
 * lint:permissions`, whichever way the tool was called.
 */
function regenerateFor(dir: string): string {
  const rel = relative(root, dir);
  if (/^(demos|apps)\/[^/]+$/.test(rel)) return 'pnpm lint:permissions';
  return `pnpm exec tsx tools/permission-diff.mts --root ${rootArg ?? rel}`;
}

/** The command to rerun THIS invocation, for the diagnostics below. */
const rerun =
  rootArg === undefined
    ? 'pnpm lint:permissions'
    : `pnpm exec tsx tools/permission-diff.mts --root ${rootArg}`;

const byKey = <T extends { key: string }>(a: T, b: T) => a.key.localeCompare(b.key);
const sorted = (keys: string[]) => [...keys].sort((a, b) => a.localeCompare(b));
const code = (s: string) => `\`${s}\``;

/**
 * `rel` is how this vertical is NAMED in a diagnostic — `demos/callout`, or the
 * `--root` path. `regenerate` is the command its header tells a reader to run.
 */
function render(rel: string, pkg: string, src: Surface, regenerate: string): string {
  const modules = src.MODULES ?? [];
  const roles = [...(src.ROLES ?? [])].sort(byKey);
  const grants = [...(src.ENTITY_GRANTS ?? [])].sort((a, b) =>
    a.entityType.localeCompare(b.entityType),
  );

  // An explicitly EMPTY surface — no modules, no roles, no grant shapes — is a standalone
  // vertical (the auth-server shape): its authorization lives outside Substrat permissions,
  // and `definePermissions({ modules: [], roles: [] })` is its deliberate declaration (D-41:
  // explicit emptiness, never silent absence). It still gets a checked-in artifact, so the
  // first module or role it ever grows lands in a reviewed diff like everyone else's.
  if (modules.length === 0 && roles.length === 0 && grants.length === 0) {
    return [
      `<!-- GENERATED by tools/permission-diff.mts — do not edit by hand.`,
      `     Regenerate: ${regenerate}`,
      `     HUMAN CHECKPOINT (CLAUDE.md): an agent may never self-approve a change to this`,
      `     file. Reviewer: this vertical declares NO permission surface — any key or role`,
      `     appearing here is the risk surface. -->`,
      ``,
      `# Permission snapshot — ${pkg}`,
      ``,
      `0 keys · 0 modules · 0 roles`,
      ``,
      `## No permission surface`,
      ``,
      `This vertical declares an explicitly empty surface`,
      `(\`definePermissions({ modules: [], roles: [] })\`): it registers no kernel modules and`,
      `stamps no role templates, so there are no permission keys to review. Its authorization`,
      `is enforced outside Substrat permissions (a standalone app's own auth).`,
      ``,
    ].join('\n');
  }

  // The registry: every key a registered manifest declares.
  const declaredBy = new Map<string, { description: string; modules: string[] }>();
  for (const m of modules) {
    for (const p of m.manifest.permissions) {
      const seen = declaredBy.get(p.key);
      if (seen) seen.modules.push(m.manifest.id);
      else declaredBy.set(p.key, { description: p.description, modules: [m.manifest.id] });
    }
  }
  if (declaredBy.size === 0) {
    cannot(
      `${rel} registers ${modules.length} module(s) declaring zero permissions.\n` +
        `  A permission snapshot over an empty registry is a green light over nothing.\n` +
        `  Remedy: check that the modules in ${rel}'s permissions entry are the array buildHost registers.`,
    );
  }

  // Orphans: a role or grant citing a key no manifest declares. Today this fails
  // nowhere — the check just silently denies, forever. Here it is exit 2.
  const orphans: string[] = [];
  for (const r of roles) {
    for (const p of r.permissions) {
      if (!declaredBy.has(p)) orphans.push(`role ${code(r.key)} → ${code(p)}`);
    }
  }
  for (const g of grants) {
    for (const p of g.permissions) {
      if (!declaredBy.has(p)) orphans.push(`grant on ${code(g.entityType)} → ${code(p)}`);
    }
  }
  // A schedule's declared permissions become a system-principal grant (#383); an
  // undeclared key there denies the scheduled operation silently, same as a role.
  for (const m of modules) {
    for (const s of m.manifest.schedules ?? []) {
      for (const p of s.permissions ?? []) {
        if (!declaredBy.has(p)) orphans.push(`schedule ${code(s.operation)} → ${code(p)}`);
      }
    }
  }
  if (orphans.length) {
    cannot(
      `${rel} references ${orphans.length} permission key(s) no registered manifest declares:\n` +
        orphans.map((o) => `    ${o}`).join('\n') +
        `\n\n  A check against an undeclared key denies silently at runtime, forever — it never\n` +
        `  throws, so no test catches it. Fix the typo, or declare the key in the owning\n` +
        `  module's manifest.`,
    );
  }

  const holders = new Map<string, string[]>();
  for (const r of roles) for (const p of r.permissions) holders.set(p, [...(holders.get(p) ?? []), r.key]);

  const registry = [...declaredBy.entries()].map(([key, v]) => ({ key, ...v })).sort(byKey);
  const out: string[] = [];

  out.push(
    `<!-- GENERATED by tools/permission-diff.mts — do not edit by hand.`,
    `     Regenerate: ${regenerate}`,
    `     HUMAN CHECKPOINT (CLAUDE.md): an agent may never self-approve a change to this`,
    `     file. Reviewer: §3 is the risk surface — a key gaining a role. -->`,
    ``,
    `# Permission snapshot — ${pkg}`,
    ``,
    `${registry.length} keys · ${modules.length} modules · ${roles.length} roles`,
    ``,
    `## 1. Registry — every key a registered manifest declares`,
    ``,
    `| Key | Description | Declared by |`,
    `| --- | --- | --- |`,
    ...registry.map((r) => `| ${code(r.key)} | ${r.description} | ${r.modules.map(code).join(', ')} |`),
    ``,
    `## 2. Roles — as defined by this vertical's provisioning code`,
    ``,
    `Identical in every tenant. Per-tenant customisation is a runtime concern.`,
    ``,
    `| Role | Permissions |`,
    `| --- | --- |`,
    ...roles.map((r) => `| ${code(r.key)} | ${sorted(r.permissions).map(code).join(', ')} |`),
    ``,
    `## 3. Coverage — which roles hold each key`,
    ``,
    `| Key | Held by |`,
    `| --- | --- |`,
    ...registry.map((r) => {
      const held = holders.get(r.key);
      return `| ${code(r.key)} | ${held ? sorted(held).map(code).join(', ') : '— no role —'} |`;
    }),
    ``,
  );

  let section = 4;
  if (grants.length) {
    out.push(
      `## ${section}. Entity-narrowed grant shapes`,
      ``,
      `Reachable WITHOUT a role, narrowed to one entity per principal. A key held by`,
      `no role in §3 but listed here is deliberate, not a gap.`,
      ``,
      `| Entity type | Permissions granted per entity |`,
      `| --- | --- |`,
      ...grants.map((g) => `| ${code(g.entityType)} | ${sorted(g.permissions).map(code).join(', ')} |`),
      ``,
    );
    section += 1;
  }

  // §_. Scheduled work (#383): each declared schedule and the permissions its
  // module's SYSTEM principal holds to run it. Widening a schedule's authority
  // lands here, in the reviewed diff.
  const schedules = modules
    .flatMap((m) => (m.manifest.schedules ?? []).map((s) => ({ module: m.manifest.id, ...s })))
    .sort((a, b) => a.operation.localeCompare(b.operation));
  if (schedules.length) {
    out.push(
      `## ${section}. Scheduled work — the system principal's grants`,
      ``,
      `Each runs on the platform sweep, under \`system:<module>\`, on the cadence shown.`,
      `The permissions are what that system principal is granted at provisioning — a`,
      `schedule can do exactly this and no more.`,
      ``,
      `| Operation | Cadence | System principal | Permissions |`,
      `| --- | --- | --- | --- |`,
      ...schedules.map(
        (s) =>
          `| ${code(s.operation)} | ${s.cadence ? `every ${s.cadence.everyMinutes} min` : '—'} | ${code(`system:${s.module}`)} | ${sorted(s.permissions ?? []).map(code).join(', ') || '— none —'} |`,
      ),
      ``,
    );
    section += 1;
  }

  out.push(
    `## ${section}. Not covered by this artifact`,
    ``,
    `- **The grants themselves** — per-principal, per-entity, minted at runtime with`,
    `  random ULIDs. Only their shapes above are representable deterministically.`,
    `- **Operator-defined roles** — roles created against a live deployment. This`,
    `  artifact covers provisioning code only.`,
    ``,
  );
  return out.join('\n');
}

// Verticals live in demos/ (demo verticals) AND apps/ (real platform verticals —
// e.g. apps/dashboard, the platform vertical). A vertical declares WHERE its permission
// surface lives via package.json `substrat.permissions` — a path to the module exporting a
// `definePermissions(...)` result. Discovery keys off that declared pointer, not a magic
// `src/seed.ts` re-export, so the location is a code fact rather than a naming convention.
interface Vertical {
  rel: string;
  dir: string;
  entry: string;
  pkg: string;
}

/** The declared entry of one project directory, or `undefined` when it declares none. */
function declaredEntry(dir: string, rel: string): Vertical | undefined {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name?: string;
    substrat?: { permissions?: string };
  };
  const entry = pkgJson.substrat?.permissions;
  if (!entry) return undefined;
  return { rel, dir, entry, pkg: pkgJson.name ?? rel };
}

const verticals: Vertical[] = [];
if (projectDir !== undefined) {
  // `--root`: exactly one project, named by the path the caller gave. No sweep, so
  // there is no "skipped silently" hazard to guard — the caller asked for THIS one,
  // and every way it cannot be rendered is an exit 2 below.
  const rel = rootArg!;
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    cannot(`--root ${rel} is not a directory.`);
  }
  const one = declaredEntry(projectDir, rel);
  if (!one) {
    cannot(
      `${rel} declares no \`substrat.permissions\` in package.json.\n` +
        `  Rendering nothing and exiting 0 would be a green light over a permission surface\n` +
        `  nobody reviewed.\n` +
        `  Remedy: add \`"substrat": { "permissions": "src/provision.ts" }\` pointing at the\n` +
        `  module that exports \`definePermissions(...)\`. See demos/callout.`,
    );
  }
  verticals.push(one);
} else {
  // Verticals live in demos/ (demo verticals) AND apps/ (real platform verticals —
  // e.g. apps/dashboard, the platform vertical). A vertical declares WHERE its permission
  // surface lives via package.json `substrat.permissions` — a path to the module exporting a
  // `definePermissions(...)` result. Discovery keys off that declared pointer, not a magic
  // `src/seed.ts` re-export, so the location is a code fact rather than a naming convention.
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
      if (!statSync(dir).isDirectory()) continue;
      const one = declaredEntry(dir, `${group}/${n}`);
      if (!one) {
        // A package that looks like a vertical (has a seed) but declares no permissions entry
        // would vanish from the checkpoint — worse than no checkpoint. Fail loudly, don't skip.
        if (existsSync(join(dir, 'src/seed.ts'))) {
          cannot(
            `${group}/${n} looks like a vertical (has src/seed.ts) but declares no\n` +
              `  \`substrat.permissions\` in package.json — it would be skipped and CI would go\n` +
              `  green over a permission surface nobody reviewed.\n` +
              `  Remedy: add \`"substrat": { "permissions": "src/provision.ts" }\` pointing at the\n` +
              `  module that exports \`definePermissions(...)\`. See demos/callout.`,
          );
        }
        continue;
      }
      verticals.push(one);
    }
  }
  verticals.sort((a, b) => a.rel.localeCompare(b.rel));

  if (verticals.length === 0) cannot(`no package under demos/ or apps/ declares substrat.permissions.`);
}

const drifted: string[] = [];
for (const { rel, dir, entry, pkg } of verticals) {
  const mod = (await import(pathToFileURL(join(dir, entry)).href)) as VerticalModule;
  const surface = mod.permissions;
  // The vacuity plug: a declared entry that exports no `permissions` (or an empty one) would
  // render a green light over nothing.
  if (!surface || !surface.modules || !surface.roles) {
    cannot(
      `${rel}/${entry} exports no \`permissions\` (a definePermissions() result).\n` +
        `  Without it this vertical is skipped and CI goes green over a permission surface\n` +
        `  nobody reviewed — worse than having no checkpoint at all.\n` +
        `  Remedy: export \`const permissions = definePermissions({ modules, roles, entityGrants })\`.\n` +
        `  See demos/callout/src/provision.ts.`,
    );
  }
  // Normalise to the shape render()/collectRegistry() already consume, so their output — and
  // therefore both artifacts — is byte-identical to the pre-migration seed.ts discovery.
  const src: Surface = {
    MODULES: surface.modules,
    ROLES: surface.roles,
    ENTITY_GRANTS: surface.entityGrants ?? [],
  };

  // The human snapshot (PERMISSIONS.md) is the one checked-in artifact — the review surface for
  // the permission checkpoint. The machine-readable registry is no longer committed (D-41):
  // `substrat push` derives it from the same `permissions` entry via `buildPermissionRegistry`,
  // so there is no generated JSON in git to keep in sync.
  const artifacts: { path: string; content: string }[] = [
    { path: join(dir, 'PERMISSIONS.md'), content: render(rel, pkg, src, regenerateFor(dir)) },
  ];

  for (const { path, content } of artifacts) {
    // Repo-relative in the sweep; relative to where the caller stands in `--root`
    // mode, where the project is not under this repo's root at all.
    const shown = projectDir === undefined ? path.slice(root.length) : relative(process.cwd(), path);
    if (!check) {
      writeFileSync(path, content);
      continue;
    }
    if (!existsSync(path)) {
      cannot(
        `${shown} does not exist.\n` +
          `  A missing artifact is a broken setup, not drift.\n` +
          `  Remedy: ${rerun} && git add ${shown}`,
      );
    }
    if (readFileSync(path, 'utf8') !== content) drifted.push(shown);
  }
}

if (drifted.length) {
  console.error(`permission-diff: ${drifted.length} artifact(s) out of date\n`);
  for (const path of drifted) console.error(`  ✗ ${path}`);
  console.error(
    `\n  The permission surface changed and the checkpoint was not regenerated.\n` +
      `  Run: ${rerun} — then READ the diff. Someone must approve it.\n`,
  );
  process.exit(1);
}

console.log(
  check
    ? `permission-diff: ${verticals.length} snapshot(s) match`
    : `permission-diff: wrote ${verticals.length} snapshot(s)`,
);
