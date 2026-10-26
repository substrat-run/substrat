import {
  MAIL_IN_PROVIDER,
  platformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  acceptInboundMail,
  deliverInboundMail,
  r2MailInStore,
  type MailInAddressDeps,
  type MailInInboundDeps,
  type MailInLandingOf,
  type MailInStore,
} from '@substrat-run/connector-mail-in';
import { runningVersionOf, type ScopeHost } from '@substrat-run/kernel';
import type { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';

/**
 * Inbound mail's control-plane half (#2611): the `email()` handler Email Routing calls, and the
 * deps the connector, the relay and the API share.
 *
 * Email Routing is enabled on the receiving subdomain only (`MAIL_IN_DOMAIN`, `in.substrat.run` in
 * production), with a catch-all rule sending every address to this worker. The apex keeps its own
 * MX: nothing here, and nothing a routing rule on the subdomain does, touches it.
 */

/** The actor mail-in effects as — the address mint, its grant, its revoke. The admin log reads it as mail-in's. */
export const MAIL_IN_ACTOR = platformActorId.parse('01JZ00000000000000000000MN');

/** The env slice inbound mail reads. Both, or no mail is received. */
export interface MailInEnv {
  /** The receiving domain (`in.substrat.run`). Unset ⇒ every message is refused, and no address is minted. */
  MAIL_IN_DOMAIN?: string;
  /** Where accepted messages wait until delivered. */
  MAIL_IN_BUCKET?: R2Bucket;
}

/** A store that refuses, for a deployment with no bucket: nothing is accepted that could not be kept. */
const NO_STORE: MailInStore = {
  put: () => Promise.reject(new Error('MAIL_IN_BUCKET is not bound — inbound mail cannot be stored')),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
};

/** The domain this deployment receives on, or undefined when it cannot: a domain with no bucket receives nothing. */
export const mailInDomainOf = (env: MailInEnv): string | undefined =>
  env.MAIL_IN_DOMAIN && env.MAIL_IN_BUCKET ? env.MAIL_IN_DOMAIN.trim().toLowerCase() : undefined;

export function mailInInboundDeps(env: MailInEnv): MailInInboundDeps {
  return {
    actor: MAIL_IN_ACTOR,
    store: env.MAIL_IN_BUCKET ? r2MailInStore(env.MAIL_IN_BUCKET) : NO_STORE,
    domain: mailInDomainOf(env),
  };
}

/**
 * The landing a scope's RUNNING version declares — the serving script's version when the scope is
 * on one, its bound version otherwise (`runningVersionOf`), read off the stored manifest.
 */
export function landingOfFor(host: CloudflareScopeHost): MailInLandingOf {
  return async (scope) => {
    // The vertical's serving pointer is read only when the scope is on a serving script: nothing
    // else can differ from its binding.
    const v = scope.servingRef ? (await host.admin.listVerticals(MAIL_IN_ACTOR)).find((x) => x.slug === scope.vertical) : undefined;
    const versionId = runningVersionOf(
      { verticalVersionId: scope.verticalVersionId as never, servingRef: scope.servingRef as never },
      v?.servingRef && v.servingVersionId ? { ref: v.servingRef, versionId: v.servingVersionId } : null,
    );
    if (!versionId) return null;
    const fact = await host.versionConnectionLandings(scope.vertical, versionId);
    if (fact.kind === 'none') return null;
    if (fact.kind === 'unreadable') throw new Error(`the running version's connection landings cannot be read: ${fact.reason}`);
    const row = fact.rows.find((r) => r.provider === MAIL_IN_PROVIDER);
    return row ? { operation: row.operation, permission: row.permission } : null;
  };
}

export function mailInAddressDeps(env: MailInEnv, host: CloudflareScopeHost): MailInAddressDeps {
  const inbound = mailInInboundDeps(env);
  return { actor: MAIL_IN_ACTOR, domain: inbound.domain, store: inbound.store, landingOf: landingOfFor(host) };
}

/** The relay's and the API's scope key. */
export interface MailInScopeKey {
  tenantId: TenantId;
  scopeId: ScopeId;
}

/** What the handler reads off Email Routing's message — `ForwardableEmailMessage`, structurally. */
export interface RoutedEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** The raw message, whole. Bounded by the size check `acceptInboundMail` makes before it asks. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The `email()` handler: refuse at SMTP time, or accept and try the delivery straight away. A
 * delivery that fails here is not an SMTP failure — the message is already durable, and the
 * connector sweep retries it. Logs carry ids and reasons, never an address.
 */
export async function handleInboundEmail(
  message: RoutedEmail,
  env: MailInEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
  host: ScopeHost,
): Promise<void> {
  const deps = mailInInboundDeps(env);
  let outcome;
  try {
    outcome = await acceptInboundMail(host, deps, {
      to: message.to,
      envelopeFrom: message.from,
      rawSize: message.rawSize,
      raw: () => readAll(message.raw),
    });
  } catch (err) {
    // Nothing was promised to the sender yet, so a failure to make the message durable is a
    // temporary refusal: throwing makes Email Routing answer 4xx and the sender retry.
    console.error('mail-in: accept failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  if (!outcome.accepted) {
    console.log('mail-in: rejected', { reason: outcome.reason, ...(outcome.connectionId ? { connectionId: outcome.connectionId } : {}) });
    message.setReject(outcome.smtp);
    return;
  }
  console.log('mail-in: received', { connectionId: outcome.connectionId, messageId: outcome.messageId, duplicate: outcome.duplicate });
  if (outcome.duplicate) return;
  const { connectionId, messageId } = outcome;
  ctx.waitUntil(
    deliverInboundMail(host, deps, connectionId, messageId).then(
      (d) => {
        if (d.status === 'dead-lettered') console.error('mail-in: dead-lettered', { connectionId, messageId, error: d.error });
        else console.log(`mail-in: ${d.status}`, { connectionId, messageId });
      },
      (err) => console.error('mail-in: delivery threw', { connectionId, messageId, error: err instanceof Error ? err.message : String(err) }),
    ),
  );
}
