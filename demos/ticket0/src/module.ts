/**
 * ticket0's operations — the business logic, and nothing else.
 *
 * Everything structural is derived from `spec/model.ts`: the migrations were emitted
 * from the entities, the manifest is assembled from both halves of the model, the
 * route table is derived at mount time, and the conversation's state machine is
 * enforced from the declaration rather than written a second time as guards here.
 *
 * What is left is what only a person could decide: what it means for a message to be
 * public, who a conversation belongs to, and what a token costs.
 */
import {
  addDecimal,
  assertTransition,
  LIST_PAGE_DEFAULT,
  mulDecimal,
  operationInputsOf,
  pageOf,
  pageVisible,
  substratError,
  type CountedPage,
  type EntityRow,
  type HandlerInput,
  type HandlerOutput,
  MODEL_USAGE_KIND,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type SqlValue,
} from '@substrat-run/kernel';
import {
  closePeriod,
  configureMeter,
  listEntries,
  recordUsage,
  usageTotal,
} from '@substrat-run/engine-metering';
import {
  DESK_METRICS_AGENTS,
  DESK_METRICS_WINDOW_DAYS,
  SEARCH_OVERFETCH,
  ticket0Entities,
  ticket0Lifecycles,
  ticket0Operations,
} from '../spec/model.js';
import { T0_PERM, ticket0Manifest } from './manifest.js';
import { ticket0Migrations } from './migrations.generated.js';

type ContactRow = EntityRow<typeof ticket0Entities, 'contact'>;
type AgentProfileRow = EntityRow<typeof ticket0Entities, 'agentProfile'>;
type ConversationRow = EntityRow<typeof ticket0Entities, 'conversation'>;
type MessageRow = EntityRow<typeof ticket0Entities, 'message'>;
type TagRow = EntityRow<typeof ticket0Entities, 'conversationTag'>;
type SavedReplyRow = EntityRow<typeof ticket0Entities, 'savedReply'>;
type CsatRow = EntityRow<typeof ticket0Entities, 'csat'>;
type SessionRow = EntityRow<typeof ticket0Entities, 'widgetSession'>;
type OpeningRow = EntityRow<typeof ticket0Entities, 'widgetOpening'>;
type DeskRow = EntityRow<typeof ticket0Entities, 'deskSettings'>;
type KbSourceRow = EntityRow<typeof ticket0Entities, 'kbSource'>;
type KbArticleRow = EntityRow<typeof ticket0Entities, 'kbArticle'>;
type AiTurnRow = EntityRow<typeof ticket0Entities, 'aiTurn'>;
type UsageRateRow = EntityRow<typeof ticket0Entities, 'usageRate'>;
type NotificationRow = EntityRow<typeof ticket0Entities, 'notification'>;

const conversationRef = (id: string) => ({ entityType: 'conversation', entityId: id });
const contactRef = (id: string) => ({ entityType: 'contact', entityId: id });
const sourceRef = (id: string) => ({ entityType: 'kbSource', entityId: id });

/** The desk is a singleton per scope, and this is its id. */
const DESK = 'desk';

/** How many lapsed snoozes one run of `ticket0/wake-snoozed` takes. The rest wait
 *  for the next tick — a batch bounds the transaction, it does not cap the feature. */
const WAKE_BATCH = 200;

/**
 * `2026-03-09T09:00:00.000Z`, as a SQLite GLOB — the shape `instant` normalises to.
 *
 * The sweep compares `snoozed_until` as TEXT, which is only the same as comparing
 * instants while every value is canonical UTC. `ticket0/snooze` guarantees that from
 * now on, but the column is older than the timer and used to accept any string, so a
 * desk may hold rows this vertical never wrote. Those sort arbitrarily: `…T11:00:00
 * -02:00` is 13:00Z and sorts BEFORE 11:00Z, and `''` or `'0'` sort before every
 * timestamp there is — each of them waking a conversation the agent did not ask for,
 * which is the one failure worse than not waking at all.
 *
 * So the sweep only ever wakes what it can compare. A non-canonical row stays
 * snoozed, exactly as it did before the timer existed, and `ticket0/wake` is still
 * the door out — a repair, not a silent misfire. This is a guard rather than a
 * migration on purpose: repairing shipped rows is a human checkpoint.
 */
const CANONICAL_INSTANT =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';

/**
 * The meters this desk records against.
 *
 * Registered lazily rather than in a migration: meter rows are the ENGINE's tables,
 * and writing another module's tables is what decision 28 forbids. `configureMeter`
 * is idempotent and freezes kind/unit on first write, so calling it on the paths
 * that need it is both safe and the only honest place for it.
 */
export const METERS = {
  inputTokens: 'ai.tokens.input',
  outputTokens: 'ai.tokens.output',
} as const;

// ---------------------------------------------------------------------------
// Reads that refuse rather than answering emptily
// ---------------------------------------------------------------------------

function conversationOrThrow(ctx: OperationContext, id: string): ConversationRow {
  const row = ctx.sql.query<ConversationRow>('SELECT * FROM ticket0_conversations WHERE id = ?', [
    id,
  ])[0];
  if (!row) throw substratError('not_found', `conversation not found: ${id}`);
  return row;
}

