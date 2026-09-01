/**
 * Read a FAILED control-plane response the way the control plane writes one (#971).
 *
 * The transport has spoken RFC 9457 `application/problem+json` since #113 phase 4 —
 * `type`, `title`, `status`, a `detail` sentence written for this occurrence, a `code`
 * from the closed taxonomy, and, on a validation failure, the offending fields. The CLI
 * read none of it: `push` pulled the deprecated `{ error }` duplicate and every other
 * command printed the first 200-300 characters of the raw body, so a 400 that named the
 * field it refused arrived as a wall of escaped JSON and a 403 arrived without the
 * permission key it had been handed.
 *
 * One reader, used by every command, so the shape a builder sees does not depend on
 * which one they ran. It degrades in the order the surfaces were built:
 *
 * 1. a problem document — `detail` (else `title`), the `code`, and the field errors;
 * 2. `{ error }` — the pre-#113 body, still what an older deployed control plane and
 *    several hand-rolled `onError`s answer with, including its top-level `issues` array
 *    (the raw Zod refusal: `{ error: 'invalid request', issues }`, where the `error`
 *    alone names nothing a builder can fix);
 * 3. anything else — a slice of the raw body, which is at least the truth.
 */
import { problem as problemSchema } from '@substrat-run/contracts';
import { explainPlatformFault } from './http.js';

/** How much of an unrecognised body is worth printing before it stops being a message. */
const RAW_BODY_LIMIT = 300;

/** What a failed response said, once. */
export interface ProblemSummary {
  /** The human sentence to print. `''` when the body carried nothing readable. */
  detail: string;
  /** The taxonomy entry, when the body named one — `conflict`, `permission_denied`, … */
  code?: string;
  /** The stable per-code title, when present. */
  title?: string;
  /** Field-level complaints from a `validation_failed`, in the order the server sent. */
  errors?: Array<{ path: string; message: string }>;
}

/**
 * The pre-#113 validation body's field complaints, in the shape a problem document uses.
 *
 * A control plane that has not adopted `toProblem` answers a Zod refusal with
 * `{ error: 'invalid request', issues: [...] }` — the sentence says nothing and the array
 * says everything. `issues` entries are Zod's own (`path: ['tag']`, `message`), so they
 * map onto `errors` one for one; an entry in some other shape is kept as its own text
 * rather than dropped, because a message nobody can read still beats one nobody sees.
 */
function legacyIssues(parsed: unknown): Array<{ path: string; message: string }> | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = (parsed as Record<string, unknown>).issues;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((issue) => {
    if (issue !== null && typeof issue === 'object') {
      const o = issue as Record<string, unknown>;
      const path = Array.isArray(o.path) ? o.path.join('.') : typeof o.path === 'string' ? o.path : '';
      if (typeof o.message === 'string' && o.message) return { path, message: o.message };
    }
    return { path: '', message: typeof issue === 'string' ? issue : JSON.stringify(issue) };
  });
}

/**
 * Parse a response body into what it actually says.
 *
 * The strict pass is the published schema (`problem` in `@substrat-run/contracts`) rather
 * than a hand-read of the same fields, so the CLI cannot drift from the document the
 * control plane emits. A body that misses a required member — a relayed error from
 * something in front of the control plane, an older deployment — falls through to the
 * lenient reads below instead of being discarded.
 */
export function readProblem(body: string): ProblemSummary {
  const raw = body.trim();
  if (raw === '') return { detail: '' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { detail: raw.slice(0, RAW_BODY_LIMIT) };
  }

  // The field complaints, wherever this body happens to carry them: `errors` is the
  // contract's member, `issues` the pre-#113 one, and a body may carry either.
  const issues = legacyIssues(parsed);

  const strict = problemSchema.safeParse(parsed);
  if (strict.success) {
    const p = strict.data;
    const errors = p.errors && p.errors.length > 0 ? p.errors : issues;
    return {
      detail: p.detail ?? p.error ?? p.title,
      code: p.code,
      title: p.title,
      ...(errors ? { errors } : {}),
    };
  }

  // Not a whole problem document. Read the members that ARE there, in the order of
  // how specific they are: `detail` is about this occurrence, `error` is the
  // deprecated duplicate of it, `title` is the class of failure.
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);
    const detail = str('detail') ?? str('error') ?? str('message') ?? str('title');
    if (detail !== undefined || issues) {
      return {
        detail: detail ?? '',
        ...(str('code') ? { code: str('code') } : {}),
        ...(str('title') ? { title: str('title') } : {}),
        ...(issues ? { errors: issues } : {}),
      };
    }
  }
  return { detail: raw.slice(0, RAW_BODY_LIMIT) };
}

/**
 * The one line (or short block) a command prints when the control plane refuses.
 *
 * `action` is what the CLI was doing — 'push failed', 'promote failed' — so the message
 * still names the command, and the status and code name the refusal. The Cloudflare
 * redacted-fault note (#559) rides along here rather than at one call site, because a
 * platform fault is not particular to `push`.
 */
export function failureMessage(action: string, status: number, body: string): string {
  const p = readProblem(body);
  const head = `${action} (${status}${p.code ? ` ${p.code}` : ''})`;
  const lines = [p.detail ? `${head}: ${p.detail}` : head];
  for (const e of p.errors ?? []) lines.push(`  ${e.path || '(root)'}: ${e.message}`);
  return lines.join('\n') + explainPlatformFault(status, p.detail);
}
