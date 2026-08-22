#!/usr/bin/env node
/**
 * The local-env checkpoint — a dev server that cannot work refuses to boot, and says
 * exactly what it needs.
 *
 * Two defects motivate this. First, `.dev.vars` is the repo's per-project local-env
 * convention (gitignored, `secrets.mjs dev` writes them) and **`wrangler dev` loads it
 * while `tsx src/server.ts` does not** — the same file, the same directory, read by one
 * entry point and silently ignored by the other. The `server` script now passes
 * `--env-file-if-exists=.dev.vars`, and this tool checks what that leaves unresolved.
 *
 * Second, and the reason this is a boot failure rather than a warning: there is no
 * terminal to prompt at. Claude Desktop starts these servers from `.claude/launch.json`
 * (`pnpm run server`) with no TTY, so a `readline` question would hang forever and a
 * warning would scroll past. What an agent CAN read is a server that died and said why.
 * `.claude/launch.json` already leans on exactly this: `autoPort: false` is set so a
 * stale port "does not get quietly reassigned, it fails the boot. For an agent,
 * mid-session" (tools/launch-emit.mts). This is the same signal for the same audience.
 *
 *   node ../../tools/env-preflight.mjs server     # guard the `server` script
 *
 * Wired as `preserver`, so it runs on BOTH paths that start the API — Claude Desktop's
 * `pnpm run server` and a human's `pnpm run dev` — without either knowing it exists.
 *
 * ## What counts as required
 *
 * Two declarations, because they answer different questions:
 *
 *   `substrat.envSpec[].required`   — required to DEPLOY. Rarely true: a hosted install
 *                                     gets its config through per-scope delivery, so the
 *                                     manifest can honestly call most keys optional.
 *   `substrat.devServers[].requires` — required to RUN THIS PROCESS LOCALLY. The gap the
 *                                     first cannot express. Locally there is no delivery
 *                                     channel, so `OIDC_ISSUER` absent means broken; and
 *                                     the harness secrets that actually bite (PLATFORM_SECRET,
 *                                     ROUTER_SECRET) are deliberately undeclared in envSpec
 *                                     at all (demos/callout/src/manifest.ts).
 *
 * A key named in `requires` and described in `envSpec` gets the spec's label, description
 * and placeholder in the failure message. A key named only in `requires` is reported bare
 * — undescribed is worth saying out loud, not worth blocking on.
 *
 * Precedence mirrors the runtime exactly, which is why it is worth stating: Node's
 * `--env-file` does NOT override an already-set variable (verified, not assumed), so a
 * shell value wins over `.dev.vars`, which wins over the spec's `default`.
 *
 * Values are never printed — only key names. Exit codes follow boundary-lint's:
 * 0 = satisfied, 1 = something required is missing, 2 = the tool cannot run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message) {
  console.error(`env-preflight: ${message}\n`);
  process.exit(2);
}

// pnpm runs a script with cwd set to the package directory, so the project is simply
// where we are. `npm_lifecycle_event` is the fallback: invoked as `preserver`, the
// script being guarded is what remains once `pre` comes off.
const project = process.cwd();
const runScript =
  process.argv[2] ?? (process.env.npm_lifecycle_event ?? '').replace(/^pre/, '') ?? '';
if (!runScript) {
  cannot('name the script being guarded, e.g. `node ../../tools/env-preflight.mjs server`.');
}

const pkgPath = join(project, 'package.json');
if (!existsSync(pkgPath)) cannot(`no package.json in ${project} — run this from a project directory.`);

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (e) {
  cannot(`${pkgPath} is not readable JSON: ${e.message}`);
}

const envSpec = pkg.substrat?.envSpec ?? [];
const devServers = pkg.substrat?.devServers ?? [];

/**
 * The entries this script starts. `dir` entries are a Vite app in a subdirectory running
 * its OWN `run` script, so a same-named script here is not the same process.
 */
const entries = devServers.filter((s) => s.run === runScript && !s.dir);

/** Declared-locally-required, in declaration order, deduped: devServers first, then envSpec. */
const required = [];
for (const entry of entries) for (const key of entry.requires ?? []) {
  if (!required.some((r) => r.key === key)) required.push({ key, via: entry.name });
}
for (const spec of envSpec) {
  if (spec.required && !required.some((r) => r.key === spec.key)) required.push({ key: spec.key, via: 'envSpec' });
}

if (!required.length) process.exit(0);

/**
 * `.dev.vars` is dotenv format. Parsed rather than loaded: this process must not inherit
 * the values it is reporting on, and nothing here should be able to print one by accident
 * — only the KEY SET is kept.
 */
const devVarsPath = join(project, '.dev.vars');
const devVarKeys = new Set();
if (existsSync(devVarsPath)) {
  for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    // A key present but empty is not set — the same rule `resolveEnvSpec` applies.
    const value = m[2].trim().replace(/^(['"])(.*)\1$/s, '$2');
    if (value !== '') devVarKeys.add(m[1]);
  }
}

const specFor = (key) => envSpec.find((s) => s.key === key);

/** Shell > .dev.vars > the spec's declared default. Mirrors `--env-file`, which never overrides. */
function resolved(key) {
  if (typeof process.env[key] === 'string' && process.env[key] !== '') return 'env';
  if (devVarKeys.has(key)) return '.dev.vars';
  const d = specFor(key)?.default;
  return typeof d === 'string' && d !== '' ? 'default' : null;
}

const missing = required.filter((r) => resolved(r.key) === null);
const label = pkg.substrat?.slug ?? pkg.name ?? 'project';

if (!missing.length) {
  console.log(`env-preflight: ${label} · ${required.length} required setting(s) resolved.`);
  process.exit(0);
}

/**
 * The path to print. Relative to the workspace root when we can find one, so the line is
 * copy-pasteable from the repo root; absolute-free and unambiguous otherwise.
 */
function workspaceRoot(from) {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return resolve(from, '..');
    dir = up;
  }
}

/** Wrap a description under a fixed indent so a long one stays readable in a server log. */
function wrap(text, indent, width = 78) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && indent.length + line.length + 1 + word.length > width) { out.push(indent + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

// The report. Written for the agent that will read it out of a dead server's log and ask
// the human — so every fact it needs is here: what is missing, what each one means, and
// the exact file to write. Never a value.
const rel = relative(workspaceRoot(project), project) || project;
const lines = [
  '',
  `✗ ${label}: ${missing.length} required setting(s) missing — not starting.`,
  '',
];
for (const { key, via } of missing) {
  const spec = specFor(key);
  const head = spec
    ? `  ${key}${spec.secret ? '  (secret)' : ''}${spec.group ? `  ·  ${spec.group}` : ''}${spec.label ? `  ·  ${spec.label}` : ''}`
    : `  ${key}  (undeclared — required by the \`${via}\` dev server)`;
  lines.push(head);
  if (spec?.description) lines.push(wrap(spec.description, '      '));
  if (spec?.placeholder) lines.push(`      e.g. ${spec.placeholder}`);
  lines.push('');
}
lines.push(
  `Write them to ${join(rel, '.dev.vars')} — gitignored, and already the file`,
  '`wrangler dev` reads, so one file serves both entry points:',
  '',
  ...missing.map(({ key }) => `  ${key}=`),
  '',
  'then start the server again. A shell variable of the same name also wins — but only',
  'from a terminal: Claude Desktop does not inherit your shell, so a dev server it',
  'starts sees `.dev.vars` and nothing else.',
  '',
);
console.error(lines.join('\n'));
process.exit(1);
