/**
 * The platform's store entry (#2289). Uploaded as the store script's main module. The driver's
 * class is imported through placeholders the uploader replaces, and the driver is reached only
 * through this module, after the call is verified.
 *
 * Every call is checked by `verify.ts`, which runs contracts' `verifyScopeStoreCall` (RFC
 * scope-stores §10.3 checks 1–4) against the public keys and the script name this upload was
 * given. The Python entry imports the same function. The default export addresses
 * `SubstratStoreObject` by `idFromName` of the signed name. The object checks the call again,
 * and refuses unless its own id is the id of that name (check 5): an object is bound to one
 * name by construction, with nothing stored that the driver could rewrite.
 *
 * The body is read once (`verifiedStoreCall`, bounded by `STORE_CALL_MAX_BYTES`: a larger one is
 * refused with 413 before it is read when its `Content-Length` says so, and at the limit when it
 * does not), verified as the text those bytes decode to, and those same bytes are what the driver
 * receives. The entry makes no string of its own.
 *
 * What this is not: a boundary against a hostile driver. The driver's module is evaluated in this
 * isolate, before this module's body, and its class runs with the object's `ctx`. A driver that
 * leaves the checks out cannot skip them; a driver written to interfere with the isolate is
 * stopped by the review of its release (D-63), not by this module.
 *
 * Inside the object, a call passes the fence (`fence.ts`, D-70) before it reaches the driver: an
 * object a deletion path has fenced refuses it, whenever it was signed. The fence is held in this
 * object, so it holds in front of any driver and behind any router.
 */
import { DurableObject } from 'cloudflare:workers';
import * as driverModule from '__SUBSTRAT_STORE_DRIVER__';
import { callThroughFence, storeObjectFence, type StoreObjectFence } from './fence.js';
import { STORE_OBJECT_BINDING, STORE_RESERVED_BINDING_PREFIX } from './names.js';
import { verifiedStoreCall, type StoreCallRefusal, type VerifiedStoreCall } from './verify.js';

type StoreEntryEnv = Record<string, unknown> & {
  [STORE_OBJECT_BINDING]: DurableObjectNamespace;
};

interface DriverObject {
  fetch(request: Request): Promise<Response>;
  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;
}

const Driver = driverModule['__SUBSTRAT_STORE_CLASS__'] as new (ctx: DurableObjectState, env: Record<string, unknown>) => DriverObject;

const refusal = ({ status, message, contentType }: StoreCallRefusal) =>
  new Response(message, { status, ...(contentType ? { headers: { 'content-type': contentType } } : {}) });

/** The env the driver is constructed with: everything but the entry's own bindings. */
function driverEnvOf(env: StoreEntryEnv): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(STORE_RESERVED_BINDING_PREFIX)));
}

/** The call, read once and verified, or the response that refuses it. */
async function verified(request: Request, env: StoreEntryEnv): Promise<Extract<VerifiedStoreCall, { ok: true }> | Response> {
  const call = await verifiedStoreCall(request, env);
  return call.ok ? call : refusal(call);
}

export class SubstratStoreObject extends DurableObject<StoreEntryEnv> {
  #driver: DriverObject | undefined;
  #fence: StoreObjectFence | undefined;

  #fenceOf(): StoreObjectFence {
    this.#fence ??= storeObjectFence(this.ctx.storage);
    return this.#fence;
  }

  /** Constructed once per object instance, on first use, so the driver keeps its in-memory state. */
  #driverObject(): DriverObject {
    this.#driver ??= new Driver(this.ctx, driverEnvOf(this.env));
    return this.#driver;
  }

  override async fetch(request: Request): Promise<Response> {
    const call = await verified(request, this.env);
    if (call instanceof Response) return call;
    const ns = this.env[STORE_OBJECT_BINDING];
    if (!this.ctx.id.equals(ns.idFromName(call.envelope.name))) return new Response('unauthorized: object', { status: 401 });
    const answer = await callThroughFence(this.#fenceOf(), call, (body) =>
      this.#driverObject().fetch(new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })),
    );
    return answer instanceof Response ? answer : refusal(answer);
  }

  /** An alarm is the object's own timer, which only the driver sets. It goes to the driver, unless the object is fenced. */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const fence = this.#fenceOf();
    if (!(await fence.admitAlarm())) return;
    try {
      const driver = this.#driverObject();
      if (typeof driver.alarm === 'function') await driver.alarm(alarmInfo);
    } finally {
      await fence.leave();
    }
  }
}

export default {
  async fetch(request: Request, env: StoreEntryEnv): Promise<Response> {
    const call = await verified(request, env);
    if (call instanceof Response) return call;
    const ns = env[STORE_OBJECT_BINDING];
    return ns.get(ns.idFromName(call.envelope.name)).fetch(
      new Request(request.url, { method: 'POST', headers: request.headers, body: call.body }),
    );
  },
};
