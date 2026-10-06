/**
 * #119 (Codex r5): one PROCESS owns a host directory. Hosts in the same process share it — the
 * multi-vertical model (#1705) — and the OS lock is released when the last of them closes, or when
 * the process dies. A host in another process is refused while it is held.
 *
 * The other process is a real one (`child_process`), driven line by line over stdin, so the lock
 * under test is the operating system's and not this process's bookkeeping.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { SqliteScopeHost } from '../src/index.js';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** A child process holding hosts on `dir`: `open` adds one, `close` closes the newest. Each line answers. */
const CHILD = `
import { createInterface } from 'node:readline';
const { SqliteScopeHost } = await import(process.argv[1]);
const dir = process.argv[2];
const hosts = [];
const say = (s) => process.stdout.write(s + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (line === 'open') { hosts.push(new SqliteScopeHost({ dir })); say('opened ' + hosts.length); }
    if (line === 'close') { await hosts.pop().close(); say('closed ' + hosts.length); }
  } catch (err) { say('refused ' + (err.extensions?.reason ?? err.message)); }
}
`;

interface Child {
  send(line: string): Promise<string>;
  proc: ChildProcessWithoutNullStreams;
}

const children: ChildProcessWithoutNullStreams[] = [];
const child = (dir: string): Child => {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD, DIST, dir], { stdio: 'pipe' });
  children.push(proc);
  const lines: string[] = [];
  const waiting: ((l: string) => void)[] = [];
  let buf = '';
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  return {
    proc,
    send: (line) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        proc.stdin.write(line + '\n');
      }),
  };
};

/** The child is gone — polled, and bounded, so a stuck child fails the case rather than hanging it. */
const exited = async (proc: ChildProcessWithoutNullStreams): Promise<void> => {
  for (let i = 0; i < 500 && proc.exitCode === null && proc.signalCode === null; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (proc.exitCode === null && proc.signalCode === null) throw new Error('child did not exit');
};

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'substrat-host-dir-'));
  dirs.push(d);
  return d;
};

afterEach(async () => {
  for (const proc of children.splice(0)) {
    proc.kill('SIGKILL');
    await exited(proc);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const refusalOf = (open: () => unknown): unknown => {
  try {
    open();
  } catch (err) {
    return err;
  }
  throw new Error('expected the host to be refused');
};

describe('one process owns a host directory (#119)', () => {
  it('refuses a host while another process holds the directory, naming it; opens once that process has closed every host', async () => {
    const dir = freshDir();
    const other = child(dir);
    expect(await other.send('open')).toBe('opened 1');
    expect(await other.send('open')).toBe('opened 2');
    const err = refusalOf(() => new SqliteScopeHost({ dir }));
    expect(errorCodeOf(err)).toBe('conflict');
    expect((err as { extensions?: { reason?: string } }).extensions?.reason).toBe('host_dir_in_use');
    expect((err as Error).message).toContain(realpathSync(dir));
    // One of its two hosts closed: the process still owns the directory.
    expect(await other.send('close')).toBe('closed 1');
    expect(errorCodeOf(refusalOf(() => new SqliteScopeHost({ dir })))).toBe('conflict');
    // The last closed: it is free.
    expect(await other.send('close')).toBe('closed 0');
    const host = new SqliteScopeHost({ dir });
    await host.close();
  }, 30_000);

  it('opens after the holding process is killed outright — the lock never outlives its owner', async () => {
    const dir = freshDir();
    const other = child(dir);
    expect(await other.send('open')).toBe('opened 1');
    expect(errorCodeOf(refusalOf(() => new SqliteScopeHost({ dir })))).toBe('conflict');
    other.proc.kill('SIGKILL');
    await exited(other.proc);
    const host = new SqliteScopeHost({ dir });
    await host.close();
  }, 30_000);

  it('lets hosts in one process share the directory, and releases it only when the last one closes', async () => {
    const dir = freshDir();
    const a = new SqliteScopeHost({ dir });
    const b = new SqliteScopeHost({ dir });
    const other = child(dir);
    expect(await other.send('open')).toMatch(/^refused host_dir_in_use/);
    await a.close();
    // `b` still holds this process's claim.
    expect(await other.send('open')).toMatch(/^refused host_dir_in_use/);
    // A host that closes twice does not release a claim another host still holds.
    await a.close();
    expect(await other.send('open')).toMatch(/^refused host_dir_in_use/);
    await b.close();
    expect(await other.send('open')).toBe('opened 1');
  }, 30_000);
});
