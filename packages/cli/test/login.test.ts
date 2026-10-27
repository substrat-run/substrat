import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { browserCommand } from '../src/login.js';

/**
 * Opening the browser for `substrat login`. The authorize URL carries `&state=` and
 * `&challenge=`; any opener that lets a shell parse it loses them (cmd.exe ends a command at
 * `&`), and the broker refuses the truncated request as "bad cli request".
 */
const url = 'https://cp.example/api/auth/cli?port=51234&state=s7Ate-_x&challenge=cH4ll-_y&fresh=1';

describe('browserCommand — the URL reaches the opener as one untouched argument', () => {
  it('darwin: open <url>', () => {
    expect(browserCommand('darwin', url)).toEqual({ cmd: 'open', args: [url] });
  });

  it('linux and the rest: xdg-open <url>', () => {
    expect(browserCommand('linux', url)).toEqual({ cmd: 'xdg-open', args: [url] });
    expect(browserCommand('freebsd', url)).toEqual({ cmd: 'xdg-open', args: [url] });
  });

  it('win32: rundll32 url.dll,FileProtocolHandler <url>, never through cmd.exe', () => {
    const { cmd, args } = browserCommand('win32', url);
    expect(cmd).toBe('rundll32');
    expect(cmd.toLowerCase()).not.toMatch(/^cmd(\.exe)?$/);
    expect(args).toEqual(['url.dll,FileProtocolHandler', url]);
    const passed = args.filter((a) => a.includes('/auth/cli'));
    expect(passed).toEqual([url]); // one element, byte-for-byte
    expect(passed[0]).toContain('&state=s7Ate-_x');
    expect(passed[0]).toContain('&challenge=cH4ll-_y');
    expect(passed[0]).toContain('&fresh=1');
  });

  // Why not `cmd /c start "" <url>` (the old opener): cmd.exe splits the line at `&`, so
  // everything after `port=` is run as further commands instead of reaching the browser.
  it.runIf(process.platform === 'win32')('documents the old bug: cmd.exe cuts the URL at the first &', () => {
    const out = spawnSync('cmd', ['/c', 'echo', url], { encoding: 'utf8', windowsHide: true });
    expect(out.stdout.trim()).toBe('https://cp.example/api/auth/cli?port=51234');
    expect(out.stdout).not.toContain('state=');
  });
});

describe('openBrowser — a missing opener never ends the login', () => {
  // spawn reports a missing executable (no xdg-open on a headless box) through an async
  // 'error' event, which no try/catch sees; with no listener it crashes the process before
  // the printed URL can be used. Driven through the built `browserLogin`, with `spawn`
  // redirected to an executable that does not exist.
  it('keeps the process alive and the fallback URL printed', () => {
    const login = new URL('../dist/login.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      timeout: 30_000,
      input: `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const realSpawn = cp.spawn;
        cp.spawn = (_cmd, args, opts) => realSpawn('substrat-test-no-such-opener', args, opts);
        syncBuiltinESMExports();
        const { browserLogin } = await import(${JSON.stringify(login)});
        void browserLogin('https://cp.invalid/api').catch(() => {});
        setTimeout(() => { console.log('STILL-RUNNING'); process.exit(0); }, 1000);
      `,
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    expect(output).toContain('STILL-RUNNING');
    expect(output).toContain('https://cp.invalid/api/auth/cli?port=');
  });
});
