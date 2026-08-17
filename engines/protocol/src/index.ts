import { z } from 'zod';
import {
  dataSubjectId,
  entityRef,
  instant,
  moduleManifest,
  permissionKey,
  principalId,
  type EntityRef,
  type EntityRow,
} from '@substrat-run/contracts';
import { protocolEntities } from './entities.js';
import {
  assertAllowed,
  ulid,
  type GuardPredicate,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The protocol engine (docs/design/engine-protocol.md, extracted at milestone
// B per decision 27: the second vertical's shape — Handlebar's per-bike
// condition report with a customer counter-signature at pickup — forced the
// invariants out of Callout's vertical code). The engine owns ONLY the
// invariants; template CONTENT (which protocols exist, what they contain)
// is 100% vertical-owned:
//
//   1. freeze freezes    — any write to a frozen instance's content fails
//   2. content_hash      — SHA-256 over template content + the frozen content;
//                          verifiable against replayed state
//   3. counter-sign      — an ADDITIONAL signature row on the same frozen
//                          content (hash re-verified, never new content)
//   4. append-only       — a response edit is a NEW row; history is audit
//                          material ("4.2 → 5.1 before signing")
//   5. version-pinned    — templates version immutably; an instance pins
//                          (key, version) at instantiation forever
//   6. void, not delete  — a protocol is superseded, never mutated or removed
//
// Entity-agnostic: an instance binds to any EntityRef ('workorder' today,
// anything tomorrow). The vertical declares the `protocol → <parent>` entity
// relation in ITS manifest — the engine cannot know the vertical's vocabulary.
//
// ---------------------------------------------------------------------------
// TWO CONTENT KINDS (milestone D). The engine's attestation half — hash,
// freeze, signatures, the guards — was always content-agnostic; only `fill`
// and the template shape were checklist-specific. That seam is now exposed:
//
//   kind: 'checklist' — sections/items, filled response-by-response. The
//     original shape; templates that predate this carry no `kind` and parse as
//     checklist, and their stored content_json is NEVER rewritten (the hash
//     covers it verbatim — a migration that touched it would invalidate every
//     signature ever made).
//
//   kind: 'document' — content the ENGINE NEVER SEES. A priced avtal, a
//     styrelserapport, a PDF: the vertical owns the rows and computes their
//     hash, and binds (contentRef, contentHash) to the instance. The engine
//     attests that a signature was made over exactly that hash at that time,
//     and says so honestly rather than pretending its recipe covered content
//     it never read. Recomputation is the VERTICAL's obligation — the engine
//     cannot verify what it cannot see, and claiming otherwise would be the
//     false audit trail a degenerate one-item checklist produces.
//
// ---------------------------------------------------------------------------
// FREEZE IS SEPARATE FROM SIGNING (milestone D). Signing used to freeze as a
// side effect, which was sound only because `signProtocol` is synchronous:
// the authenticated principal taps sign and the window between "what we showed
// them" and "what we hashed" is microseconds.
//
// An external signing flow (BankID via Scrive) is not synchronous, and the
// signatory is not a principal at all:
//
//   we dispatch a signing request  →  days pass  →  a customer signatory with
//   no account in the system signs  →  a webhook reports party X signed at
//   time T with evidence Y
//
// With freeze welded to signing, that instance stays `open` — and therefore
// writable — for the entire days-long window, so the document the customer
// saw and the content the hash is computed over can differ with no detection.
// That is a hole in the freeze invariant for ANY asynchronous signature,
// checklist or document alike.
//
// So freezing is now its own transition, and the missing noun is the
// SIGNATURE REQUEST:
//
//   open  --requestSignatures-->  pending_signature  --all resolved-->  signed
//     \                                  |
//      \--signProtocol (in-app)----------+-------------------------->  signed
//                                        |
//                          cancelSignatureRequests --> open (renegotiate)
//
// `pending_signature` is frozen: no fill, no rebind. The requests table also
// makes MULTI-PARTY expressible — "every requested party has signed" is
// `requireAllSigned`, which primary/counter alone could never say.
//
// What the engine deliberately does NOT do: talk to Scrive. Module code makes
// no network calls (boundary-lint R3). `requestSignatures` emits a fat
// `protocol.signatures-requested`; a connector/executor outside the scope
// effects it. The return path — webhook ingress and an inbound authority seam
// that lets a callback invoke `recordSignature` — does not exist in the kernel
// yet (see the issues filed alongside this change). `recordSignature` is
// shaped to be callable by that ingress when it lands, and is permissioned as
// its own key so nothing else can reach it in the meantime.
// ============================================================================

export const PROTOCOL_PERM = {
  create: permissionKey.parse('protocol:create'),
  fill: permissionKey.parse('protocol:fill'),
  bind: permissionKey.parse('protocol:bind'),
  requestSignature: permissionKey.parse('protocol:request-signature'),
  recordSignature: permissionKey.parse('protocol:record-signature'),
  sign: permissionKey.parse('protocol:sign'),
  countersign: permissionKey.parse('protocol:countersign'),
  read: permissionKey.parse('protocol:read'),
  attach: permissionKey.parse('protocol:attach'),
  void: permissionKey.parse('protocol:void'),
};

export const protocolManifest = moduleManifest.parse({
  id: '@substrat-run/engine-protocol',
  version: '0.0.2',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'protocol:create', description: 'Define protocol templates and start protocol instances on entities' },
    { key: 'protocol:fill', description: 'Record responses on an open checklist protocol (append-only)' },
    { key: 'protocol:bind', description: 'Bind vertical-owned document content (ref + hash) to an open document protocol' },
    { key: 'protocol:request-signature', description: 'Freeze a protocol and request signatures from named parties (external signing flows); also cancels a pending request set' },
    { key: 'protocol:record-signature', description: 'Record a signature reported by an external signing provider — held by connector ingress, never by a human role' },
    { key: 'protocol:sign', description: 'Sign a protocol in-app — freezes it forever (separate from fill: the technician fills, the arbetsledare signs)' },
    { key: 'protocol:countersign', description: 'Counter-sign an already-signed protocol — a second signature on the same frozen content (customer at pickup)' },
    { key: 'protocol:read', description: 'Read protocol templates, instances, responses, signature requests and signatures' },
    { key: 'protocol:attach', description: 'Attach a document to a protocol instance — the sealed signed PDF a signing connector lands on completion, or a human-uploaded document (the attachmentTargets write gate)' },
    { key: 'protocol:void', description: 'Void (supersede) a protocol — never deletes' },
  ],
  events: {
    emits: [
      { type: 'protocol.instantiated', schemaVersion: 1 },
      { type: 'protocol.response-recorded', schemaVersion: 1 },
      { type: 'protocol.content-bound', schemaVersion: 1 },
      { type: 'protocol.signatures-requested', schemaVersion: 1 },
      { type: 'protocol.signature-declined', schemaVersion: 1 },
      { type: 'protocol.signatures-cancelled', schemaVersion: 1 },
      { type: 'protocol.signed', schemaVersion: 1 },
      { type: 'protocol.countersigned', schemaVersion: 1 },
      { type: 'protocol.voided', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [
    { entityType: 'protocol', readPermission: 'protocol:read', writePermission: 'protocol:attach' },
  ],
  entitlementKey: 'protocol',
  ui: {
    entityViews: [{ entityType: 'protocol', view: './ui/ProtocolPanel' }],
  },
});

export const protocolMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE protocol_templates (
        id           TEXT PRIMARY KEY,
        key          TEXT NOT NULL,
        version      INTEGER NOT NULL,
        title        TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (key, version)
      );
      CREATE TABLE protocol_instances (
        id               TEXT PRIMARY KEY,
        template_key     TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        entity_type      TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('open','signed','voided')),
        created_by       TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        voided_by        TEXT,
        voided_reason    TEXT,
        voided_at        TEXT
      );
      CREATE TABLE protocol_responses (
        id           TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL REFERENCES protocol_instances(id),
        item_key     TEXT NOT NULL,
        value_json   TEXT NOT NULL,
        note         TEXT,
        responded_by TEXT NOT NULL,
        responded_at TEXT NOT NULL
      );
      CREATE TABLE protocol_signatures (
        id           TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL REFERENCES protocol_instances(id),
        signed_by    TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('primary','counter')),
        method       TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_ref TEXT,
        signed_at    TEXT NOT NULL
      );
    `,
  },
  // 0002 — MILESTONE D. Asynchronous, non-principal signatures and the
  // document content kind. Three shape changes:
  //
  //   1. `protocol_instances.status` gains 'pending_signature'. SQLite cannot
  //      ALTER a CHECK constraint, so this is the standard table rebuild.
  //   2. `protocol_instances` gains the frozen hash and the document binding.
  //      `frozen_hash` is BACKFILLED from each instance's earliest signature,
  //      so already-signed instances carry the hash they were frozen at.
  //   3. `protocol_signature_requests` — the new noun.
  //
  // The rebuild covers all three data tables rather than just `instances`,
  // because `responses`/`signatures` carry `REFERENCES protocol_instances(id)`
  // clauses: renaming out from under them leaves those clauses pointing at a
  // dropped table. The FK clauses are dropped rather than re-pointed —
  // neither adapter enables `PRAGMA foreign_keys` (and DO SQLite restricts
  // PRAGMA entirely), so they were never enforced; the engine is the only
  // writer and enforces the relationships in code.
  //
  // `protocol_templates` is untouched, and NO stored `content_json` is
  // rewritten: the content hash covers that string verbatim, so adding an
  // explicit `"kind":"checklist"` would invalidate every signature ever made.
  // Legacy content parses as checklist by normalisation at read time instead.
  //
  // Column names and order are preserved for every pre-existing column so that
  // Callout's `0003-protocols-to-engine` extraction handoff — which INSERTs
  // into these tables by explicit column list and runs after this migration —
  // keeps working untouched.
  {
    version: '0002-signature-requests',
    sql: `
      CREATE TABLE protocol_instances_v2 (
        id               TEXT PRIMARY KEY,
        template_key     TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        entity_type      TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        status           TEXT NOT NULL
                         CHECK (status IN ('open','pending_signature','signed','voided')),
        created_by       TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        voided_by        TEXT,
        voided_reason    TEXT,
        voided_at        TEXT,
        content_ref_type TEXT,
        content_ref_id   TEXT,
        bound_hash       TEXT,
        frozen_hash      TEXT,
        frozen_at        TEXT
      );
      INSERT INTO protocol_instances_v2
        (id, template_key, template_version, entity_type, entity_id, status,
         created_by, created_at, voided_by, voided_reason, voided_at,
         content_ref_type, content_ref_id, bound_hash, frozen_hash, frozen_at)
        SELECT i.id, i.template_key, i.template_version, i.entity_type, i.entity_id, i.status,
               i.created_by, i.created_at, i.voided_by, i.voided_reason, i.voided_at,
               NULL, NULL, NULL,
               (SELECT s.content_hash FROM protocol_signatures s
                 WHERE s.instance_id = i.id ORDER BY s.rowid LIMIT 1),
               (SELECT s.signed_at FROM protocol_signatures s
                 WHERE s.instance_id = i.id ORDER BY s.rowid LIMIT 1)
        FROM protocol_instances i;

      CREATE TABLE protocol_responses_v2 (
        id           TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL,
        item_key     TEXT NOT NULL,
        value_json   TEXT NOT NULL,
        note         TEXT,
        responded_by TEXT NOT NULL,
        responded_at TEXT NOT NULL
      );
      INSERT INTO protocol_responses_v2
        (id, instance_id, item_key, value_json, note, responded_by, responded_at)
        SELECT id, instance_id, item_key, value_json, note, responded_by, responded_at
        FROM protocol_responses;

      CREATE TABLE protocol_signatures_v2 (
        id              TEXT PRIMARY KEY,
        instance_id     TEXT NOT NULL,
        signed_by       TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('primary','counter')),
        method          TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        evidence_ref    TEXT,
        signed_at       TEXT NOT NULL,
        request_id      TEXT,
        signatory_kind  TEXT NOT NULL DEFAULT 'principal'
                        CHECK (signatory_kind IN ('principal','external')),
        signatory_label TEXT
      );
      INSERT INTO protocol_signatures_v2
        (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at,
         request_id, signatory_kind, signatory_label)
        SELECT id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at,
               NULL, 'principal', NULL
        FROM protocol_signatures;

      DROP TABLE protocol_signatures;
      DROP TABLE protocol_responses;
      DROP TABLE protocol_instances;
      ALTER TABLE protocol_instances_v2 RENAME TO protocol_instances;
      ALTER TABLE protocol_responses_v2 RENAME TO protocol_responses;
      ALTER TABLE protocol_signatures_v2 RENAME TO protocol_signatures;

      CREATE TABLE protocol_signature_requests (
        id            TEXT PRIMARY KEY,
        instance_id   TEXT NOT NULL,
        party_label   TEXT NOT NULL,
        party_kind    TEXT NOT NULL CHECK (party_kind IN ('principal','external')),
        party_ref     TEXT,
        signature_kind TEXT NOT NULL CHECK (signature_kind IN ('primary','counter')),
        method        TEXT NOT NULL,
        status        TEXT NOT NULL
                      CHECK (status IN ('pending','signed','declined','expired','cancelled')),
        content_hash  TEXT NOT NULL,
        external_ref  TEXT,
        resolved_note TEXT,
        requested_by  TEXT NOT NULL,
        requested_at  TEXT NOT NULL,
        resolved_at   TEXT
      );
      CREATE INDEX protocol_signature_requests_by_instance
        ON protocol_signature_requests (instance_id, status);
      CREATE INDEX protocol_instances_by_entity
        ON protocol_instances (entity_type, entity_id, template_key, status);
    `,
  },
  {
    // #620: how hard the provider must prove WHO signed. Nullable, so every row
    // written before this migration reads as "unspecified" and resolves to the
    // `basic` default — the behaviour they already had, since the only connector
    // shipped picked a method per party with no input from the request.
    version: '0003-party-auth-level',
    sql: `
      ALTER TABLE protocol_signature_requests
        ADD COLUMN auth_level TEXT
        CHECK (auth_level IS NULL OR auth_level IN ('basic','strong'));
    `,
  },
];

// ---------------------------------------------------------------------------
// Template content SHAPE — engine-owned so fills can be validated against the
// pinned template. The content VALUES (sections, items, vocabulary,
// branschprotokoll packs) are written by verticals.
//
// Two kinds, discriminated on `kind`. Content stored before the discriminant
// existed carries no `kind` and is normalised to 'checklist' at PARSE time
// only — never rewritten in the database, because the hash covers the stored
// string byte-for-byte.
// ---------------------------------------------------------------------------

export const protocolItem = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['check', 'value', 'text']),
  unit: z.string().optional(), // 'MΩ' on measurements
});
export type ProtocolItem = z.infer<typeof protocolItem>;

/** The original shape: sections of items, filled response-by-response. */
export const checklistContent = z.object({
  kind: z.literal('checklist'),
  sections: z
    .array(z.object({ title: z.string().min(1), items: z.array(protocolItem).min(1) }))
    .min(1),
});
export type ChecklistContent = z.infer<typeof checklistContent>;

/**
 * Content the engine never sees. The template says what KIND of document this
 * is and how to render it; the instance carries the vertical's `EntityRef` and
 * the hash the vertical computed over its own rows.
 *
 * `hashRecipe` is free text, and it is the load-bearing honesty of this kind:
 * a document signature attests to a hash the engine did not compute, so the
 * recipe for reproducing it must be written down where an auditor reading the
 * template finds it. The engine cannot enforce that the text is true — but a
 * signature over an unreproducible hash is worth nothing, and a required field
 * is what makes the vertical say out loud how to reproduce it.
 */
export const documentContent = z.object({
  kind: z.literal('document'),
  /** Vertical vocabulary for what this is — 'avtal', 'styrelserapport'. */
  documentType: z.string().min(1),
  /** How to recompute `boundHash` from the vertical's own rows. */
  hashRecipe: z.string().min(1),
  description: z.string().optional(),
});
export type DocumentContent = z.infer<typeof documentContent>;

const contentUnion = z.discriminatedUnion('kind', [checklistContent, documentContent]);

/**
 * Parses either kind, defaulting a missing discriminant to 'checklist' so
 * every template defined before milestone D still parses. Note this is a
 * READ-time normalisation: `defineTemplate` stores what it is given after
 * parsing, so new templates carry an explicit `kind`, and old rows keep their
 * bytes (and therefore their hashes) exactly as signed.
 */
export const protocolTemplateContent = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && !('kind' in value)
      ? { ...(value as Record<string, unknown>), kind: 'checklist' }
      : value,
  contentUnion,
);
export type ProtocolTemplateContent = z.infer<typeof contentUnion>;

/** Booleans for checks; strings for measurements/text (decimals stay strings, K-14). */
const responseValue = z.union([z.boolean(), z.string()]);

/**
 * Who signed. Two kinds, and the difference is the whole point of milestone D:
 *
 * - `principal` — an authenticated principal in this scope. `ref` is their
 *   `PrincipalId`. Every in-app signature.
 * - `external` — a human with no account, identified by an external provider
 *   (BankID via Scrive). `ref` is an OPAQUE `DataSubjectId` the vertical minted
 *   for that person.
 *
 * A personnummer, an email or a name must NEVER land in `ref`. It is `direct`
 * PII, and `subjectId` on the emitted event is what crypto-shredding keys the
 * erasure on (§5.3) — a `DataSubjectId` is shreddable, a personnummer written
 * into a signature row is a GDPR liability that immutability makes permanent.
 * The provider's own party identifier belongs in `evidenceRef`, which is where
 * the sealed PDF and the provider audit log are reachable from.
 *
 * This follows `engines/booking`'s `partyRef`: a participant is a person with
 * no principal, and it names them with a `DataSubjectId` for exactly this
 * reason.
 */
export const signatory = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('principal'),
    ref: principalId,
    label: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('external'),
    ref: dataSubjectId,
    label: z.string().min(1).optional(),
  }),
]);
export type Signatory = z.infer<typeof signatory>;

export interface ProtocolTemplateRow {
  id: string;
  key: string;
  version: number;
  title: string;
  content_json: string;
  created_at: string;
}

/**
 * A protocol instance row — DERIVED from the entity registry (`entities.ts`)
 * rather than written beside it. The registry is what a vertical imports to get
 * the Zod schema for a declared operation's `output`, and two descriptions of
 * one row is how they come to disagree.
 */
export type ProtocolInstanceRow = EntityRow<typeof protocolEntities, 'protocol'>;

export interface ProtocolResponseRow {
  id: string;
  instance_id: string;
  item_key: string;
  value_json: string;
  note: string | null;
  responded_by: string;
  responded_at: string;
}

export interface ProtocolSignatureRow {
  id: string;
  instance_id: string;
  /** The signatory reference: a `PrincipalId`, or an opaque `DataSubjectId`. */
  signed_by: string;
  kind: 'primary' | 'counter';
  method: string;
  content_hash: string;
  evidence_ref: string | null;
  signed_at: string;
  request_id: string | null;
  signatory_kind: 'principal' | 'external';
  signatory_label: string | null;
}

export interface ProtocolSignatureRequestRow {
  id: string;
  instance_id: string;
  party_label: string;
  party_kind: 'principal' | 'external';
  party_ref: string | null;
  signature_kind: 'primary' | 'counter';
  method: string;
  /** #620: null on every row written before `0003-party-auth-level` — reads as `basic`. */
  auth_level: 'basic' | 'strong' | null;
  status: 'pending' | 'signed' | 'declined' | 'expired' | 'cancelled';
  content_hash: string;
  external_ref: string | null;
  resolved_note: string | null;
  requested_by: string;
  requested_at: string;
  resolved_at: string | null;
}

const protocolRef = (id: string): EntityRef => ({ entityType: 'protocol', entityId: id });

function getInstanceRow(ctx: OperationContext, instanceId: string): ProtocolInstanceRow {
  const row = ctx.sql.query<ProtocolInstanceRow>(
    'SELECT * FROM protocol_instances WHERE id = ?',
    [instanceId],
  )[0];
  if (!row) throw new Error(`protocol instance not found: ${instanceId}`);
  return row;
}

function getTemplateRow(ctx: OperationContext, key: string, version: number): ProtocolTemplateRow {
  const row = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM protocol_templates WHERE key = ? AND version = ?',
    [key, version],
  )[0];
  if (!row) throw new Error(`protocol template not found: ${key}@${version}`);
  return row;
}

const templateContentOf = (template: ProtocolTemplateRow): ProtocolTemplateContent =>
  protocolTemplateContent.parse(JSON.parse(template.content_json));

/** Append order is authoritative for "latest wins" — rowid, not ULID (same-ms safe). */
function getResponseRows(ctx: OperationContext, instanceId: string): ProtocolResponseRow[] {
  return ctx.sql.query<ProtocolResponseRow>(
    'SELECT * FROM protocol_responses WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function getSignatureRows(ctx: OperationContext, instanceId: string): ProtocolSignatureRow[] {
  return ctx.sql.query<ProtocolSignatureRow>(
    'SELECT * FROM protocol_signatures WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function getRequestRows(
  ctx: OperationContext,
  instanceId: string,
): ProtocolSignatureRequestRow[] {
  return ctx.sql.query<ProtocolSignatureRequestRow>(
    'SELECT * FROM protocol_signature_requests WHERE instance_id = ? ORDER BY rowid',
    [instanceId],
  );
}

function latestPerItem(responses: ProtocolResponseRow[]): Record<string, ProtocolResponseRow> {
  const latest: Record<string, ProtocolResponseRow> = {};
  for (const r of responses) latest[r.item_key] = r; // rowid order → last append wins
  return latest;
}

const frozenAnswers = (latest: Record<string, ProtocolResponseRow>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(latest).map(([k, r]) => [k, JSON.parse(r.value_json) as unknown]),
  );

const signatoryOf = (row: ProtocolSignatureRow): Signatory =>
  ({
    kind: row.signatory_kind,
    ref: row.signed_by,
    ...(row.signatory_label ? { label: row.signatory_label } : {}),
  }) as Signatory;

// ---------------------------------------------------------------------------
// content_hash — SHA-256 via Web Crypto (globalThis.crypto: same API in Node,
// Workers, and browsers; node-only imports never). The recipe is the contract;
// there is one per content kind, and the CHECKLIST recipe is byte-identical to
// the one that shipped at milestone B, so every signature made before this
// change still verifies.
//
//   checklist: '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per
//              item, items sorted by key, latest response per item
//   document:  '<key>@<version>\n<content_json>\ndocument:<boundHash>\n'
//
// The kinds cannot collide: a response line is 'key=…' and the document line
// is 'document:…', and a document instance has no responses.
//
// Anyone can replay either against the stored rows and compare. A
// counter-signature re-runs the recipe and must land on the instance's frozen
// hash — that is the "same frozen content" invariant made checkable.
//
// For a document, note what this does and does not prove: it proves the
// signature was made over exactly `boundHash`, and that `boundHash` has not
// changed since. It does NOT prove the vertical's rows still hash to it — the
// engine never saw them. Reproducing `boundHash` from the vertical's own data
// is the vertical's obligation, and `documentContent.hashRecipe` is where the
// method must be written down.
// ---------------------------------------------------------------------------

// Web Crypto + TextEncoder are runtime globals everywhere we run (Node ≥ 18,
// Workers, browsers); declared locally so the engine needs no platform types.
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function protocolContentHash(
  template: Pick<ProtocolTemplateRow, 'key' | 'version' | 'content_json'>,
  latest: Record<string, ProtocolResponseRow>,
  boundHash?: string | null,
): Promise<string> {
  const head = `${template.key}@${template.version}\n${template.content_json}\n`;
  if (boundHash) return sha256Hex(`${head}document:${boundHash}\n`);
  const lines = Object.keys(latest)
    .sort()
    .map((k) => `${k}=${latest[k]!.value_json}\n`)
    .join('');
  return sha256Hex(`${head}${lines}`);
}

/** The hash an instance's content currently produces, whatever kind it is. */
async function currentHash(
  ctx: OperationContext,
  instance: ProtocolInstanceRow,
): Promise<string> {
  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const content = templateContentOf(template);
  if (content.kind === 'document') {
    if (!instance.bound_hash) {
      throw new Error(
        `document protocol ${instance.id} has no bound content — bind it before freezing`,
      );
    }
    return protocolContentHash(template, {}, instance.bound_hash);
  }
  return protocolContentHash(template, latestPerItem(getResponseRows(ctx, instance.id)));
}

/**
 * Re-derive the frozen hash and refuse if it moved. Fail closed: a signature
 * binds to VERIFIED frozen content, never to a trusted column.
 */
async function verifyFrozen(
  ctx: OperationContext,
  instance: ProtocolInstanceRow,
): Promise<string> {
  if (!instance.frozen_hash) {
    throw new Error(`protocol ${instance.id} is not frozen: nothing to sign against`);
  }
  const replayed = await currentHash(ctx, instance);
  if (replayed !== instance.frozen_hash) {
    throw new Error(
      `content hash mismatch: frozen ${instance.frozen_hash}, replayed ${replayed}`,
    );
  }
  return instance.frozen_hash;
}

// ---------------------------------------------------------------------------
// THE GUARDS (engine-protocol.md §6, kernel-design open question 11). One
// predicate body, TWO ways to reach it — that is the whole open question:
//
//  pole 1 — VERTICAL-COMPOSED (milestone A): the vertical calls requireSigned()
//    inside its own operation before the engine transition. Right when the
//    policy is CONDITIONAL on vertical data ("only montage orders need an
//    self-inspection" — demos/callout): the condition is vertical vocabulary, and the
//    kernel must never learn it. Weakness: it is glue an edit can silently drop.
//
//  pole 2 — MANIFEST-DECLARED (milestone C): the engine contributes the named
//    predicate `protocol/all-signed` below; a VERTICAL manifest wires it to an
//    operation (`guards: [{ before, predicate, config }]`) and the kernel runs
//    it inside that operation's transaction, before the handler. Right when the
//    gate is UNCONDITIONAL ("a repair cannot be closed until the customer
//    counter-signed the tillståndsrapport" — demos/handlebar). Adding or
//    DROPPING the gate is then a manifest diff: human-checkpoint material.
//
// Both poles are the same read against the same engine-owned tables. Star
// topology holds either way: the workorder engine knows nothing of protocols.
// ---------------------------------------------------------------------------

export function requireSigned(ctx: OperationContext, entity: EntityRef, templateKey: string): void {
  const signed = ctx.sql.query<{ id: string }>(
    `SELECT id FROM protocol_instances
     WHERE entity_type = ? AND entity_id = ? AND template_key = ? AND status = 'signed'
     LIMIT 1`,
    [entity.entityType, entity.entityId, templateKey],
  )[0];
  if (!signed) {
    throw new Error(
      `protocol required: '${templateKey}' must be signed before this transition ` +
        `(${entity.entityType} ${entity.entityId})`,
    );
  }
}

/**
 * The stronger form: signed AND counter-signed — the frozen content was
 * ACCEPTED by a second signatory (the customer at pickup). Invariant 3 already
 * guarantees a counter-signature can only exist on verified frozen content, so
 * the existence of the row is the whole check.
 */
export function requireCountersigned(
  ctx: OperationContext,
  entity: EntityRef,
  templateKey: string,
): void {
  requireSigned(ctx, entity, templateKey);
  const counter = ctx.sql.query<{ id: string }>(
    `SELECT s.id FROM protocol_signatures s
     JOIN protocol_instances i ON i.id = s.instance_id
     WHERE i.entity_type = ? AND i.entity_id = ? AND i.template_key = ?
       AND i.status = 'signed' AND s.kind = 'counter'
     LIMIT 1`,
    [entity.entityType, entity.entityId, templateKey],
  )[0];
  if (!counter) {
    throw new Error(
      `protocol required: '${templateKey}' must be counter-signed before this transition ` +
        `(${entity.entityType} ${entity.entityId})`,
    );
  }
}

/**
 * NOTE on multi-party: there is deliberately no `requireAllSigned`. In the
 * request-driven path an instance reaches `signed` only once EVERY requested
 * party has signed (see `recordSignature`), so "all parties signed" IS
 * `requireSigned` — a separate guard would read as though it checked something
 * stronger while checking the same thing. The multi-party question is answered
 * by the state machine, not by a second predicate.
 */

/**
 * Config for the `protocol/all-signed` predicate — parsed by the PREDICATE, not
 * by the kernel (the kernel keeps `config` opaque). `entityIdFrom` names the
 * field of the guarded operation's input that carries the entity id, which is
 * how one predicate serves any operation shape without the engine knowing the
 * vertical's vocabulary.
 */
export const allSignedGuardConfig = z.object({
  templateKey: z.string().min(1), // vertical content: 'tillstandsrapport'
  entityType: z.string().min(1), // what the protocol hangs on: 'workorder'
  entityIdFrom: z.string().min(1), // input field holding the id: 'orderId'
  countersigned: z.boolean().default(false), // require a second signatory's acceptance too
});
export type AllSignedGuardConfig = z.input<typeof allSignedGuardConfig>;

/** The named predicate the kernel resolves for `predicate: 'protocol/all-signed'`. */
export const allSignedPredicate: GuardPredicate = (ctx, rawConfig, input) => {
  const config = allSignedGuardConfig.parse(rawConfig);
  const entityId = z
    .string()
    .min(1, `guard 'protocol/all-signed': input field '${config.entityIdFrom}' carries no entity id`)
    .parse((input as Record<string, unknown> | undefined)?.[config.entityIdFrom]);
  const entity: EntityRef = { entityType: config.entityType, entityId };
  if (config.countersigned) requireCountersigned(ctx, entity, config.templateKey);
  else requireSigned(ctx, entity, config.templateKey);
};

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The registered operations below are their default bindings.
// The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export const defineTemplateInput = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  content: protocolTemplateContent,
});

/**
 * What a template author writes. Spelled out rather than inferred because the
 * `kind` normalisation is a `z.preprocess`, whose inferred INPUT type is
 * `unknown` — which would silently drop type-checking on exactly the object a
 * vertical hand-writes most often. `kind` is optional only for checklists, so
 * every template that predates the discriminant still compiles unchanged.
 */
export type ProtocolTemplateContentInput =
  | (Omit<ChecklistContent, 'kind'> & { kind?: 'checklist' })
  | DocumentContent;

export interface DefineTemplateInput {
  key: string;
  title: string;
  content: ProtocolTemplateContentInput;
}

/**
 * Templates version immutably: same key + new content = next version, the
 * old row is never touched. Editing a template never rewrites what a signed
 * document referred to.
 */
export function defineTemplate(
  ctx: OperationContext,
  rawInput: DefineTemplateInput,
): ProtocolTemplateRow {
  const input = defineTemplateInput.parse(rawInput);
  const version =
    (ctx.sql.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM protocol_templates WHERE key = ?',
      [input.key],
    )[0]?.v as number) ?? 1;
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_templates (id, key, version, title, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.key, version, input.title, JSON.stringify(input.content), new Date().toISOString()],
  );
  return ctx.sql.query<ProtocolTemplateRow>('SELECT * FROM protocol_templates WHERE id = ?', [
    id,
  ])[0]!;
}

/** Latest version per key — the instantiation picker's list. */
export function listTemplates(ctx: OperationContext): ProtocolTemplateRow[] {
  return ctx.sql.query<ProtocolTemplateRow>(
    `SELECT t.* FROM protocol_templates t
     WHERE t.version = (SELECT MAX(version) FROM protocol_templates WHERE key = t.key)
     ORDER BY t.key`,
  );
}

export const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entity: entityRef,
});
export type InstantiateProtocolInput = z.infer<typeof instantiateProtocolInput>;

/**
 * Pins the latest template version at instantiation — forever (invariant 5).
 * One OPEN instance per (template, entity). Which entity types may carry
 * which protocols, and when, is vertical policy — enforced by the caller.
 */
export function instantiateProtocol(
  ctx: OperationContext,
  rawInput: InstantiateProtocolInput,
): ProtocolInstanceRow {
  const input = instantiateProtocolInput.parse(rawInput);
  const template = ctx.sql.query<ProtocolTemplateRow>(
    'SELECT * FROM protocol_templates WHERE key = ? ORDER BY version DESC LIMIT 1',
    [input.templateKey],
  )[0];
  if (!template) throw new Error(`protocol template not found: ${input.templateKey}`);

  // An instance being signed is still "in play": a second one would race the
  // first for the same (template, entity) slot.
  const dup = ctx.sql.query<{ id: string }>(
    `SELECT id FROM protocol_instances
     WHERE entity_type = ? AND entity_id = ? AND template_key = ?
       AND status IN ('open','pending_signature') LIMIT 1`,
    [input.entity.entityType, input.entity.entityId, input.templateKey],
  )[0];
  if (dup) {
    throw new Error(
      `protocol '${input.templateKey}' already open on this ${input.entity.entityType}`,
    );
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_instances
       (id, template_key, template_version, entity_type, entity_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      template.key,
      template.version,
      input.entity.entityType,
      input.entity.entityId,
      ctx.principal,
      new Date().toISOString(),
    ],
  );
  // The permission walk (portal counter-sign, per-entity reads) flows along
  // this edge; the vertical declares `protocol → <parent>` in its manifest.
  ctx.link(protocolRef(id), input.entity);
  ctx.emit({
    type: 'protocol.instantiated',
    schemaVersion: 1,
    entity: protocolRef(id),
    piiClass: 'none',
    payload: {
      instanceId: id,
      templateKey: template.key,
      templateVersion: template.version,
      title: template.title,
      contentKind: templateContentOf(template).kind,
      entity: input.entity,
    },
  });
  return getInstanceRow(ctx, id);
}

/** The one place that decides whether content may still change. */
function assertUnfrozen(instance: ProtocolInstanceRow, what: string): void {
  if (instance.status === 'open') return;
  if (instance.status === 'pending_signature') {
    throw new Error(
      `protocol is out for signature: content is frozen until the requests resolve ` +
        `or are cancelled (instance ${instance.id})`,
    );
  }
  throw new Error(
    `protocol is ${instance.status}: content is frozen, ${what} can no longer change ` +
      `(append-only history kept)`,
  );
}

export const fillProtocolInput = z.object({
  instanceId: z.string().min(1),
  itemKey: z.string().min(1),
  value: responseValue,
  note: z.string().optional(),
});
export type FillProtocolInput = z.infer<typeof fillProtocolInput>;

export function fillProtocol(
  ctx: OperationContext,
  rawInput: FillProtocolInput,
): ProtocolResponseRow {
  const input = fillProtocolInput.parse(rawInput);
  const instance = getInstanceRow(ctx, input.instanceId);

  // Invariant 1+4: responses bind to an UNFROZEN instance only, and always append.
  assertUnfrozen(instance, 'responses');

  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const content = templateContentOf(template);
  if (content.kind !== 'checklist') {
    throw new Error(
      `template ${instance.template_key}@${instance.template_version} is a '${content.kind}' ` +
        `protocol: it carries no items — bind its content instead of filling it`,
    );
  }
  const item = content.sections.flatMap((s) => s.items).find((i) => i.key === input.itemKey);
  if (!item) {
    throw new Error(
      `unknown item '${input.itemKey}' in template ${instance.template_key}@${instance.template_version}`,
    );
  }
  if (item.type === 'check' && typeof input.value !== 'boolean') {
    throw new Error(`item '${item.key}' is a check: value must be boolean`);
  }
  if (item.type !== 'check' && typeof input.value !== 'string') {
    throw new Error(`item '${item.key}' is a ${item.type}: value must be a string`);
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_responses
       (id, instance_id, item_key, value_json, note, responded_by, responded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      instance.id,
      input.itemKey,
      JSON.stringify(input.value),
      input.note ?? null,
      ctx.principal,
      new Date().toISOString(),
    ],
  );
  ctx.emit({
    type: 'protocol.response-recorded',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      responseId: id,
      itemKey: input.itemKey,
      value: input.value,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
    },
  });
  return ctx.sql.query<ProtocolResponseRow>('SELECT * FROM protocol_responses WHERE id = ?', [
    id,
  ])[0]!;
}

export const bindDocumentInput = z.object({
  instanceId: z.string().min(1),
  /** The vertical entity that holds the real content — an avtal, a report. */
  contentRef: entityRef,
  /** The hash the VERTICAL computed over its own rows, per `hashRecipe`. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'contentHash must be lowercase hex SHA-256'),
});
export type BindDocumentInput = z.infer<typeof bindDocumentInput>;

/**
 * Bind (or re-bind) a document protocol's content while it is still open —
 * the document-kind counterpart of `fillProtocol`. Re-binding is the whole
 * point during negotiation: an avtal's price changes until it is sent out, and
 * each rebind moves the hash the signature will be taken over.
 *
 * Once frozen, this fails like any other write to frozen content.
 */
export function bindDocument(
  ctx: OperationContext,
  rawInput: BindDocumentInput,
): ProtocolInstanceRow {
  const input = bindDocumentInput.parse(rawInput);
  const instance = getInstanceRow(ctx, input.instanceId);
  assertUnfrozen(instance, 'the binding');

  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const content = templateContentOf(template);
  if (content.kind !== 'document') {
    throw new Error(
      `template ${instance.template_key}@${instance.template_version} is a '${content.kind}' ` +
        `protocol: fill its items instead of binding content`,
    );
  }

  ctx.sql.exec(
    `UPDATE protocol_instances
     SET content_ref_type = ?, content_ref_id = ?, bound_hash = ? WHERE id = ?`,
    [input.contentRef.entityType, input.contentRef.entityId, input.contentHash, instance.id],
  );
  ctx.emit({
    type: 'protocol.content-bound',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'none',
    payload: {
      instanceId: instance.id,
      templateKey: instance.template_key,
      templateVersion: instance.template_version,
      documentType: content.documentType,
      contentRef: input.contentRef,
      boundHash: input.contentHash,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
    },
  });
  return getInstanceRow(ctx, instance.id);
}

// ---------------------------------------------------------------------------
// Asynchronous signing — freeze first, collect signatures over days.
// ---------------------------------------------------------------------------

export const signatureRequestParty = z.object({
  /** Display name for the role, never PII: 'Beställare', 'Leverantör'. */
  label: z.string().min(1),
  kind: z.enum(['principal', 'external']),
  /**
   * Who is expected to sign, when that is known up front. A `PrincipalId` for
   * `principal`, an opaque `DataSubjectId` for `external`.
   *
   * Optional because it often is NOT known: a BankID flow addressed to a
   * company mailbox is signed by whichever firmatecknare opens it, and their
   * identity only becomes known when the provider reports it. Left unset, the
   * signatory is whoever `recordSignature` reports; set, it is a constraint
   * the recorded signatory must match.
   */
  ref: z.string().min(1).optional(),
  /**
   * 'primary' for the issuing party, 'counter' for accepting parties.
   *
   * Optional, and resolved so that a request set ALWAYS has exactly one
   * primary: declare one explicitly, or the first party becomes it. A set with
   * no primary would leave a signed instance whose issuing signature is null —
   * `requireCountersigned` would then pass on a document nobody issued.
   */
  signatureKind: z.enum(['primary', 'counter']).optional(),
  /**
   * How hard the provider must work to prove WHO signed (#620).
   *
   * - `basic` — the provider establishes control of a contact address (a signing
   *   link to an email or mobile). The default, and what a request that says
   *   nothing gets.
   * - `strong` — a national eID: BankID, and its equivalents. The signatory
   *   proves a legal identity, not the possession of a mailbox.
   *
   * Deliberately NOT the provider's own vocabulary. `se_bankid` is Scrive's word
   * for this and belongs in the connector that speaks to Scrive; an engine that
   * learned it would have to learn the next provider's too, and a vertical would
   * be choosing a Scrive enum through a provider-agnostic engine. The connector
   * maps this pair onto whatever its provider calls them (star topology).
   *
   * **`strong` is currently unsatisfiable and will be refused at dispatch.** A
   * national eID flow needs the signatory's personal number, and there is no
   * lawful carrier for one: it would have to travel on this event, which lands
   * in `_substrat_outbox` and `_substrat_platform_requests` — kernel spine rows a
   * vertical may neither write nor erase (rule 3), and B6 says a personnummer
   * never reaches the kernel, the events or the audit trail. The connector fails
   * fast and says so, rather than sending a request the provider answers with a
   * bare `409`. See the tracking issue for the sealed-carrier design.
   */
  authLevel: z.enum(['basic', 'strong']).optional(),
});
export type SignatureRequestParty = z.input<typeof signatureRequestParty>;

export const requestSignaturesInput = z.object({
  instanceId: z.string().min(1),
  /** 'scrive', 'bankid' — the provider a connector will dispatch to. */
  method: z.string().min(1),
  parties: z.array(signatureRequestParty).min(1),
});
export type RequestSignaturesInput = z.input<typeof requestSignaturesInput>;

export interface RequestSignaturesResult {
  instance: ProtocolInstanceRow;
  contentHash: string;
  requests: ProtocolSignatureRequestRow[];
}

/**
 * Freeze the content and ask named parties to sign it — the asynchronous
 * counterpart of `signProtocol`.
 *
 * This is the transition that closes the drift window: the instance leaves
 * `open` immediately, so nothing can fill or rebind it while it sits at the
 * provider. The hash is computed ONCE, here, and every signature that comes
 * back must match it.
 *
 * The engine dispatches nothing. It emits `protocol.signatures-requested` with
 * everything a connector needs (the hash, the parties, the method) and an
 * executor outside the scope makes the call — module code never touches the
 * network (boundary-lint R3).
 */
export async function requestSignatures(
  ctx: OperationContext,
  rawInput: RequestSignaturesInput,
): Promise<RequestSignaturesResult> {
  const input = requestSignaturesInput.parse(rawInput);
  const instance = getInstanceRow(ctx, input.instanceId);
  if (instance.status !== 'open') {
    throw new Error(
      `protocol is ${instance.status}: only an open protocol can be sent for signature`,
    );
  }
  const primaries = input.parties.filter((p) => p.signatureKind === 'primary');
  if (primaries.length > 1) {
    throw new Error('at most one party may sign as primary — the rest counter-sign');
  }
  // Exactly one primary, always: the declared one, else the first party.
  const primaryIndex = primaries.length === 1
    ? input.parties.findIndex((p) => p.signatureKind === 'primary')
    : 0;
  // Validate the refs that were supplied, so a personnummer cannot be smuggled
  // into a request row and land in a signature by way of the matching check.
  for (const party of input.parties) {
    if (party.ref === undefined) continue;
    signatory.parse({ kind: party.kind, ref: party.ref, label: party.label });
  }

  const contentHash = await currentHash(ctx, instance);
  const now = new Date().toISOString();
  ctx.sql.exec(
    `UPDATE protocol_instances
     SET status = 'pending_signature', frozen_hash = ?, frozen_at = ? WHERE id = ?`,
    [contentHash, now, instance.id],
  );

  const created: string[] = [];
  for (const [index, party] of input.parties.entries()) {
    const id = ulid();
    created.push(id);
    ctx.sql.exec(
      `INSERT INTO protocol_signature_requests
         (id, instance_id, party_label, party_kind, party_ref, signature_kind, method,
          auth_level, status, content_hash, external_ref, resolved_note, requested_by,
          requested_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL)`,
      [
        id,
        instance.id,
        party.label,
        party.kind,
        party.ref ?? null,
        index === primaryIndex ? 'primary' : 'counter',
        input.method,
        party.authLevel ?? null,
        contentHash,
        ctx.principal,
        now,
      ],
    );
  }

  const requests = getRequestRows(ctx, instance.id).filter((r) => created.includes(r.id));
  ctx.emit({
    type: 'protocol.signatures-requested',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'none', // party refs are opaque ids; labels are role names, never PII
    payload: {
      instanceId: instance.id,
      templateKey: instance.template_key,
      templateVersion: instance.template_version,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      method: input.method,
      contentHash,
      // Fat: a connector must never need a cross-module read to dispatch.
      contentRef:
        instance.content_ref_type && instance.content_ref_id
          ? { entityType: instance.content_ref_type, entityId: instance.content_ref_id }
          : null,
      boundHash: instance.bound_hash,
      parties: requests.map((r) => ({
        requestId: r.id,
        label: r.party_label,
        kind: r.party_kind,
        ref: r.party_ref,
        signatureKind: r.signature_kind,
        // #620: resolved here, not at the connector, so the event states the level
        // that was actually requested rather than leaving every reader to re-derive
        // the default. Additive and behaviour-preserving: a party that said nothing
        // reads `basic`, which is what the connector did for principals already.
        authLevel: r.auth_level ?? 'basic',
      })),
    },
  });

  return { instance: getInstanceRow(ctx, instance.id), contentHash, requests };
}

export const recordSignatureInput = z.object({
  requestId: z.string().min(1),
  signatory,
  /** When the party actually signed, per the provider — NOT when we heard. */
  signedAt: instant,
  /**
   * The hash the provider signed over, as the provider reports it. Checked
   * against the frozen hash: a mismatch means the document that was signed is
   * not the document we froze, and that must fail closed rather than record a
   * signature over unknown content.
   */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Sealed PDF, provider transaction id, audit log — where the proof lives. */
  evidenceRef: z.string().min(1).optional(),
});
export type RecordSignatureInput = z.input<typeof recordSignatureInput>;

export interface SignResult {
  instance: ProtocolInstanceRow;
  signature: ProtocolSignatureRow;
}

/**
 * Record a signature that happened OUTSIDE this system — the webhook's half.
 *
 * Everything `signProtocol` takes from ambient context, this takes as data:
 * the signatory is supplied (and may be an external person with no account),
 * the timestamp is the provider's, the method is the request's, and the
 * evidence reference points at the provider's sealed artifact.
 *
 * The last pending request resolving is what transitions the instance to
 * `signed` — which is the multi-party rule stated in code: an avtal is signed
 * when every requested party has signed it, not when the first one has.
 *
 * NOTE ON THE CALLER: there is no webhook ingress in the kernel yet, and no
 * inbound authority seam that would let a provider callback invoke a scope
 * operation (`ScopeHost.getScope` demands a `PrincipalId`; `ExecutorHandler`
 * has no return path into a scope). Until those land this is reachable only by
 * a principal holding `protocol:record-signature` — a key deliberately held by
 * no human role in any demo.
 */
export async function recordSignature(
  ctx: OperationContext,
  rawInput: RecordSignatureInput,
): Promise<SignResult> {
  const input = recordSignatureInput.parse(rawInput);
  const request = ctx.sql.query<ProtocolSignatureRequestRow>(
    'SELECT * FROM protocol_signature_requests WHERE id = ?',
    [input.requestId],
  )[0];
  if (!request) throw new Error(`signature request not found: ${input.requestId}`);
  if (request.status !== 'pending') {
    throw new Error(`signature request is already ${request.status}: ${request.id}`);
  }

  const instance = getInstanceRow(ctx, request.instance_id);
  if (instance.status !== 'pending_signature') {
    throw new Error(
      `protocol is ${instance.status}: signatures are only recorded while out for signature`,
    );
  }

  // Re-derive rather than trust the column, then check the provider agrees.
  const frozen = await verifyFrozen(ctx, instance);
  if (input.contentHash !== frozen) {
    throw new Error(
      `signed content does not match the frozen protocol: provider reported ` +
        `${input.contentHash}, frozen ${frozen}`,
    );
  }
  if (request.party_kind !== input.signatory.kind) {
    throw new Error(
      `signature request ${request.id} expects a ${request.party_kind} signatory, ` +
        `got ${input.signatory.kind}`,
    );
  }
  if (request.party_ref && request.party_ref !== input.signatory.ref) {
    throw new Error(
      `signature request ${request.id} was addressed to a different party than the one who signed`,
    );
  }
  if (
    getSignatureRows(ctx, instance.id).some((s) => s.signed_by === input.signatory.ref)
  ) {
    throw new Error('this signatory has already signed this protocol');
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_signatures
       (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at,
        request_id, signatory_kind, signatory_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      instance.id,
      input.signatory.ref,
      request.signature_kind,
      request.method,
      frozen,
      input.evidenceRef ?? null,
      input.signedAt,
      request.id,
      input.signatory.kind,
      input.signatory.label ?? request.party_label,
    ],
  );
  ctx.sql.exec(
    `UPDATE protocol_signature_requests
     SET status = 'signed', resolved_at = ?, external_ref = COALESCE(?, external_ref)
     WHERE id = ?`,
    [input.signedAt, input.evidenceRef ?? null, request.id],
  );

  // The instance is signed only when EVERY requested party signed — not merely
  // when nothing is left pending. A declined or expired request is not pending
  // either, and treating that as completion would mark an avtal fully executed
  // that one party refused. An unresolved refusal holds the instance frozen
  // until someone explicitly withdraws the request set.
  const unsigned = ctx.sql.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM protocol_signature_requests
     WHERE instance_id = ? AND status <> 'signed'`,
    [instance.id],
  )[0]!.n;
  const complete = unsigned === 0;
  if (complete) {
    ctx.sql.exec(`UPDATE protocol_instances SET status = 'signed' WHERE id = ?`, [instance.id]);
  }

  const signature = getSignatureRows(ctx, instance.id).find((s) => s.id === id)!;
  emitSignatureEvent(ctx, {
    instance: getInstanceRow(ctx, instance.id),
    signature,
    contentHash: frozen,
    complete,
  });
  return { instance: getInstanceRow(ctx, instance.id), signature };
}