function messageOrThrow(ctx: OperationContext, id: string): MessageRow {
  const row = ctx.sql.query<MessageRow>('SELECT * FROM ticket0_messages WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `message not found: ${id}`);
  return row;
}

function sourceOrThrow(ctx: OperationContext, id: string): KbSourceRow {
  const row = ctx.sql.query<KbSourceRow>('SELECT * FROM ticket0_kb_sources WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `documentation source not found: ${id}`);
  return row;
}

/**
 * Somebody this desk can hand work to.
 *
 * The directory is `ticket0_agent_profiles`, for the reason the operation's
 * docblock gives: it is the only in-scope record of a colleague, because nothing
 * lets module code ask who else holds a permission. So a principal with no
 * profile is refused here — `validation_failed` rather than a write, since a
 * typo that sticks is exactly what this is for.
 */
function staffOrThrow(ctx: OperationContext, principal: string): AgentProfileRow {
  const row = ctx.sql.query<AgentProfileRow>(
    'SELECT * FROM ticket0_agent_profiles WHERE principal = ?',
    [principal],
  )[0];
  if (!row) {
    throw substratError(
      'validation_failed',
      `not a member of this desk: ${principal} — they appear here once they have set a profile`,
    );
  }
  return row;
}

/**
 * The desk's settings, seeded lazily on first read.
 *
 * User-shaped configuration is DATA: a row with defaults, not DDL and not a constant
 * buried in this file. The verification secret is minted here so a desk is never
 * briefly in a state where the widget could be embedded without one.
 */
function desk(ctx: OperationContext): DeskRow {
  const existing = ctx.sql.query<DeskRow>('SELECT * FROM ticket0_desk_settings WHERE id = ?', [
    DESK,
  ])[0];
  if (existing) return existing;
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO ticket0_desk_settings
       (id, from_address, greeting, allowed_origins, verification_secret, business_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [DESK, 'support@example.com', 'Hi - how can we help?', '[]', ulid(), null, now, now],
  );
  return ctx.sql.query<DeskRow>('SELECT * FROM ticket0_desk_settings WHERE id = ?', [DESK])[0]!;
}

/** Never hand the secret back on an ordinary read. */
function publicDesk(row: DeskRow) {
  const { verification_secret: _secret, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// The state machine - enforced from the declaration, never re-derived
// ---------------------------------------------------------------------------

/**
 * Every operation that touches a conversation names itself here and lets the
 * declared lifecycle answer. An `allow` entry passes and moves nothing; an `on`
 * entry returns the next state; anything the state does not admit throws the
 * platform's own conflict with `reason: 'invalid_transition'`.
 */
function step(row: ConversationRow, operation: string): string {
  const outcome = assertTransition(
    ticket0Lifecycles.conversation,
    `conversation ${row.id}`,
    row.state,
    operation,
  );
  // `allowed` is not a degenerate transition: writing `state` after one would move
  // an entity the declaration says stays put.
  return outcome.kind === 'transition' ? outcome.to : row.state;
}

/** One place that writes `state` and `updated_at`, so they cannot disagree. */
function moveTo(ctx: OperationContext, id: string, state: string): ConversationRow {
  ctx.sql.exec('UPDATE ticket0_conversations SET state = ?, updated_at = ? WHERE id = ?', [
    state,
    ctx.now(),
    id,
  ]);
  return conversationOrThrow(ctx, id);
}

function touch(ctx: OperationContext, id: string): ConversationRow {
  ctx.sql.exec('UPDATE ticket0_conversations SET updated_at = ? WHERE id = ?', [ctx.now(), id]);
  return conversationOrThrow(ctx, id);
}

/** Apply whatever the lifecycle decided, in one place. */
function settle(ctx: OperationContext, row: ConversationRow, next: string): ConversationRow {
  return next === row.state ? touch(ctx, row.id) : moveTo(ctx, row.id, next);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface WriteMessage {
  readonly conversationId: string;
  readonly authorKind: MessageRow['author_kind'];
  readonly authorPrincipal: string | null;
  readonly visibility: MessageRow['visibility'];
  readonly bodyText: string;
  readonly bodyHtml?: string | null;
  readonly emailMessageId?: string | null;
  readonly emailInReplyTo?: string | null;
  readonly citedArticleIds?: readonly string[];
}

function writeMessage(ctx: OperationContext, m: WriteMessage): MessageRow {
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO ticket0_messages
       (id, conversation_id, author_kind, author_principal, visibility, body_text, body_html,
        email_message_id, email_in_reply_to, delivered_at, cited_article_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      m.conversationId,
      m.authorKind,
      m.authorPrincipal,
      m.visibility,
      m.bodyText,
      m.bodyHtml ?? null,
      m.emailMessageId ?? null,
      m.emailInReplyTo ?? null,
      m.citedArticleIds && m.citedArticleIds.length > 0
        ? JSON.stringify(m.citedArticleIds)
        : null,
      ctx.now(),
    ],
  );
  ctx.link({ entityType: 'message', entityId: id }, conversationRef(m.conversationId));
  return messageOrThrow(ctx, id);
}

/** The one shape every message event carries. Bodies are erasable and never ride. */
function messageEvent(row: MessageRow, type: string) {
  return {
    type,
    schemaVersion: 1 as const,
    entity: { entityType: 'message', entityId: row.id },
    piiClass: 'none' as const,
    payload: {
      id: row.id,
      conversation_id: row.conversation_id,
      author_kind: row.author_kind,
      visibility: row.visibility,
    },
  };
}

function notify(
  ctx: OperationContext,
  principal: string,
  kind: NotificationRow['kind'],
  conversationId: string | null,
): void {
  // Never tell someone about their own act.
  if (principal === String(ctx.principal)) return;
  ctx.sql.exec(
    `INSERT INTO ticket0_notifications (id, principal, kind, conversation_id, read_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [ulid(), principal, kind, conversationId, ctx.now()],
  );
}

// ---------------------------------------------------------------------------
// Contacts, sessions, and the three rungs of trust
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** An imported HMAC key. Opaque — handed straight back to `sign`, never inspected. */
interface ImportedKey {
  readonly __webCryptoKey: unique symbol;
}

/** The slice of Web Crypto this module uses. Structural, so it types under both lib sets. */
interface WebCrypto {
  subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: { name: 'HMAC'; hash: 'SHA-256' },
      extractable: boolean,
      usages: 'sign'[],
    ): Promise<ImportedKey>;
    sign(algorithm: 'HMAC', key: ImportedKey, data: Uint8Array): Promise<ArrayBuffer>;
  };
}

/**
 * Web Crypto — the same API in node, workerd and browsers, and the only crypto module
 * code is allowed (never `node:crypto`, never a hand-rolled hash).
 *
 * Reached through `globalThis`, which is the rule, and cast rather than declared because
 * the two lib sets disagree about it: `tsconfig.json` compiles this file with node's
 * ambient types, `tsconfig.worker.json` with the Workers ones, and `typeof globalThis`
 * carries no `crypto` in the second. The cast is where that disagreement is absorbed —
 * one place, named, instead of a bare `declare const crypto` that shadows the global and
 * would go on type-checking if the global ever stopped being there.
 */
const webCrypto = (globalThis as unknown as { crypto: WebCrypto }).crypto;

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Web Crypto, the same API in Node, Workers and browsers. Never a hand-rolled hash. */
async function sha256(value: string): Promise<string> {
  return hex(await webCrypto.subtle.digest('SHA-256', enc.encode(value)));
}

/**
 * The middle rung of trust: HMAC-SHA256 over the external id, keyed by the desk's
 * secret - the mechanism Intercom calls `user_hash` and Help Scout calls a Beacon
 * signature. The host page's SERVER computes it; the browser only carries it, which
 * is what makes it a claim the browser cannot forge.
 *
 * Both sides are hex of a fixed length, so the constant-time compare below leaks
 * length and nothing else.
 */
async function verifyIdentity(
  secret: string,
  externalId: string,
  signature: string,
): Promise<boolean> {
  const key = await webCrypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hex(await webCrypto.subtle.sign('HMAC', key, enc.encode(externalId)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function contactOrThrow(ctx: OperationContext, id: string): ContactRow {
  const row = ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `contact not found: ${id}`);
  return row;
}

function contactByExternalId(ctx: OperationContext, externalId: string): ContactRow | undefined {
  return ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE external_id = ?', [
    externalId,
  ])[0];
}

function contactByEmail(ctx: OperationContext, email: string): ContactRow | undefined {
  return ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE email = ?', [email])[0];
}

function createContact(
  ctx: OperationContext,
  fields: {
    external_id?: string | null;
    email?: string | null;
    display_name?: string | null;
    verified_at?: string | null;
  },
): ContactRow {
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO ticket0_contacts (id, external_id, principal, email, display_name, verified_at, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      fields.external_id ?? null,
      fields.email ?? null,
      fields.display_name ?? null,
      fields.verified_at ?? null,
      ctx.now(),
    ],
  );
  return ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE id = ?', [id])[0]!;
}

function openConversation(
  ctx: OperationContext,
  contact: ContactRow,
  channel: ConversationRow['channel'],
  subject: string,
): ConversationRow {
  const id = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO ticket0_conversations
       (id, contact_id, channel, subject, state, assignee, priority, snoozed_until,
        first_public_reply_at, resolved_at, merged_into, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', NULL, 'normal', NULL, NULL, NULL, NULL, ?, ?)`,
    [id, contact.id, channel, subject, now, now],
  );
  // The edge the permission walk follows: a contact's grant on their own entity
  // reaches their conversations through this, and reaches nobody else's.
  ctx.link(conversationRef(id), contactRef(contact.id));
  return conversationOrThrow(ctx, id);
}

/**
 * What gets stored is an ORIGIN, because that is what the browser sends and what
 * `widget-start` compares by string. The input schema only asks for a URL, so
 * `https://example.com/` or `https://example.com/pricing` would otherwise be saved
 * verbatim and never match — the desk would look configured and refuse everyone.
 */
function originsOf(urls: string[]): string[] {
  const origins = urls.map((u) => {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw substratError('validation_failed', `${u} is not an http(s) origin`);
    return url.origin;
  });
  return [...new Set(origins)];
}

function allowedOrigins(ctx: OperationContext): string[] {
  const parsed = JSON.parse(desk(ctx).allowed_origins) as unknown;
  return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
}

/**
 * What a widget call holds: a session bound to its conversation, or an opening that
 * has not said anything yet. Either way the token decides, and a refusal is a
 * sentence rather than a silent empty answer.
 */
type WidgetHold =
  | { readonly kind: 'session'; readonly conversation: ConversationRow }
  | { readonly kind: 'opening'; readonly opening: OpeningRow };

async function holdOrThrow(
  ctx: OperationContext,
  sessionId: string,
  token: string,
): Promise<WidgetHold> {
  const session = ctx.sql.query<SessionRow>('SELECT * FROM ticket0_widget_sessions WHERE id = ?', [
    sessionId,
  ])[0];
  const opening = session
    ? undefined
    : ctx.sql.query<OpeningRow>('SELECT * FROM ticket0_widget_openings WHERE id = ?', [
        sessionId,
      ])[0];
  const held = session ?? opening;
  if (!held) throw substratError('not_found', `widget session not found: ${sessionId}`);
  if (held.token_hash !== (await sha256(token)))
    throw substratError('permission_denied', 'widget session token does not match');
  // An origin dropped from the allowlist stops working rather than coasting on a
  // session opened while it was still trusted.
  if (!allowedOrigins(ctx).includes(held.origin))
    throw substratError('permission_denied', `origin no longer embedded here: ${held.origin}`);
  const table = session ? 'ticket0_widget_sessions' : 'ticket0_widget_openings';
  ctx.sql.exec(`UPDATE ${table} SET last_seen_at = ? WHERE id = ?`, [ctx.now(), held.id]);
  return session
    ? { kind: 'session', conversation: conversationOrThrow(ctx, session.conversation_id) }
    : { kind: 'opening', opening: opening! };
}

/**
 * The first message: the moment an opening becomes a conversation.
 *
 * The contact the host site vouched for was resolved when the widget opened (a
 * verified person is a record already); an anonymous visitor gets theirs here, so a
 * bubble opened and abandoned leaves no contact and no thread. The opening row moves
 * into `ticket0_widget_sessions` under the same id and token hash — the widget holds
 * the same session before and after, and never learns the difference.
 */
function bindOpening(ctx: OperationContext, opening: OpeningRow): ConversationRow {
  const contact = opening.contact_id
    ? contactOrThrow(ctx, opening.contact_id)
    : createContact(ctx, {});
  const conversation = openConversation(ctx, contact, 'widget', 'Chat');
  // The client columns travel with the row: they were the host's read of the browser
  // when it opened, and the request that carried them is long gone by now.
  ctx.sql.exec(
    `INSERT INTO ticket0_widget_sessions
       (id, conversation_id, contact_id, origin, token_hash, started_at, last_seen_at,
        user_agent, language, browser, browser_version, os, os_version, device,
        country, region, city, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opening.id,
      conversation.id,
      contact.id,
      opening.origin,
      opening.token_hash,
      opening.started_at,
      ctx.now(),
      opening.user_agent,
      opening.language,
      opening.browser,
      opening.browser_version,
      opening.os,
      opening.os_version,
      opening.device,
      opening.country,
      opening.region,
      opening.city,
      opening.timezone,
    ],
  );
  ctx.sql.exec('DELETE FROM ticket0_widget_openings WHERE id = ?', [opening.id]);
  ctx.link({ entityType: 'widgetSession', entityId: opening.id }, conversationRef(conversation.id));
  return conversation;
}

/**
 * Resolve every message's cited ids to articles, in one query for the whole page.
 *
 * A citation exists so a human can check it, and an id is not checkable — so the join
 * happens here rather than being left to each caller to reinvent, or to a browser to do
 * one request at a time.
 */
function withCitations<T extends { cited_article_ids?: string | null }>(
  ctx: OperationContext,
  rows: T[],
): (T & { citations: { id: string; title: string; url: string; headingPath: string }[] })[] {
  const ids = [
    ...new Set(
      rows.flatMap((r) => (r.cited_article_ids ? (JSON.parse(r.cited_article_ids) as string[]) : [])),
    ),
  ];
  const byId = new Map(
    (ids.length
      ? ctx.sql.query<KbArticleRow>(
          `SELECT * FROM ticket0_kb_articles WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        )
      : []
    ).map((a) => [a.id, a]),
  );
  return rows.map((r) => ({
    ...r,
    citations: (r.cited_article_ids ? (JSON.parse(r.cited_article_ids) as string[]) : [])
      .map((id) => byId.get(id))
      .filter((a): a is KbArticleRow => a !== undefined)
      .map((a) => ({ id: a.id, title: a.title, url: a.url, headingPath: a.heading_path })),
  }));
}

/**
 * Both customer-facing reads, written once: public messages only, author id stripped.
 *
 * A separate path from the staff read rather than the same one with a flag, because
 * the flag is the bug - one read whose output depends on who is asking is how an
 * internal note reaches a customer.
 */
function publicThread(
  ctx: OperationContext,
  conversationId: string,
  input: { limit?: number; cursor?: string },
) {
  const limit = input.limit ?? LIST_PAGE_DEFAULT;
  const rows = input.cursor
    ? ctx.sql.query<MessageRow>(
        `SELECT * FROM ticket0_messages
          WHERE conversation_id = ? AND visibility = 'public' AND id > ? ORDER BY id LIMIT ?`,
        [conversationId, input.cursor, limit],
      )
    : ctx.sql.query<MessageRow>(
        `SELECT * FROM ticket0_messages
          WHERE conversation_id = ? AND visibility = 'public' ORDER BY id LIMIT ?`,
        [conversationId, limit],
      );
  return pageOf(
    withCitations(
      ctx,
      rows.map(({ author_principal: _hidden, ...rest }) => rest),
    ),
    limit,
    (row) => row.id,
  );
}

// ---------------------------------------------------------------------------
// Pricing - the vertical's, never the ledger's
// ---------------------------------------------------------------------------

/** One conversation's slice of a meter, from the entries that carry it as a subject. */
function sumEntries(
  ctx: OperationContext,
  meter: string,
  subject: { entityType: string; entityId: string },
  from: string,
  to: string,
): { qty: string; entryCount: number } | null {
  const entries = listEntries(ctx, { meter, subject, from, to });
  if (entries.length === 0) return null;
  return {
    qty: entries.reduce((sum, e) => addDecimal(sum, e.qty), '0'),
    entryCount: entries.length,
  };
}

/** The rate in force for a meter at an instant: the latest one that had taken effect. */
function rateFor(ctx: OperationContext, meterKey: string, at: string): UsageRateRow | undefined {
  return ctx.sql.query<UsageRateRow>(
    `SELECT * FROM ticket0_usage_rates
      WHERE meter_key = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`,
    [meterKey, at],
  )[0];
}

/**
 * Register the two meters this desk records against. Idempotent by construction.
 */
function ensureMeters(ctx: OperationContext): void {
  configureMeter(ctx, {
    key: METERS.inputTokens,
    kind: 'counter',
    unit: 'token',
    description: 'Tokens sent to the model',
  });
  configureMeter(ctx, {
    key: METERS.outputTokens,
    kind: 'counter',
    unit: 'token',
    description: 'Tokens the model produced',
  });
}

/**
 * `total / divisor`, half-up at 6 dp, as a decimal string.
 *
 * `@substrat-run/contracts` gives a sum and a product on 6-dp decimal strings and no
 * quotient — the ledger never needs one, because a bill is a sum of priced quantities.
 * A *rate* — what one resolved conversation cost — is a quotient, so this computes it in
 * the same representation and the same rounding, in BigInt, so the money reaches the
 * screen without passing through a float. Only non-negative totals occur here; a cost is
 * a sum of priced token counts.
 */
function divDecimal(total: string, divisor: number): string {
  const [whole = '0', frac = ''] = total.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
  const d = BigInt(divisor);
  const quotient = (micro * 2n + d) / (d * 2n);
  const fraction = (quotient % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${quotient / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

/** A rate, rounded to a fixed number of places so a screen is not shown 0.3333333333. */
function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** An instant `days` away from `at`, as the same canonical ISO text every column holds. */
function shiftDays(at: string, days: number): string {
  return new Date(Date.parse(at) + days * 86_400_000).toISOString();
}

/**
 * Whole seconds between two SQL timestamp expressions, as SQL.
 *
 * `julianday` is the comparison, not text ordering, so this is correct for any instant
 * SQLite can parse — including the trailing `Z` every column here carries. It rounds to
 * a whole second because nothing on the report is measured finer than that.
 *
 * Both arguments are column names or `?` written in this file. Nothing a caller sends
 * reaches here — a caller's instants are bound as parameters, as everywhere else.
 */
const elapsed = (from: string, to: string) =>
  `CAST(ROUND((julianday(${to}) - julianday(${from})) * 86400) AS INTEGER)`;

/**
 * Median and p90 of a query that yields one `seconds` column.
 *
 * By **nearest rank**: the p-th percentile is the value at position `ceil(p × n)`, so
 * every answer is a duration that actually happened rather than an interpolation between
 * two that did. Three queries and constant memory — the durations are never materialized,
 * which is what keeps a report over a busy year from being a page of its own.
 *
 * `select` is a query literal written above, wrapped rather than concatenated with
 * anything a caller sent; the caller's window arrives in `params` and is bound.
 */
function percentiles(
  ctx: OperationContext,
  select: string,
  params: readonly SqlValue[],
): { measured: number; medianSeconds: number | null; p90Seconds: number | null } {
  const measured = Number(
    ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM (${select})`, params)[0]?.n ?? 0,
  );
  if (measured === 0) return { measured: 0, medianSeconds: null, p90Seconds: null };
  const at = (fraction: number): number | null => {
    const offset = Math.max(0, Math.ceil(fraction * measured) - 1);
    const row = ctx.sql.query<{ seconds: number }>(
      `SELECT seconds FROM (${select}) ORDER BY seconds ASC LIMIT 1 OFFSET ?`,
      [...params, offset],
    )[0];
    return row ? Number(row.seconds) : null;
  };
  return { measured, medianSeconds: at(0.5), p90Seconds: at(0.9) };
}

/**
 * Who carried the window: conversations resolved, and public replies sent.
 *
 * Two different facts about the same people, so they are counted separately and unioned
 * rather than joined — a join between "conversations they resolved" and "messages they
 * sent" multiplies one by the other. Only **public** agent messages count as replies: an
 * internal note is a note to a colleague, and counting it as customer contact is the one
 * way this number could flatter somebody who never wrote to a customer at all.
 */
function deskAgents(
  ctx: OperationContext,
  from: string,
  to: string,
): { principal: string; displayName: string | null; resolved: number; replies: number }[] {
  return ctx.sql
    .query<{ principal: string; display_name: string | null; resolved: number; replies: number }>(
      `SELECT a.principal, p.display_name,
              SUM(a.resolved) AS resolved, SUM(a.replies) AS replies
         FROM (
           SELECT assignee AS principal, COUNT(*) AS resolved, 0 AS replies
             FROM ticket0_conversations
            WHERE assignee IS NOT NULL
              AND resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at <= ?
            GROUP BY assignee
           UNION ALL
           SELECT author_principal AS principal, 0 AS resolved, COUNT(*) AS replies
             FROM ticket0_messages
            WHERE author_kind = 'agent' AND visibility = 'public'
              AND author_principal IS NOT NULL
              AND created_at >= ? AND created_at <= ?
            GROUP BY author_principal
         ) a
         LEFT JOIN ticket0_agent_profiles p ON p.principal = a.principal
        GROUP BY a.principal, p.display_name
        ORDER BY resolved DESC, replies DESC, a.principal ASC
        LIMIT ?`,
      [from, to, from, to, DESK_METRICS_AGENTS],
    )
    .map((r) => ({
      principal: r.principal,
      displayName: r.display_name,
      resolved: Number(r.resolved),
      replies: Number(r.replies),
    }));
}

function overfetch(limit: number): number {
  return Math.min(limit * SEARCH_OVERFETCH, MAX_SEARCH_LIMIT);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const operations = {
  // --- The desk ------------------------------------------------------------

  'ticket0/get-desk': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    return publicDesk(desk(ctx));
  },

  'ticket0/configure-desk': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    const current = desk(ctx);
    ctx.sql.exec(
      `UPDATE ticket0_desk_settings
          SET from_address = ?, greeting = ?, allowed_origins = ?, business_hours = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.fromAddress ?? current.from_address,
        input.greeting ?? current.greeting,
        input.allowedOrigins ? JSON.stringify(originsOf(input.allowedOrigins)) : current.allowed_origins,
        input.businessHours === undefined ? current.business_hours : input.businessHours,
        ctx.now(),
        DESK,
      ],
    );
    const row = desk(ctx);
    ctx.emit({
      type: 'ticket0.desk-configured',
      schemaVersion: 1,
      entity: { entityType: 'deskSettings', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, from_address: row.from_address, allowed_origins: row.allowed_origins },
    });
    return publicDesk(row);
  },

  'ticket0/rotate-verification-secret': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    desk(ctx);
    const secret = `${ulid()}${ulid()}`;
    const now = ctx.now();
    ctx.sql.exec(
      'UPDATE ticket0_desk_settings SET verification_secret = ?, updated_at = ? WHERE id = ?',
      [secret, now, DESK],
    );
    ctx.emit({
      type: 'ticket0.verification-secret-rotated',
      schemaVersion: 1,
      entity: { entityType: 'deskSettings', entityId: DESK },
      piiClass: 'none',
      // Deliberately not the secret: an event is immutable, and an immutable copy
      // of a secret cannot be rotated away.
      payload: { id: DESK },
    });
    return { id: DESK, secret, rotatedAt: now };
  },

  'ticket0/set-agent-profile': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    // The caller's own principal, never one from the input - this cannot rename a
    // colleague however it is called.
    const principal = String(ctx.principal);
    const existing = ctx.sql.query<AgentProfileRow>(
      'SELECT * FROM ticket0_agent_profiles WHERE principal = ?',
      [principal],
    )[0];
    // The whole row, both ways. The input states every field, so there is nothing to
    // merge with what is already there - which is the point: a merge here would be
    // the read-modify-write the model refuses.
    if (existing) {
      ctx.sql.exec(
        'UPDATE ticket0_agent_profiles SET display_name = ?, avatar_url = ?, signature = ? WHERE principal = ?',
        [input.displayName, input.avatarUrl, input.signature, principal],
      );
    } else {
      ctx.sql.exec(
        `INSERT INTO ticket0_agent_profiles (principal, display_name, avatar_url, signature, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [principal, input.displayName, input.avatarUrl, input.signature, ctx.now()],
      );
    }
    const row = ctx.sql.query<AgentProfileRow>(
      'SELECT * FROM ticket0_agent_profiles WHERE principal = ?',
      [principal],
    )[0]!;
    // The principal and the row's birth, nothing personal: the name, the avatar and
    // the signature are all erasable, and an event is the one place in a scope an
    // erasure cannot reach.
    ctx.emit({
      type: 'ticket0.agent-profile-set',
      schemaVersion: 1,
      entity: { entityType: 'agentProfile', entityId: row.principal },
      piiClass: 'none',
      payload: { principal: row.principal, created_at: row.created_at },
    });
    return row;
  },

  'ticket0/list-agents': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    return ctx.page<AgentProfileRow>('agentProfile', input);
  },

  // --- Knowledge base ------------------------------------------------------

  'ticket0/add-kb-source': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage));
    const existing = ctx.sql.query<KbSourceRow>('SELECT * FROM ticket0_kb_sources WHERE url = ?', [
      input.url,
    ])[0];
    if (existing) return existing;
    const id = ulid();
    ctx.sql.exec(
      `INSERT INTO ticket0_kb_sources (id, kind, url, label, status, last_ingested_at, last_error, created_at)
       VALUES (?, ?, ?, ?, 'idle', NULL, NULL, ?)`,
      [id, input.kind, input.url, input.label, ctx.now()],
    );
    const row = sourceOrThrow(ctx, id);
    ctx.emit({
      type: 'ticket0.kb-source-added',
      schemaVersion: 1,
      entity: sourceRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, kind: row.kind, url: row.url, label: row.label },
    });
    return row;
  },

  'ticket0/list-kb-sources': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRead));
    return ctx.page<KbSourceRow>('kbSource', input);
  },

  'ticket0/ingest-kb-source': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage, sourceRef(input.sourceId)));
    const row = sourceOrThrow(ctx, input.sourceId);
    ctx.sql.exec('UPDATE ticket0_kb_sources SET status = ?, last_error = NULL WHERE id = ?', [
      'ingesting',
      row.id,
    ]);
    const updated = sourceOrThrow(ctx, row.id);
    // The fetching happens outside this transaction, in a connector: module code has
    // no network, and holding a scope's transaction open across someone else's docs
    // site would be the reason why even if it did.
    ctx.emit({
      type: 'ticket0.kb-ingest-requested',
      schemaVersion: 1,
      entity: sourceRef(updated.id),
      piiClass: 'none',
      payload: { id: updated.id, kind: updated.kind, url: updated.url },
    });
    return updated;
  },

  'ticket0/record-kb-articles': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage, sourceRef(input.sourceId)));
    sourceOrThrow(ctx, input.sourceId);
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const article of input.articles) {
      const hash = await sha256(`${article.title} ${article.headingPath} ${article.body}`);
      const existing = ctx.sql.query<KbArticleRow>(
        'SELECT * FROM ticket0_kb_articles WHERE source_id = ? AND url = ?',
        [input.sourceId, article.url],
      )[0];
      if (existing && existing.content_hash === hash) {
        // The whole reason for the hash: a nightly re-read of an unchanged docs site
        // writes nothing, so the audit trail stays worth reading.
        unchanged += 1;
        continue;
      }
      if (existing) {
        ctx.sql.exec(
          `UPDATE ticket0_kb_articles
              SET title = ?, heading_path = ?, body = ?, content_hash = ?, ingested_at = ?
            WHERE id = ?`,
          [article.title, article.headingPath, article.body, hash, ctx.now(), existing.id],
        );
        updated += 1;
        continue;
      }
      const id = ulid();
      ctx.sql.exec(
        `INSERT INTO ticket0_kb_articles
           (id, source_id, url, title, heading_path, body, content_hash, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.sourceId,
          article.url,
          article.title,
          article.headingPath,
          article.body,
          hash,
          ctx.now(),
        ],
      );
      ctx.link({ entityType: 'kbArticle', entityId: id }, sourceRef(input.sourceId));
      added += 1;
    }

    ctx.sql.exec(
      'UPDATE ticket0_kb_sources SET status = ?, last_ingested_at = ?, last_error = NULL WHERE id = ?',
      ['idle', ctx.now(), input.sourceId],
    );
    const result = { sourceId: input.sourceId, added, updated, unchanged };
    ctx.emit({
      type: 'ticket0.kb-source-ingested',
      schemaVersion: 1,
      entity: sourceRef(input.sourceId),
      piiClass: 'none',
      payload: result,
    });
    return result;
  },

  'ticket0/record-kb-ingest-failure': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage, sourceRef(input.sourceId)));
    sourceOrThrow(ctx, input.sourceId);
    // `last_ingested_at` is left alone on purpose: it is when the last GOOD read
    // happened, which is exactly what the desk wants to know once a read has failed —
    // the assistant is still answering from that copy.
    ctx.sql.exec('UPDATE ticket0_kb_sources SET status = ?, last_error = ? WHERE id = ?', [
      'failed',
      input.error,
      input.sourceId,
    ]);
    const row = sourceOrThrow(ctx, input.sourceId);
    ctx.emit({
      type: 'ticket0.kb-ingest-failed',
      schemaVersion: 1,
      entity: sourceRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, url: row.url, last_error: row.last_error },
    });
    return row;
  },

  'ticket0/search-kb': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRead));
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const fetch = overfetch(limit);
    const hits = ctx.search('kbArticle', input.q, { limit: fetch });
    if (hits.length === 0) return { results: [], limit, capped: false };

    const params: string[] = hits.map((h) => h.id);
    let sql = `SELECT * FROM ticket0_kb_articles WHERE id IN (${hits.map(() => '?').join(', ')})`;
    if (input.sourceId) {
      sql += ' AND source_id = ?';
      params.push(input.sourceId);
    }
    const rows = ctx.sql.query<KbArticleRow>(sql, params);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // `IN (...)` returns whatever order the table hands back, so the rank has to be
    // put back deliberately: the best answer to a support question arriving third is
    // a knowledge base people stop trusting.
    const ordered = hits
      .map((h, i) => {
        const row = byId.get(h.id);
        return row ? { ...row, snippet: row.body.slice(0, 240), rank: i } : undefined;
      })
      .filter((r): r is KbArticleRow & { snippet: string; rank: number } => r !== undefined);

    return {
      results: ordered.slice(0, limit),
      limit,
      capped: ordered.length > limit || hits.length === fetch,
    };
  },

  // --- Contacts ------------------------------------------------------------

  'ticket0/list-contacts': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.contactRead));
    return ctx.page<ContactRow>('contact', input);
  },

  // --- The inbox -----------------------------------------------------------

  'ticket0/list-conversations': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    // Only the filters actually asked for: an undefined column must not become a
    // `WHERE state IS NULL` that quietly returns nothing.
    const filters: Record<string, unknown> = {};
    for (const key of ['state', 'assignee', 'channel', 'priority'] as const) {
      if (input[key] !== undefined) filters[key] = input[key];
    }
    return ctx.page<ConversationRow>('conversation', {
      ...input,
      filters,
      total: true,
    }) as CountedPage<ConversationRow>;
  },

  'ticket0/get-conversation': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    return conversationOrThrow(ctx, input.conversationId);
  },

  'ticket0/widget-session': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    conversationOrThrow(ctx, input.conversationId);
    // Named columns, and `token_hash` is not among them: this is the one read of the
    // session table a human can reach, and the hash is the one thing it must not say.
    const session =
      ctx.sql.query<Omit<SessionRow, 'token_hash'>>(
        `SELECT id, conversation_id, contact_id, origin, started_at, last_seen_at,
                user_agent, language, browser, browser_version, os, os_version, device,
                country, region, city, timezone
           FROM ticket0_widget_sessions
          WHERE conversation_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
        [input.conversationId],
      )[0] ?? null;
    return { session };
  },

  /**
   * The rating, read by the people it is about.
   *
   * Null rather than a throw for an unrated conversation: not being rated is the
   * ordinary case, and the rail simply shows no card.
   */
  'ticket0/get-csat': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    conversationOrThrow(ctx, input.conversationId);
    const csat =
      ctx.sql.query<CsatRow>(
        'SELECT conversation_id, score, comment, submitted_at FROM ticket0_csat WHERE conversation_id = ?',
        [input.conversationId],
      )[0] ?? null;
    return { csat };
  },

  'ticket0/list-messages': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    conversationOrThrow(ctx, input.conversationId);
    // The route already narrows by conversation, so the filter is supplied rather
    // than read off the input - a caller cannot widen it to another conversation.
    const page = ctx.page<MessageRow>('message', {
      ...input,
      filters: { conversation_id: input.conversationId },
      total: true,
    }) as CountedPage<MessageRow>;
    return { ...page, entries: withCitations(ctx, page.entries) };
  },

  'ticket0/post-note': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationDraft, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/post-note');
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'agent',
      authorPrincipal: String(ctx.principal),
      visibility: 'internal',
      bodyText: input.body,
    });
    touch(ctx, conversation.id);
    if (conversation.assignee) notify(ctx, conversation.assignee, 'mentioned', conversation.id);
    ctx.emit(messageEvent(row, 'ticket0.note-posted'));
    return row;
  },

  /**
   * The operation the whole assistant design turns on.
   *
   * Nothing in this body knows whether the caller is a human or the assistant, and
   * that is the point: the check above is the entire difference between a desk where
   * the AI answers customers and one where it drafts for review.
   */
  'ticket0/post-public-reply': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationReplyPublic, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/post-public-reply');

    const profile = ctx.sql.query<AgentProfileRow>(
      'SELECT * FROM ticket0_agent_profiles WHERE principal = ?',
      [String(ctx.principal)],
    )[0];
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: profile?.display_name === ASSISTANT_NAME ? 'assistant' : 'agent',
      authorPrincipal: String(ctx.principal),
      visibility: 'public',
      bodyText: input.body,
      bodyHtml: input.bodyHtml ?? null,
      citedArticleIds: input.citedArticleIds,
    });
    if (!conversation.first_public_reply_at) {
      ctx.sql.exec('UPDATE ticket0_conversations SET first_public_reply_at = ? WHERE id = ?', [
        ctx.now(),
        conversation.id,
      ]);
    }
    settle(ctx, conversation, next);

    // Ids only: the body is erasable, so it cannot ride an immutable event. The relay
    // comes back for it at send time through `ticket0/read-outbound`.
    ctx.emit(messageEvent(row, 'ticket0.reply-requested'));
    return row;
  },

  'ticket0/assign': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    // Before the write, not after: an assignee nobody can resolve is a queue entry
    // that never gets worked and a notification nobody receives.
    //
    // `!== null` rather than truthiness, because `''` is a string the schema accepts
    // and truthiness would wave it through — and an empty assignee is the exact
    // failure this check exists for: not null, so the row reads as assigned, and not
    // a person, so nobody is told and nobody works it.
    if (input.assignee !== null) staffOrThrow(ctx, input.assignee);
    const next = step(conversation, 'ticket0/assign');
    ctx.sql.exec('UPDATE ticket0_conversations SET assignee = ? WHERE id = ?', [
      input.assignee,
      conversation.id,
    ]);
    const row = settle(ctx, conversation, next);
    if (input.assignee) notify(ctx, input.assignee, 'assigned', conversation.id);
    ctx.emit({
      type: 'ticket0.conversation-assigned',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, assignee: row.assignee, state: row.state },
    });
    return row;
  },

  'ticket0/set-priority': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/set-priority');
    ctx.sql.exec('UPDATE ticket0_conversations SET priority = ? WHERE id = ?', [
      input.priority,
      conversation.id,
    ]);
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-priority-set',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, priority: row.priority, state: row.state },
    });
    return row;
  },

  'ticket0/snooze': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/snooze');
    ctx.sql.exec('UPDATE ticket0_conversations SET snoozed_until = ? WHERE id = ?', [
      input.until,
      conversation.id,
    ]);
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-snoozed',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, snoozed_until: row.snoozed_until },
    });
    return row;
  },

  'ticket0/wake': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/wake');
    ctx.sql.exec('UPDATE ticket0_conversations SET snoozed_until = NULL WHERE id = ?', [
      conversation.id,
    ]);
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-woke',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, state: row.state },
    });
    return row;
  },

  /**
   * The timer behind `snooze` — the schedule's only caller, never a route.
   *
   * It does exactly what `ticket0/wake` does, per conversation, and it does it
   * through the same declared edge: `step()` is what says a snoozed conversation may
   * become open, so a sweep cannot move one the machine would refuse. The event is
   * the same too, so nothing downstream has to know which door a conversation came
   * back through.
   *
   * Capped, and ordered by when the snooze lapsed. The cap is not a limit on how many
   * conversations may wake — the schedule fires again — it is a bound on how much one
   * transaction does, so a desk that snoozed ten thousand conversations to the same
   * minute wakes them in batches instead of holding the scope open.
   */
  'ticket0/wake-snoozed': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationAssign));
    const due = ctx.sql.query<ConversationRow>(
      `SELECT * FROM ticket0_conversations
        WHERE state = 'snoozed'
          AND snoozed_until GLOB ?
          AND snoozed_until <= ?
        ORDER BY snoozed_until LIMIT ?`,
      [CANONICAL_INSTANT, ctx.now(), WAKE_BATCH],
    );
    for (const conversation of due) {
      const next = step(conversation, 'ticket0/wake-snoozed');
      ctx.sql.exec('UPDATE ticket0_conversations SET snoozed_until = NULL WHERE id = ?', [
        conversation.id,
      ]);
      const row = settle(ctx, conversation, next);
      ctx.emit({
        type: 'ticket0.conversation-woke',
        schemaVersion: 1,
        entity: conversationRef(row.id),
        piiClass: 'none',
        payload: { id: row.id, state: row.state },
      });
      // Whoever is holding it. An unassigned conversation is nobody's to be told
      // about — it is back in the inbox, which is where an unassigned conversation
      // is looked for anyway.
      if (row.assignee) notify(ctx, row.assignee, 'snooze-woke', row.id);
    }
    return { woke: due.length };
  },

  /**
   * Resolve.
   *
   * The lifecycle says which states admit this. The other half of the rule - that a
   * conversation may not be resolved before the customer has heard anything - is a
   * CONDITION, which an edge deliberately cannot carry, so it lives here.
   */
  'ticket0/resolve': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationResolve, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/resolve');
    if (!conversation.first_public_reply_at) {
      // `conflict`, not `precondition_failed`: this is a refusal about the state the
      // conversation is in, exactly like the lifecycle's own. A sibling guard
      // answering 412 where the declared machine answers 409 would make the status a
      // fact about which line of code refused rather than about what was refused.
      throw substratError('conflict', 'nothing has been sent to the customer yet - reply before resolving', {
        reason: 'no_public_reply',
      });
    }
    ctx.sql.exec('UPDATE ticket0_conversations SET resolved_at = ? WHERE id = ?', [
      ctx.now(),
      conversation.id,
    ]);
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-resolved',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, resolved_at: row.resolved_at, contact_id: row.contact_id },
    });
    return row;
  },

  'ticket0/close': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationResolve, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/close');
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-closed',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id },
    });
    return row;
  },

  'ticket0/merge': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationMerge, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/merge');
    if (input.intoConversationId === conversation.id)
      throw substratError('validation_failed', 'a conversation cannot be merged into itself');
    const survivor = conversationOrThrow(ctx, input.intoConversationId);
    // Both ends, deliberately: merging is a read of the survivor as much as a write
    // of the loser, and one check would let a caller fold a conversation into one
    // they cannot see.
    assertAllowed(await ctx.check(T0_PERM.conversationMerge, conversationRef(survivor.id)));

    /**
     * Same person, or not at all.
     *
     * A widget session names a conversation, and the merge below repoints it at the
     * survivor — so folding one contact's conversation into another's would hand the
     * first contact's session token a thread belonging to the second. `widget-thread`
     * would then serve it, because the token is exactly the capability it checks.
     *
     * Merging two conversations from the same person is the real case (they wrote in
     * twice); merging across people is the one that leaks, and there is no version of
     * it worth supporting.
     */
    if (conversation.contact_id !== survivor.contact_id) {
      throw substratError(
        'conflict',
        'these conversations belong to different contacts — merging them would give one ' +
          "person's session the other's thread",
        { reason: 'different_contacts' },
      );
    }

    ctx.sql.exec('UPDATE ticket0_conversations SET merged_into = ?, updated_at = ? WHERE id = ?', [
      survivor.id,
      ctx.now(),
      conversation.id,
    ]);
    /**
     * Everything that hangs off the loser moves with it.
     *
     * Repointing only the messages left the rest behind, and two of them break
     * visibly: a `widget_session` still naming the loser resolves to a conversation
     * whose messages have gone, so the visitor's widget empties itself; and an
     * `ai_turn` left behind takes the assistant's draft card off the survivor, which
     * is where the human is now looking.
     */
    for (const table of ['ticket0_messages', 'ticket0_ai_turns', 'ticket0_widget_sessions']) {
      ctx.sql.exec(`UPDATE ${table} SET conversation_id = ? WHERE conversation_id = ?`, [
        survivor.id,
        conversation.id,
      ]);
    }
    // Notifications point at whichever conversation a person should open, which is
    // now the survivor.
    ctx.sql.exec(
      'UPDATE ticket0_notifications SET conversation_id = ? WHERE conversation_id = ?',
      [survivor.id, conversation.id],
    );
    // A tag is keyed by (conversation_id, tag), so a blind move collides whenever
    // both conversations carry the same one. Move what does not collide.
    ctx.sql.exec(
      `UPDATE ticket0_conversation_tags SET conversation_id = ? WHERE conversation_id = ?
         AND tag NOT IN (SELECT tag FROM ticket0_conversation_tags WHERE conversation_id = ?)`,
      [survivor.id, conversation.id, survivor.id],
    );
    ctx.sql.exec('DELETE FROM ticket0_conversation_tags WHERE conversation_id = ?', [
      conversation.id,
    ]);
    /**
     * `csat` deliberately stays. It is keyed by the conversation and it is a rating OF
     * that conversation — moving it would either collide with the survivor's own
     * rating or silently reattribute one exchange's score to another.
     */

    // The permission walk follows declared edges, so the moved rows need one to the
    // survivor. `parents` is an allowlist the kernel accumulates, so this widens
    // rather than rewrites — and both conversations were reachable by the caller,
    // which is what `merge` checked on each of them.
    const survivorRef = conversationRef(survivor.id);
    for (const [table, entityType] of [
      ['ticket0_messages', 'message'],
      ['ticket0_ai_turns', 'aiTurn'],
      ['ticket0_widget_sessions', 'widgetSession'],
    ] as const) {
      for (const row of ctx.sql.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE conversation_id = ?`,
        [survivor.id],
      )) {
        ctx.link({ entityType, entityId: row.id }, survivorRef);
      }
    }
    const row = conversationOrThrow(ctx, conversation.id);
    ctx.emit({
      type: 'ticket0.conversation-merged',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, merged_into: row.merged_into },
    });
    return row;
  },

  'ticket0/tag-conversation': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/tag-conversation');
    const existing = ctx.sql.query<TagRow>(
      'SELECT * FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?',
      [conversation.id, input.tag],
    )[0];
    // Already tagged is not a second tagging, so it emits nothing - a consumer
    // counting this event is counting the tag going ON, once.
    if (existing) return existing;
    ctx.sql.exec(
      'INSERT INTO ticket0_conversation_tags (conversation_id, tag, created_at) VALUES (?, ?, ?)',
      [conversation.id, input.tag, ctx.now()],
    );
    const row = ctx.sql.query<TagRow>(
      'SELECT * FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?',
      [conversation.id, input.tag],
    )[0]!;
    ctx.emit({
      type: 'ticket0.conversation-tagged',
      schemaVersion: 1,
      // About the conversation. A tag is keyed by both its columns and cannot be
      // pointed at, and "this conversation was tagged" is the fact anyway.
      entity: conversationRef(row.conversation_id),
      piiClass: 'none',
      payload: { conversation_id: row.conversation_id, tag: row.tag, created_at: row.created_at },
    });
    return row;
  },

  /**
   * Take a tag off, and answer whether there was one.
   *
   * A DELETE of one composite-keyed row, so `removed` is the whole return value that
   * matters: untagging what was never tagged is a no-op that says so rather than a
   * `not_found` every caller would have to catch to render a chip disappearing.
   */
  'ticket0/untag-conversation': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/untag-conversation');
    const existing = ctx.sql.query<TagRow>(
      'SELECT conversation_id, tag, created_at FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?',
      [conversation.id, input.tag],
    )[0];
    // Nothing was removed, so nothing is announced - the mirror of tagging twice,
    // which announces once. A consumer counting this event counts tags coming OFF.
    if (!existing) return { conversation_id: conversation.id, tag: input.tag, removed: false };
    ctx.sql.exec('DELETE FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?', [
      conversation.id,
      input.tag,
    ]);
    ctx.emit({
      type: 'ticket0.conversation-untagged',
      schemaVersion: 1,
      entity: conversationRef(conversation.id),
      piiClass: 'none',
      payload: { conversation_id: conversation.id, tag: input.tag },
    });
    return { conversation_id: conversation.id, tag: input.tag, removed: true };
  },

  /**
   * The tags on one conversation, sorted by tag so the rail renders the same chips
   * in the same order on every load. Unpaged: a conversation carries a handful.
   */
  'ticket0/list-conversation-tags': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    conversationOrThrow(ctx, input.conversationId);
    const tags = ctx.sql.query<TagRow>(
      `SELECT conversation_id, tag, created_at FROM ticket0_conversation_tags
        WHERE conversation_id = ? ORDER BY tag`,
      [input.conversationId],
    );
    return { tags };
  },

  /**
   * The vocabulary, which is whatever has been typed - there is no tag table anyone
   * curates. Most-used first, so autocomplete offers the tag people actually mean
   * and a typo used once sorts last.
   */
  'ticket0/list-tags': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    const tags = ctx.sql.query<{ tag: string; count: number }>(
      `SELECT tag, COUNT(*) AS count FROM ticket0_conversation_tags
        GROUP BY tag ORDER BY count DESC, tag`,
      [],
    );
    return { tags };
  },

  // --- Saved replies -------------------------------------------------------

  'ticket0/list-saved-replies': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    return ctx.page<SavedReplyRow>('savedReply', input);
  },

  'ticket0/create-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    const existing = ctx.sql.query<SavedReplyRow>(
      'SELECT * FROM ticket0_saved_replies WHERE title = ?',
      [input.title],
    )[0];
    if (existing) return existing;
    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, input.title, input.body, String(ctx.principal), ctx.now()],
    );
    const row = ctx.sql.query<SavedReplyRow>('SELECT * FROM ticket0_saved_replies WHERE id = ?', [
      id,
    ])[0]!;
    ctx.emit({
      type: 'ticket0.saved-reply-created',
      schemaVersion: 1,
      entity: { entityType: 'savedReply', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        title: row.title,
        body: row.body,
        created_by: row.created_by,
        created_at: row.created_at,
      },
    });
    return row;
  },

  // --- The assistant -------------------------------------------------------

  /**
   * The message and the meter entries, written in one transaction.
   *
   * `turnId` is the ledger's dedupe key, so a retried turn returns the existing entry
   * rather than billing twice - and because both writes are in this transaction, a
   * turn cannot be charged for without being recorded, or recorded without being
   * charged for.
   *
   * The permission is `draft`, always. Whether the answer then goes out is a separate
   * act with a separate permission, which is the entire design.
   */
  'ticket0/record-answer': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationDraft, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/record-answer');

    // Idempotent at this end too: the ledger dedupes by key, and so must the side
    // table hanging off it, or a replay writes a second turn against one entry.
    const existing = ctx.sql.query<AiTurnRow>('SELECT * FROM ticket0_ai_turns WHERE id = ?', [
      input.turnId,
    ])[0];
    if (existing) return existing;

    ensureMeters(ctx);
    const subject = conversationRef(conversation.id);
    const inputEntry = recordUsage(ctx, {
      meter: METERS.inputTokens,
      qty: String(input.inputTokens),
      subject,
      dedupeKey: `${input.turnId}:in`,
    });
    recordUsage(ctx, {
      meter: METERS.outputTokens,
      qty: String(input.outputTokens),
      subject,
      dedupeKey: `${input.turnId}:out`,
    });
    // The platform's copy (#1054): the same line the model host produced, handed to the
    // platform ledger as an intent in THIS transaction — so a turn cannot be metered here
    // without being reported there, and the early return above keeps a replay from
    // reporting it twice. The drain refuses a line attributed to any other scope.
    if (input.usage) ctx.requestPlatform({ kind: MODEL_USAGE_KIND, payload: input.usage });

    // The drafted answer is an INTERNAL message. Sending it is `post-public-reply`,
    // and that is a different permission on purpose.
    const message = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'assistant',
      authorPrincipal: String(ctx.principal),
      visibility: 'internal',
      bodyText: input.body,
    });

    ctx.sql.exec(
      `INSERT INTO ticket0_ai_turns
         (id, conversation_id, message_id, model, input_tokens, output_tokens,
          cited_article_ids, confidence, outcome, meter_entry_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.turnId,
        conversation.id,
        message.id,
        input.model,
        input.inputTokens,
        input.outputTokens,
        JSON.stringify(input.citedArticleIds),
        input.confidence ?? null,
        input.outcome,
        inputEntry.entry.id,
        // The reason belongs to a failure. A caller that sends one on a drafted turn
        // is confused, and keeping it would make the card say two things at once.
        input.outcome === 'failed' ? (input.error ?? null) : null,
        ctx.now(),
      ],
    );
    ctx.link({ entityType: 'aiTurn', entityId: input.turnId }, conversationRef(conversation.id));
    touch(ctx, conversation.id);

    const row = ctx.sql.query<AiTurnRow>('SELECT * FROM ticket0_ai_turns WHERE id = ?', [
      input.turnId,
    ])[0]!;
    // Both are the assistant handing the conversation to a person — one because the
    // documentation had nothing, one because the assistant itself did not run.
    if ((input.outcome === 'escalated' || input.outcome === 'failed') && conversation.assignee)
      notify(ctx, conversation.assignee, 'escalated', conversation.id);
    ctx.emit({
      type: 'ticket0.answer-recorded',
      schemaVersion: 1,
      entity: { entityType: 'aiTurn', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        conversation_id: row.conversation_id,
        model: row.model,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        outcome: row.outcome,
      },
    });
    return row;
  },

  /**
   * The assistant never got to run, and the widget — the principal that accepted the
   * message — writes that down. Same row shape as `record-answer`'s failure, minus
   * the meter entries: nothing ran, so there is nothing to charge for, and a turn
   * with no cost has no entry to hang off.
   *
   * Idempotent on `turnId` for the same reason `record-answer` is: a host that retries
   * the job after fixing the assistant finds the turn already there. That is the
   * intended reading — the message got its answer, and it was "no".
   */
  'ticket0/record-assistant-failure': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationWidget, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/record-assistant-failure');

    const existing = ctx.sql.query<AiTurnRow>('SELECT * FROM ticket0_ai_turns WHERE id = ?', [
      input.turnId,
    ])[0];
    if (existing) return existing;

    // A system note, INTERNAL: the customer's thread never carries it (`publicThread`
    // filters on visibility), and the desk draws the failure card where the note sits.
    const message = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'system',
      authorPrincipal: String(ctx.principal),
      visibility: 'internal',
      bodyText: 'The assistant could not act on this message. It is waiting for a person.',
    });
    ctx.sql.exec(
      `INSERT INTO ticket0_ai_turns
         (id, conversation_id, message_id, model, input_tokens, output_tokens,
          cited_article_ids, confidence, outcome, meter_entry_id, error, created_at)
       VALUES (?, ?, ?, ?, 0, 0, '[]', NULL, 'failed', NULL, ?, ?)`,
      [input.turnId, conversation.id, message.id, input.model, input.error, ctx.now()],
    );
    ctx.link({ entityType: 'aiTurn', entityId: input.turnId }, conversationRef(conversation.id));
    touch(ctx, conversation.id);

    const row = ctx.sql.query<AiTurnRow>('SELECT * FROM ticket0_ai_turns WHERE id = ?', [
      input.turnId,
    ])[0]!;
    if (conversation.assignee) notify(ctx, conversation.assignee, 'escalated', conversation.id);
    ctx.emit({
      type: 'ticket0.assistant-failed',
      schemaVersion: 1,
      entity: { entityType: 'aiTurn', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        conversation_id: row.conversation_id,
        model: row.model,
        error: row.error,
      },
    });
    return row;
  },

  /**
   * Is the assistant working? Counted over the last day, and the newest failures by
   * name. Both tables are this module's own, so the join is not a boundary crossing.
   */
  'ticket0/assistant-health': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    const since = new Date(new Date(ctx.now()).getTime() - HEALTH_WINDOW_MS).toISOString();
    const counts = ctx.sql.query<{ turns: number; failed: number | null }>(
      `SELECT COUNT(*) AS turns,
              SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM ticket0_ai_turns
        WHERE created_at >= ?`,
      [since],
    )[0];
    const recent = ctx.sql.query<{
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      error: string | null;
      created_at: string;
    }>(
      `SELECT t.id, t.conversation_id, c.subject, t.model, t.error, t.created_at
         FROM ticket0_ai_turns t
         JOIN ticket0_conversations c ON c.id = t.conversation_id
        WHERE t.outcome = 'failed'
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`,
      [HEALTH_RECENT],
    );
    return {
      since,
      turns: counts?.turns ?? 0,
      failed: Number(counts?.failed ?? 0),
      recent,
    };
  },

  /**
   * What the assistant produced on this conversation — for the human deciding whether
   * to send it, and carrying no token counts. Cost has one door and this is not it.
   */
  'ticket0/list-turns': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    conversationOrThrow(ctx, input.conversationId);
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const rows = input.cursor
      ? ctx.sql.query<AiTurnRow>(
          'SELECT * FROM ticket0_ai_turns WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?',
          [input.conversationId, input.cursor, limit],
        )
      : ctx.sql.query<AiTurnRow>(
          'SELECT * FROM ticket0_ai_turns WHERE conversation_id = ? ORDER BY id LIMIT ?',
          [input.conversationId, limit],
        );

    // One query for the whole page's citations rather than one per turn: a
    // conversation with a dozen turns should not be a dozen round trips.
    const ids = [...new Set(rows.flatMap((r) => JSON.parse(r.cited_article_ids) as string[]))];
    const articles = ids.length
      ? ctx.sql.query<KbArticleRow>(
          `SELECT * FROM ticket0_kb_articles WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        )
      : [];
    const byId = new Map(articles.map((a) => [a.id, a]));

    return pageOf(
      rows.map((r) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        message_id: r.message_id,
        model: r.model,
        confidence: r.confidence,
        outcome: r.outcome,
        error: r.error,
        created_at: r.created_at,
        citations: (JSON.parse(r.cited_article_ids) as string[])
          .map((id) => byId.get(id))
          .filter((a): a is KbArticleRow => a !== undefined)
          .map((a) => ({ id: a.id, title: a.title, url: a.url, headingPath: a.heading_path })),
      })),
      limit,
      (row) => row.id,
    );
  },

  // --- The money -----------------------------------------------------------

  'ticket0/usage-summary': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.usageRead));
    const to = input.to ?? ctx.now();
    const from = input.from ?? '1970-01-01T00:00:00.000Z';
    ensureMeters(ctx);
    const subject = input.conversationId ? conversationRef(input.conversationId) : undefined;

    let total = '0';
    let currency = 'EUR';
    const lines = Object.values(METERS).map((meterKey) => {
      // Narrowed to one conversation, the engine's aggregate is the wrong tool - it
      // sums a whole meter - so the entries carrying that subject are summed instead.
      // Same ledger, same rows, one filter narrower.
      const agg = subject
        ? sumEntries(ctx, meterKey, subject, from, to)
        : usageTotal(ctx, { meter: meterKey, from, to });
      const qty = agg?.qty ?? '0';
      const entryCount = agg?.entryCount ?? 0;
      const rate = rateFor(ctx, meterKey, to);
      const unitPrice = rate?.unit_price ?? '0';
      if (rate) currency = rate.currency;
      // Decimal strings through the contracts helpers, never floats - a token price
      // has more decimal places than a float has patience for.
      const amount = mulDecimal(qty, unitPrice);
      total = addDecimal(total, amount);
      return { meterKey: String(meterKey), unit: 'token', qty, unitPrice, amount, entryCount };
    });

    return { from, to, currency, total, lines };
  },

  'ticket0/set-usage-rate': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.usageRead));
    // Re-pricing is an append keyed by the date it takes effect, so a closed month
    // stays reproducible at the price it was closed under.
    ctx.sql.exec(
      `INSERT INTO ticket0_usage_rates (meter_key, unit_price, currency, effective_from)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (meter_key, effective_from)
       DO UPDATE SET unit_price = excluded.unit_price, currency = excluded.currency`,
      [input.meterKey, input.unitPrice, input.currency, input.effectiveFrom],
    );
    return ctx.sql.query<UsageRateRow>(
      'SELECT * FROM ticket0_usage_rates WHERE meter_key = ? AND effective_from = ?',
      [input.meterKey, input.effectiveFrom],
    )[0]!;
  },

  'ticket0/close-usage-period': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.usageRead));
    ensureMeters(ctx);
    // The engine's own function, in this transaction. It freezes the window into
    // immutable lines and advances the close horizon, so no entry can land behind it
    // afterwards.
    const closed = closePeriod(ctx, { from: input.from, to: input.to });
    return {
      periodId: closed.period.id,
      from: closed.period.from,
      to: closed.period.to,
      lines: closed.lines.length,
    };
  },

  // --- The desk, measured --------------------------------------------------

  'ticket0/desk-metrics': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.usageRead));
    const now = ctx.now();
    const to = input.to ?? now;
    const from = input.from ?? shiftDays(to, -DESK_METRICS_WINDOW_DAYS);

    // Volume, per channel and in total, in one pass.
    //
    // A merged conversation is not a second arrival — it is the same customer's thread
    // wearing another id — so it is excluded from `opened`. `resolved` counts a
    // `resolved_at` wherever it is, merged or not: a thread somebody resolved and later
    // folded into another really was resolved, and dropping it would move a past
    // window's number every time an old thread was tidied up.
    //
    // Every channel the desk has ever used gets a row, including one that saw nothing in
    // this window. That is deliberate: a report whose rows appear and vanish with the
    // range is one nobody can compare two ranges of.
    const channels = ctx.sql.query<{ channel: 'widget' | 'email'; opened: number; resolved: number }>(
      `SELECT channel,
              SUM(CASE WHEN created_at >= ? AND created_at <= ? AND merged_into IS NULL
                       THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at <= ?
                       THEN 1 ELSE 0 END) AS resolved
         FROM ticket0_conversations
        GROUP BY channel
        ORDER BY channel`,
      [from, to, from, to],
    ).map((r) => ({ channel: r.channel, opened: Number(r.opened), resolved: Number(r.resolved) }));

    // Speed. Both are measured over the conversations whose EVENT lands in the window —
    // a first reply that happened this week counts this week, whenever the conversation
    // arrived. Anchoring on `created_at` instead would make the current window's median
    // move every time an old thread was finally answered.
    const firstResponse = percentiles(
      ctx,
      `SELECT ${elapsed('created_at', 'first_public_reply_at')} AS seconds
         FROM ticket0_conversations
        WHERE first_public_reply_at IS NOT NULL
          AND first_public_reply_at >= ? AND first_public_reply_at <= ?`,
      [from, to],
    );
    const resolution = percentiles(
      ctx,
      `SELECT ${elapsed('created_at', 'resolved_at')} AS seconds
         FROM ticket0_conversations
        WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at <= ?`,
      [from, to],
    );

    // Backlog is a fact about NOW and deliberately ignores the window: what is waiting
    // does not care which dates the reader picked. `new` counts as open — nobody has
    // touched it, which is the worst kind of open there is.
    const backlogCounts = ctx.sql.query<{ open: number; snoozed: number; unassigned: number }>(
      `SELECT SUM(CASE WHEN state IN ('new', 'open') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN state = 'snoozed' THEN 1 ELSE 0 END) AS snoozed,
              SUM(CASE WHEN state IN ('new', 'open') AND assignee IS NULL THEN 1 ELSE 0 END)
                AS unassigned
         FROM ticket0_conversations
        WHERE merged_into IS NULL`,
    )[0];
    // "Oldest untouched" is by `updated_at`, not `created_at`: a week-old thread somebody
    // replied to an hour ago is not the one going stale.
    const oldest = ctx.sql.query<{ id: string; seconds: number }>(
      `SELECT id, ${elapsed('updated_at', '?')} AS seconds
         FROM ticket0_conversations
        WHERE state IN ('new', 'open') AND merged_into IS NULL
        ORDER BY updated_at ASC, id ASC
        LIMIT 1`,
      [now],
    )[0];

    const agents = deskAgents(ctx, from, to);

    const csat = ctx.sql.query<{ responses: number; total: number | null }>(
      `SELECT COUNT(*) AS responses, SUM(score) AS total
         FROM ticket0_csat
        WHERE submitted_at >= ? AND submitted_at <= ?`,
      [from, to],
    )[0];
    const responses = Number(csat?.responses ?? 0);

    // The assistant, which is the reason this operation exists. Outcomes and tokens come
    // off the same rows, so the rate and the bill it produced cannot disagree.
    const turns = ctx.sql.query<{
      turns: number;
      answered: number | null;
      drafted: number | null;
      escalated: number | null;
      failed: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }>(
      `SELECT COUNT(*) AS turns,
              SUM(CASE WHEN outcome = 'answered' THEN 1 ELSE 0 END) AS answered,
              SUM(CASE WHEN outcome = 'drafted' THEN 1 ELSE 0 END) AS drafted,
              SUM(CASE WHEN outcome = 'escalated' THEN 1 ELSE 0 END) AS escalated,
              SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens
         FROM ticket0_ai_turns
        WHERE created_at >= ? AND created_at <= ?`,
      [from, to],
    )[0];
    const turnCount = Number(turns?.turns ?? 0);
    const share = (n: number) => (turnCount === 0 ? null : round(n / turnCount, 4));

    // Priced the way `usage-summary` prices, from the desk's own rate card at the end of
    // the window — the same door, the same numbers. Decimal strings throughout: a token
    // price has more places than a float has patience for, and dividing by a count does
    // not change that.
    const inputRate = rateFor(ctx, METERS.inputTokens, to);
    const outputRate = rateFor(ctx, METERS.outputTokens, to);
    const cost = addDecimal(
      mulDecimal(String(Number(turns?.input_tokens ?? 0)), inputRate?.unit_price ?? '0'),
      mulDecimal(String(Number(turns?.output_tokens ?? 0)), outputRate?.unit_price ?? '0'),
    );
    const resolved = channels.reduce((sum, c) => sum + c.resolved, 0);

    return {
      from,
      to,
      volume: {
        opened: channels.reduce((sum, c) => sum + c.opened, 0),
        resolved,
        byChannel: channels,
      },
      firstResponse,
      resolution,
      backlog: {
        open: Number(backlogCounts?.open ?? 0),
        snoozed: Number(backlogCounts?.snoozed ?? 0),
        unassigned: Number(backlogCounts?.unassigned ?? 0),
        oldestUntouchedId: oldest?.id ?? null,
        oldestUntouchedAgeSeconds: oldest ? Number(oldest.seconds) : null,
      },
      agents,
      csat: {
        responses,
        average: responses === 0 ? null : round(Number(csat?.total ?? 0) / responses, 2),
      },
      assistant: {
        turns: turnCount,
        answered: Number(turns?.answered ?? 0),
        drafted: Number(turns?.drafted ?? 0),
        escalated: Number(turns?.escalated ?? 0),
        failed: Number(turns?.failed ?? 0),
        deflectionRate: share(Number(turns?.answered ?? 0)),
        escalationRate: share(Number(turns?.escalated ?? 0)),
        failureRate: share(Number(turns?.failed ?? 0)),
        currency: inputRate?.currency ?? outputRate?.currency ?? 'EUR',
        cost,
        costPerResolved: resolved === 0 ? null : divDecimal(cost, resolved),
      },
    };
  },

  // --- The email relay -----------------------------------------------------

  'ticket0/ingest-message': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));

    // Idempotent on the provider's message id: mail providers redeliver, and a
    // redelivered message must not become a second message in the thread.
    const seen = ctx.sql.query<MessageRow>(
      'SELECT * FROM ticket0_messages WHERE email_message_id = ?',
      [input.emailMessageId],
    )[0];
    if (seen) return seen;

    const contact =
      contactByEmail(ctx, input.contactEmail) ??
      createContact(ctx, {
        email: input.contactEmail,
        display_name: input.contactName ?? null,
        verified_at: ctx.now(),
      });

    const conversation = input.conversationId
      ? conversationOrThrow(ctx, input.conversationId)
      : openConversation(ctx, contact, 'email', input.subject);

    const next = step(conversation, 'ticket0/ingest-message');
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'contact',
      authorPrincipal: null,
      visibility: 'public',
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      emailMessageId: input.emailMessageId,
      emailInReplyTo: input.emailInReplyTo ?? null,
    });
    settle(ctx, conversation, next);
    if (conversation.assignee) notify(ctx, conversation.assignee, 'replied', conversation.id);
    ctx.emit(messageEvent(row, 'ticket0.message-ingested'));
    return row;
  },

  'ticket0/read-outbound': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));
    const message = messageOrThrow(ctx, input.messageId);
    if (message.visibility !== 'public')
      throw substratError('permission_denied', 'internal notes are never sent to a customer');
    const conversation = conversationOrThrow(ctx, message.conversation_id);
    const contact = ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE id = ?', [
      conversation.contact_id,
    ])[0];
    const author = message.author_principal
      ? ctx.sql.query<AgentProfileRow>('SELECT * FROM ticket0_agent_profiles WHERE principal = ?', [
          message.author_principal,
        ])[0]
      : undefined;

    return {
      messageId: message.id,
      conversationId: conversation.id,
      subject: conversation.subject,
      toEmail: contact?.email ?? null,
      fromAddress: desk(ctx).from_address,
      agentName: author?.display_name ?? null,
      // Gone after an erasure - which is exactly why the event carried ids only:
      // there is nothing left to send, and the send finds that out here.
      bodyText: message.body_text,
      bodyHtml: message.body_html,
      emailInReplyTo: message.email_in_reply_to,
    };
  },

  'ticket0/record-delivery': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));
    const message = messageOrThrow(ctx, input.messageId);
    ctx.sql.exec('UPDATE ticket0_messages SET delivered_at = ?, email_message_id = ? WHERE id = ?', [
      ctx.now(),
      input.emailMessageId,
      message.id,
    ]);
    const row = messageOrThrow(ctx, message.id);
    ctx.emit({
      type: 'ticket0.message-delivered',
      schemaVersion: 1,
      entity: { entityType: 'message', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, conversation_id: row.conversation_id, delivered_at: row.delivered_at },
    });
    return row;
  },

  // --- The widget ----------------------------------------------------------

  /**
   * The embedding allowlist, for the surface that has to answer a preflight.
   *
   * The desk's own list and nothing else — no seeded origins, no deployment default.
   * `widget-start` refuses an unlisted origin below out of the same array, so the
   * browser's answer and the operation's answer cannot disagree. They used to: the
   * dev server's CORS consulted a boot-time list while this consulted the table, so
   * an origin added through `configure-desk` passed the operation and was blocked by
   * the browser, and one removed passed the browser and was refused here.
   */
  'ticket0/widget-origins': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    return { origins: allowedOrigins(ctx) };
  },

  'ticket0/widget-start': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    const settings = desk(ctx);
    // Refused at the door, before a contact or a conversation exists.
    if (!allowedOrigins(ctx).includes(input.origin))
      throw substratError('permission_denied', `this desk is not embedded on ${input.origin}`);

    let contact: ContactRow | null;
    let verified = false;
    if (input.identity) {
      const ok = await verifyIdentity(
        settings.verification_secret,
        input.identity.externalId,
        input.identity.signature,
      );
      if (!ok) throw substratError('permission_denied', 'identity signature does not verify');
      verified = true;
      contact =
        contactByExternalId(ctx, input.identity.externalId) ??
        createContact(ctx, {
          external_id: input.identity.externalId,
          email: input.identity.email ?? null,
          display_name: input.identity.displayName ?? null,
          verified_at: ctx.now(),
        });
    } else {
      // The bottom rung: nobody, yet. An anonymous visitor's contact is made by their
      // first message (`bindOpening`), so a bubble opened and abandoned leaves no row.
      contact = null;
    }

    /**
     * No conversation, no principal, no grant — and that is the design.
     *
     * Opening the widget is not a conversation: the thread exists from the first
     * `widget-post`, which is what keeps a curl, a crawler that ran the script, or a
     * person who clicked and left out of the inbox. `contact.principal` stays null
     * until this person signs in for real, at which point the portal's grant is made
     * against a login that actually exists. A visitor in a chat bubble reaches their
     * conversation by holding the token below, which is why there is nothing here to
     * grant, revoke, or reap.
     */
    const token = `${ulid()}${ulid()}`;
    const id = ulid();
    const now = ctx.now();
    // What the transport knew about the browser, or nulls when it knew nothing. Stored
    // on the opening because it is a fact about THIS browser, not about the person, and
    // the first message carries it onto the session — the request is long gone by then.
    const client = input.client;
    ctx.sql.exec(
      `INSERT INTO ticket0_widget_openings
         (id, contact_id, origin, token_hash, started_at, last_seen_at,
          user_agent, language, browser, browser_version, os, os_version, device,
          country, region, city, timezone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        contact?.id ?? null,
        input.origin,
        await sha256(token),
        now,
        now,
        client?.userAgent ?? null,
        client?.language ?? null,
        client?.device.browser ?? null,
        client?.device.browserVersion ?? null,
        client?.device.os ?? null,
        client?.device.osVersion ?? null,
        client?.device.kind ?? null,
        client?.geo.country ?? null,
        client?.geo.region ?? null,
        client?.geo.city ?? null,
        client?.geo.timezone ?? null,
      ],
    );

    ctx.emit({
      type: 'ticket0.widget-session-started',
      schemaVersion: 2,
      entity: { entityType: 'widgetOpening', entityId: id },
      piiClass: 'none',
      // Never the token. It is the visitor's whole authority over this thread, and
      // an immutable copy of a capability cannot be revoked.
      payload: { sessionId: id, verified, origin: input.origin, startedAt: now },
    });

    return {
      sessionId: id,
      token,
      greeting: settings.greeting,
      verified,
      origin: input.origin,
      startedAt: now,
    };
  },

  'ticket0/widget-post': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    // The token decides WHICH conversation, and there is no conversation id in the
    // input for a caller to substitute one.
    const hold = await holdOrThrow(ctx, input.sessionId, input.token);
    // The first message opens the conversation; every later one finds it bound.
    const conversation =
      hold.kind === 'session' ? hold.conversation : bindOpening(ctx, hold.opening);
    const next = step(conversation, 'ticket0/widget-post');
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'contact',
      authorPrincipal: null,
      visibility: 'public',
      bodyText: input.body,
    });
    settle(ctx, conversation, next);
    if (conversation.assignee) notify(ctx, conversation.assignee, 'replied', conversation.id);
    ctx.emit(messageEvent(row, 'ticket0.message-ingested'));
    return row;
  },

  'ticket0/widget-thread': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    const hold = await holdOrThrow(ctx, input.sessionId, input.token);
    // Nothing said yet, nothing to read: an empty page, not a refusal. The widget
    // polls this before the first message too, and a 404 would make it drop the session.
    if (hold.kind === 'opening') return pageOf([], LIST_PAGE_DEFAULT, () => '');
    return publicThread(ctx, hold.conversation.id, input);
  },

  // --- The portal ----------------------------------------------------------

  /**
   * Nobody holds `conversation:read-own` scope-wide, so this is a per-row proof walk
   * rather than a `WHERE contact_id = ?`. The distinction matters: a WHERE clause is
   * a promise the author remembered to keep; the walk is one the kernel keeps.
   */
  'ticket0/my-conversations': async (ctx, input) =>
    pageVisible(
      (p) => ctx.page<ConversationRow>('conversation', p),
      input,
      async (c) => (await ctx.check(T0_PERM.conversationReadOwn, conversationRef(c.id))).allowed,
    ),

  'ticket0/my-messages': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationReadOwn, conversationRef(input.conversationId)),
    );
    conversationOrThrow(ctx, input.conversationId);
    return publicThread(ctx, input.conversationId, input);
  },

  'ticket0/submit-csat': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationReadOwn, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/submit-csat');
    const existing = ctx.sql.query<CsatRow>(
      'SELECT * FROM ticket0_csat WHERE conversation_id = ?',
      [conversation.id],
    )[0];
    if (existing) throw substratError('conflict', 'this conversation has already been rated');
    ctx.sql.exec(
      'INSERT INTO ticket0_csat (conversation_id, score, comment, submitted_at) VALUES (?, ?, ?, ?)',
      [conversation.id, input.score, input.comment ?? null, ctx.now()],
    );
    const row = ctx.sql.query<CsatRow>('SELECT * FROM ticket0_csat WHERE conversation_id = ?', [
      conversation.id,
    ])[0]!;
    ctx.emit({
      type: 'ticket0.csat-submitted',
      schemaVersion: 1,
      entity: conversationRef(row.conversation_id),
      piiClass: 'none',
      // The comment is erasable and cannot ride; a score identifies nobody.
      payload: { conversation_id: row.conversation_id, score: row.score },
    });
    return row;
  },

  // --- Notifications -------------------------------------------------------

  'ticket0/my-notifications': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.notificationReadOwn));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    // Scoped to the caller's OWN principal, taken from ctx and never from input.
    const rows = input.cursor
      ? ctx.sql.query<NotificationRow>(
          'SELECT * FROM ticket0_notifications WHERE principal = ? AND id > ? ORDER BY id LIMIT ?',
          [String(ctx.principal), input.cursor, limit],
        )
      : ctx.sql.query<NotificationRow>(
          'SELECT * FROM ticket0_notifications WHERE principal = ? ORDER BY id LIMIT ?',
          [String(ctx.principal), limit],
        );
    return pageOf(rows, limit, (row) => row.id);
  },

  'ticket0/mark-notification-read': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.notificationReadOwn));
    const row = ctx.sql.query<NotificationRow>(
      'SELECT * FROM ticket0_notifications WHERE id = ? AND principal = ?',
      [input.notificationId, String(ctx.principal)],
    )[0];
    // Not-found rather than denied: a notification addressed to somebody else is not
    // a thing this caller may learn the existence of.
    if (!row) throw substratError('not_found', `notification not found: ${input.notificationId}`);
    ctx.sql.exec('UPDATE ticket0_notifications SET read_at = ? WHERE id = ?', [ctx.now(), row.id]);
    const read = ctx.sql.query<NotificationRow>(
      'SELECT * FROM ticket0_notifications WHERE id = ?',
      [row.id],
    )[0]!;
    ctx.emit({
      type: 'ticket0.notification-read',
      schemaVersion: 1,
      entity: { entityType: 'notification', entityId: read.id },
      piiClass: 'none',
      payload: {
        id: read.id,
        principal: read.principal,
        kind: read.kind,
        conversation_id: read.conversation_id,
        read_at: read.read_at,
        created_at: read.created_at,
      },
    });
    return read;
  },
} satisfies {
  // Derived by the platform, not restated here - `HandlerOutput` is what knows that
  // a `paged` declaration means the handler returns a Page of the declared entry.
  [K in keyof typeof ticket0Operations]: OperationHandler<
    HandlerInput<(typeof ticket0Operations)[K]>,
    HandlerOutput<(typeof ticket0Operations)[K]>
  >;
};

/**
 * The assistant's display name.
 *
 * It decides how a public reply is attributed, and it lives here rather than in
 * `desk_settings` because it is not a policy anyone tunes - the assistant's
 * AUTHORITY is a grant, and the only thing left is what to call it.
 */
export const ASSISTANT_NAME = 'Assistant';

/** `assistant-health` counts over this window — a day, which is how often somebody looks. */
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** And names this many of the newest failures. Enough to see a pattern; not a log. */
const HEALTH_RECENT = 10;

export const ticket0Module: ModuleRegistration = {
  manifest: ticket0Manifest,
  migrations: ticket0Migrations,
  // The host parses every invocation against the same declaration the routes and
  // the document come from, so "parse, don't trust" holds on every path in — HTTP,
  // widget, test, seed — rather than in the handlers that remembered (#953).
  operationInputs: operationInputsOf(ticket0Operations),
  operations: operations as ModuleRegistration['operations'],
};
