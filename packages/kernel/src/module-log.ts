/**
 * `ctx.log` — the structured logger module code writes through (#1746, #1747).
 *
 * ## Why module code needs one
 *
 * The invocation line (`invocation-line.ts`, which vertical-host writes per request) is the
 * per-request record: which operation ran, who ran it, how it ended. A vertical's own
 * `console.log` inside a handler carries none of that. It is reachable only by correlating
 * out from the stamped line, it cannot be filtered by operation, and it is free text, so
 * similar lines can only be grouped by guessing.
 *
 * `ctx.log` writes the line with the fields already on it — tenant, scope, operation,
 * invocation, who it ran as — and with the TEMPLATE it was written from:
 *
 * ```ts
 * ctx.log.warn('reply to {ticketId} bounced: {reason}', { ticketId, reason });
 * ```
 *
 * The template is what makes log patterns exact (#1747). Every line written from that call
 * site shares `reply to {ticketId} bounced: {reason}`, whatever the values were, so the
 * Patterns view groups by an equality rather than by mining free text for similar shapes.
 * That only holds while the template is a constant. A template built from values
 * (`` ctx.log.info(`reply to ${id}`) ``) still logs, but every line is its own pattern.
 *
 * ## The fields are the host's, not the caller's
 *
 * Tenant, scope, operation and invocation come from the context the host built, never from
 * `fields`. A caller cannot file a line under another operation, and a field named `tenantId`
 * stays a field. That is the same posture as the event envelope, which the kernel stamps.
 *
 * ## Logging never fails the operation
 *
 * A log call is not part of the transaction and has no result. Anything it cannot write
 * as given — an oversized value, a key it will not index, a value that is not a primitive —
 * is trimmed or stringified rather than thrown, because an operation that failed over its
 * own diagnostics is a worse outcome than a shortened line. For the same reason a line is
 * written even when the operation later rolls back: it happened, and a failure's logs are
 * the ones a reader opens the page for.
 */

/** A log level. `debug` is kept, and a reader may hide it. */
export type ModuleLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A field value. Anything else is stringified on the way out. */
export type ModuleLogFieldValue = string | number | boolean | null;

/** The fields a line carries, by name. */
export type ModuleLogFields = Readonly<Record<string, ModuleLogFieldValue>>;

/** What `ctx.log` is. Each method writes one line and returns nothing. */
export interface ModuleLog {
  debug(template: string, fields?: ModuleLogFields): void;
  info(template: string, fields?: ModuleLogFields): void;
  warn(template: string, fields?: ModuleLogFields): void;
  error(template: string, fields?: ModuleLogFields): void;
}

/**
 * The line `ctx.log` writes. A published contract, like `InvocationLogLine`: readers filter
 * on these key names, and the log platform indexes a JSON line's top-level keys. Add
 * fields; never rename one.
 */
export interface ModuleLogLine {
  /** Discriminator — tells this line from the invocation line and from a bare `console.log`. */
  substrat: 'log';
  level: ModuleLogLevel;
  /** The call site's template, verbatim (bounded). Lines from one call site share it. */
  template: string;
  /** The template with `{name}` placeholders filled from `fields`. */
  message: string;
  fields: Record<string, ModuleLogFieldValue>;
  tenantId: string;
  scopeId: string;
  /** The operation the line was written under. `null` inside a consumer, which runs on behalf of none. */
  operation: string | null;
  /** The invocation id (#1237) — the join to the invocation line and to the events. */
  invocationId: string | null;
  /** Who the code ran as: `principal`, `connection`, `system`, `capability` or `vertical`. */
  principalKind: string | null;
}

/** Where a host sends a line. The default writes it to the runtime's console. */
export type ModuleLogSink = (line: ModuleLogLine) => void;

/** Bounds, so one careless call cannot write a line the log platform truncates or refuses. */
export const MODULE_LOG_LIMITS = {
  template: 500,
  message: 4000,
  fields: 32,
  value: 1000,
} as const;