export const declineSignatureInput = z.object({
  requestId: z.string().min(1),
  reason: z.string().min(1),
  /** 'declined' when a party refused; 'expired' when the provider timed out. */
  outcome: z.enum(['declined', 'expired']).default('declined'),
});
export type DeclineSignatureInput = z.input<typeof declineSignatureInput>;

/**
 * A party refused, or the provider's window expired. The instance stays
 * `pending_signature` and therefore frozen — a refusal is not permission to
 * edit. Renegotiating means cancelling the request set explicitly, which is a
 * separate, permissioned, audited act.
 */
export function declineSignature(
  ctx: OperationContext,
  rawInput: DeclineSignatureInput,
): ProtocolSignatureRequestRow {
  const input = declineSignatureInput.parse(rawInput);
  const request = ctx.sql.query<ProtocolSignatureRequestRow>(
    'SELECT * FROM protocol_signature_requests WHERE id = ?',
    [input.requestId],
  )[0];
  if (!request) throw new Error(`signature request not found: ${input.requestId}`);
  if (request.status !== 'pending') {
    throw new Error(`signature request is already ${request.status}: ${request.id}`);
  }
  const instance = getInstanceRow(ctx, request.instance_id);
  ctx.sql.exec(
    `UPDATE protocol_signature_requests
     SET status = ?, resolved_at = ?, resolved_note = ? WHERE id = ?`,
    [input.outcome ?? 'declined', new Date().toISOString(), input.reason, request.id],
  );
  ctx.emit({
    type: 'protocol.signature-declined',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'none',
    payload: {
      instanceId: instance.id,
      requestId: request.id,
      templateKey: instance.template_key,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      partyLabel: request.party_label,
      outcome: input.outcome ?? 'declined',
      reason: input.reason,
    },
  });
  return ctx.sql.query<ProtocolSignatureRequestRow>(
    'SELECT * FROM protocol_signature_requests WHERE id = ?',
    [request.id],
  )[0]!;
}

