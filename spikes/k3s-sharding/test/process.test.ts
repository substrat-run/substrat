/**
 * A child frozen by SIGSTOP when its runner dies is still killed (#1638, review of #2202, nit 8).
 *
 * The child stands in for a shard the kill test froze; the "runner" is a throwaway process, so
 * killing it does not take this test with it. A stopped child runs none of its own handlers:
 * only the sentinel (`src/process.ts`) can end it.
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    if (c.pid && alive(c.pid)) {
      c.kill('SIGCONT');
      c.kill('SIGKILL');
    }
  }
});

describe('sentinel', () => {
  it('kills a stopped child once its runner is gone', async () => {
    const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    spawned.push(runner);
    const dir = mkdtempSync(join(tmpdir(), 'k3s-sharding-sentinel-'));
    const child = fork(fileURLToPath(new URL('../src/control-plane.ts', import.meta.url)), [], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, CP_DIR: dir, PORT: '0', SPIKE_RUNNER_PID: String(runner.pid) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    spawned.push(child);
    await new Promise<void>((resolve) => child.once('message', () => resolve()));

    child.kill('SIGSTOP');
    runner.kill('SIGKILL');
    for (let i = 0; i < 100 && alive(child.pid!); i++) await sleep(100);
    expect(alive(child.pid!)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
