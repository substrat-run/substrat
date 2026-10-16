/**
 * The data-loss replay's own process (#2321): what `checkMigrationDataLoss` runs the vertical's
 * migrations in, so a runaway one can be stopped. A SQLite statement runs in native code that no
 * JavaScript timer and no `worker.terminate()` can interrupt, and this Node's `node:sqlite` has no
 * progress handler; a process can always be killed. See `replayInChild` for the parent's half.
 *
 * Reads one request as JSON on stdin — the vertical's kernel URL, its modules as data, the spine
 * DDL — and writes one JSON line per message to stdout, synchronously, so the line naming the
 * migration about to run is out before that migration can block the process. Started with an empty
 * environment, in the temp directory, against an in-memory database.
 *
 * It must not outlive the push that started it, however that push ends. The parent kills it on a
 * timeout, but a parent killed by a signal runs no handler at all, and an orphaned replay blocked
 * in a SQLite step would spin forever. So the child carries a watchdog of
 * its own: a worker thread — which a blocked main thread cannot starve — that kills this process
 * when its parent is gone (the parent pid changes as the OS re-parents it) or the request's hard
 * deadline passes. Covered: the parent exiting, crashing, or being killed by any signal, SIGKILL
 * included, within the watchdog's poll interval. Not covered: a parent that is alive but stopped
 * (SIGSTOP) — the replay then runs until the deadline.
 */
import { writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface ReplayRequest {
  readonly kernelUrl: string;
  readonly modules: readonly unknown[];
  readonly spineDdl?: string;
  /** Wall-clock limit for the whole replay, after which the child kills itself — a backstop. */
  readonly deadlineMs: number;
}

/** How often the watchdog looks at its parent. */
export const WATCHDOG_POLL_MS = 200;

/** Kill this process when the parent that started it is gone, or `deadlineMs` has passed. */
function watchdog(deadlineMs: number): void {
  const worker = new Worker(
    `const { workerData: { parent, until, every } } = require('node:worker_threads');
     setInterval(() => {
       if (process.ppid !== parent || Date.now() > until) process.kill(process.pid, 'SIGKILL');
     }, every);`,
    { eval: true, workerData: { parent: process.ppid, until: Date.now() + deadlineMs, every: WATCHDOG_POLL_MS } },
  );
  // The watchdog never keeps a finished replay alive.
  worker.unref();
}

/** Each stdout line, in order: zero or more `started`, then one `done`. */
export type ChildMessage =
  | { readonly type: 'started'; readonly key: string; readonly authored: boolean }
  | {
      readonly type: 'done';
      readonly result:
        | { readonly kind: 'outcome'; readonly outcome: unknown }
        | { readonly kind: 'no-sqlite' }
        | { readonly kind: 'error'; readonly message: string };
    };

const send = (message: ChildMessage): void => {
  writeSync(1, `${JSON.stringify(message)}\n`);
};

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReplayRequest;
  watchdog(request.deadlineMs);

  let open: () => Sqlite;
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => Sqlite };
    open = () => new DatabaseSync(':memory:');
  } catch {
    send({ type: 'done', result: { kind: 'no-sqlite' } });
    return;
  }
  try {
    const kernel = (await import(request.kernelUrl)) as {
      replayMigrations: (db: unknown, modules: readonly unknown[], opts: unknown) => unknown;
    };
    const db = open();
    const outcome = kernel.replayMigrations(
      {
        exec: (q: string) => db.exec(q),
        query: (q: string, p: readonly unknown[] = []) => db.prepare(q).all(...p),
        run: (q: string, p: readonly unknown[] = []) => ({ changes: Number(db.prepare(q).run(...p).changes) }),
      },
      request.modules,
      {
        spineDdl: request.spineDdl,
        onMigration: (key: string, authored: boolean) => send({ type: 'started', key, authored }),
      },
    );
    send({ type: 'done', result: { kind: 'outcome', outcome } });
  } catch (e) {
    send({ type: 'done', result: { kind: 'error', message: e instanceof Error ? e.message : String(e) } });
  }
}

await main();