export const cancelSignatureRequestsInput = z.object({
  instanceId: z.string().min(1),
  reason: z.string().min(1),
});
export type CancelSignatureRequestsInput = z.infer<typeof cancelSignatureRequestsInput>;

/**
 * Withdraw an outstanding request set and thaw the instance — the
 * renegotiation path an avtal needs when a party declines or the price moves.
 *
 * Cancelling THAWS: status returns to `open` and the frozen hash is cleared,
 * so the next `requestSignatures` freezes fresh content at a fresh hash.
 * Signatures already collected are NOT removed — they are append-only history
 * attesting to content that really was frozen at the time — but they were
 * taken over the OLD hash, so they can never satisfy the new one. That is the
 * intended reading: a party who signed v1 has not signed v2.
 */
export function cancelSignatureRequests(
  ctx: OperationContext,
  rawInput: CancelSignatureRequestsInput,
): ProtocolInstanceRow {
  const input = cancelSignatureRequestsInput.parse(rawInput);
  const instance = getInstanceRow(ctx, input.instanceId);
  if (instance.status !== 'pending_signature') {
    throw new Error(
      `protocol is ${instance.status}: only a protocol out for signature can be withdrawn`,
    );
  }
  const now = new Date().toISOString();
  const cancelled = ctx.sql.exec(
    `UPDATE protocol_signature_requests
     SET status = 'cancelled', resolved_at = ?, resolved_note = ?
     WHERE instance_id = ? AND status = 'pending'`,
    [now, input.reason, instance.id],
  );
  ctx.sql.exec(
    `UPDATE protocol_instances
     SET status = 'open', frozen_hash = NULL, frozen_at = NULL WHERE id = ?`,
    [instance.id],
  );
  ctx.emit({
    type: 'protocol.signatures-cancelled',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'none',
    payload: {
      instanceId: instance.id,
      templateKey: instance.template_key,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      cancelled: cancelled.changes,
      reason: input.reason,
    },
  });
  return getInstanceRow(ctx, instance.id);
}

