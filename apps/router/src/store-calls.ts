import {
  clientSafeStoreError,
  issueScopeStoreEnvelope,
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  ScopeStoreKeyError,
  scopeStoreObjectName,
  scopeStoreScriptName,
  storeCallRequest,
  storeResponse,
  type StoreCallRequest,
  type StoreResponse,
} from '@substrat-run/contracts';

/**
 * A scope-store call, after the egress worker has named the caller from the
 * dispatch parameters (#2207). The first version reaches only the scope that
 * dispatch serves, and only a binding that version declared.
 */
export interface StoreCallCaller {
  readonly vertical: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly stores: readonly { readonly binding: string; readonly driver: string }[] | null;
}

/**
 * `ok` is what the store answered: `{ result }`, or `{ error }` with the store's status,
 * already cut to what a client may read. A store reached that answered outside the
 * envelope is `ok` too, as `bad_envelope` with 502, the code the in-process path gives it.
 * The store's `code` travels only as the envelope's `code`, which the vertical reads as
 * `storeCode`; the platform's code is derived from the status. Not `ok` is the
 * platform's own refusal, or a store it could not reach.
 */
export type StoreCallOutcome =
  | { ok: true; status: number; body: StoreResponse }
  | { ok: false; status: number; message: string };

export interface StoreCallEnv {
  /** PKCS8 Ed25519 private key, base64url. Signs audience `caller`. The store holds only the public key. */
  readonly STORE_CALLER_KEY?: string;
  readonly DISPATCH?: {
    get(scriptName: string): { fetch(request: Request): Promise<Response> };
  };
}

/**
 * Sign the envelope and address that driver's script. The private key stays here.
 * A reserved operation is not signed with the caller key: the platform calls
 * those directly, with its own key.
 */
export async function handleStoreCall(
  env: StoreCallEnv,
  caller: StoreCallCaller,
  rawRequest: unknown,
): Promise<StoreCallOutcome> {
  const parsed = storeCallRequest.safeParse(rawRequest);
  if (!parsed.success) {
    return { ok: false, status: 400, message: 'store call refused: the body is not a store call' };
  }
  const request: StoreCallRequest = parsed.data;
  if (request.operation.startsWith('substrat.')) {
    return { ok: false, status: 403, message: `store operation '${request.operation}' is reserved for the platform` };
  }
  if (request.scopeId !== caller.scopeId) {
    return { ok: false, status: 403, message: 'store call refused: this dispatch reaches only its own scope' };
  }
  const declared = caller.stores?.find((store) => store.binding === request.binding);
  if (!declared) {
    return { ok: false, status: 404, message: `store call refused: '${request.binding}' is not a store this version declares` };
  }
  if (!env.STORE_CALLER_KEY) {
    console.warn('scope store call refused: STORE_CALLER_KEY is not set');
    return { ok: false, status: 503, message: 'this router is not configured for scope stores' };
  }
  if (!env.DISPATCH) {
    return { ok: false, status: 503, message: 'this router cannot dispatch scope stores' };
  }
  const objectName = scopeStoreObjectName(caller.tenantId, caller.vertical, request.scopeId, request.binding);
  const scriptName = scopeStoreScriptName(caller.vertical, declared.driver);
  const body = JSON.stringify({ ...request, objectName });
  let issued;
  try {
    issued = await issueScopeStoreEnvelope({
      privateKey: env.STORE_CALLER_KEY,
      aud: 'caller',
      script: scriptName,
      name: objectName,
      op: request.operation,
      body,
    });
  } catch (error) {
    if (!(error instanceof ScopeStoreKeyError)) throw error;
    // Set but unusable, e.g. a raw key where PKCS8 belongs. The message never carries the key.
    console.warn(`scope store call refused: STORE_CALLER_KEY is set but unusable (${error.message})`);
    return { ok: false, status: 503, message: 'this router is not configured for scope stores' };
  }
  let response: Response;
  try {
    response = await env.DISPATCH.get(scriptName).fetch(
      new Request('https://scope-store/invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SCOPE_STORE_ENVELOPE_HEADER]: issued.header,
          [SCOPE_STORE_SIGNATURE_HEADER]: issued.signature,
        },
        body,
      }),
    );
  } catch (error) {
    console.warn(`scope store call to ${scriptName} failed: ${dispatchFailure(error)}`);
    return { ok: false, status: 503, message: 'the scope store could not be reached' };
  }
  return storeAnswer(scriptName, response);
}

/**
 * What a log line may say about a dispatch that threw. A driver's uncaught exception comes
 * back through dispatch with its message, and a Python entry's message is its traceback,
 * so the message is never logged: only whether the script is missing, or the error's name
 * when it is a plain identifier.
 */
function dispatchFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'a non-error was thrown';
  if (error.message.startsWith('Worker not found')) return 'the script is not in the dispatch namespace';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'an error was thrown';
}

/**
 * Read what the store script answered. An `{ error }` envelope is the store's refusal
 * whatever the HTTP status, as it is on the in-process path, which has none. A
 * `{ result }` counts only on a 2xx. Anything else, such as the store entry's own text
 * refusal or a platform error page, is `bad_envelope`: its body is not passed on or
 * logged, since a store's failure text can carry its traceback.
 */
async function storeAnswer(scriptName: string, response: Response): Promise<StoreCallOutcome> {
  const parsed = storeResponse.safeParse(await response.json().catch(() => undefined));
  if (parsed.success && 'error' in parsed.data) {
    const error = clientSafeStoreError(parsed.data.error);
    return { ok: true, status: error.status, body: { error } };
  }
  if (parsed.success && response.ok) {
    return { ok: true, status: response.status, body: parsed.data };
  }
  console.warn(`scope store ${scriptName} answered ${response.status} outside the store envelope`);
  return { ok: true, status: 502, body: { error: { code: 'bad_envelope', status: 502 } } };
}
