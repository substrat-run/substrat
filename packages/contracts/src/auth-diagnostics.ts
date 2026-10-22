/**
 * Credential-free authentication diagnostics shared by providers, hosts and log readers.
 * No runtime imports: the platform entry bundles this independently of the vertical.
 * A diagnostic describes a check, never grants authority. Unknown fields are discarded
 * on both write and read; tokens, claims, identities and exception messages have no slot.
 */
export const AUTH_CHECK_STAGES = ['bearer', 'session', 'mcp-audience', 'mcp-caller'] as const;
export const AUTH_CHECK_OUTCOMES = ['accepted', 'refused', 'absent', 'error'] as const;
export const AUTH_CHECK_REASONS = [
  'verified', 'session-invalid', 'credential-missing', 'discovery-failed', 'key-resolution-failed',
  'token-expired', 'token-not-active', 'issuer-invalid', 'audience-invalid',
  'claims-invalid', 'signature-invalid', 'token-invalid', 'verification-failed',
  'subject-missing', 'assertion-not-access-token', 'delegation-refused', 'token-not-for-app',
  'resource-mismatch', 'caller-resolved', 'caller-refused', 'caller-error',
] as const;

export interface AuthCheck {
  stage: (typeof AUTH_CHECK_STAGES)[number];
  outcome: (typeof AUTH_CHECK_OUTCOMES)[number];
  reason: (typeof AUTH_CHECK_REASONS)[number];
}

export const AUTH_CHECK_CAP = 16;
export interface AuthRecording {
  authChecks?: AuthCheck[];
  authChecksDropped?: number;
}

/** Registered across bundled copies; the host supplies a request-local recorder. */
export const AUTH_DIAGNOSTICS_KEY = Symbol.for('substrat.auth-diagnostics');
export interface AuthDiagnosticsSink {
  record(check: AuthCheck): void;
}

/** Copy only the bounded vocabulary, including when called from untyped code. */
export function authCheckOf(value: unknown): AuthCheck | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!(AUTH_CHECK_STAGES as readonly unknown[]).includes(v.stage)
    || !(AUTH_CHECK_OUTCOMES as readonly unknown[]).includes(v.outcome)
    || !(AUTH_CHECK_REASONS as readonly unknown[]).includes(v.reason)) return undefined;
  return { stage: v.stage, outcome: v.outcome, reason: v.reason } as AuthCheck;
}

/** Old lines and unrecognised future entries read as unrecorded, never as success. */
export function authChecksOf(value: unknown): AuthCheck[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, AUTH_CHECK_CAP).flatMap((v) => {
    const check = authCheckOf(v);
    return check ? [check] : [];
  });
}

export function tallyAuthCheck(record: AuthRecording, value: AuthCheck): void {
  const check = authCheckOf(value);
  if (!check) return;
  const checks = record.authChecks ??= [];
  if (checks.length < AUTH_CHECK_CAP) checks.push(check);
  else record.authChecksDropped = (record.authChecksDropped ?? 0) + 1;
}

/** Best effort. No host, an old host, or a broken sink must not change authentication. */
export function recordAuthCheck(check: AuthCheck): void {
  try {
    const safe = authCheckOf(check);
    if (!safe) return;
    const sink = (globalThis as Record<symbol, unknown>)[AUTH_DIAGNOSTICS_KEY] as AuthDiagnosticsSink | undefined;
    sink?.record(safe);
  } catch {
    // Observability never decides whether a caller is admitted.
  }
}