// ---------------------------------------------------------------------------
// In-app signing — the everyday field case, unchanged in shape and behaviour.
// ---------------------------------------------------------------------------

/** Both signing paths emit the same pair of events, so they agree by construction. */
function emitSignatureEvent(
  ctx: OperationContext,
  args: {
    instance: ProtocolInstanceRow;
    signature: ProtocolSignatureRow;
    contentHash: string;
    complete: boolean;
    responses?: Record<string, unknown>;
  },
): void {
  const { instance, signature, contentHash, complete } = args;
  const signatories = getSignatureRows(ctx, instance.id).map(signatoryOf);
  const base = {
    instanceId: instance.id,
    templateKey: instance.template_key,
    templateVersion: instance.template_version,
    entity: { entityType: instance.entity_type, entityId: instance.entity_id },
    method: signature.method,
    contentHash,
    // Document kind: what was signed lives in the vertical, so the event
    // carries the pointer and the hash rather than the content.
    contentRef:
      instance.content_ref_type && instance.content_ref_id
        ? { entityType: instance.content_ref_type, entityId: instance.content_ref_id }
        : null,
    boundHash: instance.bound_hash,
    // fat payload: the frozen answers travel with the event (checklist kind)
    responses: args.responses ?? {},
    signatory: signatoryOf(signature),
    // Retained for consumers that read the flat field: the signatory's ref.
    signedBy: signature.signed_by,
    evidenceRef: signature.evidence_ref,
    signedAt: signature.signed_at,
    /** False while other requested parties are still outstanding. */
    complete,
    signatories,
  };

  if (signature.kind === 'primary') {
    ctx.emit({
      type: 'protocol.signed',
      schemaVersion: 1,
      entity: protocolRef(instance.id),
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(signature.signed_by),
      payload: base,
    });
    return;
  }
  const primary = getSignatureRows(ctx, instance.id).find((s) => s.kind === 'primary');
  ctx.emit({
    type: 'protocol.countersigned',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(signature.signed_by),
    payload: {
      ...base,
      signedBy: primary?.signed_by ?? null,
      countersignedBy: signature.signed_by,
      countersignatory: signatoryOf(signature),
    },
  });
}

