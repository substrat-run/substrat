#!/usr/bin/env tsx
/**
 * The dev-server checkpoint — one declared topology, one emitted client file (#752).
 *
 * Claude Desktop starts a project's dev servers from `.claude/launch.json`, opens
 * them in the Browser pane, and with `autoVerify` on takes screenshots and reads
 * server logs after every edit. That matters here more than for most projects: our
 * scenario tests compose the host directly and never touch `server.ts`, so the HTTP
 * layer is precisely the part a green suite says nothing about — and the Browser
 * pane is the reliable way to drive it.
 *
 * ## Why this is emitted rather than written
 *
 * `.claude/launch.json` is an adapter, and design/agent-surface.md §3 is explicit
 * that an adapter may route, describe and trigger but may never hold substance.
 * Hand-authoring one per demo would put the dev topology — commands, env, and up to
 * three ports — in a client-specific file, as a fourth copy of facts that already
 * live in `package.json`'s `dev` script, `src/server.ts` and `app/vite.config.ts`.
 *
 * So the topology is declared once in the `substrat.devServers` block of each
 * project's package.json — the same neutral block `substrat push` and the
 * SessionStart hook already read — and this emits the client file from it. §6's
 * table calls this shape correctly: two copies that must read IDENTICALLY get a
 * regenerate-and-diff, like lint:permissions, lint:model, lint:api and
 * lint:agent-rules, not a hash baseline.
 *
 * ## The port is never declared
 *
 * A declaration carries `portEnv` + `portFrom` — which env var moves the port, and
 * which file binds it — and the NUMBER is read out of that file's
 * `process.env.<portEnv> ?? N`. Declaring the number instead would make the
 * declaration a second copy of it, and the copy that is wrong is the one nobody
 * runs. With `autoPort: false` (mandatory wherever auth is in the loop — our
 * OIDC-only demos redirect to a fixed callback and the shop's Better Auth trusts
 * two fixed origins) a stale port does not get quietly reassigned, it fails the
 * boot. For an agent, mid-session.
 *
 *   pnpm lint:launch            re-emit every .claude/launch.json
 *   pnpm lint:launch --check    CI: exit 1 if any emitted file has drifted
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_SERVERS as TEMPLATE_DEV_SERVERS } from '../packages/create-substrat/dev-servers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The `version` field Claude Desktop's preview-server config carries. */
const LAUNCH_VERSION = '0.0.1';

const check = process.argv.includes('--check');

type DevServer = {
  name: string;
  run: string;
  dir?: string;
  portEnv: string;
  portFrom: string;
  env?: Record<string, string>;
};

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`launch: ${message}\n`);
  process.exit(2);
}

/**
 * The port a source file binds. We match the one shape every server and vite config
 * in the repo uses — `process.env.X ?? 1234` — rather than executing anything: a
 * config that has to be RUN to reveal its port is a config an agent cannot read
 * either, and the uniformity is worth keeping mechanical.
 */
function portFrom(project: string, entry: DevServer): number {
  const file = join(ROOT, project, entry.portFrom);
  if (!existsSync(file)) {
    cannot(
      `${project}: ${entry.name} declares portFrom "${entry.portFrom}", which does not exist.\n` +
        `  Point it at the file that binds the port, or drop the entry.`,
    );
  }
  const source = readFileSync(file, 'utf8');
  const match = new RegExp(`process\\.env\\.${entry.portEnv}\\s*\\?\\?\\s*(\\d+)`).exec(source);
  if (!match) {
    cannot(
      `${project}: ${entry.name} declares portEnv "${entry.portEnv}", but ${entry.portFrom}\n` +
        `  binds no \`process.env.${entry.portEnv} ?? <port>\`. The declaration and the code\n` +
        `  disagree about which variable moves this server — fix whichever is wrong.`,
    );
  }
  return Number(match[1]);
}

/**
 * One entry per process, never a `concurrently` pair. The split is the point: with
 * separate entries Claude can attach the Browser to the web port while reading the
 * API's logs independently, which a single wrapper process makes impossible.
 */
function configuration(project: string, entry: DevServer) {
  const runtimeArgs = entry.dir ? ['--dir', entry.dir, entry.run] : ['run', entry.run];
  return {
    name: entry.name,
    runtimeExecutable: 'pnpm',
    runtimeArgs,
    port: portFrom(project, entry),
    ...(entry.env ? { env: entry.env } : {}),
    // Never `true`. See the header: a reassigned port breaks an auth redirect, not the boot.
    autoPort: false,
  };
}

function launchJson(project: string, servers: DevServer[]): string {
  return `${JSON.stringify(
    { version: LAUNCH_VERSION, configurations: servers.map((s) => configuration(project, s)) },
    null,
    2,
  )}\n`;
}

/** Every project that declares dev servers: the demos, plus the scaffolded template. */
function projects(): Array<{ path: string; servers: DevServer[] }> {
  const found: Array<{ path: string; servers: DevServer[] }> = [];
  for (const name of readdirSync(join(ROOT, 'demos')).sort()) {
    const manifest = join(ROOT, 'demos', name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const servers = pkg.substrat?.devServers as DevServer[] | undefined;
    if (!servers?.length) continue;
    found.push({ path: join('demos', name), servers });
  }
  if (!found.length) {
    cannot(
      'no demo declares `substrat.devServers`.\n' +
        '  This checkpoint exists to keep those declarations and the emitted launch\n' +
        '  files in step; scanning nothing must not pass for being in sync.',
    );
  }
  // The template's declaration is shared with create-substrat's scaffolder, so a
  // scaffolded project carries the same neutral block its launch file was emitted from.
  found.push({
    path: join('packages', 'create-substrat', 'template'),
    servers: TEMPLATE_DEV_SERVERS as DevServer[],
  });
  return found;
}

const drifted: string[] = [];
let emitted = 0;

for (const { path, servers } of projects()) {
  const target = join(path, '.claude', 'launch.json');
  const next = launchJson(path, servers);
  const absolute = join(ROOT, target);
  const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;

  if (current === next) {
    emitted += 1;
    continue;
  }
  if (check) {
    drifted.push(target);
    continue;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, next);
  console.log(`launch: ${current === undefined ? 'wrote' : 'updated'} ${target}`);
  emitted += 1;
}

if (check && drifted.length) {
  console.error(
    `launch: ${drifted.length} launch file(s) do not match the declared dev servers:\n` +
      drifted.map((f) => `  ${f}`).join('\n') +
      `\n\n  Run \`pnpm lint:launch\` and commit the result. The declaration in each\n` +
      `  project's \`substrat.devServers\` block is the source; the launch file is an\n` +
      `  adapter emitted from it (design/agent-surface.md §3, §6).\n`,
  );
  process.exit(1);
}

console.log(`launch: ${emitted} launch file(s) in sync with their declared dev servers.`);
