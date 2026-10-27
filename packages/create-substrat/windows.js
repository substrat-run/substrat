// Windows long paths, offered once when a project is scaffolded.
//
// A project's node_modules holds files deeper than Windows' old 260-character limit. Node, npm
// and pnpm go past it on their own; many other programs (PowerShell, Python, installers) stop
// there until the machine-wide `LongPathsEnabled` setting is on. Turning it on needs an
// administrator, so the scaffold asks first and then has Windows run the one registry write
// elevated: the person answers one question and Windows' own "allow this app" prompt.
// `substrat doctor --fix` (@substrat-run/cli, doctor.ts) does the same later; the two keep the
// same command and the same reading of `reg query`.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const FILESYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** Every argument is a constant: nothing a person or a project supplies reaches the shell. */
export const ELEVATE_LONG_PATHS_SCRIPT =
  'Start-Process -FilePath reg.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ' +
  `'add','${FILESYSTEM_KEY}','/v','LongPathsEnabled','/t','REG_DWORD','/d','1','/f'`;

const LATER = 'npx @substrat-run/cli doctor --fix';

/** `reg query`'s answer: on, or off (an absent value is Windows' default, which is off). */
export function parseLongPaths(stdout) {
  const m = stdout?.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) !== 0 : false;
}

/** One question on the terminal; `undefined` when input ends (or Ctrl+C) before an answer. */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
      rl.close();
    });
    rl.on('close', () => resolve(undefined));
  });
}

export const realSystem = () => ({
  platform: process.platform,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  query: () => {
    try {
      return execFileSync('reg.exe', ['query', FILESYSTEM_KEY, '/v', 'LongPathsEnabled'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return undefined;
    }
  },
  elevate: () => {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ELEVATE_LONG_PATHS_SCRIPT], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  },
  ask,
});

/**
 * The lines to print after scaffolding, having offered to turn long paths on where that applies.
 * Nothing on macOS and Linux, or when they are already on. Without a terminal to ask on (a coding
 * agent) it changes nothing and says how to turn them on later. Never throws: a scaffold that
 * has been written is not undone by a setting.
 */
export async function offerLongPaths(sys = realSystem()) {
  if (sys.platform !== 'win32') return [];
  if (parseLongPaths(sys.query())) return [];
  const why = [
    '  Windows long paths are off. A project\'s node_modules holds files deeper than',
    '  260 characters, and many programs stop at that limit until it is turned on.',
  ];
  if (!sys.interactive) return [...why, `  Turn it on once (Windows asks you to allow it): ${LATER}`, ''];
  const answer = await sys.ask([...why, '  Turn it on now? Windows will ask you to allow it. [Y/n] '].join('\n'));
  if (answer === undefined || !(answer === '' || /^y/i.test(answer))) {
    return ['', `  Left off. Turn it on later with: ${LATER}`, ''];
  }
  try {
    sys.elevate();
  } catch {
    /* declined or failed: the re-read below says which */
  }
  return parseLongPaths(sys.query())
    ? ['', '  ✓ Windows long paths turned on. Restart your terminal and editor so they see it.', '']
    : ['', `  Long paths are still off (the permission prompt was declined). Later: ${LATER}`, ''];
}