/**
 * In-app sign (engine-protocol.md §5): the authenticated principal signs, now;
 * integrity comes from the hash + immutability + the spine event. Freezing and
 * signing coincide here, which is sound precisely BECAUSE it is synchronous —
 * there is no window between what the signer saw and what was hashed.
 *
 * For an external provider flow (BankID via Scrive) use `requestSignatures` +
 * `recordSignature` instead: the signatory is not `ctx.principal`, the moment
 * is not now, and freezing must happen at dispatch rather than at signature.
 * Exactly ONE primary signature per instance — enforced by the open → signed
 * transition.
 */
export async function signProtocol(
  ctx: OperationContext,
  input: { instanceId: string },
): Promise<SignResult> {
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status !== 'open') {
    throw new Error(`protocol is ${instance.status}: only an open protocol can be signed`);
  }
  const latest = latestPerItem(getResponseRows(ctx, instance.id));
  const contentHash = await currentHash(ctx, instance);
  const now = new Date().toISOString();
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_signatures
       (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at,
        request_id, signatory_kind, signatory_label)
     VALUES (?, ?, ?, 'primary', 'in-app', ?, NULL, ?, NULL, 'principal', NULL)`,
    [id, instance.id, ctx.principal, contentHash, now],
  );
  ctx.sql.exec(
    `UPDATE protocol_instances SET status = 'signed', frozen_hash = ?, frozen_at = ? WHERE id = ?`,
    [contentHash, now, instance.id],
  );
  const signature = getSignatureRows(ctx, instance.id).find((s) => s.id === id)!;
  emitSignatureEvent(ctx, {
    instance: getInstanceRow(ctx, instance.id),
    signature,
    contentHash,
    complete: true,
    responses: frozenAnswers(latest),
  });
  return { instance: getInstanceRow(ctx, instance.id), signature };
}

/**
 * Counter-sign (invariant 3): a SECOND signature on the SAME frozen content —
 * the customer at pickup. Requires a signed instance; the content hash is
 * recomputed and must equal the frozen hash (frozen content, verified, never
 * assumed). One counter-signature per signatory; a signatory never
 * counter-signs what they primary-signed.
 */
export async function countersignProtocol(
  ctx: OperationContext,
  input: { instanceId: string },
): Promise<SignResult> {
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status !== 'signed') {
    throw new Error(
      `protocol is ${instance.status}: only a signed (frozen) protocol can be counter-signed`,
    );
  }
  const signatures = getSignatureRows(ctx, instance.id);
  const primary = signatures.find((s) => s.kind === 'primary');
  if (!primary) throw new Error(`signed protocol has no primary signature: ${instance.id}`); // corrupt state, fail closed
  if (signatures.some((s) => s.signed_by === ctx.principal)) {
    throw new Error('counter-signature must come from a signatory who has not already signed');
  }

  // Re-run the recipe against stored state: the counter-signature binds to
  // verified frozen content, not to a trusted column.
  const contentHash = await verifyFrozen(ctx, instance);

  const latest = latestPerItem(getResponseRows(ctx, instance.id));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO protocol_signatures
       (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at,
        request_id, signatory_kind, signatory_label)
     VALUES (?, ?, ?, 'counter', 'in-app', ?, NULL, ?, NULL, 'principal', NULL)`,
    [id, instance.id, ctx.principal, contentHash, new Date().toISOString()],
  );
  const signature = getSignatureRows(ctx, instance.id).find((s) => s.id === id)!;
  emitSignatureEvent(ctx, {
    instance,
    signature,
    contentHash,
    complete: true,
    responses: frozenAnswers(latest),
  });
  return { instance: getInstanceRow(ctx, instance.id), signature };
}

