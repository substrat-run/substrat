import {
  issueScopeStoreEnvelope,
  scopeStoreObjectName,
  scopeStoreScriptName,
  storeCallRequest,
  type StoreCallRequest,
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
  readonly stores: readonly { readonly binding: string; readonly kind: string }[] | null;
}

export type StoreCallOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; message: string };

export interface StoreCallEnv {
  /** PKCS8 Ed25519 private key, base64url. Signs audience `caller`. The store holds only the public key. */
  readonly STORE_CALLER_KEY?: string;
  readonly DISPATCH?: {
    get(scriptName: string): { fetch(request: Request): Promise<Response> };
  };
}

/**
 * Sign the envelope and address that kind's script. The private key stays here.
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
    return { ok: false, status: 503, message: 'this router is not configured for scope stores' };
  }
  if (!env.DISPATCH) {
    return { ok: false, status: 503, message: 'this router cannot dispatch scope stores' };
  }
  const objectName = scopeStoreObjectName(caller.tenantId, caller.vertical, request.scopeId, request.binding);
  const body = JSON.stringify({ ...request, objectName });
  let issued;
  try {
    issued = await issueScopeStoreEnvelope({
      privateKey: env.STORE_CALLER_KEY,
      aud: 'caller',
      name: objectName,
      op: request.operation,
      body,
    });
  } catch {
    return { ok: false, status: 503, message: 'this router is not configured for scope stores' };
  }
  const script = env.DISPATCH.get(scopeStoreScriptName(caller.vertical, declared.kind));
  const response = await script.fetch(
    new Request('https://scope-store/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-substrat-store-envelope': issued.header,
        'x-substrat-store-signature': issued.signature,
      },
      body,
    }),
  );
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, status: response.status, message: 'the scope store refused the call' };
  }
  return { ok: true, status: response.status, body: result };
}