/** A field name the log platform indexes as it is — no dots, which would read as a path. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Runtime global, declared rather than imported, as `secret-box.ts` declares `crypto`: this
// package compiles against `lib: ["ES2023"]` with no DOM and no workers types.
declare const console: {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};

/**
 * The default sink: one JSON line on the console method matching the level, so a platform
 * that reads the level off the method agrees with the `level` field.
 */
export const consoleLogSink: ModuleLogSink = (line) => {
  const text = JSON.stringify(line);
  if (line.level === 'error') console.error(text);
  else if (line.level === 'warn') console.warn(text);
  else if (line.level === 'debug') console.debug(text);
  else console.log(text);
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A field value as the line carries it: primitives as they are, anything else as text.
 * UNBOUNDED — the caller redacts before it clips (see `moduleLogLine`).
 */
function fieldValue(v: unknown): ModuleLogFieldValue {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return v;
  if (v === undefined) return null;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * `{name}` placeholders filled from `fields`. A placeholder with no field is left as it
 * is, so a missing value reads as missing rather than as an empty gap in the sentence.
 */
export function renderTemplate(template: string, fields: Readonly<Record<string, ModuleLogFieldValue>>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(fields, name) ? String(fields[name]) : whole,
  );
}

/** What the host knows about the code a logger is handed to. */
export interface ModuleLogContext {
  tenantId: string;
  scopeId: string;
  operation: string | null;
  /** Read at each call: the invocation id is set on the host for the duration of a call. */
  invocationId: () => string | null;
  principalKind: string | null;
  /**
   * #1672: redact a capability secret this invocation minted before it reaches the line.
   * A log is a store read by a wider audience than the caller, so the secret is withheld
   * rather than refused: refusing would fail the operation over a diagnostic.
   */
  redact?: (text: string) => string;
}

/** The line one call writes. Exported for the adapters' tests and for a sink that wants it. */
export function moduleLogLine(
  ctx: ModuleLogContext,
  level: ModuleLogLevel,
  template: unknown,
  given: unknown,
): ModuleLogLine {
  const redact = ctx.redact ?? ((t: string) => t);
  // REDACT FIRST, THEN CLIP — every string, every time. Redaction is an exact match on the
  // whole secret, so clipping first can cut a secret that straddles a limit down to all but
  // its last characters, which then no longer matches and is written out. A capability
  // secret missing one character is a few dozen guesses from the whole one.
  const full: Record<string, ModuleLogFieldValue> = {};
  const fields: Record<string, ModuleLogFieldValue> = {};
  if (given !== null && typeof given === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
      if (n >= MODULE_LOG_LIMITS.fields) break;
      if (!FIELD_NAME.test(k)) continue;
      const value = fieldValue(v);
      full[k] = typeof value === 'string' ? redact(value) : value;
      fields[k] = typeof full[k] === 'string' ? clip(full[k] as string, MODULE_LOG_LIMITS.value) : full[k]!;
      n += 1;
    }
  }
  const fullTemplate = redact(typeof template === 'string' ? template : String(template));
  // Rendered from the redacted, unclipped parts, redacted once more (a secret could be
  // assembled across a placeholder), and only then bounded.
  const message = clip(redact(renderTemplate(fullTemplate, full)), MODULE_LOG_LIMITS.message);
  return {
    substrat: 'log',
    level,
    template: clip(fullTemplate, MODULE_LOG_LIMITS.template),
    message,
    fields,
    tenantId: ctx.tenantId,
    scopeId: ctx.scopeId,
    operation: ctx.operation,
    invocationId: ctx.invocationId(),
    principalKind: ctx.principalKind,
  };
}

/**
 * Build `ctx.log`. Each call writes one line to `sink`; a sink that throws is swallowed,
 * for the same reason nothing else here throws.
 */
export function moduleLog(ctx: ModuleLogContext, sink: ModuleLogSink = consoleLogSink): ModuleLog {
  const write = (level: ModuleLogLevel) => (template: string, fields?: ModuleLogFields) => {
    try {
      sink(moduleLogLine(ctx, level, template, fields));
    } catch {
      // A log line that could not be written is not the operation's failure.
    }
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