/** Voiding, not deleting: a superseded protocol keeps its rows forever. */
export function voidProtocol(
  ctx: OperationContext,
  input: { instanceId: string; reason: string },
): ProtocolInstanceRow {
  const reason = z.string().min(1).parse(input.reason);
  const instance = getInstanceRow(ctx, z.string().min(1).parse(input.instanceId));
  if (instance.status === 'voided') throw new Error('protocol is already voided');
  const now = new Date().toISOString();
  // An outstanding request set dies with the protocol — leaving rows `pending`
  // on a voided instance would keep `requireAllSigned` reading a live gate on
  // a document that is out of play.
  ctx.sql.exec(
    `UPDATE protocol_signature_requests
     SET status = 'cancelled', resolved_at = ?, resolved_note = ?
     WHERE instance_id = ? AND status = 'pending'`,
    [now, `protocol voided: ${reason}`, instance.id],
  );
  ctx.sql.exec(
    `UPDATE protocol_instances
     SET status = 'voided', voided_by = ?, voided_reason = ?, voided_at = ? WHERE id = ?`,
    [ctx.principal, reason, now, instance.id],
  );
  ctx.emit({
    type: 'protocol.voided',
    schemaVersion: 1,
    entity: protocolRef(instance.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: {
      instanceId: instance.id,
      entity: { entityType: instance.entity_type, entityId: instance.entity_id },
      previousStatus: instance.status,
      reason,
    },
  });
  return getInstanceRow(ctx, instance.id);
}

export interface ProtocolDetail {
  instance: ProtocolInstanceRow;
  template: { key: string; version: number; title: string; content: ProtocolTemplateContent };
  responses: ProtocolResponseRow[]; // full append-only history
  latest: Record<string, ProtocolResponseRow>; // per-item, last append wins
  signature: ProtocolSignatureRow | null; // the primary (issuing) signature
  signatures: ProtocolSignatureRow[]; // all rows, primary + counter-signatures
  requests: ProtocolSignatureRequestRow[]; // the signature request set, if any
}

export function getProtocol(ctx: OperationContext, instanceId: string): ProtocolDetail {
  const instance = getInstanceRow(ctx, instanceId);
  const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
  const responses = getResponseRows(ctx, instance.id);
  const signatures = getSignatureRows(ctx, instance.id);
  return {
    instance,
    template: {
      key: template.key,
      version: template.version,
      title: template.title,
      content: templateContentOf(template),
    },
    responses,
    latest: latestPerItem(responses),
    signature: signatures.find((s) => s.kind === 'primary') ?? null,
    signatures,
    requests: getRequestRows(ctx, instance.id),
  };
}

export interface ProtocolSummary {
  instance: ProtocolInstanceRow;
  title: string;
  contentKind: ProtocolTemplateContent['kind'];
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
  countersignedBy: string | null;
  countersignedAt: string | null;
  /** How many requested signatures are still outstanding. */
  pendingSignatures: number;
}

export function listProtocolsForEntity(ctx: OperationContext, entity: EntityRef): ProtocolSummary[] {
  const instances = ctx.sql.query<ProtocolInstanceRow>(
    `SELECT * FROM protocol_instances
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
  return instances.map((instance) => {
    const template = getTemplateRow(ctx, instance.template_key, instance.template_version);
    const content = templateContentOf(template);
    // A document has one thing to settle — its bound content — so it reads as
    // 0/1 or 1/1 rather than pretending to a checklist's item count.
    const total =
      content.kind === 'checklist'
        ? content.sections.reduce((n, s) => n + s.items.length, 0)
        : 1;
    const answered =
      content.kind === 'checklist'
        ? Object.keys(latestPerItem(getResponseRows(ctx, instance.id))).length
        : instance.bound_hash
          ? 1
          : 0;
    const signatures = getSignatureRows(ctx, instance.id);
    const primary = signatures.find((s) => s.kind === 'primary');
    const counter = signatures.filter((s) => s.kind === 'counter').at(-1);
    const pendingSignatures = ctx.sql.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM protocol_signature_requests
       WHERE instance_id = ? AND status = 'pending'`,
      [instance.id],
    )[0]!.n;
    return {
      instance,
      title: template.title,
      contentKind: content.kind,
      answered,
      total,
      signedBy: primary?.signed_by ?? null,
      signedAt: primary?.signed_at ?? null,
      countersignedBy: counter?.signed_by ?? null,
      countersignedAt: counter?.signed_at ?? null,
      pendingSignatures,
    };
  });
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// Reads and per-instance mutations check per-entity (portal-style walks:
// role checks still pass at the node; entity-narrowed grants resolve along
// the vertical-declared parent edges).
// ---------------------------------------------------------------------------

