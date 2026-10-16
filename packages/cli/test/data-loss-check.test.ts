import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkMigrationDataLoss,
  dataLossCheckRequired,
  formatDataLossCheck,
  replayInChild,
  type ReplayInputs,
} from '../src/data-loss-check.js';

/**
 * #2321 — the data-loss check a push makes before upload, on its own: the vertical's kernel
 * reached as a value and a URL (here the workspace kernel's build, which is what a fixture
 * vertical links), the replay run in the BUILT child process, as it ships. The push-level half,
 * through the real `push()`, is in push-data-loss.test.ts.
 */
const kernelDist = join(fileURLToPath(new URL('../../kernel', import.meta.url)), 'dist', 'index.js');
const childPath = fileURLToPath(new URL('../dist/data-loss-replay-child.js', import.meta.url));
const ready = existsSync(kernelDist) && existsSync(childPath);
const kernel = ready ? ((await import(pathToFileURL(kernelDist).href)) as Record<string, unknown>) : null;
const kernelUrl = pathToFileURL(kernelDist).href;

type Migration = { version: string; sql: string; moves?: Record<string, string>; discards?: Record<string, string> };
const INIT: Migration = { version: '0001', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);' };
const inputs = (migrations: Migration[], over: Partial<ReplayInputs> = {}): ReplayInputs => ({
  kernel,
  kernelUrl,
  modules: [{ manifest: { id: 'notes' }, migrations }],
  spineDdl: async () => undefined,
  ...over,
});
const run = async (i: ReplayInputs, opts: Parameters<typeof checkMigrationDataLoss>[1] = {}) => {
  const log: string[] = [];
  const warn: string[] = [];
  const result = checkMigrationDataLoss(i, { log: (m) => log.push(m), warn: (m) => warn.push(m), childPath, ...opts });
  return { result, log, warn };
};

