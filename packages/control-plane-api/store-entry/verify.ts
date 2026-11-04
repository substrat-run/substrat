/**
 * The check every store entry makes on a call before any driver code runs (#2289, #2290). The
 * TypeScript entry imports it, and the Python entry imports the same function bundled as
 * `STORE_VERIFIER_MODULE`, so the two entries share one verifier and no parser of their own.
 *
 * It reads the script name and both audiences' key lists from the env the upload bound, and
 * runs contracts' `verifyScopeStoreCall`: RFC scope-stores §10.3 checks 1–4, in that function's
 * fixed order. The object binding (check 5) needs the object's id, so each entry makes it itself.
 */
import {
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  STORE_CALL_MAX_BYTES,
  scopeStorePublicKeysFrom,
  verifyScopeStoreCall,
  type ScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';
import { STORE_CALLER_KEYS_VAR, STORE_PLATFORM_KEYS_VAR, STORE_SCRIPT_VAR } from './names.js';

/**
 * A call the entry refuses: answer `status` with `message`, as plain text. It is the entry's own
 * answer, never a store's, so it stays outside the store envelope (#2815): a caller reads it as a bad
 * envelope. The router and the control plane refuse an oversize body before they sign it, so the 413
 * here is the entry holding its own limit, not the refusal a vertical sees.
 */
export interface StoreCallRefusal {
  readonly ok: false;
  readonly status: 401 | 413 | 503;
  readonly message: string;
}

/** What the entry does with a call: hand it on, or answer `status` with `message`. */
export type StoreCallVerdict = { readonly ok: true; readonly envelope: ScopeStoreEnvelope } | StoreCallRefusal;

/** A call whose body is over `STORE_CALL_MAX_BYTES`. */
const tooLarge: StoreCallRefusal = { ok: false, status: 413, message: `payload too large: at most ${STORE_CALL_MAX_BYTES} bytes` };

/** The refusal for a declared `Content-Length` over the limit, or undefined. Reads no body. */
export function storeCallDeclaredRefusal(headers: { get(name: string): string | null }): StoreCallRefusal | undefined {
  const declared = headers.get('content-length');
  // A value that is not a plain count says nothing: the body read decides.
  return declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > STORE_CALL_MAX_BYTES ? tooLarge : undefined;
}

/** The body as bytes, read to at most `STORE_CALL_MAX_BYTES`: a stream that goes past it is cancelled and refused. */
async function boundedBody(body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null): Promise<Uint8Array | StoreCallRefusal> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > STORE_CALL_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A call the entry admitted: the envelope, and the body as the bytes it was verified from. */
export type VerifiedStoreCall =
  | { readonly ok: true; readonly envelope: ScopeStoreEnvelope; readonly body: ArrayBuffer }
  | StoreCallRefusal;

/**
 * The one read of a store call (#2811). A declared `Content-Length` over `STORE_CALL_MAX_BYTES` is
 * refused before the body is read. Otherwise the body is read once, counting bytes, so a missing or
 * false length is refused at the limit and not after the rest has been read. It is verified as the
 * text those bytes decode to under a strict UTF-8 decode that keeps a BOM (invalid UTF-8 is refused
 * 401 as a digest mismatch), so the digest covers exactly the bytes handed on
 * (`body`, an `ArrayBuffer` of exactly its length), so no entry makes a string for the driver and
 * the Python entry keeps the body in JavaScript.
 */
export async function verifiedStoreCall(
  request: { readonly headers: { get(name: string): string | null }; readonly body: Parameters<typeof boundedBody>[0] },
  env: Record<string, unknown>,
): Promise<VerifiedStoreCall> {
  const declared = storeCallDeclaredRefusal(request.headers);
  if (declared) return declared;
  const bytes = await boundedBody(request.body);
  if (!(bytes instanceof Uint8Array)) return bytes;
  // Strict, and the BOM kept as U+FEFF: the digest is over the text, the driver gets the bytes, so
  // the two must be the same bytes. A lenient decode would verify a BOM-prefixed body, or one with
  // an invalid sequence, under the signature of the canonical body while the driver read other bytes.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, status: 401, message: 'unauthorized: digest' };
  }
  const verdict = await storeCallVerdict(request.headers, text, env);
  return verdict.ok ? { ok: true, envelope: verdict.envelope, body: bytes.buffer as ArrayBuffer } : verdict;
}

/**
 * The verdict on one call. `body` is the request body, read once by the entry, and the same
 * string the driver is handed. A store this upload did not configure refuses everything with
 * 503, so it never reads as the caller's fault.
 */
export async function storeCallVerdict(
  headers: { get(name: string): string | null },
  body: string,
  env: Record<string, unknown>,
): Promise<StoreCallVerdict> {
  const script = env[STORE_SCRIPT_VAR];
  let keys;
  try {
    if (typeof script !== 'string' || script.length === 0) throw new Error('no script name');
    keys = scopeStorePublicKeysFrom({
      caller: String(env[STORE_CALLER_KEYS_VAR] ?? ''),
      platform: String(env[STORE_PLATFORM_KEYS_VAR] ?? ''),
    });
  } catch {
    return { ok: false, status: 503, message: 'this store script is not configured' };
  }
  const verdict = await verifyScopeStoreCall({
    envelope: headers.get(SCOPE_STORE_ENVELOPE_HEADER),
    signature: headers.get(SCOPE_STORE_SIGNATURE_HEADER),
    body,
    keys,
    script,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  return verdict.ok ? verdict : { ok: false, status: 401, message: `unauthorized: ${verdict.refusal}` };
}