const defineTemplateOp: OperationHandler<DefineTemplateInput, ProtocolTemplateRow> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return defineTemplate(ctx, input);
};

const listTemplatesOp: OperationHandler<undefined, ProtocolTemplateRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.read));
  return listTemplates(ctx);
};

const instantiateOp: OperationHandler<
  { templateKey: string; entityType: string; entityId: string },
  ProtocolInstanceRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
};

const fillOp: OperationHandler<FillProtocolInput, ProtocolResponseRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.fill, protocolRef(input.instanceId)));
  return fillProtocol(ctx, input);
};

const bindOp: OperationHandler<BindDocumentInput, ProtocolInstanceRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.bind, protocolRef(input.instanceId)));
  return bindDocument(ctx, input);
};

const requestSignaturesOp: OperationHandler<RequestSignaturesInput, RequestSignaturesResult> =
  async (ctx, input) => {
    assertAllowed(
      await ctx.check(PROTOCOL_PERM.requestSignature, protocolRef(input.instanceId)),
    );
    return requestSignatures(ctx, input);
  };

const cancelSignaturesOp: OperationHandler<CancelSignatureRequestsInput, ProtocolInstanceRow> =
  async (ctx, input) => {
    assertAllowed(
      await ctx.check(PROTOCOL_PERM.requestSignature, protocolRef(input.instanceId)),
    );
    return cancelSignatureRequests(ctx, input);
  };