/** A stand-in replay process that answers one message, to drive the parent's handling of it. */
const fakeChild = (message: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'substrat-replay-child-')), 'child.mjs');
  writeFileSync(path, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(message))} + '\\n'));\n`);
  return path;
};

/**
 * The real replay child, behind a wrapper that writes the child's pid to a file, and — by
 * listening on the child's own progress lines — each migration as it starts: the process to
 * watch, by pid, on any platform, and the moment it is really running a given migration rather
 * than still reading its request. Liveness is `process.kill(pid, 0)` — ESRCH is gone; any other
 * error is not an answer, and throws.
 */
const pidRecordingChild = (): { path: string; pid: () => number | undefined; started: () => string } => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-replay-pid-'));
  const pidFile = join(dir, 'pid');
  const startedFile = join(dir, 'started');
  const path = join(dir, 'child.mjs');
  writeFileSync(
    path,
    [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'const write = fs.writeSync;',
      // The child's progress goes to fd 1 through writeSync; copy each `started` key aside.
      `fs.writeSync = (fd, data, ...rest) => { if (fd === 1) { try { const m = JSON.parse(String(data)); if (m.type === 'started') fs.appendFileSync(${JSON.stringify(startedFile)}, m.key + '\\n'); } catch {} } return write(fd, data, ...rest); };`,
      'syncBuiltinESMExports();',
      `await import(${JSON.stringify(pathToFileURL(childPath).href)});`,
    ].join('\n'),
  );
  return {
    path,
    pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined),
    started: () => (existsSync(startedFile) ? readFileSync(startedFile, 'utf8') : ''),
  };
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
};
const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (what()) return true;
  return what();
};

describe.runIf(ready)("the push's data-loss check, through the vertical's own kernel", () => {
  it('refuses an undeclared destructive migration with the fence message and the remedy', async () => {
    const { result } = await run(inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;' }]));
    await expect(result).rejects.toThrow(/data-loss check: REFUSED — migration notes@0002 would lose data/);
    await expect(result).rejects.toThrow(/discards: \{ 'notes': '<why this data may go>' \}/);
  });

  it('passes the declared version, printing each declaration with its reason', async () => {
    const { result, log, warn } = await run(inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;', discards: { notes: 'retired' } }]));
    await expect(result).resolves.toEqual({ status: 'passed', authored: 2 });
    expect(log).toEqual([
      'declared  notes@0002 discards notes: retired',
      'data-loss check: PASSED (2 authored migration(s) replayed against a populated scope)',
    ]);
    expect(warn).toEqual([]);
  });

  it('passes an additive migration', async () => {
    const { result } = await run(inputs([INIT, { version: '0002', sql: 'ALTER TABLE notes ADD COLUMN title TEXT;' }]));
    await expect(result).resolves.toEqual({ status: 'passed', authored: 2 });
  });

  it('a refusal is a refusal under --require-data-loss-check too', async () => {
    const drop = inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;' }]);
    await expect((await run(drop, { require: true })).result).rejects.toThrow(/REFUSED/);
  });

  it('an ATTACH is refused, and writes no file on the machine running the push', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'substrat-attach-')), 'leak.db');
    const { result } = await run(
      inputs([INIT, { version: '0002', sql: `ATTACH DATABASE '${file}' AS x; CREATE TABLE x.leak (a TEXT); INSERT INTO x.leak VALUES ('hi');` }]),
    );
    await expect(result).rejects.toThrow(/REFUSED — migration notes@0002: it attaches or detaches a database/);
    expect(existsSync(file)).toBe(false);
  });

  it('INCOMPLETE says how many migrations went unchecked after the one that could not run, and goes on', async () => {
    const { result, warn } = await run(
      inputs([
        INIT,
        { version: '0002', sql: "UPDATE notes SET body = json_extract(body, '$.text');" },
        { version: '0003', sql: 'DROP TABLE notes;' },
      ]),
    );
    await expect(result).resolves.toMatchObject({ status: 'incomplete', authored: 3, notReplayed: 2, key: 'notes@0002' });
    expect(warn[0]).toMatch(/^⚠ notes@0002 could not be replayed on synthetic data: .*json/i);
    expect(warn.at(-1)).toBe(
      '⚠ data-loss check: INCOMPLETE (2 of 3 authored migration(s) were not replayed after notes@0002 failed) — the fence still refuses at promote',
    );
  });

  it('INCOMPLETE refuses under --require-data-loss-check', async () => {
    const i = inputs([INIT, { version: '0002', sql: "UPDATE notes SET body = json_extract(body, '$.x');" }]);
    await expect((await run(i, { require: true })).result).rejects.toThrow(/INCOMPLETE.*\n--require-data-loss-check/);
  });

  it('a migration that never ends is stopped at the time limit: INCOMPLETE, naming it, and its process is gone', async () => {
    const forever: Migration = { version: '0002', sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c;' };
    const child = pidRecordingChild();
    const started = Date.now();
    const { result, warn } = await run(inputs([INIT, forever, { version: '0003', sql: 'DROP TABLE notes;' }]), {
      timeoutMs: 1500,
      childPath: child.path,
    });
    await expect(result).resolves.toMatchObject({ status: 'incomplete', authored: 3, notReplayed: 2, key: 'notes@0002' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(warn[0]).toMatch(/notes@0002 could not be replayed on synthetic data: it did not finish within 1\.5 s and was stopped/);
    // Killed, not abandoned: the answer comes once the replay process is gone.
    const pid = child.pid();
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid!)).toBe(false);
  }, 30_000);

  it('the time limit is per migration: a replay longer than it in total still passes', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ version: `00${i + 2}`, sql: `ALTER TABLE notes ADD COLUMN c${i} TEXT;` }));
    const { result } = await run(inputs([INIT, ...many]), { timeoutMs: 1500 });
    await expect(result).resolves.toEqual({ status: 'passed', authored: 7 });
  }, 30_000);

  it('builds the spine it is handed first; without it a spine read is INCOMPLETE and names the remedy', async () => {
    const reads: Migration = { version: '0002', sql: 'INSERT INTO notes (id, body) SELECT id, kind FROM _substrat_things;' };
    const spine = 'CREATE TABLE _substrat_things (id TEXT, kind TEXT);';
    await expect((await run(inputs([INIT, reads], { spineDdl: async () => spine }))).result).resolves.toMatchObject({ status: 'passed' });
    const without = await run(inputs([INIT, reads]));
    await expect(without.result).resolves.toMatchObject({ status: 'incomplete' });
    expect(without.warn.join('\n')).toContain('add @substrat-run/adapter-sqlite as a devDependency');
  });

  it('the replay process sees none of the environment', async () => {
    process.env.SUBSTRAT_REPLAY_PROBE = 'visible';
    try {
      // The child is started with an empty environment; a probe child would print what it sees.
      const probe = join(mkdtempSync(join(tmpdir(), 'substrat-replay-env-')), 'probe.mjs');
      writeFileSync(
        probe,
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'done', result: { kind: 'error', message: JSON.stringify(Object.keys(process.env)) } }) + '\\n'));\n`,
      );
      const r = await replayInChild({ kernelUrl, modules: [], deadlineMs: 60_000 }, { childPath: probe });
      expect(r).toMatchObject({ kind: 'error' });
      expect(JSON.parse((r as { message: string }).message)).not.toContain('SUBSTRAT_REPLAY_PROBE');
    } finally {
      delete process.env.SUBSTRAT_REPLAY_PROBE;
    }
  });
});

