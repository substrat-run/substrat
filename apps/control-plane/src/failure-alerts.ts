import type { OpsFailureEntry, PlatformActorId } from '@substrat-run/contracts';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import type { HostAdmin, PlatformSweepReport } from '@substrat-run/kernel';

/**
 * The staff failure digest (#1416, first slice) — the one thing in the observability
 * stack that TELLS somebody instead of waiting to be looked at.
 *
 * Every failure the platform records lands in the ops-failure ledger
 * (`_substrat_ops_failures`), where the console's Issues view can read it — if a
 * person opens the console. Nothing pushed. This phase runs at the end of the
 * scheduled pass, reads the ledger since the previous pass, folds in the pass's own
 * `report.errors`, and sends ONE email to the opted-in staff address. Per pass, never
 * per failure: a burst of a hundred identical refusals is one message with a count,
 * not a hundred messages.
 *
 * Deliberately narrow, and each narrowing is a choice a reviewer can overturn:
 *   - STAFF only. A tenant-facing notification needs a recipient model and a
 *     preference surface the dashboard does not have; this is the platform telling
 *     its own operators.
 *   - The control plane's existing email transport, not a notification service
 *     (#118). One channel that already works beats a channel abstraction with one
 *     implementation.
 *   - The STORED record only — the ops-failure ledger and the pass's in-memory
 *     errors. No metric threshold, no Cloudflare Analytics query: those need a
 *     definition of "abnormal" nobody has written yet.
 *   - OPT-IN. `STAFF_ALERT_EMAIL` unset ⇒ the phase does nothing, so a deployment
 *     that has not asked for mail gets none, exactly the posture the retention
 *     windows and the backup phase take.
 *
 * The watermark is the previous pass's sweep-run trace (#1232) — the durable mark
 * every pass leaves — so "since the previous pass" is read from storage rather than
 * remembered by an isolate that does not persist. It is read BEFORE the sweep runs
 * (`failureDigestWatermark`, then `sendFailureDigest` after): a drained CP-less
 * batch written during this pass carries the `at` its vertical stamped, which can
 * sit later than the previous pass's own rows, and reading it as "the previous
 * pass" would move the window past failures nobody has mailed. It is capped from
 * below at one cron interval before this pass began: with no sweep-run rows at all
 * (a deployment with nothing to sweep) the window would otherwise be unbounded, and
 * the same failures would be re-sent every quarter hour. The residual imprecision
 * is at the edge and is deliberate in the alerting direction — a failure recorded
 * in the previous pass's tail, after its last sweep-run row, is reported twice,
 * never zero times. The ledger, not the mail, is the record.
 */

/** The cron cadence in `wrangler.jsonc` (`*\/15 * * * *`) — the first-run and no-rows fallback window. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** How many failures the digest lists in full before it counts the rest. */
const DIGEST_ROW_CAP = 50;

/**
 * How many of the most recently WRITTEN sweep-run rows the watermark considers. A
 * row's id is a ULID stamped at write time while its `at` may be older (a drained
 * batch carries the pass time its vertical stamped), so the newest row by id is not
 * always the newest `at`; the max over the previous pass's tail is.
 */
const WATERMARK_ROWS = 25;

/** The ledger a digest reads, and the one it writes its own failures to. */
export type FailureDigestAdmin = Pick<HostAdmin, 'listOpsFailures' | 'listSweepRuns' | 'recordOpsFailure'>;

export interface FailureDigestOptions {
  admin: FailureDigestAdmin;
  actor: PlatformActorId;
  transport: EmailTransport;
  from: EmailAddress;
  /** The raw `STAFF_ALERT_EMAIL` value — comma-separated addresses; blank/unset ⇒ skipped. */
  recipients: string | undefined;
  /** The lower bound of the window — `failureDigestWatermark`, read before the sweep. */
  since: string;
  /** The pass's own per-unit failures, which live in memory only until they are mailed. */
  reportErrors: PlatformSweepReport['errors'];
  /** Where the digest says the reader can look — the console origin, when known. */
  consoleUrl?: string;
  /** The clock; injectable so a test can pin the window. */
  now?: () => Date;
}

