/**
 * Every process the harness spawns ends with its parent, and in any case within a bounded
 * lifetime. The test machine is shared, and a shard orphaned by a crashed test run would
 * otherwise sit on a port and a directory lock until someone noticed.
 *
 * Two layers, because one cannot cover a stopped process. The process's own handlers (IPC
 * disconnect, SIGTERM, a max-life timer) cover a running one. A process the kill test froze
 * with SIGSTOP runs none of them, so if the runner dies during a freeze it would outlive it.
 * A sentinel covers that: a second, tiny process that is never stopped. It polls the runner
 * and the child, and when the runner is gone it continues and kills the child. It exits as
 * soon as the child is gone.
 */
import { spawn } from 'node:child_process';

/** The sentinel, as a `node -e` body: argv is [child pid, runner pid]. */
const SENTINEL = `/* k3s-sharding sentinel */
const [child, runner] = process.argv.slice(1).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
setInterval(() => {
  if (!alive(child)) process.exit(0);
  if (!alive(runner)) {
    try { process.kill(child, 'SIGCONT'); process.kill(child, 'SIGKILL'); } catch {}
    process.exit(0);
  }
}, 250);`;

export function exitWithParent(onExit?: () => void): void {
  const done = () => {
    try {
      onExit?.();
    } finally {
      process.exit(0);
    }
  };
  // Spawned with an IPC channel: it closes when the parent exits, however it exits.
  process.on('disconnect', done);
  process.on('SIGTERM', done);
  const maxLife = Number(process.env.SPIKE_MAX_LIFE_MS ?? 180_000);
  setTimeout(done, maxLife).unref();

  const runner = Number(process.env.SPIKE_RUNNER_PID ?? process.ppid);
  const { NODE_OPTIONS: _preloads, ...env } = process.env;
  spawn(process.execPath, ['-e', SENTINEL, String(process.pid), String(runner)], {
    stdio: 'ignore',
    detached: true,
    env,
  }).unref();
}
