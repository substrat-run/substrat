import { z } from 'zod';
import {
  connectionId,
  instant,
  scopeId,
  tenantId,
  type ConnectionActivity,
  type ConnectionActivitySource,
  type ConnectionCredential,
  type ConnectionId,
  type ConnectionProbe,
  type DomainEvent,
  type Instant,
} from '@substrat-run/contracts';
import type {
  ConnectorConnection,
  ConnectorHandler,
  ConnectorOptions,
  FetchLike,
  HostAdmin,
  ScopeHost,
} from '@substrat-run/kernel';
import { ScriveApi, ScriveApiError, SCRIVE_TESTBED, scriveSecret, type ScriveParty } from './api.js';
import { renderPdf } from './pdf.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `api.ts`/`mock.ts` do.
declare const AbortSignal: { timeout(ms: number): unknown };
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export { ScriveApi, ScriveApiError, SCRIVE_TESTBED, SCRIVE_PRODUCTION } from './api.js';
export { ScriveMock, type ScriveMockOptions } from './mock.js';
export { renderPdf } from './pdf.js';

/**
 * The Scrive connector — the OUTBOUND half of external signing.
 *
 * `engine-protocol` emits `protocol.signatures-requested` when a vertical
 * freezes a document and sends it for signature. This turns that into a Scrive
 * document: create → set file → set parties (BankID) → start.
 *
 * ## The return path exists now (#97), but nothing schedules it yet
 *
 * The outbound half above is verified against the real testbed. The return path
 * — recording a completed signature back onto the protocol instance — is
 * `reconcileScriveDispatch` below. It could not be written until #97: a
 * signature lives in the SCOPE database, `getScope` demands a `PrincipalId`, and
 * a connector is not one. #97 gave a connection its own door
 * (`getConnectorScope`) and made its authority an ordinary permission grant, so
 * the driver records a signature by invoking `protocol/record-signature` as the
 * connection itself.
 *
 * What each earlier gap became:
 *
 * 1. **Recording the provider's document id / dispatch idempotency.** Solved
 *    without #97 by a directory-side ledger (`ctx.admin.putConnectorState`): a
 *    redelivery finds the row and skips instead of sending a SECOND document.
 *    Directory-side because a connector runs INSIDE the scope's dispatch and
 *    re-entering the scope actor deadlocks. A narrow residual remains (ledger
 *    write failing after `start` succeeds) — closable with provider-side dedup
 *    via the `substrat_instance` tag.
 * 2. **Recording a signature.** Solved by `reconcileScriveDispatch` on the #97
 *    seam — a top-level operation, OUTSIDE any dispatch, so re-entering the scope
 *    is safe. `sweepScriveReconciliations` is the poll driver over it: it
 *    enumerates the dispatch ledger (`listConnectorState`) and reconciles every
 *    outstanding instance, so completion needs no per-instance caller.
 *
 * Both triggers for the return path exist now (#96):
 *
 * - **Poll, the floor:** `sweepScriveReconciliations` runs on the platform
 *   sweeper — `startPlatformSweeper` in a node deployment (live in
 *   `demos/meridian/src/server.ts`), `definePlatformSweeperDO`'s alarm on
 *   Cloudflare — and is the source of truth that survives lost callbacks.
 * - **Push, the latency layer:** `handleScriveCallback` verifies a capability
 *   URL (Scrive callbacks carry no signature, so the URL's minted token is the
 *   whole authentication) and runs the same reconcile immediately. The
 *   deployment mounts `SCRIVE_CALLBACK_ROUTE` and configures `callbackUrl`.
 */
export interface ScriveConnectorOptions {
  /** `SCRIVE_TESTBED` by default; production needs a paid licence. */
  baseUrl?: string;
  /**
   * What `authLevel: 'basic'` means for THIS connection (#620) — the Scrive
   * authentication method a party gets when the request asks for no more than
   * control of a contact address.
   *
   * `'standard'` by default, and that default is the fix: the connector used to
   * hardcode `se_bankid` for every external party, which Scrive refuses with
   * `409 … requires valid personal number field` unless the party carries a
   * personnummer — one this platform deliberately never supplies (B6). Every
   * document this connector had ever sent failed on it.
   *
   * A deployment whose signatories all use BankID and which supplies personal
   * numbers by some other means can set `'se_bankid'` here; a request asking for
   * `authLevel: 'strong'` overrides it either way.
   */
  defaultAuthMethod?: 'standard' | 'se_bankid';
  /**
   * Where Scrive should POST status changes (#96, the push layer).
   *
   * Scrive's callbacks are **unauthenticated** — there is no signature to
   * verify — so this must be a capability URL (an unguessable secret in the
   * path), and a callback must never be trusted as a fact. It is a hint to
   * re-read `documents/{id}/get`. Optional because polling alone is a complete
   * strategy: the sweep is the floor, push only collapses its latency.
   *
   * The `ref` carries everything `handleScriveCallback` resolves the hint by —
   * the connection, the instance, and the freshly minted capability token —
   * and `scriveCallbackPath(ref)` is the canonical way to lay them into a
   * path. A deployment supplies only its public base:
   * `(ref) => `${base}${scriveCallbackPath(ref)}``.
   */
  callbackUrl?: (ref: ScriveCallbackRef) => string;
}

/**
 * What a Scrive callback URL must carry for the ingress to resolve it without
 * trusting anything in the request body (#96): which connection, which
 * dispatched instance, and the capability token minted for exactly that
 * dispatch. The ids are routing, not secrets; the token is the entire
 * authentication, because the provider offers none.
 */
export interface ScriveCallbackRef {
  connectionId: string;
  instanceId: string;
  token: string;
}

/**
 * The canonical callback path — mint side and ingress side agree through this
 * one function, so a deployment mounts one route shape and never re-derives it.
 */
export const scriveCallbackPath = (ref: ScriveCallbackRef): string =>
  `/hooks/scrive/${ref.connectionId}/${ref.instanceId}/${ref.token}`;

