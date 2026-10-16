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
 */
import { writeSync } from 'node:fs';

export interface ReplayRequest {
  readonly kernelUrl: string;
  readonly modules: readonly unknown[];
  readonly spineDdl?: string;
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
