import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The CLI's own version, read from the package.json that ships in the npm tarball (npm
 * always includes it, whatever the `files` array says). Resolved relative to this module,
 * so it works both from `dist/` at runtime and from `src/` under vitest — both are one
 * level below the package root. Best-effort: a missing/garbled file yields `0.0.0` rather
 * than throwing, since `substrat --version` must never fail.
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Parse a leading `major.minor.patch` (ignoring any prerelease/build suffix). */
function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** a < b, semver-wise. */
function lt(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

export type Advisory = { level: 'blocked' | 'behind'; message: string } | null;

/**
 * The freshness decision, as a pure function so it can be tested without a TTY or a
 * network. The control plane — the authority on whether this CLI is still *compatible*,
 * which npm's `latest` tag is not — advertises two values on every response:
 *   `min`    the oldest version it will keep accepting pushes from (the compat floor)
 *   `latest` the newest published version
 * Below the floor is `blocked` (the server also refuses the push outright — this is just
 * the friendly heads-up); merely behind `latest` is `behind`. Anything unparseable or
 * absent yields no advisory, so a server that says nothing costs nothing.
 */
export function staleAdvisory(current: string, server: { min?: string | null; latest?: string | null }): Advisory {
  const cur = parse(current);
  if (!cur) return null;
  const min = server.min ? parse(server.min) : null;
  const latest = server.latest ? parse(server.latest) : null;
  if (min && lt(cur, min)) {
    return {
      level: 'blocked',
      message:
        `this substrat CLI (${current}) is below the minimum the platform supports (${server.min}). ` +
        `Upgrade before your next push — older versions will stop being accepted:\n    npm i -g @substrat-run/cli`,
    };
  }
  if (latest && lt(cur, latest)) {
    return {
      level: 'behind',
      message: `a newer substrat CLI is available (${server.latest}, you have ${current}): npm i -g @substrat-run/cli`,
    };
  }
  return null;
}

/**
 * Detect a stale WORKSPACE build (#386). In the monorepo the `substrat` bin is a
 * symlink to `packages/cli/dist/cli.js`, so after a `git pull` that touched `src/`
 * without a rebuild, the stale dist fails in maximally confusing ways — e.g. a Zod
 * refusal of `registry: undefined` after #363 made the field required, with nothing
 * saying the CLI itself was the problem. The published tarball ships no `src/`
 * (package.json `files`), so for an npm-installed CLI this is always null.
 *
 * Pure decision over two directories so it is testable with temp dirs: newest `.ts`
 * mtime under src (recursing is unnecessary — the CLI's src is flat) vs newest `.js`
 * mtime under dist. Returns the warning to print, or null.
 */
export function distStaleAdvisory(srcDir: string, distDir: string): string | null {
  const newest = (dir: string, ext: string): number => {
    let t = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(ext)) t = Math.max(t, statSync(join(dir, f)).mtimeMs);
    }
    return t;
  };
  const src = newest(srcDir, '.ts');
  const dist = newest(distDir, '.js');
  if (src === 0 || dist === 0 || src <= dist) return null;
  return (
    `this substrat CLI runs from a workspace build that is OLDER than its sources — ` +
    `its failures may be stale-build artifacts, not real errors. Rebuild first:\n` +
    `    pnpm --filter @substrat-run/cli build`
  );
}

/**
 * Warn (stderr, never stdout) when the running dist is older than the checkout's src.
 * A no-op outside the monorepo (no `src/` in the tarball), when running straight from
 * source (vitest/tsx), and on any error — a freshness nudge must never fail a command.
 */
export function warnIfDistStale(): void {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    if (!/[/\\]dist[/\\]?$/.test(here)) return; // running from src — nothing built to be stale
    const root = fileURLToPath(new URL('..', import.meta.url));
    const advisory = distStaleAdvisory(join(root, 'src'), join(root, 'dist'));
    if (advisory) console.error(`⚠ ${advisory}`);
  } catch {
    /* installed CLI (no src/), or fs hiccup — silence either way */
  }
}

/** Response headers carrying the version advisory (see {@link staleAdvisory}). */
export const CLI_MIN_VERSION_HEADER = 'x-substrat-cli-min-version';
export const CLI_LATEST_VERSION_HEADER = 'x-substrat-cli-latest-version';

/**
 * Read the version advisory off a control-plane response and nudge the builder — to
 * stderr (never stdout, which `push` output is parsed from), and only on a TTY, so
 * scripted/CI runs stay silent. Never throws: a version banner must not be able to fail
 * a deploy. Call it on any authenticated response; the server side may not advertise the
 * headers yet, in which case this is a no-op.
 */
export function warnIfStale(headers: Headers): void {
  if (!process.stderr.isTTY) return;
  try {
    const advisory = staleAdvisory(cliVersion(), {
      min: headers.get(CLI_MIN_VERSION_HEADER),
      latest: headers.get(CLI_LATEST_VERSION_HEADER),
    });
    if (advisory) console.error(`⚠ ${advisory.message}`);
  } catch {
    /* an advisory must never fail the command it rode in on */
  }
}