/**
 * The ingress-facing pair. Both check `protocol:record-signature`, which is a
 * connector's key rather than a person's — the permission diff is where a
 * deployment declares that it trusts something to speak for an external
 * signing provider.
 */
const recordSignatureOp: OperationHandler<RecordSignatureInput, SignResult> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.recordSignature));
  return recordSignature(ctx, input);
};

const declineSignatureOp: OperationHandler<
  DeclineSignatureInput,
  ProtocolSignatureRequestRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.recordSignature));
  return declineSignature(ctx, input);
};

const signOp: OperationHandler<{ instanceId: string }, SignResult> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.sign, protocolRef(input.instanceId)));
  return signProtocol(ctx, input);
};

const countersignOp: OperationHandler<{ instanceId: string }, SignResult> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.countersign, protocolRef(input.instanceId)));
  return countersignProtocol(ctx, input);
};

const voidOp: OperationHandler<{ instanceId: string; reason: string }, ProtocolInstanceRow> =
  async (ctx, input) => {
    assertAllowed(await ctx.check(PROTOCOL_PERM.void, protocolRef(input.instanceId)));
    return voidProtocol(ctx, input);
  };

const getOp: OperationHandler<{ instanceId: string }, ProtocolDetail> = async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.read, protocolRef(input.instanceId)));
  return getProtocol(ctx, input.instanceId);
};

const listForEntityOp: OperationHandler<
  { entityType: string; entityId: string },
  ProtocolSummary[]
> = async (ctx, input) => {
  const entity: EntityRef = entityRef.parse(input);
  assertAllowed(await ctx.check(PROTOCOL_PERM.read, entity));
  return listProtocolsForEntity(ctx, entity);
};

export const protocolModule: ModuleRegistration = {
  manifest: protocolManifest,
  migrations: protocolMigrations,
  // The engine CONTRIBUTES the predicate; a vertical manifest WIRES it (K-17).
  // The engine never declares a guard of its own: what is mandatory when is
  // vertical policy, and the engine cannot know another module's operations.
  predicates: {
    'protocol/all-signed': allSignedPredicate,
  },
  operations: {
    'protocol/define-template': defineTemplateOp as OperationHandler<never, unknown>,
    'protocol/list-templates': listTemplatesOp as OperationHandler<never, unknown>,
    'protocol/instantiate': instantiateOp as OperationHandler<never, unknown>,
    'protocol/fill': fillOp as OperationHandler<never, unknown>,
    'protocol/bind-document': bindOp as OperationHandler<never, unknown>,
    'protocol/request-signatures': requestSignaturesOp as OperationHandler<never, unknown>,
    'protocol/cancel-signatures': cancelSignaturesOp as OperationHandler<never, unknown>,
    'protocol/record-signature': recordSignatureOp as OperationHandler<never, unknown>,
    'protocol/decline-signature': declineSignatureOp as OperationHandler<never, unknown>,
    'protocol/sign': signOp as OperationHandler<never, unknown>,
    'protocol/countersign': countersignOp as OperationHandler<never, unknown>,
    'protocol/void': voidOp as OperationHandler<never, unknown>,
    'protocol/get': getOp as OperationHandler<never, unknown>,
    'protocol/list-for-entity': listForEntityOp as OperationHandler<never, unknown>,
  },
};