describe('what the replay process answers', () => {
  it('no node:sqlite is SKIPPED — loud on stderr, never silent, and not a refusal by default', async () => {
    const childPath = fakeChild({ type: 'done', result: { kind: 'no-sqlite' } });
    const i = inputs([INIT], { kernel: { MIGRATION_REPLAY_API: 1, replayMigrations: () => ({}) } });
    const { result, warn, log } = await run(i, { childPath });
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    expect(warn).toEqual([`⚠ data-loss check: SKIPPED (node:sqlite unavailable on Node ${process.versions.node}; it needs 22.13 or later) — the fence still refuses at promote`]);
    expect(log).toEqual([]);
    await expect((await run(i, { childPath, require: true })).result).rejects.toThrow(/SKIPPED \(node:sqlite unavailable/);
  });

  it('a process that ends without an answer is SKIPPED, with what it said', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'substrat-replay-crash-')), 'child.mjs');
    writeFileSync(path, "console.error('boom'); process.exit(3);\n");
    const i = inputs([INIT], { kernel: { MIGRATION_REPLAY_API: 1, replayMigrations: () => ({}) } });
    const { result, warn } = await run(i, { childPath: path });
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    expect(warn.join('\n')).toMatch(/the replay itself failed: the replay process ended \(exit 3\) without an answer: boom/);
  });

  it('nothing authored starts no replay at all', async () => {
    const { result } = await run(inputs([]), { childPath: '/nonexistent/child.js', require: true });
    await expect(result).resolves.toEqual({ status: 'passed', authored: 0 });
  });
});

describe('a kernel this CLI cannot call is SKIPPED, by feature detection', () => {
  const skipped = async (over: Partial<ReplayInputs>) => {
    const { result, warn } = await run(inputs([INIT], over), { childPath: fakeChild({ type: 'done', result: { kind: 'outcome', outcome: { ok: true } } }) });
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    return warn.join('\n');
  };
  it('no kernel resolves', async () => {
    expect(await skipped({ kernel: null })).toContain('no @substrat-run/kernel resolves from the vertical');
    expect(await skipped({ kernel: { MIGRATION_REPLAY_API: 1, replayMigrations: () => ({}) }, kernelUrl: null })).toContain(
      'no @substrat-run/kernel resolves from the vertical',
    );
  });
  it('a kernel from before the replay', async () => {
    expect(await skipped({ kernel: { moduleMigrations: () => [] } })).toContain('has no migration replay (upgrade it)');
  });
  it('a kernel with a replay API this CLI does not know', async () => {
    expect(await skipped({ kernel: { MIGRATION_REPLAY_API: 2, replayMigrations: () => ({}) } })).toContain(
      'replay API 2, this CLI calls 1 (upgrade the CLI)',
    );
  });
  it('a kernel whose replay returns an outcome of another shape', async () => {
    expect(await skipped({ kernel: { MIGRATION_REPLAY_API: 1, replayMigrations: () => ({}) } })).toContain(
      'returned a replay outcome this CLI does not recognise',
    );
  });
});

