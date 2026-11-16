import { errorCodeOf, PROBLEM_CATALOG, problemCodeOf, problemDetail, type ErrorCode } from '@substrat-run/contracts';

/**
 * #3235: what a connection's tenant may read about why a landing call failed — the call a
 * connector makes into the tenant's own vertical, as the connection, to land a provider record.
 *
 * A connector's failed binding has two texts. Staff's row keeps the whole thrown error: it may
 * quote the provider's answer, the platform's transport, a fault's internals. The tenant's row
 * gets only this, and only when the failure is the VERTICAL's own refusal of the call: its
 * operation ran in the tenant's scope, over the tenant's data, and answered "no". That answer is
 * the tenant's to read, because it is their code (or the code they installed) saying something
 * about their own records — a UNIQUE constraint in its own table, a validation it declared.
 *
 * Withheld, by returning `undefined`, so the caller says only that the binding did not land:
 *
 * - a 5xx, or a code the catalog answers with one: the platform failing, not the vertical
 *   refusing, and its text is the runtime's;
 * - a 401 or `unauthenticated`: the platform's own credential check on its internal call;
 * - an answer that is not a problem document (a router's plain-text miss, a truncated body);
 * - an in-process throw that declared no code: nothing tells the vertical's sentence from a
 *   host's, so it stays staff's. Over the hosted hop the vertical's own surface already judged
 *   such a throw the caller's 400, and that answer is read.
 *
 * Read structurally, never by class: the hosted hop throws the control-plane client's
 * `ControlPlaneError` (`status`, and the raw `body`), which the kernel does not import, and an
 * in-process host throws the kernel's coded errors.
 *
 * `operation` is the operation the connector called, which the vertical declared. The detail is
 * one line, cut to {@link LANDING_REFUSAL_DETAIL_MAX}: a sweep row carries a sentence, never a
 * payload.
 */
export function landingRefusalSaid(operation: string, err: unknown): string | undefined {
  const refusal = refusalOf(err);
  if (!refusal) return undefined;
  const code = refusal.code ? ` (${refusal.code})` : '';
  return `the app's '${operation}' refused it${code}: ${oneLine(refusal.detail)}`;
}

/** The most of a vertical's refusal detail a tenant's line carries. */
export const LANDING_REFUSAL_DETAIL_MAX = 160;

function refusalOf(err: unknown): { code: ErrorCode | undefined; detail: string } | undefined {
  const e = err as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (e === null || typeof e !== 'object') return undefined;
  // The hosted hop: the vertical's own answer, as its platform surface rendered it.
  // A coded in-process error carries a `status` too; only the hop's error carries the raw body.
  if (typeof e.status === 'number' && 'body' in e) {
    if (!tenantStatus(e.status) || typeof e.body !== 'string') return undefined;
    let body: unknown;
    try {
      body = JSON.parse(e.body);
    } catch {
      return undefined;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const code = problemCodeOf(body);
    if (code !== undefined && !tenantStatus(PROBLEM_CATALOG[code].status)) return undefined;
    const detail = problemDetail(body);
    return detail === undefined ? undefined : { code, detail };
  }
  // In process: only a throw that declared what it is.
  const code = errorCodeOf(err);
  if (code === undefined || !tenantStatus(PROBLEM_CATALOG[code].status)) return undefined;
  return typeof e.message === 'string' && e.message !== '' ? { code, detail: e.message } : undefined;
}

/** A 4xx that is not the platform's own authentication of its call. */
const tenantStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 401 && status !== 407;

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LANDING_REFUSAL_DETAIL_MAX ? `${flat.slice(0, LANDING_REFUSAL_DETAIL_MAX - 1)}…` : flat;
};
