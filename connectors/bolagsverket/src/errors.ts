import type { OrgnrRefusal } from './orgnr.js';

/**
 * What a caller branches on when a lookup does not produce a result.
 *
 * - `invalid_orgnr` — refused locally, never sent (`reason` says why).
 * - `refused` — the provider said "not with this client": a 401 after one re-mint, or a 403.
 * - `rate_limited` — a 429 that outlasted the retries; `retryAfterSeconds` is the wait.
 * - `upstream` — anything that says nothing about the credential: a 5xx, a timeout, a body
 *   that is not the documented shape. Reading one of these as a refusal would make a
 *   Bolagsverket outage look like a bad credential.
 *
 * "Not found" is not here: an organisation number that names nothing is an answer
 * (`exists: false`), not a failure.
 */
export type BolagsverketErrorCode = 'invalid_orgnr' | 'refused' | 'rate_limited' | 'upstream';

export class BolagsverketError extends Error {
  readonly code: BolagsverketErrorCode;
  /** The HTTP status, or 0 when nothing was sent. */
  readonly status: number;
  readonly body: string;
  readonly retryAfterSeconds: number | null;
  readonly reason: OrgnrRefusal | null;

  constructor(
    code: BolagsverketErrorCode,
    message: string,
    options: { status?: number; body?: string; retryAfterSeconds?: number | null; reason?: OrgnrRefusal } = {},
  ) {
    super(message);
    this.name = 'BolagsverketError';
    this.code = code;
    this.status = options.status ?? 0;
    this.body = options.body ?? '';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.reason = options.reason ?? null;
  }

  /** The bit a connection's health record keeps: the credential itself was turned away. */
  get refused(): boolean {
    return this.code === 'refused';
  }
}

/** The provider's message from whichever envelope arrived, else a slice of the body. */
export function errorMessage(body: string, status: number): string {
  try {
    const e = JSON.parse(body) as { error_description?: unknown; error?: unknown; message?: unknown; detail?: unknown };
    for (const v of [e.error_description, e.message, e.detail, e.error]) {
      if (typeof v === 'string' && v !== '') return v;
    }
  } catch {
    // Not JSON: the raw slice is more use than nothing.
  }
  const slice = body.trim().slice(0, 200);
  return slice === '' ? `HTTP ${status}` : slice;
}