export type FailureDigestOutcome =
  | { status: 'skipped'; reason: 'no-recipient' | 'nothing-to-report' }
  | { status: 'sent'; since: string; failures: number; reportErrors: number; to: string[] }
  | { status: 'failed'; since: string; error: string };

/**
 * The lower bound of this pass's window, read BEFORE the sweep so nothing this pass
 * writes can be mistaken for the previous one: the newest `at` among the last few
 * sweep-run rows written, floored at one cron interval before the pass. A read that
 * fails falls back to the floor rather than failing the phase — one interval of
 * failures is still mailed — and is recorded as a ledger row of its own, so the
 * digest it feeds carries it.
 */
export async function failureDigestWatermark(opts: {
  admin: FailureDigestAdmin;
  actor: PlatformActorId;
  /** When this pass begins — the floor is one cron interval before it. */
  passStartedAt: Date;
}): Promise<string> {
  const floor = new Date(opts.passStartedAt.getTime() - SWEEP_INTERVAL_MS).toISOString();
  let previous: string | undefined;
  try {
    const rows = await opts.admin.listSweepRuns(opts.actor, { limit: WATERMARK_ROWS });
    for (const row of rows) if (previous === undefined || row.at > previous) previous = row.at;
  } catch (err) {
    await recordOwnFailure(opts, 'watermark', messageOf(err));
    previous = undefined;
  }
  return previous !== undefined && previous > floor ? previous : floor;
}

/**
 * The phase. Never throws: a send failure is recorded as an ops failure of its own
 * (so the NEXT digest carries it, and the Issues view shows it) and returned, and the
 * pass it rides on is never sunk by its reporter — the recorder's own rule.
 */
export async function sendFailureDigest(opts: FailureDigestOptions): Promise<FailureDigestOutcome> {
  const to = parseRecipients(opts.recipients);
  if (to.length === 0) return { status: 'skipped', reason: 'no-recipient' };

  const now = opts.now ?? (() => new Date());
  const { since } = opts;
  let failures: OpsFailureEntry[];
  try {
    failures = await opts.admin.listOpsFailures(opts.actor, { since, order: 'asc' });
  } catch (err) {
    // A ledger that cannot be read is itself a failure worth a row — but the mail is
    // what cannot be trusted now, so say so rather than sending a digest that reads
    // "nothing happened" over a read that failed.
    const error = messageOf(err);
    await recordOwnFailure(opts, 'read', error);
    return { status: 'failed', since, error };
  }

  if (failures.length === 0 && opts.reportErrors.length === 0) {
    return { status: 'skipped', reason: 'nothing-to-report' };
  }

  const message = failureDigestEmail({
    to,
    from: opts.from,
    since,
    until: now().toISOString(),
    failures,
    reportErrors: opts.reportErrors,
    consoleUrl: opts.consoleUrl,
  });
  try {
    await opts.transport.send(message);
  } catch (err) {
    const error = messageOf(err);
    await recordOwnFailure(opts, 'send', error);
    return { status: 'failed', since, error };
  }
  return { status: 'sent', since, failures: failures.length, reportErrors: opts.reportErrors.length, to };
}

/**
 * Awaited, not fire-and-forget: the scheduled handler returns as soon as the phase
 * does, and a row still in flight at that point may never land. The recorder's own
 * failure is swallowed so it cannot mask the phase's answer — the rule the drain's
 * recorder follows — but the write is given the chance to finish.
 */
async function recordOwnFailure(
  opts: { admin: FailureDigestAdmin; actor: PlatformActorId },
  stage: 'watermark' | 'read' | 'send',
  error: string,
): Promise<void> {
  try {
    await opts.admin.recordOpsFailure({ actor: opts.actor, operation: 'alerts.digest', stage, message: error });
  } catch {
    // deliberately swallowed — see above
  }
}