/** The same path as a `:param` route pattern, for mounting the ingress. */
export const SCRIVE_CALLBACK_ROUTE = '/hooks/scrive/:connectionId/:instanceId/:token';

/**
 * What the connector remembers about a dispatch, stored per-connection in the
 * directory (`ctx.admin.putConnectorState`).
 *
 * Two jobs. **Outbound idempotency:** a redelivery finds this row and skips
 * instead of creating a second document. **The return path (#97):** the poll
 * driver reads it to map a signed provider party back to the scope operation
 * that records it — which needs, per party, the `requestId` it resolves and the
 * `signatory` to attribute it to, plus the frozen `contentHash` `recordSignature`
 * checks the provider against, and the `vertical` to reopen the connection under.
 * None of that is derivable from Scrive's document, so it is captured here at
 * dispatch, when the event still carries it.
 */
export interface ScriveDispatchState {
  documentId: string;
  instanceId: string;
  scopeId: string;
  tenantId: string;
  /** The scope's vertical — half the key that reopens the connection to poll. */
  vertical: string;
  /**
   * The frozen content hash from `protocol.signatures-requested`. Reported back
   * verbatim on record: `recordSignature` re-derives the frozen hash and refuses
   * a signature whose reported hash disagrees, so the document that was signed is
   * provably the document that was frozen.
   */
  contentHash: string;
  /**
   * The dispatched parties, in the order sent to Scrive — which is the order
   * Scrive returns them, so the Nth provider party is this Nth entry. Carries
   * what `recordSignature` cannot get from the provider: the `requestId` to
   * resolve and the substrat `ref`/`kind` to attribute the signature to.
   */
  parties: {
    requestId: string;
    label: string;
    kind: 'principal' | 'external';
    /** The substrat signatory, when known up front; null when identity is only learned at signing. */
    ref: string | null;
  }[];
  /** Requests already recorded by a prior poll — so a re-poll is a no-op, not a double. */
  recordedRequestIds?: string[];
  /**
   * The capability token minted for this dispatch's callback URL (#96) — present
   * exactly when the connector was configured with `callbackUrl`. The ingress
   * compares a presented token against this in constant time and answers
   * uniformly otherwise; a row without one (older dispatch, poll-only config)
   * simply has no callback door, and the sweep remains its only trigger.
   */
  webhookToken?: string;
  /**
   * The attachment id of the sealed signed PDF, once landed (#476 step 2). Set after the
   * document closes and the file is fetched and stored via the blob-store attachment
   * surface; its presence is what makes a re-poll skip the download rather than land a
   * second copy — the connection can write attachments but not list them, so the ledger is
   * the only idempotency handle.
   */
  sealedAttachmentId?: string;
  dispatchedAt: string;
}

/**
 * The connector-state key prefix under which every dispatch ledger row lives —
 * the handle the poll sweep enumerates by (`listConnectorState(id, prefix)`).
 */
const DISPATCH_PREFIX = 'scrive:dispatch:';
/** The connector-state key for one signature request set. */
const dispatchKey = (instanceId: string): string => `${DISPATCH_PREFIX}${instanceId}`;

/** The payload half of `protocol.signatures-requested` this connector reads. */
const signaturesRequested = z.object({
  instanceId: z.string().min(1),
  templateKey: z.string().min(1),
  templateVersion: z.number().int(),
  contentHash: z.string().min(1),
  boundHash: z.string().nullable().optional(),
  method: z.string().min(1),
  parties: z.array(
    z.object({
      requestId: z.string().min(1),
      label: z.string().min(1),
      kind: z.enum(['principal', 'external']),
      ref: z.string().nullable(),
      signatureKind: z.enum(['primary', 'counter']),
      // #620: absent on events emitted by an engine older than 0003 — read as
      // `basic`, which is what those requests effectively asked for.
      authLevel: z.enum(['basic', 'strong']).default('basic'),
    }),
  ),
});

/**
 * The engine's provider-agnostic `authLevel` → Scrive's own vocabulary (#620, #687).
 *
 * `strong` means a national eID, which for Scrive is `se_bankid`.
 *
 * This used to REFUSE `strong` before egress, on the reasoning that Scrive's BankID
 * auth-to-sign requires a `personal_number` on the party and this platform carries no
 * personnummer by design (B6: it may reach neither the kernel, the events, nor the
 * audit trail). The premise was wrong, and #687 measured it: what Scrive validates is
 * that the party HAS a `personal_number` field, not that it holds a value. An empty
 * field — which carries no PII and needs no lawful carrier — draws exactly the same
 * `start` errors as a filled one, and the signatory completes it during the BankID
 * ceremony. `ScriveApi.update` sends that empty field for every `se_bankid` party.
 *
 * The direction of travel agrees: BankID has not accepted a `personalNumber` from the
 * relying party since API v6 — the personnummer comes back in the completion data.
 *
 * So `strong` maps straight through. What still stops such a document from starting is
 * the DELIVERY address (#687 item 1), which is not specific to BankID: no party this
 * connector sends carries an email, so Scrive answers
 * `invalid_invitation_delivery_info` at `basic` too. That gap is a carrier for a
 * contact, not an auth-level refusal, and refusing `strong` here never addressed it.
 */
function scriveAuthMethod(
  authLevel: 'basic' | 'strong',
  fallback: 'standard' | 'se_bankid',
): 'standard' | 'se_bankid' {
  return authLevel === 'strong' ? 'se_bankid' : fallback;
}

/**
 * Build the handler. Register it with `host.registerConnector`.
 *
 * Only reacts to `method: 'scrive'` — a vertical asking for BankID through
 * another provider emits the same event, and this must not answer for it.
 */
