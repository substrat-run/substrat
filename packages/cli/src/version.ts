import { readFileSync } from 'node:fs';

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