describe('the strict switch', () => {
  it('is the flag, or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK set to 1, true or yes in any case', () => {
    const warned: string[] = [];
    const required = (env: NodeJS.ProcessEnv, argv = ['push']) => dataLossCheckRequired(argv, env, (m) => warned.push(m));
    expect(required({}, ['push', '--require-data-loss-check'])).toBe(true);
    for (const yes of ['1', 'true', 'TRUE', 'Yes', ' yes ']) expect(required({ SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: yes })).toBe(true);
    for (const no of ['', '0', 'false', 'No']) expect(required({ SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: no })).toBe(false);
    expect(required({})).toBe(false);
    expect(warned).toEqual([]);
  });

  it('an unrecognised value is read as no, out loud', () => {
    const warned: string[] = [];
    expect(dataLossCheckRequired(['push'], { SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: 'on' }, (m) => warned.push(m))).toBe(false);
    expect(warned).toEqual([
      '⚠ SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=on is not one of 1/true/yes or 0/false/no — read as no, so the data-loss check stays optional',
    ]);
  });

  it('formats every outcome as one summary line', () => {
    expect(formatDataLossCheck({ status: 'passed', authored: 3 })).toBe(
      'data-loss check: PASSED (3 authored migration(s) replayed against a populated scope)',
    );
    expect(formatDataLossCheck({ status: 'skipped', why: 'x' })).toBe('data-loss check: SKIPPED (x) — the fence still refuses at promote');
  });
});

describe.runIf(ready)('the replay process does not outlive the push that started it', () => {
  const checkJs = fileURLToPath(new URL('../dist/data-loss-check.js', import.meta.url));
  const FOREVER = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c;';

  /** A push stand-in running one endless migration in a replay child whose pid it records. */
  const parentRunningForever = () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-replay-orphan-'));
    const child = pidRecordingChild();
    const parent = join(dir, 'parent.mjs');
    writeFileSync(
      parent,
      `import { checkMigrationDataLoss } from ${JSON.stringify(pathToFileURL(checkJs).href)};
const kernel = await import(${JSON.stringify(kernelUrl)});
await checkMigrationDataLoss(
  { kernel, kernelUrl: ${JSON.stringify(kernelUrl)}, modules: [{ manifest: { id: 'notes' }, migrations: ${JSON.stringify([INIT, { version: '0002', sql: FOREVER }])} }], spineDdl: async () => undefined },
  { childPath: ${JSON.stringify(child.path)}, timeoutMs: 600000 },
);
`,
    );
    return { child, process: spawn(process.execPath, [parent], { stdio: 'ignore' }) };
  };

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`a push killed with ${signal}, the replay's pid alone, takes the replay with it`, async () => {
      const { child, process: parent } = parentRunningForever();
      try {
        // The replay is running the endless migration — not still reading its request, which a
        // dead parent would end by itself — before the push is killed.
        expect(await until(() => child.started().includes('notes@0002'), 15_000)).toBe(true);
        const pid = child.pid()!;
        expect(alive(pid)).toBe(true);
        parent.kill(signal);
        // The watchdog polls every 200 ms; a few seconds is generous under load.
        expect(await until(() => !alive(pid), 10_000)).toBe(true);
      } finally {
        parent.kill('SIGKILL');
        const pid = child.pid();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 40_000);
  }
});

describe.runIf(ready)('the replay process kills itself at its hard deadline', () => {
  it('whatever the parent is waiting for: the backstop behind the per-migration limit', async () => {
    const forever = { version: '0002', sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c;' };
    const r = await replayInChild(
      { kernelUrl, modules: [{ manifest: { id: 'notes' }, migrations: [INIT, forever] }], deadlineMs: 1500 },
      { childPath, timeoutMs: 600_000 },
    );
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/the replay process ended \(SIGKILL\) without an answer/);
  }, 30_000);
});

describe.runIf(ready)('the time limit is per migration', () => {
  /** A migration that runs about `ms` on this machine: a bounded recursive CTE, calibrated here. */
  const migrationTaking = (() => {
    let perRow: number | undefined;
    return async (ms: number, version: string): Promise<Migration> => {
      if (perRow === undefined) {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        const rows = 2_000_000;
        const t0 = performance.now();
        db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT count(*) FROM c;`);
        perRow = (performance.now() - t0) / rows;
      }
      const n = Math.max(1, Math.round(ms / perRow));
      return { version, sql: `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT count(*) FROM c;` };
    };
  })();

  it('three migrations each at about half the limit pass, though together they run past it', async () => {
    const limit = 4000;
    const slow = await Promise.all(['0002', '0003', '0004'].map((v) => migrationTaking(limit / 2, v)));
    const started = Date.now();
    const { result } = await run(inputs([INIT, ...slow]), { timeoutMs: limit });
    await expect(result).resolves.toEqual({ status: 'passed', authored: 4 });
    // The point of the test: the replay as a whole took longer than one migration may.
    expect(Date.now() - started).toBeGreaterThan(limit);
  }, 60_000);
});
