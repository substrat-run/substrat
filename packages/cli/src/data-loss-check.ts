/**
 * The data-loss check a push makes before upload (#2321): the vertical's authored migrations,
 * replayed against an in-memory scope that holds data, through the data-loss fence (#115).
 *
 * The fence refuses, at apply, a migration that would lose data a scope holds and does not
 * declare it — which closes every populated scope until a fixed version ships. In this repository
 * `lint:migration-fence` asks the question in the pull request; a vertical built anywhere else
 * has only this, the push, as the earlier and cheaper place to hear no.
 *
 * The replay is the VERTICAL's own kernel's (`replayMigrations`), reached at run time the way
 * `moduleMigrations` is (#1677): it is the copy of the fence the vertical's scopes run at apply,
 * so it is the one whose answer matters, and this CLI stays Apache-2.0 with no kernel dependency.
 * What this module supplies is only what the kernel does not import: an empty in-memory SQLite
 * (`node:sqlite`), and the platform's spine tables from the vertical's own
 * `@substrat-run/adapter-sqlite`, when it has one, for an authored migration that reads them.
 *
 * It runs in a process of its own (`data-loss-replay-child.ts`), with an empty environment and a
 * time limit per migration, because a runaway statement — a recursive CTE with no end — runs in
 * native code nothing in this process could interrupt. The fence refuses ATTACH, so the replay
 * never reaches a file; it opens no network connection and reads none of the vertical's data.
 *
 * Three outcomes, never confused:
 * - REFUSED — the fence would refuse a migration. The push stops, with the fence's own message
 *   naming the declaration (`moves` / `discards`) to add. There is no flag past it: a `discards`
 *   entry with its reason is the reviewed way to lose data on purpose.
 * - INCOMPLETE — a migration could not be run on synthetic rows at all (its SQL needs real input,
 *   reads a spine table this CLI could not build, or did not finish in time). The replay stops
 *   there, so the migrations after it go unchecked, and the warning says how many.
 * - SKIPPED — nothing could be replayed: no `node:sqlite` (Node before 22.13), or a kernel with
 *   no replay this CLI knows how to call.
 * The last two do not refuse by default — promote is the hard gate, and the fence still refuses
 * there — unless the caller asks for the guarantee (`--require-data-loss-check`).
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ChildMessage, ReplayRequest } from './data-loss-replay-child.js';

/** The replay API this CLI calls — `MIGRATION_REPLAY_API` in `@substrat-run/kernel`. */
const REPLAY_API = 1;

/**
 * How long one migration may run. A Durable Object would stop a migration that ran this long
 * on its own CPU limit, so a replay that has not finished by then is not one worth waiting for.
 */
export const MIGRATION_TIMEOUT_MS = 30_000;

/** What the push hands over: read off the same import that yields the permission surface. */
export interface ReplayInputs {
  /** The vertical's own `@substrat-run/kernel`, as imported from its directory, or null. */
  readonly kernel: unknown;
  /** Where that kernel resolves, for the replay's own process to import — or null. */
  readonly kernelUrl: string | null;
  /** The permission entry's `modules`, each a registration carrying its `migrations`. */
  readonly modules: readonly unknown[];
  /** The vertical's adapter-sqlite `SCOPE_SPINE_DDL`, resolved only when a replay runs. */
  readonly spineDdl: () => Promise<string | undefined>;
}

export type DataLossCheck =
  | { readonly status: 'passed'; readonly authored: number }
  | { readonly status: 'skipped'; readonly why: string }
  | {
      readonly status: 'incomplete';
      readonly authored: number;
      readonly notReplayed: number;
      readonly key: string;
      readonly message: string;
    };

interface KernelReplay {
  readonly MIGRATION_REPLAY_API?: unknown;
  readonly replayMigrations?: unknown;
}

interface ReplayOutcome {
  readonly authored: number;
  readonly passed: number;
  readonly refused?: { readonly key: string; readonly message: string };
  readonly failed?: { readonly key: string; readonly message: string };
  readonly declared: readonly string[];
}

const isOutcome = (o: unknown): o is ReplayOutcome => {
  const r = o as ReplayOutcome | null;
  const stop = (s: unknown) =>
    s === undefined || (typeof (s as { key?: unknown }).key === 'string' && typeof (s as { message?: unknown }).message === 'string');
  return (
    typeof r === 'object' && r !== null &&
    typeof r.authored === 'number' && typeof r.passed === 'number' &&
    Array.isArray(r.declared) && r.declared.every((d) => typeof d === 'string') &&
    stop(r.refused) && stop(r.failed)
  );
};

