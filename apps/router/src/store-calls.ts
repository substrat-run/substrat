import {
  clientSafeStoreError,
  isPlatformStoreCode,
  issueScopeStoreEnvelope,
  PLATFORM_STORE_CODE,
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  ScopeStoreKeyError,
  STORE_CALL_MAX_BYTES,
  scopeStoreBodyBytes,
  scopeStoreObjectName,
  scopeStoreScriptName,
  storeCallRequest,
  storeAnswerOf,
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
 * envelope is `ok` too, as `substrat.bad_envelope` with 502, the code the in-process path gives it.
 * The store's `code` travels only as the envelope's `code`, which the vertical reads as
 * `storeCode`; the platform's code is derived from the status. Not `ok` is the
 * platform's own refusal, or a store it could not reach, with a `PLATFORM_STORE_CODE`.
 */
export type StoreCallOutcome =
  | { ok: true; status: number; body: StoreResponse }
  | { ok: false; status: number; code: PlatformStoreCode; message: string };

type PlatformStoreCode = (typeof PLATFORM_STORE_CODE)[keyof typeof PLATFORM_STORE_CODE];

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
    return refused(400, PLATFORM_STORE_CODE.refused, 'store call refused: the body is not a store call');
  }
  const request: StoreCallRequest = parsed.data;
  if (request.operation.startsWith('substrat.')) {
    return refused(403, PLATFORM_STORE_CODE.reservedOperation, `store operation '${request.operation}' is reserved for the platform`);
  }
  if (request.scopeId !== caller.scopeId) {
    return refused(403, PLATFORM_STORE_CODE.scopeMismatch, 'store call refused: this dispatch reaches only its own scope');
  }
  const declared = caller.stores?.find((store) => store.binding === request.binding);
  if (!declared) {
    return refused(
      404,
      PLATFORM_STORE_CODE.undeclaredBinding,
      `store call refused: '${request.binding}' is not a store this version declares`,
    );
  }
  if (!env.STORE_CALLER_KEY) {
    console.warn('scope store call refused: STORE_CALLER_KEY is not set');
    return unavailable('this router is not configured for scope stores');
  }
  if (!env.DISPATCH) {
    return unavailable('this router cannot dispatch scope stores');
  }
  const objectName = scopeStoreObjectName(caller.tenantId, caller.vertical, request.scopeId, request.binding);
  const scriptName = scopeStoreScriptName(caller.vertical, declared.driver);
  const body = JSON.stringify({ ...request, objectName });
  // The store entry refuses a body over the limit (#2811), so it is refused here, before it is signed.
  const bytes = scopeStoreBodyBytes(body);
  if (bytes > STORE_CALL_MAX_BYTES) {
    return refused(
      413,
      PLATFORM_STORE_CODE.tooLarge,
      `store call refused: its body is ${bytes} bytes, over the limit of ${STORE_CALL_MAX_BYTES}. Nothing was sent.`,
    );
  }
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
    return unavailable('this router is not configured for scope stores');
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
    return unavailable('the scope store could not be reached');
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

/** The platform's own refusal: its rule's code (#2406), and a message for a person. */
const refused = (status: number, code: PlatformStoreCode, message: string): StoreCallOutcome => ({ ok: false, status, code, message });
const unavailable = (message: string): StoreCallOutcome => refused(503, PLATFORM_STORE_CODE.unavailable, message);

/**
 * Read what the store script answered. An `{ error }` envelope is the store's refusal
 * whatever the HTTP status, as it is on the in-process path, which has none. A
 * `{ result }` counts only on a 2xx. Anything else, such as the store entry's own text
 * refusal or a platform error page, is a bad envelope: its body is not passed on or
 * logged, since a store's failure text can carry its traceback. So is an `{ error }` whose
 * code is reserved to the platform (#2815): a store's answer must not read as the platform's.
 */
async function storeAnswer(scriptName: string, response: Response): Promise<StoreCallOutcome> {
  const answer = storeAnswerOf(response.status, await response.json().catch(() => undefined));
  if (answer && 'error' in answer) {
    if (isPlatformStoreCode(answer.error.code)) {
      console.warn(`scope store ${scriptName} answered with a code reserved to the platform`);
      return BAD_ENVELOPE;
    }
    const error = clientSafeStoreError(answer.error);
    return { ok: true, status: error.status, body: { error } };
  }
  if (answer) return { ok: true, status: response.status, body: answer };
  console.warn(`scope store ${scriptName} answered ${response.status} outside the store envelope`);
  return BAD_ENVELOPE;
}

const BAD_ENVELOPE: StoreCallOutcome = { ok: true, status: 502, body: { error: { code: PLATFORM_STORE_CODE.badEnvelope, status: 502 } } };