export function scriveConnector(options: ScriveConnectorOptions): ConnectorHandler {
  const baseUrl = options.baseUrl ?? SCRIVE_TESTBED;
  const defaultAuthMethod = options.defaultAuthMethod ?? 'standard';

  return async (ctx, event: DomainEvent) => {
    const payload = signaturesRequested.parse(event.payload);
    if (payload.method !== 'scrive') return; // not ours; delivered, not effected

    const conn = await ctx.connection('scrive');

    // Idempotency (#101 gap 3). Delivery is at-least-once, so a redelivery must
    // not create a SECOND Scrive document — duplicate legal paperwork sent to
    // real signatories. The connector cannot record "done" in the scope, because
    // it runs INSIDE the scope's dispatch and re-entering the scope actor
    // deadlocks (verified). So the dispatch ledger lives in the directory, which
    // `ctx.admin` reaches without touching the scope.
    const key = dispatchKey(payload.instanceId);
    const prior = (await ctx.admin.getConnectorState(conn.id, key)) as
      | ScriveDispatchState
      | undefined;
    if (prior) return; // already dispatched — do nothing, idempotently

    // Resolve every party's authentication method BEFORE the first call (#620).
    // It no longer refuses anything (#687), so nothing here can orphan a draft —
    // but the mapping stays up front, because anything that ever DOES refuse must
    // do so before `createDocument`: a throw mid-`update` leaves a draft behind at
    // the provider, and a retrying delivery leaves one per attempt.
    const authMethods = payload.parties.map((p) => scriveAuthMethod(p.authLevel, defaultAuthMethod));

    const api = new ScriveApi(conn, baseUrl);

    // The artifact. NOT the avtal — this connector cannot read the vertical's
    // content, and should not learn its vocabulary in order to try. It renders
    // an attestation sheet naming what is being signed and the hash it is
    // identified by. A real contract needs the vertical's own rendering plus a
    // document store, and neither exists (see README).
    const pdf = renderPdf({
      title: `${payload.templateKey} v${payload.templateVersion}`,
      lines: [
        `Instans: ${payload.instanceId}`,
        `Innehållshash (SHA-256): ${payload.contentHash}`,
        ...(payload.boundHash ? [`Dokumenthash: ${payload.boundHash}`] : []),
        '',
        'Parter:',
        ...payload.parties.map((p) => `  ${p.label} (${p.signatureKind})`),
        '',
        'Signaturen avser innehållet som identifieras av hashen ovan.',
      ],
    });

    // The capability token (#96): minted per dispatch, stored in the ledger row,
    // and laid into the callback URL — the URL is the only authentication a
    // Scrive callback will ever carry, so it has to be unguessable.
    const webhookToken = options.callbackUrl ? mintCallbackToken() : undefined;

    const doc = await api.createDocument();
    await api.setFile(doc.id, `${payload.templateKey}.pdf`, pdf);
    await api.update(doc.id, {
      title: `${payload.templateKey} v${payload.templateVersion}`,
      ...(options.callbackUrl && webhookToken
        ? {
            callbackUrl: options.callbackUrl({
              connectionId: conn.id,
              instanceId: payload.instanceId,
              token: webhookToken,
            }),
          }
        : {}),
      // Tag the document with the instance id (verified settable). It is not yet
      // used for dedup — the list-by-tag filter needs a query syntax not settled
      // here — but it makes the eventual provider-side reconciliation that would
      // close the narrow create-then-record window (below) a filter away.
      tags: [{ name: 'substrat_instance', value: payload.instanceId }],
      parties: payload.parties.map(
        (p, i): ScriveParty => ({
          name: p.label,
          // #620: the REQUEST decides, then this connection's default, then
          // `standard` — resolved above, before any egress. It used to be
          // `p.kind === 'external' ? 'se_bankid' : 'standard'`: a requirement the
          // caller could neither see nor satisfy, and the reason every document
          // this connector ever sent came back a 409. `update` adds the empty
          // `personal_number` field a `se_bankid` party needs (#687).
          authenticationMethodToSign: authMethods[i]!,
          // Scrive auto-adds the API user as the author, and exactly one party
          // must be it. The issuing (primary) party is the sender's side, so it
          // is the author — and it still signs. Verified: an explicit author
          // party in `update` replaces the auto one.
          isAuthor: p.signatureKind === 'primary',
          isSignatory: true,
        }),
      ),
    });
    await api.start(doc.id);

    // Record the dispatch so a redelivery skips it. This is the write that
    // closes the duplicate hole for the common case (a retry after a fully
    // successful dispatch).
    //
    // The residual: if this write itself fails after `start` succeeded, the
    // retry finds no state and creates a second document. Closing that fully
    // needs provider-side dedup — the `substrat_instance` tag set above, once a
    // list-by-tag query lets the connector adopt an existing document instead of
    // creating one. Left as a follow-up; a rare double is a large improvement on
    // every-retry-doubles.
    const state: ScriveDispatchState = {
      documentId: doc.id,
      instanceId: payload.instanceId,
      scopeId: ctx.scopeId,
      tenantId: ctx.tenantId,
      vertical: ctx.vertical,
      contentHash: payload.contentHash,
      parties: payload.parties.map((p) => ({
        requestId: p.requestId,
        label: p.label,
        kind: p.kind,
        ref: p.ref,
      })),
      ...(webhookToken ? { webhookToken } : {}),
      dispatchedAt: event.occurredAt,
    };
    await ctx.admin.putConnectorState(conn.id, key, state);
  };
}

/**
 * Register the connector on a host.
 *
 * `maxAttempts` is deliberately higher than the executor default: a provider
 * being briefly unreachable is ordinary, and giving up on a signature request
 * after five tries would be giving up on a contract.
 */
export function registerScriveConnector(
  host: ScopeHost,
  options: ScriveConnectorOptions & { id?: string; retry?: ConnectorOptions },
): void {
  host.registerConnector(
    options.id ?? 'scrive',
    'protocol.signatures-requested',
    scriveConnector(options),
    {
      maxAttempts: 8,
      baseDelayMs: 5_000,
      maxDelayMs: 900_000,
      timeoutMs: 30_000,
      ...options.retry,
    },
  );
}