/** Comma-separated addresses; whitespace tolerated, empties dropped. */
export function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface FailureDigestInput {
  to: string[];
  from: EmailAddress;
  since: string;
  until: string;
  failures: readonly OpsFailureEntry[];
  reportErrors: PlatformSweepReport['errors'];
  consoleUrl?: string;
}

/**
 * The message. Both parts always (the transport port enforces it); the text part is
 * the one a pager-style reader sees, so it carries every fact the html does. Each
 * row is one failure: when, what operation and stage, which vertical, how it was
 * refused (status/code) and the message — the same columns the Issues view groups
 * by, so a reader can find the row again.
 */
export function failureDigestEmail(input: FailureDigestInput) {
  const total = input.failures.length + input.reportErrors.length;
  const subject = `[substrat] ${total} failure${total === 1 ? '' : 's'} since ${input.since}`;

  const failureLines = input.failures.slice(0, DIGEST_ROW_CAP).map(failureLine);
  const errorLines = input.reportErrors.slice(0, DIGEST_ROW_CAP).map(
    (e) => `${e.kind} ${e.id}: ${e.error}`,
  );
  const failuresMore = Math.max(0, input.failures.length - DIGEST_ROW_CAP);
  const errorsMore = Math.max(0, input.reportErrors.length - DIGEST_ROW_CAP);

  const textSections: string[] = [
    `The platform sweep recorded ${total} failure${total === 1 ? '' : 's'} between ${input.since} and ${input.until}.`,
  ];
  if (input.failures.length > 0) {
    textSections.push(
      `Ops failures (${input.failures.length}):`,
      ...failureLines.map((l) => `  - ${l}`),
      ...(failuresMore > 0 ? [`  … and ${failuresMore} more`] : []),
    );
  }
  if (input.reportErrors.length > 0) {
    textSections.push(
      `Sweep errors this pass (${input.reportErrors.length}):`,
      ...errorLines.map((l) => `  - ${l}`),
      ...(errorsMore > 0 ? [`  … and ${errorsMore} more`] : []),
    );
  }
  if (input.consoleUrl) textSections.push(`Console: ${input.consoleUrl}`);
  textSections.push(
    'You receive this because STAFF_ALERT_EMAIL on the control plane names this address; unset it to stop.',
  );
  const text = textSections.join('\n\n');

  const list = (lines: string[], more: number) =>
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}${
      more > 0 ? `<li>… and ${more} more</li>` : ''
    }</ul>`;
  const html = [
    `<p>${escapeHtml(textSections[0]!)}</p>`,
    input.failures.length > 0
      ? `<p><strong>Ops failures (${input.failures.length})</strong></p>${list(failureLines, failuresMore)}`
      : '',
    input.reportErrors.length > 0
      ? `<p><strong>Sweep errors this pass (${input.reportErrors.length})</strong></p>${list(errorLines, errorsMore)}`
      : '',
    input.consoleUrl
      ? `<p><a href="${escapeAttr(input.consoleUrl)}">${escapeHtml(input.consoleUrl)}</a></p>`
      : '',
    `<p style="color:#6b6b6b">${escapeHtml(textSections[textSections.length - 1]!)}</p>`,
  ].join('');

  return { to: input.to, from: input.from, subject, text, html };
}

function failureLine(f: OpsFailureEntry): string {
  const where = [f.operation, f.stage].filter(Boolean).join('/');
  const refusal = [f.status !== null ? String(f.status) : null, f.code, f.origin].filter(Boolean).join(' ');
  const parts = [
    f.at,
    where,
    f.vertical ? `vertical=${f.vertical}` : null,
    f.tenantId ? `tenant=${f.tenantId}` : null,
    refusal ? `[${refusal}]` : null,
    truncate(f.message, 200),
    f.reference ? `reference=${f.reference}` : null,
  ];
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
