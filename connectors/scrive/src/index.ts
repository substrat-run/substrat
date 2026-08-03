import { z } from 'zod';
import { scopeId, tenantId, type ConnectionId, type DomainEvent } from '@substrat-run/contracts';
import type {
  ConnectorConnection,
  ConnectorHandler,
  ConnectorOptions,
  FetchLike,
  HostAdmin,
  ScopeHost,
} from '@substrat-run/kernel';
import { ScriveApi, SCRIVE_TESTBED, type ScriveParty } from './api.js';
import { renderPdf } from './pdf.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `api.ts`/`mock.ts` do.
declare const AbortSignal: { timeout(ms: number): unknown };

export { ScriveApi, SCRIVE_TESTBED, SCRIVE_PRODUCTION } from './api.js';
export { ScriveMock } from './mock.js';
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
 * The one gap that remains: **nothing calls the sweep on a timer** (#96, poll
 * path). There is no cron, queue or Durable Object alarm in any deployment yet —
 * the same trigger `drainDue` still lacks — so `sweepScriveReconciliations` runs
 * from a test or by hand today. That trigger, not the seam or the driver, is why
 * the connector stays unpublished; it is a deployment concern, not connector
 * code.
 */
export interface ScriveConnectorOptions {
  /** `SCRIVE_TESTBED` by default; production needs a paid licence. */
  baseUrl?: string;
  /**
   * Where Scrive should POST status changes.
   *
   * Scrive's callbacks are **unauthenticated** — there is no signature to
   * verify — so this must be a capability URL (an unguessable secret in the
   * path), and a callback must never be trusted as a fact. It is a hint to
   * re-read `documents/{id}/get`. Optional because polling alone is a complete
   * strategy and needs no ingress at all (#96).
   */
  callbackUrl?: (instanceId: string) => string;
}

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
    }),
  ),
});

/**
 * Build the handler. Register it with `host.registerConnector`.
 *
 * Only reacts to `method: 'scrive'` — a vertical asking for BankID through
 * another provider emits the same event, and this must not answer for it.
 */
export function scriveConnector(options: ScriveConnectorOptions): ConnectorHandler {
  const baseUrl = options.baseUrl ?? SCRIVE_TESTBED;

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

    const doc = await api.createDocument();
    await api.setFile(doc.id, `${payload.templateKey}.pdf`, pdf);
    await api.update(doc.id, {
      title: `${payload.templateKey} v${payload.templateVersion}`,
      ...(options.callbackUrl ? { callbackUrl: options.callbackUrl(payload.instanceId) } : {}),
      // Tag the document with the instance id (verified settable). It is not yet
      // used for dedup — the list-by-tag filter needs a query syntax not settled
      // here — but it makes the eventual provider-side reconciliation that would
      // close the narrow create-then-record window (below) a filter away.
      tags: [{ name: 'substrat_instance', value: payload.instanceId }],
      parties: payload.parties.map(
        (p): ScriveParty => ({
          name: p.label,
          // BankID for external signatories; a principal signing through the
          // provider still authenticates, but the flow does not require the
          // stronger method to be meaningful.
          authenticationMethodToSign: p.kind === 'external' ? 'se_bankid' : 'standard',
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