/** The outcome of reconciling one dispatched instance against the provider. */
export interface ScriveReconcileResult {
  /** The provider document reconciled. */
  documentId: string;
  /** Scrive's current document status (`pending`, `closed`, `rejected`, …). */
  documentStatus: string;
  /** Requests recorded as signed on THIS run (empty if nothing new completed). */
  recorded: { requestId: string; signedAt: string }[];
  /** Parties the provider reports as signed that the driver could not record, and why. */
  skipped: { requestId: string; reason: string }[];
  /** True once every party in the set has been recorded into the scope. */
  complete: boolean;
  /**
   * The sealed signed PDF's fate this run (#476 step 2): `{ attachmentId }` when it was
   * fetched and landed, `{ skipped }` with a reason when the document is not yet closed,
   * already landed, or the store was unreachable (retried next poll). Absent when the
   * document never reached completion.
   */
  sealedDocument?: { attachmentId: string } | { skipped: string };
}

/**
 * The RETURN path (#97): read the provider's state for one dispatched instance
 * and record any completed signatures back into the scope.
 *
 * This is the half the connector could not do until #97 landed. A provider's
 * signature has to be written onto the protocol instance in the SCOPE, and a
 * connector is not a `PrincipalId`, so `getScope` could not let it in. #97 gives
 * the door a connection can walk through — `getConnectorScope(connectionId,
 * scopeId)` returns a stub whose authority is the connection itself, and what it
 * may do is an ordinary permission check against `connection:<id>` grants. So
 * this records a signature by invoking `protocol/record-signature` on that stub;
 * it works iff the connection was granted `protocol:record-signature`
 * (`grantToConnection`), which appears in the permission diff like any grant.
 *
 * **Why a top-level function and not the dispatch handler.** A connector runs
 * INSIDE the scope's dispatch, and re-entering the scope actor from there
 * deadlocks (the reason dispatch idempotency lives in the directory, not the
 * scope). Recording runs as its own top-level operation, outside any dispatch —
 * which is exactly what a poll driver or a callback ingress is. Neither exists
 * yet (nothing schedules this — issue #96); this is the reconcile step both will
 * call, made correct and testable now, invoked by hand or by a test until a
 * scheduler lands.
 *
 * Idempotent by construction: signed requests are remembered in the ledger, so a
 * re-poll of a half-signed set records only what is newly done, and re-polling a
 * fully-signed set records nothing.
 *
 * `fetch` is passed in because sanctioned egress is the host's to own and it
 * exposes no top-level opener; the same `fetch` the host was built with is
 * bound here to the connection (with health recorded via `recordConnectionUse`),
 * mirroring what the dispatch context does internally.
 */
export async function reconcileScriveDispatch(
  host: ScopeHost,
  connectionId: ConnectionId,
  instanceId: string,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): Promise<ScriveReconcileResult> {
  const admin = host.admin;
  const key = dispatchKey(instanceId);
  const state = (await admin.getConnectorState(connectionId, key)) as ScriveDispatchState | undefined;
  if (!state) {
    throw new Error(
      `no scrive dispatch recorded for instance ${instanceId} on connection ${connectionId} — ` +
        `nothing to reconcile`,
    );
  }

  // Read the provider's truth. A callback would only be a hint to do exactly
  // this; the fact is `documents/{id}/get`.
  const conn = await openScriveConnection(
    admin,
    options.fetch,
    tenantId.parse(state.tenantId),
    state.vertical,
    options.timeoutMs ?? 30_000,
  );
  const api = new ScriveApi(conn, options.baseUrl ?? SCRIVE_TESTBED);
  const doc = await api.get(state.documentId);

  // The connection acting as itself (#97). Refuses a scope in another tenant or
  // running another vertical by construction, and every write below is gated on
  // the connection's own `protocol:record-signature` grant.
  const scope = await host.getConnectorScope(connectionId, scopeId.parse(state.scopeId));

  const recorded: { requestId: string; signedAt: string }[] = [];
  const skipped: { requestId: string; reason: string }[] = [];
  const done = new Set(state.recordedRequestIds ?? []);

  for (const [i, party] of state.parties.entries()) {
    if (done.has(party.requestId)) continue; // recorded on an earlier poll
    const providerParty = doc.parties[i];
    const signedAt = providerParty?.sign_time ?? null;
    if (!signedAt) continue; // not signed yet

    // Fail closed on a party-order mismatch rather than attributing a signature
    // to the wrong request. The connector sends exactly the party set Scrive
    // keeps, in order, so index alignment holds for this model; if a provider
    // ever reorders, the name disagreeing is the signal to move to name-keyed
    // matching — and until then this refuses to guess.
    const providerName = providerParty?.fields?.find((f) => f.type === 'name')?.value;
    if (providerName !== undefined && providerName !== party.label) {
      skipped.push({
        requestId: party.requestId,
        reason: `provider party ${i} is '${String(providerName)}', dispatch expected '${party.label}' — refusing to attribute`,
      });
      continue;
    }

    if (!party.ref) {
      // The request named no signatory up front and the connector does not
      // extract the signer's identity from the provider (personnummer is direct
      // PII we deliberately never persist), so there is no `ref` to attribute to.
      skipped.push({
        requestId: party.requestId,
        reason: 'provider reports a signature but the request named no signatory ref to attribute it to',
      });
      continue;
    }

    try {
      await scope.invoke('protocol/record-signature', {
        requestId: party.requestId,
        signatory: { kind: party.kind, ref: party.ref, label: party.label },
        signedAt,
        // Reported verbatim; `recordSignature` checks it against the re-derived
        // frozen hash and fails closed on disagreement.
        contentHash: state.contentHash,
        // Where the proof lives at the provider — the sealed document.
        evidenceRef: `scrive:document:${state.documentId}`,
      });
      recorded.push({ requestId: party.requestId, signedAt });
      done.add(party.requestId);
    } catch (err) {
      // A request already resolved (a racing poll, or a redelivery) is not an
      // error to this driver — the signature is on the instance, which is the
      // goal. Anything else is real and propagates.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already/i.test(msg)) {
        done.add(party.requestId);
        continue;
      }
      throw err;
    }
  }

  const complete = state.parties.every((p) => done.has(p.requestId));

  // The sealed document (#476 step 2). Once the provider closes the document and every
  // party is recorded in the scope, the signing evidence exists only at Scrive — pull the
  // sealed PDF once and land it as an attachment on the protocol instance, keyed to the
  // `protocol` attachment target the engine declares. The connection lands it as ITSELF
  // (`getConnectorAttachments` gates on its `protocol:attach` grant), so the row and the
  // object are born together inside the scope. Attempted after signatures are recorded and
  // never allowed to undo them: a failure here (store not provisioned yet, transient
  // egress) is reported and retried next poll, not thrown.
  let sealedDocument: ScriveReconcileResult['sealedDocument'];
  let sealedAttachmentId = state.sealedAttachmentId;
  if (doc.status === 'closed' && complete && !sealedAttachmentId) {
    try {
      const bytes = await api.getMainFile(state.documentId);
      const attachments = await host.getConnectorAttachments(
        connectionId,
        scopeId.parse(state.scopeId),
      );
      const record = await attachments.upload({
        entity: { entityType: 'protocol', entityId: state.instanceId },
        filename: `signed-${state.documentId}.pdf`,
        contentType: 'application/pdf',
        // The signed contract is the customer-facing proof of the signature.
        visibility: 'customer',
        body: bytes,
      });
      sealedAttachmentId = record.id;
      sealedDocument = { attachmentId: record.id };
    } catch (err) {
      sealedDocument = { skipped: err instanceof Error ? err.message : String(err) };
    }
  } else if (sealedAttachmentId) {
    sealedDocument = { skipped: 'already landed' };
  } else if (doc.status === 'closed' && !complete) {
    sealedDocument = { skipped: 'document closed but not every party is recorded yet' };
  }

  // Remember what is recorded — and whether the sealed PDF landed — so a re-poll skips both
  // without leaning on `recordSignature` throwing. Same row as the dispatch ledger, so the
  // dispatch idempotency guard still finds it.
  if (recorded.length || sealedAttachmentId !== state.sealedAttachmentId) {
    await admin.putConnectorState(connectionId, key, {
      ...state,
      recordedRequestIds: [...done],
      ...(sealedAttachmentId ? { sealedAttachmentId } : {}),
    } satisfies ScriveDispatchState);
  }

  return {
    documentId: state.documentId,
    documentStatus: doc.status,
    recorded,
    skipped,
    complete,
    ...(sealedDocument ? { sealedDocument } : {}),
  };
}

