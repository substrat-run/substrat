/**
 * The shapes this engine ACCEPTS — every operation's input, and the template
 * content vocabulary the inputs are built from.
 *
 * A file of their own for the same reason `schemas.ts` is one, and the reason is
 * mechanical rather than tidiness. `index.ts` re-exports `operations.ts` so that
 * a vertical importing the engine gets the declared surface from the package
 * root; `operations.ts` declares each operation against the schema the handler
 * parses. With those schemas living in `index.ts`, importing the engine ran
 * `operations.ts` before `defineTemplateInput` was initialised — a require cycle
 * that a warm `dist` hides and `pnpm lint:permissions`, which really imports the
 * module, finds on the first run.
 *
 * So this module imports nothing from `index.ts`. It is a leaf, and the whole
 * declared surface — entities, row schemas, input schemas — sits below the
 * implementation rather than interleaved with it.
 *
 * Everything here stays exported from the package root: these are what a
 * composing vertical passes in, and `index.ts` re-exports each one.
 */
import { z } from 'zod';
import { dataSubjectId, entityRef, instant, principalId } from '@substrat-run/contracts';

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

/**
 * The content VALUE, either kind — what a parsed template holds.
 *
 * Exported alongside `protocolTemplateContent` because the two describe
 * different moments and only one of them is a parser for stored bytes. This is
 * the shape a caller RECEIVES (`protocol/get` returns it); the preprocessing
 * schema below is what turns a stored row into it, discriminant-less legacy rows
 * included. Declaring a return against a `z.preprocess` would publish the
 * normalisation as though it were the contract.
 */
export const contentUnion = z.discriminatedUnion('kind', [checklistContent, documentContent]);

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

export const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entity: entityRef,
});
export type InstantiateProtocolInput = z.infer<typeof instantiateProtocolInput>;

export const fillProtocolInput = z.object({
  instanceId: z.string().min(1),
  itemKey: z.string().min(1),
  value: responseValue,
  note: z.string().optional(),
});
export type FillProtocolInput = z.infer<typeof fillProtocolInput>;

export const bindDocumentInput = z.object({
  instanceId: z.string().min(1),
  /** The vertical entity that holds the real content — an avtal, a report. */
  contentRef: entityRef,
  /** The hash the VERTICAL computed over its own rows, per `hashRecipe`. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'contentHash must be lowercase hex SHA-256'),
  /**
   * The RENDERED document — an attachment on this instance holding the bytes a
   * signatory will be shown (#711). Optional, and absence is a complete answer:
   * a vertical that renders nothing keeps the behaviour it had, and a signing
   * connector falls back to its own attestation sheet.
   *
   * Naming an id rather than searching for one is deliberate. A connector that
   * had to PICK among an instance's attachments would need a rule, and the
   * return path lands the sealed signed copy on this same instance — so a wrong
   * rule mails a counterparty their own signed contract to sign again. The
   * caller says which bytes; nothing downstream has to guess.
   */
  documentAttachmentId: z.string().min(1).nullable().optional(),
});
export type BindDocumentInput = z.infer<typeof bindDocumentInput>;

/**
 * How a signing party is REACHED (#687) — a delivery address, and nothing else.
 *
 * Typed rather than an opaque blob the engine never interprets, and the reason is
 * the `authLevel` argument from #620 one level down: a provider-agnostic engine
 * that cannot say what "how to reach a party" means is an engine every vertical
 * has to guess around, and every connector has to re-derive. The type is small,
 * provider-agnostic, and — with no personal number in it — free of anything a
 * provider-specific vocabulary would be needed for.
 *
 * **No `personalNumber`, deliberately, and not merely as an omission.** An
 * optional PII field on an engine surface is a carrier that exists, and this one
 * is not needed by any path in the tree: a signatory enters their personnummer
 * into the BankID ceremony itself, and it comes back in the completion data.
 * Adding it would recreate exactly the problem this carrier was built to avoid.
 */
export const partyContact = z
  .object({
    email: z.string().email().optional(),
    /** E.164 preferred; the provider decides what it accepts. */
    mobile: z.string().min(1).optional(),
  })
  .refine((c) => c.email !== undefined || c.mobile !== undefined, {
    message: 'a party contact must carry an email or a mobile — an empty contact reaches nobody',
  });
export type PartyContact = z.infer<typeof partyContact>;

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
   * **`strong` needs a delivery address, never a personal number** (#687, #688).
   * The earlier reading of this field — that a national eID flow must carry the
   * signatory's personnummer, and is therefore unsatisfiable — was measured and
   * is false: what a provider validates is that a BankID party HAS a personal
   * number field, not that it holds a value, and BankID has not accepted one
   * from the relying party since API v6. So there is no `personalNumber` on this
   * shape, and its absence is a decision rather than an omission: an optional
   * PII field on an engine surface is a carrier that exists. If some future
   * provider genuinely needs one, that is a provider-specific refusal at egress
   * in that connector, with its own carrier argument.
   *
   * What both levels need is `contact` below, and neither can do without it.
   */
  authLevel: z.enum(['basic', 'strong']).optional(),
  /**
   * How this party is REACHED (#687) — the thing whose absence made every
   * external signature this platform ever sent fail at the provider.
   *
   * Required for any party that will be INVITED, which is every party except the
   * one issuing the document (see `signatureKind`): the issuer is the author at
   * the provider, reached through the platform's own account, and an author is
   * never invited. `requestSignatures` refuses a set that would send a document
   * to somebody it cannot reach, rather than letting the provider answer
   * `invalid_invitation_delivery_info` a layer later where the caller cannot see
   * it.
   *
   * **This is `direct` PII and the engine never stores it in the clear.** It is
   * sealed to the receiving connector's public key inside the operation, before
   * anything is emitted, and only the envelope reaches the row and the event
   * (design/signature-contact-carrier.md). A vertical passes a plain address in;
   * from the operation's return onward nothing in the platform can read it back.
   */
  contact: partyContact.optional(),
});
export type SignatureRequestParty = z.input<typeof signatureRequestParty>;

export const requestSignaturesInput = z.object({
  instanceId: z.string().min(1),
  /** 'scrive', 'bankid' — the provider a connector will dispatch to. */
  method: z.string().min(1),
  parties: z.array(signatureRequestParty).min(1),
});
export type RequestSignaturesInput = z.input<typeof requestSignaturesInput>;

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

export const declineSignatureInput = z.object({
  requestId: z.string().min(1),
  reason: z.string().min(1),
  /** 'declined' when a party refused; 'expired' when the provider timed out. */
  outcome: z.enum(['declined', 'expired']).default('declined'),
});
export type DeclineSignatureInput = z.input<typeof declineSignatureInput>;

export const cancelSignatureRequestsInput = z.object({
  instanceId: z.string().min(1),
  reason: z.string().min(1),
});
export type CancelSignatureRequestsInput = z.infer<typeof cancelSignatureRequestsInput>;
