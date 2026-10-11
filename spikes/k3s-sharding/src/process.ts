/**
 * Every process the harness spawns ends with its parent, and in any case within a bounded
 * lifetime. The test machine is shared, and a shard orphaned by a crashed test run would
 * otherwise sit on a port and a directory lock until someone noticed.
 */
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
}
