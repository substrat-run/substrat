import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor, ELEVATE_LONG_PATHS_SCRIPT, parseLongPaths, realSystem, type DoctorSystem } from '../src/doctor.js';
import { installFakeWrangler } from './fake-wrangler.js';

const ON = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    0x1\r\n\r\n';
const OFF = ON.replace('0x1', '0x0');

/** A project with wrangler installed, and a stand-in system whose registry is `value`. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrat doctor å '));
  writeFileSync(join(dir, 'package.json'), '{"name":"acme"}');
  installFakeWrangler(dir);
  return dir;
}

function windows(registry: string | undefined, onElevate: (set: (v: string) => void) => void = () => {}): DoctorSystem & { elevations: number } {
  let value = registry;
  const sys = {
    platform: 'win32' as const,
    nodeVersion: '24.1.0',
    elevations: 0,
    queryLongPaths: () => value,
    elevateLongPaths: () => {
      sys.elevations++;
      onElevate((v) => (value = v));
    },
  };
  return sys;
}

describe('parseLongPaths — what `reg query` says', () => {
  it.each([
    [ON, true],
    [OFF, false],
    [ON.replace('0x1', '0x00000001'), true],
    // reg exits 1 when the value is absent: Windows' default, which is off.
    [undefined, false],
    ['', false],
  ])('%j → %s', (stdout, on) => {
    expect(parseLongPaths(stdout)).toBe(on);
  });
});

describe('doctor — reads, and changes nothing without --fix', () => {
  it('a ready Windows machine: every check passes', () => {
    const r = doctor(project(), {}, windows(ON));
    expect(r.problems).toBe(0);
    expect(r.lines.join('\n')).toMatch(/✓ Node 24\.1\.0[\s\S]*✓ wrangler 0\.0\.0-fake[\s\S]*✓ Windows long paths are on/);
  });

  it('long paths off: one problem, the command that fixes it, and no elevation', () => {
    const sys = windows(OFF);
    const r = doctor(project(), {}, sys);
    expect(r.problems).toBe(1);
    expect(r.lines.join('\n')).toContain('substrat doctor --fix');
    expect(sys.elevations).toBe(0);
  });

  it('--fix elevates once, and reports success only when the registry says so afterwards', () => {
    const sys = windows(undefined, (set) => set(ON));
    const r = doctor(project(), { fix: true }, sys);
    expect(sys.elevations).toBe(1);
    expect(r.problems).toBe(0);
    expect(r.lines.join('\n')).toContain('✓ Windows long paths: turned on');
    expect(r.lines.join('\n')).toContain('restart your terminal and editor');
  });

  it('--fix with the permission prompt declined: still a problem, said plainly, never a pass', () => {
    const sys = windows(OFF, () => {
      throw new Error('The operation was canceled by the user.');
    });
    const r = doctor(project(), { fix: true }, sys);
    expect(sys.elevations).toBe(1);
    expect(r.problems).toBe(1);
    expect(r.lines.join('\n')).toContain('still off');
  });

  it('--fix when long paths are already on does not ask Windows for anything', () => {
    const sys = windows(ON);
    expect(doctor(project(), { fix: true }, sys).problems).toBe(0);
    expect(sys.elevations).toBe(0);
  });

  it('macOS and Linux have no such limit: no long-path line, no elevation', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const sys = { ...windows(OFF), platform };
      const r = doctor(project(), { fix: true }, sys);
      expect(r.problems).toBe(0);
      expect(r.lines.join('\n')).not.toContain('long paths');
      expect(sys.elevations).toBe(0);
    }
  });

  it('names a missing wrangler and an old Node, with what to do about each', () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat doctor å '));
    writeFileSync(join(dir, 'package.json'), '{"name":"acme"}');
    const r = doctor(dir, {}, { ...windows(ON), nodeVersion: '20.11.0' });
    expect(r.problems).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Node 20\.11\.0: `substrat push` needs Node 22[\s\S]*npm install --save-dev wrangler/);
  });

  it('outside a project it does not call wrangler missing', () => {
    const r = doctor(mkdtempSync(join(tmpdir(), 'substrat doctor å ')), {}, windows(ON));
    expect(r.problems).toBe(0);
    expect(r.lines.join('\n')).toContain('no project in');
  });

  it('the elevated command is fixed text: nothing from the project or the person reaches it', () => {
    expect(ELEVATE_LONG_PATHS_SCRIPT).toBe(
      "Start-Process -FilePath reg.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'add','HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem','/v','LongPathsEnabled','/t','REG_DWORD','/d','1','/f'",
    );
  });
});

/** The real registry, read-only: the query this machine answers is one parseLongPaths reads. */
describe.runIf(process.platform === 'win32')('on Windows, the real registry', () => {
  it('answers the query with a value parseLongPaths understands, or with none (off)', () => {
    const out = realSystem().queryLongPaths();
    if (out !== undefined) expect(out).toMatch(/LongPathsEnabled\s+REG_DWORD\s+0x[0-9a-f]+/i);
    expect(typeof parseLongPaths(out)).toBe('boolean');
  });
});

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
describe('the command', () => {
  it('exits non-zero exactly when a check fails, and prints each check', () => {
    const ready = project();
    const r = spawnSync(process.execPath, [cli, 'doctor', ready], { encoding: 'utf8' });
    expect(r.stdout).toContain('substrat doctor');
    expect(r.stdout).toContain('✓ wrangler 0.0.0-fake');
    // The machine decides the rest (an old Node, Windows long paths off): the exit code follows it.
    expect(r.status).toBe(r.stdout.includes('✗') ? 1 : 0);
  });
});