/**
 * The identity half of a connection, as the directory holds it — everything the two
 * read paths below need to reopen the credential. Deliberately not the whole
 * `Connection`: these functions reopen a connection, they do not inspect one.
 */
export interface ScriveConnectionRef {
  id: ConnectionId;
  tenantId: string;
  vertical: string;
}

/**
 * **Probe** the credential (#605): one cheap authenticated read, answering whether
 * Scrive accepts these keys and whose account they act as.
 *
 * Why this exists. A connection's health (§3.7) is written by whatever call happened
 * last, so a freshly connected credential carries no health at all until the first real
 * dispatch — which for this connector means a legal document going out to real
 * signatories. Verifying at connect time is the difference between finding a typo now
 * and finding it in a failed signing request days later.
 *
 * A rejected credential is a RESULT, not an exception: `{ ok: false, error }` carries
 * the provider's own words, and "This feature is disabled" reading differently from
 * "No valid access credentials were provided" is the entire point. Failures that are
 * not the provider's answer — no live connection, a secret that cannot be unsealed —
 * still throw, because those are platform faults and must not read as a bad key.
 *
 * Rides the same connection-bound `fetch` as every other call here, so a probe also
 * refreshes `lastOkAt` / `lastError` — verifying is itself a use.
 */
export async function probeScriveConnection(
  host: ScopeHost,
  connection: ScriveConnectionRef,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): Promise<ConnectionProbe> {
  const conn = await openScriveConnection(
    host.admin,
    options.fetch,
    tenantId.parse(connection.tenantId),
    connection.vertical,
    options.timeoutMs ?? 15_000,
  );
  return probeWith(conn, options.baseUrl ?? SCRIVE_TESTBED);
}

/**
 * **Probe a credential that is not stored yet** (#605) — the connect-time check.
 *
 * The gap this closes: connecting used to mean *storing*. The row was written, the UI
 * said "Connected", and the first evidence that Scrive disagreed arrived on the next
 * dispatch or sweep — by which point a signature request had already failed. Worse for a
 * ROTATION, where writing first replaces a working credential with a broken one.
 *
 * So this takes the candidate secret directly, touches no connection and no store, and
 * lets the caller decide before anything is written. It records no health for the same
 * reason: there may be no connection to record it against, and a candidate's failure is
 * not a fact about the live connection.
 *
 * `refused` on the result is what makes the answer actionable — see the field's own note:
 * a 401/403 is grounds to reject the connect, an unreachable provider is not.
 */
