import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveWrangler } from './push.js';

/**
 * `substrat doctor [dir] [--fix]`: is this machine and project ready to build and push?
 *
 * It reads, and changes nothing, unless `--fix` is given. The one thing `--fix` changes is
 * Windows' long-path setting, because that is the one a person cannot be expected to know
 * about: a vertical's `node_modules` holds files deeper than Windows' old 260-character limit,
 * and with the setting off, programs built to go past it (PowerShell, Python, many installers)
 * still stop there. Node goes past it either way; cmd.exe and Explorer never do, and git has its
 * own `core.longpaths`. The setting is machine-wide and needs an administrator, so `--fix` asks Windows to run
 * the one registry write elevated: the person sees Windows' own "allow this app" prompt, once.
 */

/** What the system calls are, so a test can stand in for the registry and the elevation. */
export interface DoctorSystem {
  platform: NodeJS.Platform;
  nodeVersion: string;
  /** `reg query` of the long-path value: its stdout, or `undefined` when the value is absent. */
  queryLongPaths: () => string | undefined;
  /** Run the elevated registry write; throws when it did not run (the prompt was declined). */
  elevateLongPaths: () => void;
}

const FILESYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** Every argument is a constant: nothing a person or a project supplies reaches the shell. */
export const ELEVATE_LONG_PATHS_SCRIPT =
  "Start-Process -FilePath reg.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList " +
  `'add','${FILESYSTEM_KEY}','/v','LongPathsEnabled','/t','REG_DWORD','/d','1','/f'`;

export const realSystem = (): DoctorSystem => ({
  platform: process.platform,
  nodeVersion: process.versions.node,
  queryLongPaths: () => {
    try {
      return execFileSync('reg.exe', ['query', FILESYSTEM_KEY, '/v', 'LongPathsEnabled'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return undefined; // reg exits 1 when the value does not exist, which means "off"
    }
  },
  elevateLongPaths: () => {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ELEVATE_LONG_PATHS_SCRIPT], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  },
});

/** On, off, or (not Windows) not a question at all. */
export function parseLongPaths(stdout: string | undefined): boolean {
  const m = stdout?.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1]!, 16) !== 0 : false;
}

export interface DoctorResult {
  lines: string[];
  /** How many checks still fail. A non-zero count is a non-zero exit. */
  problems: number;
}

/** Push needs wrangler 4, and wrangler 4 needs Node 22. */
const NODE_FOR_PUSH = 22;

export function doctor(dir: string, opts: { fix?: boolean } = {}, sys: DoctorSystem = realSystem()): DoctorResult {
  const lines: string[] = [];
  let problems = 0;
  const bad = (line: string, ...hints: string[]) => {
    problems++;
    lines.push(`  ✗ ${line}`, ...hints.map((h) => `      ${h}`));
  };

  const major = Number(sys.nodeVersion.split('.')[0]);
  if (major >= NODE_FOR_PUSH) lines.push(`  ✓ Node ${sys.nodeVersion}`);
  else bad(`Node ${sys.nodeVersion}: \`substrat push\` needs Node ${NODE_FOR_PUSH} or later, because wrangler 4 does`, 'install a current Node LTS from https://nodejs.org');

  const root = resolve(dir);
  if (!existsSync(join(root, 'package.json'))) {
    lines.push(`  – no project in ${root} (no package.json), so wrangler is not checked`);
  } else {
    try {
      lines.push(`  ✓ wrangler ${resolveWrangler(root).version}, installed in this project`);
    } catch {
      bad('wrangler is not installed in this project — `substrat push` builds with it', 'npm install --save-dev wrangler    (or: pnpm add -D wrangler)');
    }
  }

  if (sys.platform === 'win32') {
    let on = parseLongPaths(sys.queryLongPaths());
    if (!on && opts.fix) {
      lines.push('  … turning on Windows long paths — Windows asks you to allow it');
      try {
        sys.elevateLongPaths();
      } catch {
        /* declined or failed: the re-read below says which way it went */
      }
      on = parseLongPaths(sys.queryLongPaths());
      if (on) {
        lines.push('  ✓ Windows long paths: turned on', '      programs already running keep the old limit: restart your terminal and editor');
      } else {
        bad('Windows long paths are still off — the permission prompt was declined or did not appear', 'run `substrat doctor --fix` again and choose Yes');
      }
    } else if (on) {
      lines.push('  ✓ Windows long paths are on');
    } else {
      bad(
        'Windows long paths are off: node_modules holds files deeper than 260 characters, and programs stop at that limit until it is on',
        'substrat doctor --fix    (Windows asks you to allow it, once)',
      );
    }
  }

  return { lines, problems };
}
