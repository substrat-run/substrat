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
 * The body is read once, verified as that string, and that same string is what the driver
 * receives.
 *
 * What this is not: a boundary against a hostile driver. The driver's module is evaluated in this
 * isolate, before this module's body, and its class runs with the object's `ctx`. A driver that
 * leaves the checks out cannot skip them; a driver written to interfere with the isolate is
 * stopped by the review of its release (D-63), not by this module.
 */
import { DurableObject } from 'cloudflare:workers';
import * as driverModule from '__SUBSTRAT_STORE_DRIVER__';
import type { ScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';
import { STORE_OBJECT_BINDING, STORE_RESERVED_BINDING_PREFIX } from './names.js';
import { storeCallVerdict } from './verify.js';

type StoreEntryEnv = Record<string, unknown> & {
  [STORE_OBJECT_BINDING]: DurableObjectNamespace;
};

interface DriverObject {
  fetch(request: Request): Promise<Response>;
  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;
}

const Driver = driverModule['__SUBSTRAT_STORE_CLASS__'] as new (ctx: DurableObjectState, env: Record<string, unknown>) => DriverObject;

const text = (status: number, message: string) => new Response(message, { status });

/** The env the driver is constructed with: everything but the entry's own bindings. */
function driverEnvOf(env: StoreEntryEnv): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(STORE_RESERVED_BINDING_PREFIX)));
}

/** The verified envelope, or the response that refuses the call. */
async function verified(request: Request, body: string, env: StoreEntryEnv): Promise<ScopeStoreEnvelope | Response> {
  const verdict = await storeCallVerdict(request.headers, body, env);
  return verdict.ok ? verdict.envelope : text(verdict.status, verdict.message);
}

export class SubstratStoreObject extends DurableObject<StoreEntryEnv> {
  #driver: DriverObject | undefined;

  /** Constructed once per object instance, on first use, so the driver keeps its in-memory state. */
  #driverObject(): DriverObject {
    this.#driver ??= new Driver(this.ctx, driverEnvOf(this.env));
    return this.#driver;
  }

  override async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    const envelope = await verified(request, body, this.env);
    if (envelope instanceof Response) return envelope;
    const ns = this.env[STORE_OBJECT_BINDING];
    if (!this.ctx.id.equals(ns.idFromName(envelope.name))) return text(401, 'unauthorized: object');
    return this.#driverObject().fetch(
      new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    );
  }

  /** An alarm is the object's own timer, which only the driver sets. It goes to the driver. */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const driver = this.#driverObject();
    if (typeof driver.alarm === 'function') await driver.alarm(alarmInfo);
  }
}

export default {
  async fetch(request: Request, env: StoreEntryEnv): Promise<Response> {
    const body = await request.text();
    const envelope = await verified(request, body, env);
    if (envelope instanceof Response) return envelope;
    const ns = env[STORE_OBJECT_BINDING];
    return ns.get(ns.idFromName(envelope.name)).fetch(
      new Request(request.url, { method: 'POST', headers: request.headers, body }),
    );
  },
};