export async function probeScriveSecret(
  secret: Record<string, string>,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): Promise<ConnectionProbe> {
  const parsed = scriveSecret.safeParse(secret);
  if (!parsed.success) {
    // A malformed credential IS a refusal — the provider would reject it, and there is
    // no point spending a round trip to hear so.
    return {
      ok: false,
      refused: true,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: `incomplete Scrive credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const conn: ConnectorConnection = {
    id: connectionId.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'scrive',
    secret: parsed.data,
    expiresAt: null,
    fetch: (input, init) => options.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  };
  return probeWith(conn, options.baseUrl ?? SCRIVE_TESTBED);
}

/** The shared probe body: one `getprofile`, mapped to the platform's declared shape. */
async function probeWith(conn: ConnectorConnection, baseUrl: string): Promise<ConnectionProbe> {
  const api = new ScriveApi(conn, baseUrl);
  // WHICH Scrive this is, on every answer — and especially on a failure. A production
  // credential sent to the testbed comes back 401, identical to a mistyped key, so a
  // probe that does not name the environment sends an operator to check the wrong thing.
  // (It happened: the deployed control plane ran with no SCRIVE_BASE_URL and silently
  // fell through to the connector's testbed default.)
  const environment = { label: 'Environment', value: describeEnvironment(baseUrl) };
  let profile;
  try {
    profile = await api.getProfile();
  } catch (err) {
    return {
      ok: false,
      // Only the provider saying "not with these credentials" counts. A timeout or a
      // 5xx says nothing about the credential, and treating it as a refusal would make
      // a Scrive outage look like every tenant's keys going bad at once.
      refused: err instanceof ScriveApiError && err.refused,
      accountRef: null,
      accountLabel: null,
      facts: [environment],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const person = [profile.fstname, profile.sndname].filter((s) => s !== '').join(' ');
  const company = profile.company?.companyname ?? '';
  return {
    ok: true,
    refused: false,
    // What `externalAccountRef` means for this provider — so a console can say "these
    // keys are for a different Scrive company than the one you connected".
    accountRef: profile.company?.companyid ?? null,
    accountLabel: company !== '' ? `${company}${profile.email ? ` (${profile.email})` : ''}` : (profile.email || null),
    facts: [
      environment,
      ...(company !== '' ? [{ label: 'Company', value: company }] : []),
      ...(person !== '' || profile.email
        ? [{ label: 'API user', value: person !== '' ? `${person}${profile.email ? ` <${profile.email}>` : ''}` : profile.email }]
        : []),
      ...(profile.role ? [{ label: 'Role', value: profile.role.replace(/^role_/, '').replace(/_/g, ' ') }] : []),
    ],
    error: null,
  };
}

/**
 * Name the provider environment a base URL points at — 'production (scrive.com)',
 * 'testbed (api-testbed.scrive.com)', or the bare host for anything else (a mock, a
 * self-hosted proxy). Reported by every probe, because "which Scrive did you ask?" is
 * the question a 401 leaves an operator with, and guessing it wrong costs an afternoon.
 */
function describeEnvironment(baseUrl: string): string {
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (host === 'scrive.com' || host === 'www.scrive.com') return `production (${host})`;
  if (host.includes('testbed')) return `testbed (${host})`;
  return host;
}

/** Provider status → the word an operator reads. Unknown values pass through verbatim. */
const DOCUMENT_STATUS: Record<string, string> = {
  preparation: 'draft at provider',
  pending: 'awaiting signatures',
  closed: 'signed',
  canceled: 'cancelled',
  timedout: 'timed out',
  rejected: 'rejected',
};

/** An ISO instant, or null — a projector must never fail a read over a stray timestamp. */
const asInstant = (value: string | undefined): Instant | null => {
  const parsed = instant.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * **What this connection has done** (#605) — the dispatch ledger, projected into the
 * platform's declared activity shape.
 *
 * The ledger is the only durable record that an outbound call ever happened: the audit
 * log deliberately holds none (`openConnection` is unaudited — one row per outbound HTTP
 * call would drown the log that matters) and health keeps exactly one line. So this is
 * the read that answers "has anything gone out, and what happened to it".
 *
 * **The projection is the redaction.** A ledger row carries the callback capability
 * token — the entire authentication of the webhook door — so the row must never be
 * served raw. Mapping it here, field by field into a declared shape, is what makes
 * that structural rather than something a route has to remember.
 *
 * `live` joins the provider's CURRENT status onto each row with ONE `documents/list`
 * call. A provider failure degrades to the ledger's own view (`live: false`) rather
 * than failing the read: a console that can't reach Scrive should still show what was
 * sent. The flag travels in the result precisely so the UI never presents a stale
 * ledger status as the provider's truth.
 */
export async function scriveConnectionActivity(
  host: ScopeHost,
  connection: ScriveConnectionRef,
  options: {
    fetch: FetchLike;
    baseUrl?: string;
    timeoutMs?: number;
    live?: boolean;
    /** `provider` lists Scrive's own archive instead; see {@link scriveProviderDocuments}. */
    source?: ConnectionActivitySource;
  },
): Promise<ConnectionActivity> {
  if (options.source === 'provider') return scriveProviderDocuments(host, connection, options);
  const rows = await host.admin.listConnectorState(connection.id, DISPATCH_PREFIX);

  // The live join: one bounded page, keyed by document id. Best-effort by design.
  let provider: Map<string, { title: string; status: string; mtime?: string }> | undefined;
  if (options.live) {
    try {
      const conn = await openScriveConnection(
        host.admin,
        options.fetch,
        tenantId.parse(connection.tenantId),
        connection.vertical,
        options.timeoutMs ?? 15_000,
      );
      const api = new ScriveApi(conn, options.baseUrl ?? SCRIVE_TESTBED);
      const list = await api.listDocuments({ max: 100 });
      provider = new Map(
        list.documents.map((d) => [d.id, { title: d.title, status: d.status, mtime: d.mtime }]),
      );
    } catch {
      provider = undefined; // degraded to the ledger's view; reported as `live: false`
    }
  }

  const entries = rows.map(({ key, value }) => {
    const state = value as ScriveDispatchState;
    const done = new Set(state.recordedRequestIds ?? []);
    const signed = state.parties.filter((p) => done.has(p.requestId)).length;
    const live = provider?.get(state.documentId);

    // Ledger-derived status, used when there is no live read. It says what the PLATFORM
    // knows — signatures recorded, sealed copy stored — never what the provider has
    // since done, which is exactly the distinction `live` exists to keep honest.
    const ledgerStatus =
      state.sealedAttachmentId !== undefined
        ? 'signed — sealed copy stored'
        : state.parties.length > 0 && signed === state.parties.length
          ? 'signed'
          : signed > 0
            ? `partly signed (${signed}/${state.parties.length})`
            : 'sent for signature';

    return {
      key,
      title: live?.title && live.title !== '' ? live.title : `Signature request ${state.instanceId}`,
      reference: state.documentId,
      status: live ? (DOCUMENT_STATUS[live.status] ?? live.status) : ledgerStatus,
      at: asInstant(state.dispatchedAt),
      facts: [
        ...state.parties.slice(0, 24).map((p) => ({
          label: p.label,
          value: done.has(p.requestId) ? 'signature recorded' : 'awaiting signature',
        })),
        { label: 'Content hash', value: state.contentHash },
        ...(state.sealedAttachmentId ? [{ label: 'Sealed copy', value: 'stored on the instance' }] : []),
        ...(live?.mtime ? [{ label: 'Provider last change', value: live.mtime }] : []),
      ],
    };
  });

  // Newest first — a console reads the last thing that happened, not the first.
  entries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { source: 'ledger', entries, live: provider !== undefined };
}

/**
 * **The provider's own archive** (#605) — `documents/list`, straight through.
 *
 * A different question from the ledger, and worth asking separately: this shows every
 * document in the Scrive account, including ones nobody here created (someone working in
 * Scrive's own UI) and ones sent before this connection existed. The ledger cannot show
 * those, and this cannot show a dispatch the platform recorded but Scrive never received.
 * Two views, both true, neither a superset — which is why `source` travels in the answer.
 *
 * Rows the platform DID send are marked as such: the connector tags every document it
 * creates with `substrat_instance`, so "sent from here" is a fact the provider itself
 * carries rather than a join this has to guess at.
 *
 * Unlike the ledger read, a provider failure here THROWS. There is no degraded view to
 * fall back to — an empty list would read as "the account is empty", which is a lie.
 */
export async function scriveProviderDocuments(
  host: ScopeHost,
  connection: ScriveConnectionRef,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number; max?: number },
): Promise<ConnectionActivity> {
  const conn = await openScriveConnection(
    host.admin,
    options.fetch,
    tenantId.parse(connection.tenantId),
    connection.vertical,
    options.timeoutMs ?? 15_000,
  );
  const api = new ScriveApi(conn, options.baseUrl ?? SCRIVE_TESTBED);
  const list = await api.listDocuments({ max: options.max ?? 50 });

  // Which of them this platform sent — read from the ledger, so the marking is ours to
  // know and needs no extra provider call.
  const ours = new Set(
    (await host.admin.listConnectorState(connection.id, DISPATCH_PREFIX)).map(
      ({ value }) => (value as ScriveDispatchState).documentId,
    ),
  );

  return {
    source: 'provider',
    live: true, // by construction — these ARE the provider's rows
    entries: list.documents.map((d) => ({
      key: `scrive:document:${d.id}`,
      title: d.title !== '' ? d.title : `Document ${d.id}`,
      reference: d.id,
      status: DOCUMENT_STATUS[d.status] ?? d.status,
      at: asInstant(d.ctime),
      facts: [
        ...(d.mtime ? [{ label: 'Last change', value: d.mtime }] : []),
        { label: 'Sent from', value: ours.has(d.id) ? 'this app' : 'elsewhere in this Scrive account' },
      ],
    })),
  };
}

/**
 * **The stored credential, as a console may see it** (#605).
 *
 * The four-part OAuth1 credential goes into the store and never comes back out — that
 * rule is why `Connection` cannot carry a secret. But it left an integrations screen
 * where "connected" and "connected with a mistyped token" looked the same, and the only
 * repair on offer was to paste all four fields again blind.
 *
 * So the connector — the only party that knows which of ITS fields are identifiers and
 * which are secrets — answers a reduced view. Scrive's own UI calls two of the four
 * "credentials identifier"; those are shown whole, because an identifier that cannot be
 * read identifies nothing. The two secrets are reduced to a bullet run and their last
 * four characters: enough to tell two credentials apart at a glance, not enough to sign
 * a request with. Anything shorter than eight characters is masked entirely rather than
 * mostly revealed.
 */
export async function scriveCredentialSummary(
  host: ScopeHost,
  connection: ScriveConnectionRef,
): Promise<ConnectionCredential> {
  const open = await host.admin.openConnection(
    tenantId.parse(connection.tenantId),
    connection.vertical,
    'scrive',
  );
  if (!open) {
    throw new Error(
      `no live 'scrive' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`,
    );
  }
  const secret = scriveSecret.parse(open.secret);
  return {
    fields: [
      { key: 'clientId', label: 'Client credentials identifier', value: secret.clientId, masked: false },
      { key: 'clientSecret', label: 'Client credentials secret', value: mask(secret.clientSecret), masked: true },
      { key: 'tokenId', label: 'Token credentials identifier', value: secret.tokenId, masked: false },
      { key: 'tokenSecret', label: 'Token credentials secret', value: mask(secret.tokenSecret), masked: true },
    ],
  };
}

/** A bullet run plus the last four — or nothing at all when there is too little to hide behind. */
const mask = (value: string): string =>
  value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`;

/** What one sweep of a connection's outstanding dispatches did. */
export interface ScriveSweepResult {
  /** Dispatch ledger rows enumerated for the connection. */
  found: number;
  /** Rows the ledger already shows fully recorded — not polled against the provider. */
  skipped: number;
  /** Rows reconciled against the provider this sweep. */
  polled: number;
  /** Instances that reached "every party signed" this sweep. */
  completed: string[];
  /** Instances polled but still awaiting at least one signature. */
  outstanding: string[];
  /** Per-instance reconcile failures; the sweep continues past them. */
  failed: { instanceId: string; error: string }[];
}

/**
 * The SCHEDULER's unit of work (#96, poll path): reconcile every outstanding
 * dispatch for one connection against the provider.
 *
 * `reconcileScriveDispatch` records the signatures for ONE known instance; this
 * is what finds the instances. It enumerates the dispatch ledger
 * (`listConnectorState(connectionId, 'scrive:dispatch:')` — the read that method
 * exists for) and reconciles each row that is not already fully recorded. A
 * timer calls this; it holds no timer itself. That keeps the trigger a
 * deployment concern (a Cloudflare cron or Durable Object alarm, the same home
 * `drainDue` still needs) and this a plain, testable function.
 *
 * Robust by construction, because a poller must be: a row already complete per
 * the ledger is skipped without touching the provider (so a finished signature
 * is not re-fetched on every tick), and a provider error on one instance is
 * recorded and stepped over rather than sinking the batch. Idempotent — running
 * it twice over the same state records nothing the second time.
 *
 * Scoped to one connection deliberately: a connection is (tenant, vertical,
 * provider), so a sweep never crosses a tenant. A platform sweeper iterates the
 * connections it is responsible for and calls this for each.
 */
export async function sweepScriveReconciliations(
  host: ScopeHost,
  connectionId: ConnectionId,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): Promise<ScriveSweepResult> {
  const entries = await host.admin.listConnectorState(connectionId, DISPATCH_PREFIX);
  const result: ScriveSweepResult = {
    found: entries.length,
    skipped: 0,
    polled: 0,
    completed: [],
    outstanding: [],
    failed: [],
  };

  for (const { value } of entries) {
    const state = value as ScriveDispatchState;
    // The ledger already knows this one is done — don't poll a settled document.
    const done = new Set(state.recordedRequestIds ?? []);
    if (state.parties.length > 0 && state.parties.every((p) => done.has(p.requestId))) {
      result.skipped += 1;
      continue;
    }
    try {
      const r = await reconcileScriveDispatch(host, connectionId, state.instanceId, options);
      result.polled += 1;
      (r.complete ? result.completed : result.outstanding).push(state.instanceId);
    } catch (err) {
      result.failed.push({
        instanceId: state.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/** 256 bits from the runtime's CSPRNG, as hex — the capability a callback URL carries. */
function mintCallbackToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare a presented token against the stored one without leaking where they
 * diverge: both are digested first, and the DIGESTS are compared bytewise, so
 * the comparison runs over fixed-length, attacker-unpredictable values whatever
 * the inputs were. (`crypto.subtle.timingSafeEqual` is Workers-only; this holds
 * everywhere the connector runs.)
 */
async function tokensMatch(presented: string, stored: string): Promise<boolean> {
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(presented), digest(stored)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** What the ingress did with one callback. */
export type ScriveCallbackOutcome =
  /** Token verified; the reconcile ran. `result` is the same shape a poll returns. */
  | { accepted: true; result: ScriveReconcileResult }
  /**
   * Not verified — unknown connection, unknown instance, no callback door on
   * the row, or a token mismatch. Deliberately ONE shape for all four: which it
   * was is logged server-side, never answered to the caller, so the response is
   * no oracle for probing which instances exist.
   */
  | { accepted: false; reason: string };

/**
 * The webhook INGRESS (#96) — the push half of the return path, beside the poll.
 *
 * Scrive's callbacks are unauthenticated and their bodies are untrusted, so
 * this takes no body at all: the capability URL is the entire input. Verify the
 * token against the dispatch ledger row, and on a match run the SAME
 * `reconcileScriveDispatch` the sweep runs — re-fetch the provider's truth,
 * record what is newly signed, idempotently (connections.md §5: a webhook is a
 * cache invalidation, not a fact).
 *
 * That design is also the replay protection. A replayed or stale callback
 * cannot assert anything — it only triggers another idempotent reconcile whose
 * facts come from `documents/{id}/get` — so a seen-set with a retention window
 * (the shape #96 sketched for providers that sign their callbacks) has nothing
 * to protect here. The cost of a replay is one provider read.
 *
 * Fail-closed and quiet: anything short of a verified token returns
 * `{ accepted: false }` with a uniform shape and NO provider egress — an
 * attacker without the token cannot make this function fetch. A reconcile
 * failure after verification throws (the caller should answer 5xx so the
 * provider retries); the poll floor covers whatever push drops.
 */
export async function handleScriveCallback(
  host: ScopeHost,
  ref: ScriveCallbackRef,
  options: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): Promise<ScriveCallbackOutcome> {
  const parsedConnection = connectionId.safeParse(ref.connectionId);
  if (!parsedConnection.success) return { accepted: false, reason: 'malformed connection id' };

  let state: ScriveDispatchState | undefined;
  try {
    state = (await host.admin.getConnectorState(
      parsedConnection.data,
      dispatchKey(ref.instanceId),
    )) as ScriveDispatchState | undefined;
  } catch {
    // An unknown connection reads the same as an unknown instance — no oracle.
    return { accepted: false, reason: 'no such dispatch' };
  }
  if (!state) return { accepted: false, reason: 'no such dispatch' };
  if (!state.webhookToken) return { accepted: false, reason: 'dispatch has no callback door' };
  if (!(await tokensMatch(ref.token, state.webhookToken))) {
    return { accepted: false, reason: 'token mismatch' };
  }

  const result = await reconcileScriveDispatch(host, parsedConnection.data, ref.instanceId, options);
  return { accepted: true, result };
}

/**
 * Open the connection with egress bound to it — the same binding the dispatch
 * context makes internally, rebuilt here from public `HostAdmin` methods because
 * the host exposes no top-level opener. Health lands on the right connection via
 * `recordConnectionUse`, exactly as a dispatched call's does.
 *
 * (The cleaner home is a host method that hands a `ConnectorConnection` to any
 * caller, dispatch or poll; that is a kernel addition for when the scheduler
 * lands, not a precondition for the record-back path.)
 */
async function openScriveConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: ReturnType<typeof tenantId.parse>,
  vertical: string,
  timeoutMs: number,
): Promise<ConnectorConnection> {
  const open = await admin.openConnection(tenant, vertical, 'scrive');
  if (!open) {
    throw new Error(`no live 'scrive' connection for tenant ${tenant} / vertical '${vertical}'`);
  }
  return {
    ...open,
    fetch: async (input, init) => {
      try {
        const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        await admin.recordConnectionUse(
          open.id,
          res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} from scrive` },
        );
        return res;
      } catch (err) {
        await admin.recordConnectionUse(open.id, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