type ChildResult =
  | Extract<ChildMessage, { type: 'done' }>['result']
  | { readonly kind: 'timeout'; readonly key: string | undefined; readonly passed: number };

/** The built child, beside this module in `dist`. */
const CHILD = fileURLToPath(new URL('./data-loss-replay-child.js', import.meta.url));

/**
 * Run the replay in its own process, killing it when one migration runs past `timeoutMs`. Each
 * `started` line restarts the clock, so the limit is per migration, and says which one was
 * running when it fired and how many authored migrations had passed before it.
 */
export function replayInChild(
  request: ReplayRequest,
  opts: { readonly childPath?: string; readonly timeoutMs?: number } = {},
): Promise<ChildResult> {
  const timeoutMs = opts.timeoutMs ?? MIGRATION_TIMEOUT_MS;
  // The child's stderr is kept, never forwarded: node's notice that `node:sqlite` is experimental
  // stays out of the push log, and only a process that dies without answering is shown it.
  const child = spawn(process.execPath, [opts.childPath ?? CHILD], {
    cwd: tmpdir(),
    // Nothing of the pusher's environment: the replay needs none of it.
    env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolveResult) => {
    let settled = false;
    let key: string | undefined;
    let authoredStarted = 0;
    let runningAuthored = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    // A push that ends any other way — it exits, throws, or is killed by a signal, SIGKILL
    // included — takes the replay with it through the child's own watchdog
    // (`data-loss-replay-child.ts`), which no handler here could do for SIGKILL. On POSIX; on
    // Windows, where an orphan is not re-parented, only the child's hard deadline stops it.
    const settle = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveResult(result);
        return;
      }
      // Answered only once the process is gone, so nothing the replay started outlives it.
      child.once('exit', () => resolveResult(result));
      child.kill('SIGKILL');
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => settle({ kind: 'timeout', key, passed: authoredStarted - (runningAuthored ? 1 : 0) }), timeoutMs);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        let message: ChildMessage;
        try {
          message = JSON.parse(line) as ChildMessage;
        } catch {
          continue;
        }
        if (message.type === 'started') {
          key = message.key;
          runningAuthored = message.authored;
          if (message.authored) authoredStarted += 1;
          arm();
        } else if (message.type === 'done') {
          settle(message.result);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', (e) => settle({ kind: 'error', message: e.message }));
    // `close`, not `exit`: it fires once stdout has drained, so a last `done` line is never lost.
    child.on('close', (code, signal) =>
      settle({ kind: 'error', message: `the replay process ended (${signal ?? `exit ${code}`}) without an answer${stderr ? `: ${stderr.trim()}` : ''}` }),
    );
    arm();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

const DOCS = 'see https://substrat.net/concepts/deploying ("A migration cannot quietly lose data")';

const TRUTHY = /^(1|true|yes)$/i;
const FALSY = /^(0|false|no)?$/i;

/**
 * Is the check required to have run: the flag, or `SUBSTRAT_REQUIRE_DATA_LOSS_CHECK` set to `1`,
 * `true` or `yes` (any case). Any other non-empty value is warned about rather than read as no,
 * because a CI job that meant yes would otherwise get the permissive default without a word.
 */
export function dataLossCheckRequired(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error,
): boolean {
  if (argv.includes('--require-data-loss-check')) return true;
  const value = (env.SUBSTRAT_REQUIRE_DATA_LOSS_CHECK ?? '').trim();
  if (TRUTHY.test(value)) return true;
  if (!FALSY.test(value)) {
    warn(
      `⚠ SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=${value} is not one of 1/true/yes or 0/false/no — read as no, so the data-loss check stays optional`,
    );
  }
  return false;
}

/** The one summary line, the same in the check's own output and the push's last line. */
export function formatDataLossCheck(check: DataLossCheck): string {
  switch (check.status) {
    case 'passed':
      return `data-loss check: PASSED (${check.authored} authored migration(s) replayed against a populated scope)`;
    case 'skipped':
      return `data-loss check: SKIPPED (${check.why}) — the fence still refuses at promote`;
    case 'incomplete':
      return (
        `data-loss check: INCOMPLETE (${check.notReplayed} of ${check.authored} authored migration(s) were not replayed ` +
        `after ${check.key} failed) — the fence still refuses at promote`
      );
  }
}

/**
 * Replay the vertical's migrations through its own kernel's fence. Throws when the fence would
 * refuse one, and — with `require` — when the check was skipped or incomplete. Otherwise returns
 * the outcome, having printed each declared move and discard with its reason (`log`) and the
 * summary (`log` when passed, `warn` — stderr — when it is not).
 */
export async function checkMigrationDataLoss(
  inputs: ReplayInputs,
  opts: {
    readonly require?: boolean;
    readonly log?: (message: string) => void;
    readonly warn?: (message: string) => void;
    /** The replay process's entry and per-migration limit; the defaults are the shipped ones. */
    readonly childPath?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<DataLossCheck> {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;
  const check = await replay(inputs, opts, log);
  const line = formatDataLossCheck(check);
  if (check.status === 'passed') {
    log(line);
    return check;
  }
  if (check.status === 'incomplete') {
    warn(`⚠ ${check.key} could not be replayed on synthetic data: ${check.message}`);
    if (/no such table: _substrat_/i.test(check.message)) {
      warn(
        '  it reads a platform table this CLI could not build: add @substrat-run/adapter-sqlite as a devDependency ' +
          'so the replay can create them.',
      );
    }
  }
  if (opts.require) {
    throw new Error(`${line}.\n--require-data-loss-check (or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1) refuses a push it could not fully check.`);
  }
  warn(`⚠ ${line}`);
  return check;
}

async function replay(
  inputs: ReplayInputs,
  opts: { readonly childPath?: string; readonly timeoutMs?: number },
  log: (message: string) => void,
): Promise<DataLossCheck> {
  const kernel = inputs.kernel as KernelReplay | null;
  const authoredCount = inputs.modules.reduce<number>((n, m) => {
    const migrations = (m as { migrations?: unknown }).migrations;
    return n + (Array.isArray(migrations) ? migrations.length : 0);
  }, 0);
  // Nothing authored, nothing the fence judges — and no reason to need SQLite.
  if (authoredCount === 0) return { status: 'passed', authored: 0 };
  if (!kernel || !inputs.kernelUrl) return { status: 'skipped', why: 'no @substrat-run/kernel resolves from the vertical' };
  if (typeof kernel.replayMigrations !== 'function') {
    return { status: 'skipped', why: "the vertical's @substrat-run/kernel has no migration replay (upgrade it)" };
  }
  if (kernel.MIGRATION_REPLAY_API !== REPLAY_API) {
    return {
      status: 'skipped',
      why: `the vertical's @substrat-run/kernel has migration replay API ${String(kernel.MIGRATION_REPLAY_API)}, this CLI calls ${REPLAY_API} (upgrade the CLI)`,
    };
  }
  // The registrations as data — what the replay reads of them, without the handlers no
  // process boundary can carry.
  const modules = JSON.parse(
    JSON.stringify(inputs.modules.map((m) => ({ manifest: (m as { manifest?: unknown }).manifest, migrations: (m as { migrations?: unknown }).migrations }))),
  ) as unknown[];
  const timeoutMs = opts.timeoutMs ?? MIGRATION_TIMEOUT_MS;
  // The child's own backstop, far past anything the per-migration limit allows: every authored
  // migration and up to three derived ones per module (search, entity state, list), each at the
  // limit, plus one for the start.
  const deadlineMs = timeoutMs * (authoredCount + 3 * modules.length + 1);
  const result = await replayInChild(
    { kernelUrl: inputs.kernelUrl, modules, spineDdl: await inputs.spineDdl(), deadlineMs },
    { ...opts, timeoutMs },
  );
  if (result.kind === 'no-sqlite') {
    return { status: 'skipped', why: `node:sqlite unavailable on Node ${process.versions.node}; it needs 22.13 or later` };
  }
  if (result.kind === 'error') return { status: 'skipped', why: `the replay itself failed: ${result.message}` };
  if (result.kind === 'timeout') {
    return {
      status: 'incomplete',
      authored: authoredCount,
      notReplayed: authoredCount - result.passed,
      key: result.key ?? 'the replay',
      message:
        `it did not finish within ${timeoutMs / 1000} s and was stopped — a statement with no end, such as a recursive CTE ` +
        "without a limit? A Durable Object's own CPU limit would stop it at promote too",
    };
  }
  const outcome = result.outcome;
  if (!isOutcome(outcome)) return { status: 'skipped', why: "the vertical's kernel returned a replay outcome this CLI does not recognise" };
  for (const line of outcome.declared) log(`declared  ${line}`);
  if (outcome.refused) {
    throw new Error(
      `data-loss check: REFUSED — ${outcome.refused.message}\n` +
        'A scope holding that data would refuse this migration at promote and fail closed. Fix the migration, or ' +
        `declare the loss on it (\`moves\` / \`discards\`, with its reason) for review — ${DOCS}.`,
    );
  }
  if (outcome.failed) {
    return {
      status: 'incomplete',
      authored: outcome.authored,
      notReplayed: outcome.authored - outcome.passed,
      key: outcome.failed.key,
      message: outcome.failed.message,
    };
  }
  return { status: 'passed', authored: outcome.authored };
}
