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
  scopeStorePublicKeysFrom,
  verifyScopeStoreCall,
  type ScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';
import { STORE_CALLER_KEYS_VAR, STORE_PLATFORM_KEYS_VAR, STORE_SCRIPT_VAR } from './names.js';

/** What the entry does with a call: hand it on, or answer `status` with `message`. */
export type StoreCallVerdict =
  | { readonly ok: true; readonly envelope: ScopeStoreEnvelope }
  | { readonly ok: false; readonly status: 401 | 503; readonly message: string };

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
