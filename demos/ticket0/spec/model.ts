/**
 * ticket0's model — what exists, declared once.
 *
 * The concept is approved (`spec/concept.md`); this is its entity, operation and
 * lifecycle surface, and everything downstream derives from it: the migrations,
 * the manifest, the route table, the permission registry, the API document and
 * the browser client.
 *
 * ## What this vertical composes
 *
 * `engine-metering` — by CALL. Its in-scope `recordUsage` / `closePeriod` run inside
 * this vertical's own transactions. It exports no entity registry, so nothing from it
 * appears in the `defineOperations` engine list: this vertical emits events about its
 * own entities only, and reaches the ledger through the engine's functions. An absent
 * engine registry is a fact about how the engine is composed, not an omission.
 *
 * `engine-invites` — by CALL, for staff joining a desk. Its operations are its own;
 * nothing about them is redeclared here.
 *
 * ## Two transports are declared here and do not exist yet
 *
 * `ticket0/widget-*` and `ticket0/ingest-message` are real operations that work today
 * when invoked by a test, a seed, or an authenticated caller. What is missing is not
 * the operation, it is the way in:
 *
 *   - the widget needs an anonymous, cross-origin public surface (no CORS handling
 *     exists in the vertical host or the router today);
 *   - inbound email needs webhook ingress with signature verification and replay
 *     protection.
 *
 * Both are platform work, sequenced separately (concept §3, §9). Declaring the
 * operations now is deliberate: the data model and the permission model are the same
 * either way, and discovering them later would mean a migration rather than an edit.
 */
import {
  clientContext,
  defineEntities,
  defineLifecycles,
  defineOperations,
  emitModel,
  z,
  modelUsageLine,
} from '@substrat-run/contracts';
import { MAX_SEARCH_LIMIT } from '@substrat-run/kernel';

/**
 * How much wider than the answer the knowledge-base search asks the index for.
 *
 * Article search is ranked and then filtered — by source, and by what the caller
 * reaches — and a ranked top-N filtered afterwards returns fewer than N.
 */
export const SEARCH_OVERFETCH = 4;

/** This vertical's own search cap, derived from the kernel's so the two cannot drift. */
export const TICKET0_SEARCH_MAX = Math.floor(MAX_SEARCH_LIMIT / SEARCH_OVERFETCH);

/**
 * How much of a failure's reason a turn keeps. A provider's error body can be a page
 * of HTML; the first two thousand characters carry the status line and the sentence
 * after it, which is what a person reading the card needs. The harness truncates to
 * this BEFORE recording — a reason too long to record would otherwise turn a
 * recordable failure into an unrecorded one, which is the silence this exists to end.
 */
export const ASSISTANT_ERROR_MAX = 2000;

/**
 * What the HOST knew about the browser when the widget opened — `ClientContext`
 * flattened into columns. Shared by `widgetOpening` (where `widget-start` records it)
 * and `widgetSession` (where the first message carries it), so the two tables cannot
 * drift apart on what a browser is. Every column is nullable: a node dev server has no
 * geo, a request may carry no `User-Agent`, and a row that predates these columns has
 * nothing to say. `user_agent` is the raw header beside the parsed names, so a better
 * parser can re-read it later. No IP address: the city carries the useful part of it
 * without the fingerprint.
 */
const CLIENT_COLUMNS = {
  user_agent: z.string().nullable(),
  language: z.string().nullable(),
  browser: z.string().nullable(),
  browser_version: z.string().nullable(),
  os: z.string().nullable(),
  os_version: z.string().nullable(),
  device: z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']).nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
} as const;

export const ticket0Entities = defineEntities({
  /**
   * A person who asked something.
   *
   * Three rungs of trust live in two nullable columns rather than an enum, because
   * the rung is a fact about what was proven rather than a state anything moves
   * through:
   *
   *   - `external_id` null, `verified_at` null   → anonymous visitor
   *   - `external_id` set,  `verified_at` set    → the host site's server vouched
   *     for this identity by signing it with the desk's secret
   *   - `principal` set                          → they signed in for real
   *
   * `key` is on `external_id` so a vouched-for identity is one contact forever.
   * SQLite permits many NULLs under a UNIQUE, which is exactly right here: every
   * anonymous visitor is their own contact and none of them collide.
   *
   * `email` and `display_name` are the directly personal fields, so they are
   * erasable — which also makes them uncarryable by any event.
   */
  contact: {
    table: 'ticket0_contacts',
    fields: z.object({
      id: z.string(),
      external_id: z.string().nullable(),
      principal: z.string().nullable(),
      email: z.string().nullable(),
      display_name: z.string().nullable(),
      verified_at: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['external_id'],
    erasable: ['email', 'display_name'],
  },

  /**
   * A staff member's name and signature, keyed by their account.
   *
   * This table exists because the design promises human-readable names on outbound
   * email and in the conversation timeline, and accounts are opaque ULIDs. Without
   * it, "Anna from Substrat" has no source table — a promised string with nowhere to
   * come from is a missing table, and it is cheaper to notice now.
   *
   * Keyed by `principal`, not an `id` of its own: one profile per person is the
   * point, and a second id would permit two.
   */
  agentProfile: {
    table: 'ticket0_agent_profiles',
    fields: z.object({
      principal: z.string(),
      display_name: z.string(),
      avatar_url: z.string().nullable(),
      signature: z.string().nullable(),
      created_at: z.string(),
    }),
    primaryKey: ['principal'],
    // All three are the person: the name outright, a picture of them by reference,
    // and a signature that in practice is the name again with a title under it.
    erasable: ['display_name', 'avatar_url', 'signature'],
  },

  /**
   * The core noun. Not a ticket — the ticket is a view of this once it needs work.
   *
   * `merged_into` is nullable and self-referential: a merged conversation keeps its
   * history and forwards to its survivor. It is never deleted, because the customer
   * who wrote it is entitled to find it.
   */
  conversation: {
    table: 'ticket0_conversations',
    fields: z.object({
      id: z.string(),
      contact_id: z.string(),
      channel: z.enum(['widget', 'email']),
      subject: z.string(),
      state: z.enum(['new', 'open', 'snoozed', 'resolved', 'closed']),
      assignee: z.string().nullable(),
      priority: z.enum(['low', 'normal', 'urgent']),
      snoozed_until: z.string().nullable(),
      first_public_reply_at: z.string().nullable(),
      resolved_at: z.string().nullable(),
      merged_into: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    parents: ['contact'],
  },

  /**
   * One message in a conversation.
   *
   * `visibility` is the single most consequential column in this app: it is the
   * difference between a note to a colleague and an email to a customer. It is an
   * enum rather than a boolean so that reading a row makes the answer obvious
   * rather than requiring the reader to remember which way round `internal` went.
   *
   * The bodies are **erasable**, and that has a consequence worth stating out loud:
   * no event can carry them. So the outbound-email event carries ids only, and the
   * relay reads the body back through `ticket0/read-outbound` at send time. That is
   * one more round trip and it buys a real property — an erased customer's words
   * cannot be emailed out afterwards, because there is nothing left to send.
   */
  message: {
    table: 'ticket0_messages',
    fields: z.object({
      id: z.string(),
      conversation_id: z.string(),
      author_kind: z.enum(['contact', 'agent', 'assistant', 'system']),
      author_principal: z.string().nullable(),
      visibility: z.enum(['public', 'internal']),
      body_text: z.string(),
      body_html: z.string().nullable(),
      email_message_id: z.string().nullable(),
      email_in_reply_to: z.string().nullable(),
      delivered_at: z.string().nullable(),
      /**
       * The knowledge-base articles this message was sent with, as JSON ids.
       *
       * Deliberately not the same fact as `ai_turn.cited_article_ids`: the turn records
       * what the MODEL drew on, this records what actually went to the customer, and a
       * human who edits a draft before sending can make them differ. It is also the
       * only one a customer-facing read may return, since the turn is staff-only.
       */
      cited_article_ids: z.string().nullable(),
      created_at: z.string(),
    }),
    parents: ['conversation'],
    erasable: ['body_text', 'body_html'],
  },

  /**
   * A free tag on a conversation. Composite-keyed, so deliberately un-pointable:
   * nothing grants on a tag, nothing attaches to one, and no event is about one.
   */
  conversationTag: {
    table: 'ticket0_conversation_tags',
    fields: z.object({
      conversation_id: z.string(),
      tag: z.string(),
      created_at: z.string(),
    }),
    primaryKey: ['conversation_id', 'tag'],
  },

  /** A canned answer. Every desk grows these; better to ship the table than to watch
   *  them accumulate as browser bookmarks. */
  savedReply: {
    table: 'ticket0_saved_replies',
    fields: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    key: ['title'],
  },

  /** One satisfaction score per conversation, once. Keyed by the conversation for
   *  exactly that reason — an `id` of its own would permit a second rating. */
  csat: {
    table: 'ticket0_csat',
    fields: z.object({
      conversation_id: z.string(),
      score: z.number(),
      comment: z.string().nullable(),
      submitted_at: z.string(),
    }),
    primaryKey: ['conversation_id'],
    erasable: ['comment'],
  },

  /**
   * A browser session in the widget.
   *
   * `token_hash`, never the token: this row is what an anonymous visitor's entire
   * access rests on, and a readable session table is a readable set of session
   * tokens. `origin` is recorded because the desk's embedding allowlist is checked
   * per request, and a session that started on an origin later removed from the
   * allowlist must stop working rather than coast.
   *
   * The `CLIENT_COLUMNS` are what the host knew about the browser when the widget
   * opened, carried over from the opening by the first message — so an agent can see
   * "Safari 17 on iOS, Stockholm, 3 am their time" without asking. Read back by
   * `widget-session`, which is the one staff-side read of this table and omits
   * `token_hash`.
   */
  widgetSession: {
    table: 'ticket0_widget_sessions',
    fields: z.object({
      id: z.string(),
      conversation_id: z.string(),
      contact_id: z.string(),
      origin: z.string(),
      token_hash: z.string(),
      started_at: z.string(),
      last_seen_at: z.string(),
      ...CLIENT_COLUMNS,
    }),
    parents: ['conversation'],
    key: ['token_hash'],
  },

  /**
   * A widget that has been opened and has not said anything yet.
   *
   * Opening the bubble is not a conversation. Until the first message the desk holds
   * only this: a token hash to recognise the visitor by, the origin to keep checking,
   * and — for a visitor the host site vouched for — which contact they are. The
   * conversation, and for an anonymous visitor the contact too, are created by the
   * first `widget-post`, which moves this row into `widgetSession` under the same id.
   * So a curl, a crawler that ran the script, or a person who clicked and left create
   * nothing an agent can see; before this, each of them was an empty "Chat" in the inbox.
   *
   * Its own table rather than a nullable `conversation_id` on `widgetSession`: the
   * journal cannot relax a NOT NULL in place (SQLite would need a rebuild), and a
   * session that exists but reaches no thread is a different thing anyway.
   */
  widgetOpening: {
    table: 'ticket0_widget_openings',
    fields: z.object({
      id: z.string(),
      contact_id: z.string().nullable(),
      origin: z.string(),
      token_hash: z.string(),
      started_at: z.string(),
      last_seen_at: z.string(),
      // Recorded here, at the moment the host had the request in hand; the first
      // message copies them onto the session, since the opening row is gone by then.
      ...CLIENT_COLUMNS,
    }),
    key: ['token_hash'],
  },

  /**
   * The desk's own settings — one row per scope, id fixed.
   *
   * Note what is NOT here: any column deciding whether the assistant may reply to
   * customers. That is a grant on the assistant's account (concept §4), and a
   * column would be a second place to say it — which is how the two come to
   * disagree, and how `if (desk.aiMode === 'auto')` gets written.
   */
  deskSettings: {
    table: 'ticket0_desk_settings',
    fields: z.object({
      id: z.string(),
      from_address: z.string(),
      greeting: z.string(),
      allowed_origins: z.string(),
      verification_secret: z.string(),
      business_hours: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  },

  /** Where knowledge-base articles come from. */
  kbSource: {
    table: 'ticket0_kb_sources',
    fields: z.object({
      id: z.string(),
      kind: z.enum(['llms-txt', 'sitemap', 'markdown']),
      url: z.string(),
      label: z.string(),
      status: z.enum(['idle', 'ingesting', 'failed']),
      last_ingested_at: z.string().nullable(),
      last_error: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['url'],
  },

  /**
   * One document the assistant may cite.
   *
   * `content_hash` is what makes a re-ingest that changed nothing write nothing —
   * which matters because re-ingesting is a scheduled act, and a desk that rewrites
   * its whole knowledge base every night has a useless audit trail.
   */
  kbArticle: {
    table: 'ticket0_kb_articles',
    fields: z.object({
      id: z.string(),
      source_id: z.string(),
      url: z.string(),
      title: z.string(),
      heading_path: z.string(),
      body: z.string(),
      content_hash: z.string(),
      ingested_at: z.string(),
    }),
    parents: ['kbSource'],
    key: ['source_id', 'url'],
  },

  /**
   * One assistant turn, and what it cost.
   *
   * This is the side table the metering engine's own documentation prescribes:
   * the ledger counts tokens and stays ignorant of support desks, and richer
   * tagging hangs off the entry id here. `meter_entry_id` is nullable because a
   * turn that failed before the model answered has nothing to record.
   *
   * `error` is why a `failed` turn failed, in the words of whatever threw — the
   * provider's status line, the refused permission, the missing credential. A failed
   * turn used to carry only its outcome, so the desk could see THAT the assistant had
   * not answered and nothing about why; the reason went to the dev server's stdout
   * and, on a worker, nowhere at all. Null on every other outcome.
   */
  aiTurn: {
    table: 'ticket0_ai_turns',
    fields: z.object({
      id: z.string(),
      conversation_id: z.string(),
      message_id: z.string().nullable(),
      model: z.string(),
      input_tokens: z.number(),
      output_tokens: z.number(),
      cited_article_ids: z.string(),
      confidence: z.number().nullable(),
      outcome: z.enum(['drafted', 'answered', 'escalated', 'failed']),
      meter_entry_id: z.string().nullable(),
      error: z.string().nullable(),
      created_at: z.string(),
    }),
    parents: ['conversation'],
  },

  /**
   * Meter key → unit price. Ours, because prices are vertical vocabulary and the
   * ledger deliberately has no opinion about money.
   *
   * `unit_price` is a string: money is never a float here. Composite-keyed on the
   * meter and the date it took effect, so re-pricing is an append rather than an
   * edit and a closed month stays reproducible at the price it was closed under.
   */
  usageRate: {
    table: 'ticket0_usage_rates',
    fields: z.object({
      meter_key: z.string(),
      unit_price: z.string(),
      currency: z.string(),
      effective_from: z.string(),
    }),
    primaryKey: ['meter_key', 'effective_from'],
  },

  /** Something a person should be told about. */
  notification: {
    table: 'ticket0_notifications',
    fields: z.object({
      id: z.string(),
      principal: z.string(),
      kind: z.enum(['assigned', 'replied', 'mentioned', 'snooze-woke', 'escalated']),
      conversation_id: z.string().nullable(),
      read_at: z.string().nullable(),
      created_at: z.string(),
    }),
  },
});

/**
 * Thirteen keys, and the interesting ones are the last three.
 *
 * - `conversation:read` is desk-wide and held by staff. `conversation:read-own` is
 *   never held scope-wide by anybody — it is granted per contact on their own
 *   `contact` entity when they appear, and reaches their conversations through the
 *   declared parent edge. That asymmetry is what makes one customer's history
 *   unreachable to another while staff see the whole desk.
 *
 * - `conversation:draft` and `conversation:reply-public` are the assistant's whole
 *   authority model. It always holds the first; whether it holds the second is what
 *   distinguishes a desk that lets the AI talk to customers from one that does not.
 *   Same code, different grant, no branch.
 *
 * - `usage:read` is the money, and it is held by exactly one role.
 *
 * - `conversation:relay` is held by NO human role. The email connection holds it,
 *   acting as itself, so it can bring messages in and read the ones going out —
 *   the same shape the Scrive connector uses to record a signature back.
 *
 * `conversation:widget` is the odd one, and it is the answer to a question this
 * design spent a while getting wrong. It is held by ONE principal per desk — the
 * desk's own widget service — and it is not what confines a visitor. The SESSION
 * TOKEN is.
 *
 * That is a capability, not a permission, and the distinction is legitimate here
 * rather than a shortcut: `widget-post` and `widget-thread` take a session id and a
 * token and NO conversation id, so the conversation is derived from possession of an
 * unguessable secret and never from anything the caller supplied. There is no
 * widening attack because the input surface does not admit one.
 *
 * What it buys is that a stranger in a chat bubble needs no principal, no grant and
 * no reaping — the three things that made the anonymous visitor an open question.
 * What it costs is stated rather than hidden: for widget writes the kernel is not the
 * thing doing the confining, and the audit actor is the desk's widget service rather
 * than the individual. Per-visitor attribution lives on `message.conversation_id` →
 * `conversation.contact_id` instead of in the event envelope.
 *
 * The portal is the other door and it is unchanged: a real login, a real principal,
 * `conversation:read-own` narrowed to a contact, the full kernel walk. Principals
 * where there is a login to hang one on, capabilities where there is not.
 */
export const TICKET0_PERMISSIONS = [
  'conversation:read',
  'conversation:widget',
  'conversation:read-own',
  'conversation:draft',
  'conversation:reply-public',
  'conversation:assign',
  'conversation:resolve',
  'conversation:merge',
  'conversation:relay',
  'contact:read',
  'kb:read',
  'kb:manage',
  'desk:configure',
  'usage:read',
  'notification:read-own',
] as const;

export const ticket0Operations = defineOperations(ticket0Entities, TICKET0_PERMISSIONS)({
  // ─── The desk ────────────────────────────────────────────────────────────────

  'ticket0/get-desk': {
    summary: 'The desk’s settings',
    permission: 'desk:configure',
    output: ticket0Entities.deskSettings.fields.omit({ verification_secret: true }),
    http: { method: 'GET', path: '/desk' },
  },

  'ticket0/configure-desk': {
    summary: 'Change the desk’s settings',
    permission: 'desk:configure',
    input: z.object({
      fromAddress: z.string().email().optional(),
      greeting: z.string().min(1).optional(),
      allowedOrigins: z.array(z.string().url()).optional(),
      businessHours: z.string().nullable().optional(),
    }),
    output: ticket0Entities.deskSettings.fields.omit({ verification_secret: true }),
    http: { method: 'PATCH', path: '/desk' },
    emits: {
      entity: 'deskSettings',
      entityIdFrom: 'id',
      type: 'ticket0.desk-configured',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'from_address', 'allowed_origins'],
    },
  },

  /**
   * Mint a new identity-verification secret and return it ONCE.
   *
   * This is the only operation that ever returns the secret in the clear — every
   * read of the desk omits it. Rotating invalidates every signature the customer's
   * site is currently producing, which is why it is its own deliberate act rather
   * than a field on `configure-desk`.
   */
  'ticket0/rotate-verification-secret': {
    summary: 'Issue a new identity-verification secret (shown once)',
    permission: 'desk:configure',
    output: z.object({ id: z.string(), secret: z.string(), rotatedAt: z.string() }),
    http: { method: 'POST', path: '/desk/verification-secret' },
    emits: {
      entity: 'deskSettings',
      entityIdFrom: 'id',
      type: 'ticket0.verification-secret-rotated',
      schemaVersion: 1,
      piiClass: 'none',
      // The secret itself is not in the payload, for the obvious reason: events are
      // immutable, and an immutable copy of a secret cannot be rotated away.
      payload: ['id'],
    },
  },

  'ticket0/set-agent-profile': {
    summary: 'Set your own display name and signature',
    // Any staff member may set their OWN profile; the handler writes the caller's
    // principal and takes no principal from the input, so this cannot rename a
    // colleague.
    permission: 'conversation:draft',
    /**
     * A whole profile, not a patch — and the model is what insists on that.
     *
     * `{ displayName, avatarUrl?, signature? }` is a partial field-bag over the
     * agent's own row: one field naming it and the rest optional columns, which is
     * read-modify-write. Two tabs each change one field, each save, neither
     * conflicts, and the second silently discards the first. The usual answer is an
     * `If-Match`, but it cannot be given here: the row is keyed by the CALLER's
     * principal, which is deliberately absent from the input so this can never
     * rename a colleague, so there is no id for `concurrency` to name.
     *
     * So the operation states the whole row instead. `null` means "no avatar",
     * absent is not a thing you can be, and a save carries everything it means.
     */
    input: z.object({
      displayName: z.string().min(1),
      avatarUrl: z.string().url().nullable(),
      signature: z.string().nullable(),
    }),
    output: ticket0Entities.agentProfile.fields,
    http: { method: 'PUT', path: '/agents/me' },
    emits: {
      entity: 'agentProfile',
      entityIdFrom: 'principal',
      type: 'ticket0.agent-profile-set',
      schemaVersion: 1,
      piiClass: 'none',
      // The principal and when the profile was first made, and nothing else. The
      // name, the avatar and the signature are all the person and all erasable, so
      // none may be carried — an event is the one place in a scope an erasure
      // cannot reach. A consumer that needs the name reads it.
      payload: ['principal', 'created_at'],
    },
  },

  /**
   * The desk's staff — the directory an assignee picker reads, and the one the
   * `assign` handler validates against.
   *
   * A profile is what makes someone assignable. That is a deliberate reading of
   * "staff of this desk" and not a shortcut: nothing in a scope lets module code
   * ask who else holds `conversation:read`, so the only in-scope record of a
   * colleague is the row they wrote about themselves. It also gives the rule a
   * shape a person can act on — an agent who cannot be found in the picker sets
   * their profile and appears — where a hidden role table would only produce a
   * name that is missing for no visible reason.
   *
   * Read under `conversation:read`, the same key the inbox already needs: knowing
   * the names of the people whose queue you are looking at is not a second
   * decision from being allowed to look at it.
   *
   * Sorted by name by default because this list is read by a human choosing from
   * it, not by a feed.
   */
  'ticket0/list-agents': {
    summary: 'The staff of this desk',
    permission: 'conversation:read',
    output: ticket0Entities.agentProfile.fields,
    paged: { over: { entity: 'agentProfile', sortable: ['display_name', 'created_at'] } },
    http: { method: 'GET', path: '/agents' },
  },

  // ─── Knowledge base ──────────────────────────────────────────────────────────

  'ticket0/add-kb-source': {
    summary: 'Point the desk at a source of documentation',
    permission: 'kb:manage',
    input: z.object({
      kind: z.enum(['llms-txt', 'sitemap', 'markdown']),
      url: z.string().url(),
      label: z.string().min(1),
    }),
    output: ticket0Entities.kbSource.fields,
    http: { method: 'POST', path: '/kb/sources' },
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-source-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'url', 'label'],
    },
  },

  'ticket0/list-kb-sources': {
    summary: 'The desk’s documentation sources',
    permission: 'kb:read',
    output: ticket0Entities.kbSource.fields,
    paged: { over: { entity: 'kbSource', sortable: ['created_at', 'label'], filterable: ['status'] } },
    http: { method: 'GET', path: '/kb/sources' },
  },

  /**
   * Ask for a source to be re-read.
   *
   * Ingestion fetches URLs, which module code may not do — so this operation records
   * the intent and emits, and a connector does the fetching outside the transaction.
   * The event is what the connector consumes; the operation returns immediately.
   */
  'ticket0/ingest-kb-source': {
    summary: 'Re-read a documentation source',
    permission: { key: 'kb:manage', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string() }),
    output: ticket0Entities.kbSource.fields,
    http: { method: 'POST', path: '/kb/sources/{sourceId}/ingest' },
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-ingest-requested',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'url'],
    },
  },

  /**
   * Record what a source ingest found.
   *
   * The connector invokes this, acting as itself, once it has fetched and parsed —
   * the same authority seam the relay uses. It is idempotent on content hash: an
   * article whose text did not change is not rewritten, so a nightly re-ingest of an
   * unchanged docs site produces an empty diff rather than a full one.
   */
  'ticket0/record-kb-articles': {
    summary: 'Record the articles an ingest produced',
    permission: { key: 'kb:manage', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({
      sourceId: z.string(),
      articles: z.array(
        z.object({
          url: z.string().url(),
          title: z.string(),
          headingPath: z.string(),
          body: z.string(),
        }),
      ),
    }),
    output: z.object({
      sourceId: z.string(),
      added: z.number(),
      updated: z.number(),
      unchanged: z.number(),
    }),
    http: { method: 'POST', path: '/kb/sources/{sourceId}/articles' },
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'sourceId',
      type: 'ticket0.kb-source-ingested',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['sourceId', 'added', 'updated', 'unchanged'],
    },
  },

  /**
   * Record that a source could not be read.
   *
   * The other half of `record-kb-articles`, and the half that was missing: a fetch
   * that failed left the source at `ingesting` for good, because nothing wrote
   * `failed`. The connector invokes this from its catch, and the desk shows the reason
   * on the row — a failed read is a health signal, not a spinner.
   */
  'ticket0/record-kb-ingest-failure': {
    summary: 'Record that a documentation source could not be read',
    permission: { key: 'kb:manage', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string(), error: z.string().min(1) }),
    output: ticket0Entities.kbSource.fields,
    http: { method: 'POST', path: '/kb/sources/{sourceId}/failure' },
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-ingest-failed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'url', 'last_error'],
    },
  },

  /**
   * Find articles by text — ranked and capped, not paged.
   *
   * A separate contract from a paged list on purpose: this one is ordered by
   * relevance and truncated, and an answer that was truncated has to say so, or a
   * screen shows the first twenty of two hundred matches as though that were all.
   */
  'ticket0/search-kb': {
    summary: 'Search the knowledge base',
    permission: 'kb:read',
    input: z.object({
      q: z.string().min(2),
      sourceId: z.string().optional(),
      limit: z.number().int().positive().max(TICKET0_SEARCH_MAX).optional(),
    }),
    output: z.object({
      results: z.array(
        ticket0Entities.kbArticle.fields.extend({ snippet: z.string(), rank: z.number() }),
      ),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/kb/search' },
  },

  // ─── Contacts ────────────────────────────────────────────────────────────────

  'ticket0/list-contacts': {
    summary: 'The people who have asked something',
    permission: 'contact:read',
    output: ticket0Entities.contact.fields,
    paged: { over: { entity: 'contact', sortable: ['created_at'], filterable: ['external_id'] } },
    http: { method: 'GET', path: '/contacts' },
  },

  // ─── The inbox ───────────────────────────────────────────────────────────────

  'ticket0/list-conversations': {
    summary: 'The desk’s conversations',
    permission: 'conversation:read',
    /**
     * The filters, declared as INPUT as well as `filterable`.
     *
     * Both are needed and they are not the same statement. `filterable` below tells the
     * kernel which columns a walk may narrow on and provisions the indexes behind them;
     * this tells the TRANSPORT what to accept, because `mountOperations` parses only the
     * page trio out of a query string and would drop anything else on the floor. Without
     * it the emitted OpenAPI advertises five parameters that reach no handler — which is
     * what it did until an inbox tried to use them.
     *
     * Same shape as todo's `list-shares`, which declares `listId` and `filterable:
     * ['list_id']` for exactly this reason.
     */
    input: z.object({
      state: z.enum(['new', 'open', 'snoozed', 'resolved', 'closed']).optional(),
      assignee: z.string().optional(),
      channel: z.enum(['widget', 'email']).optional(),
      priority: z.enum(['low', 'normal', 'urgent']).optional(),
    }),
    output: ticket0Entities.conversation.fields,
    paged: {
      over: {
        entity: 'conversation',
        // `updated_at` first: an inbox is sorted by what moved most recently, and
        // [0] is the default the screen gets without asking.
        sortable: ['updated_at', 'created_at', 'priority'],
        filterable: ['state', 'assignee', 'channel', 'priority', 'contact_id'],
      },
      order: 'desc',
      total: true,
    },
    http: { method: 'GET', path: '/conversations' },
  },

  'ticket0/get-conversation': {
    summary: 'One conversation',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'GET', path: '/conversations/{conversationId}' },
  },

  /**
   * The messages on a conversation, staff view — internal notes included.
   *
   * The customer-facing read is `ticket0/widget-thread` / `ticket0/my-messages`,
   * which are different operations rather than this one with a flag. A single
   * operation whose output depends on who is asking is exactly how an internal note
   * reaches a customer.
   */
  'ticket0/list-messages': {
    summary: 'Every message on a conversation, notes included',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    // Resolved, not raw ids: a citation exists so a human can check it, and an id is
    // not checkable. Every read that renders a message does this the same way.
    output: ticket0Entities.message.fields.extend({ citations: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          headingPath: z.string(),
        }),
      ) }),
    paged: {
      over: {
        entity: 'message',
        sortable: ['created_at'],
        filterable: ['conversation_id', 'visibility', 'author_kind'],
      },
      total: true,
    },
    http: { method: 'GET', path: '/conversations/{conversationId}/messages' },
  },

  /**
   * The browser behind a widget conversation — what the visitor was holding and
   * roughly where, as recorded when the session opened.
   *
   * Staff-side and entity-checked like every other read of a conversation; the
   * session's `token_hash` is the one column that never leaves the row, since the
   * table is otherwise a readable set of session tokens. One session, the latest: a
   * merge can leave a survivor with several, and the most recent one is the browser
   * the person is in now. Null for an email conversation, or a widget session that
   * predates the client columns — the rail simply has no card to show.
   */
  'ticket0/widget-session': {
    summary: 'The browser session behind a widget conversation',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: z.object({
      session: ticket0Entities.widgetSession.fields.omit({ token_hash: true }).nullable(),
    }),
    http: { method: 'GET', path: '/conversations/{conversationId}/widget-session' },
  },

  /**
   * The rating the customer left, read by the people it is about.
   *
   * `submit-csat` is a portal operation under `conversation:read-own`; this is its
   * staff half, and without it a score was stored and then unreachable by anyone —
   * which is not the same thing as storing it. Nullable rather than 404: an unrated
   * conversation is the normal case, and a read that throws for it would make every
   * caller catch. Same shape as `widget-session` above for that reason.
   *
   * Aggregates — an average, a leaderboard — are reporting and belong with the
   * reporting issue. This is the one rating on the one conversation.
   */
  'ticket0/get-csat': {
    summary: 'The satisfaction rating on a conversation, if there is one',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: z.object({ csat: ticket0Entities.csat.fields.nullable() }),
    http: { method: 'GET', path: '/conversations/{conversationId}/csat' },
  },

  'ticket0/post-note': {
    summary: 'Leave an internal note colleagues can see and the customer cannot',
    permission: { key: 'conversation:draft', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), body: z.string().min(1) }),
    output: ticket0Entities.message.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/notes' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.note-posted',
      schemaVersion: 1,
      // The body is erasable and so cannot ride here; nothing else on this payload
      // identifies anybody.
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'author_kind', 'visibility'],
    },
  },

  /**
   * Send a reply that leaves the building.
   *
   * This is the permission the whole assistant design turns on. A human agent holds
   * it. The assistant holds it only in a desk that granted it — and in a desk that
   * did not, this call is denied with a proof path, the draft stays internal, and
   * nothing reaches the customer.
   */
  'ticket0/post-public-reply': {
    summary: 'Reply to the customer',
    permission: {
      key: 'conversation:reply-public',
      entity: 'conversation',
      idFrom: 'conversationId',
    },
    input: z.object({
      conversationId: z.string(),
      body: z.string().min(1),
      bodyHtml: z.string().nullable().optional(),
      /** What this answer drew on. Optional: a human reply usually cites nothing. */
      citedArticleIds: z.array(z.string()).optional(),
    }),
    output: ticket0Entities.message.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/replies' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.reply-requested',
      schemaVersion: 1,
      piiClass: 'none',
      // Ids only. The relay reads the body back through `ticket0/read-outbound` at
      // send time, because the body is erasable and an event cannot carry it — which
      // is also what stops an erased customer's words being emailed out afterwards.
      payload: ['id', 'conversation_id', 'visibility'],
    },
  },

  /**
   * `assignee` is a principal that must already be in the desk's directory — one
   * of the rows `ticket0/list-agents` returns. The handler refuses anything else
   * rather than writing it (#1079): an unchecked string here sticks silently, and
   * the `assigned` notification it mints is addressed to somebody who will never
   * read it. `null` is the other legal value, and means nobody.
   */
  'ticket0/assign': {
    summary: 'Assign a conversation to someone (or nobody)',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), assignee: z.string().nullable() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/assignee' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-assigned',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'assignee', 'state'],
    },
  },

  /**
   * Priority is triage, not workflow: it moves the conversation nowhere and is legal
   * in every state the conversation is still alive in.
   *
   * It shares `conversation:assign` with the operations beside it deliberately —
   * routing work to a person and ranking that work are the same act by the same
   * people, and a second key would be a permission nobody ever grants separately.
   */
  'ticket0/set-priority': {
    summary: "Set a conversation's priority",
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({
      conversationId: z.string(),
      priority: z.enum(['low', 'normal', 'urgent']),
    }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/priority' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-priority-set',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'priority', 'state'],
    },
  },

  'ticket0/snooze': {
    summary: 'Park a conversation until a time',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), until: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/snooze' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-snoozed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'snoozed_until'],
    },
  },

  /** Bring a snoozed conversation back by hand. The timer does this too; a person
   *  changing their mind should not have to wait for it. */
  'ticket0/wake': {
    summary: 'Un-snooze a conversation',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/wake' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-woke',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'state'],
    },
  },

  /**
   * Resolve.
   *
   * The lifecycle says which states admit this; it deliberately cannot say the other
   * half of the rule — that a conversation may not be resolved before a public reply
   * has been sent. An edge cannot carry a condition, by design. That one is a guard,
   * wired in the manifest, evaluated inside this operation's own transaction.
   */
  'ticket0/resolve': {
    summary: 'Mark a conversation resolved',
    permission: { key: 'conversation:resolve', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/resolve' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-resolved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'resolved_at', 'contact_id'],
    },
  },

  'ticket0/close': {
    summary: 'Close a resolved conversation for good',
    permission: { key: 'conversation:resolve', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/close' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-closed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  /** Fold one conversation into another. The loser keeps its history and forwards. */
  'ticket0/merge': {
    summary: 'Merge this conversation into another',
    permission: { key: 'conversation:merge', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), intoConversationId: z.string() }),
    output: ticket0Entities.conversation.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/merge' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'id',
      type: 'ticket0.conversation-merged',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'merged_into'],
    },
  },

  'ticket0/tag-conversation': {
    summary: 'Tag a conversation',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), tag: z.string().min(1) }),
    output: ticket0Entities.conversationTag.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/tags' },
    emits: {
      // About the CONVERSATION, not the tag. A tag is keyed by both its columns and
      // so cannot be pointed at — which is right, because "this conversation was
      // tagged" is the fact anyone downstream cares about.
      entity: 'conversation',
      entityIdFrom: 'conversation_id',
      type: 'ticket0.conversation-tagged',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['conversation_id', 'tag', 'created_at'],
    },
  },

  /**
   * Take a tag off again.
   *
   * The tag is in the PATH rather than the body because it is half of the row's
   * identity — this is a DELETE of one composite-keyed row, and `todo/revoke-share`
   * is the same shape. `removed` is the answer to "was there one": untagging
   * something that was never tagged is not an error, it is a no-op that says so,
   * which mirrors tagging twice announcing once.
   */
  'ticket0/untag-conversation': {
    summary: 'Take a tag off a conversation',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), tag: z.string().min(1) }),
    output: z.object({
      conversation_id: z.string(),
      tag: z.string(),
      removed: z.boolean(),
    }),
    http: { method: 'DELETE', path: '/conversations/{conversationId}/tags/{tag}' },
    emits: {
      // About the conversation, for the same reason tagging is: a tag cannot be
      // pointed at, and "this conversation lost a tag" is the fact downstream wants.
      entity: 'conversation',
      entityIdFrom: 'conversation_id',
      type: 'ticket0.conversation-untagged',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['conversation_id', 'tag'],
    },
  },

  /**
   * The tags on one conversation.
   *
   * Deliberately not paged. A conversation carries a handful of tags and the rail
   * renders all of them at once; a cursor here would be a page control over four
   * chips, and a screen that had to walk it would be the only caller.
   */
  'ticket0/list-conversation-tags': {
    summary: 'The tags on a conversation',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: z.object({ tags: z.array(ticket0Entities.conversationTag.fields) }),
    http: { method: 'GET', path: '/conversations/{conversationId}/tags' },
  },

  /**
   * The desk's tag vocabulary — every tag in use, and how often.
   *
   * Tags are free text, so the vocabulary is not a table anyone maintains: it is
   * whatever has been typed. Handing the count back with each one is what makes the
   * list usable as autocomplete rather than as a wall — the tag five conversations
   * carry is the one a person means, and a typo that was used once sorts last and
   * reads as the mistake it is.
   */
  'ticket0/list-tags': {
    summary: 'Every tag the desk uses, most-used first',
    permission: 'conversation:read',
    output: z.object({
      tags: z.array(z.object({ tag: z.string(), count: z.number().int() })),
    }),
    http: { method: 'GET', path: '/tags' },
  },

  // ─── Saved replies ───────────────────────────────────────────────────────────

  'ticket0/list-saved-replies': {
    summary: 'The desk’s canned answers',
    permission: 'conversation:draft',
    output: ticket0Entities.savedReply.fields,
    paged: { over: { entity: 'savedReply', sortable: ['title', 'created_at'] } },
    http: { method: 'GET', path: '/saved-replies' },
  },

  'ticket0/create-saved-reply': {
    summary: 'Save a canned answer',
    permission: 'conversation:draft',
    input: z.object({ title: z.string().min(1), body: z.string().min(1) }),
    output: ticket0Entities.savedReply.fields,
    http: { method: 'POST', path: '/saved-replies' },
    emits: {
      entity: 'savedReply',
      entityIdFrom: 'id',
      type: 'ticket0.saved-reply-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title', 'body', 'created_by', 'created_at'],
    },
  },

  // ─── The assistant ───────────────────────────────────────────────────────────

  /**
   * Record what the assistant produced, and what it cost.
   *
   * One operation for both halves on purpose: the message and the meter entry are
   * written in the same transaction, so a turn cannot be charged for without being
   * recorded, or recorded without being charged for.
   *
   * `turnId` is caller-supplied and is the ledger's dedupe key — a retried turn
   * returns the existing entry rather than billing twice. That is the single
   * assertion the metering engine exists to make true, and the scenario replays it.
   *
   * The permission is `draft`, always. Whether the recorded answer then goes out is
   * a separate act with a separate permission — which is the entire design.
   */
  'ticket0/record-answer': {
    summary: 'Record an assistant answer and its token usage',
    permission: { key: 'conversation:draft', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({
      conversationId: z.string(),
      turnId: z.string(),
      model: z.string(),
      body: z.string().min(1),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      citedArticleIds: z.array(z.string()),
      confidence: z.number().min(0).max(1).nullable().optional(),
      outcome: z.enum(['drafted', 'answered', 'escalated', 'failed']),
      /** Why, when `outcome` is `failed` — what the model or the provider threw. Additive. */
      error: z.string().min(1).max(ASSISTANT_ERROR_MAX).optional(),
      /**
       * The platform's own record of the call (#1054), when the platform's model host ran
       * it: the line goes to the platform ledger as a `model-usage` intent in the same
       * transaction as the meter entries. Absent for the extractive fallback and for a
       * failed turn — nothing ran, nothing to attribute. Additive.
       */
      usage: modelUsageLine.optional(),
    }),
    output: ticket0Entities.aiTurn.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/answers' },
    emits: {
      entity: 'aiTurn',
      entityIdFrom: 'id',
      type: 'ticket0.answer-recorded',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'model', 'input_tokens', 'output_tokens', 'outcome'],
    },
  },

  /**
   * Record that the assistant never got as far as an answer — as the WIDGET.
   *
   * `record-answer` is how the assistant records its own failure: the model threw,
   * the assistant still holds `conversation:draft`, and the turn says `failed` with
   * the reason. This is for the failure the assistant cannot record because the
   * assistant itself is what failed: its service principal was never minted, its role
   * was never assigned, its first operation was refused. The host that started the
   * job sees that, and the only principal it can still be sure of is the widget's —
   * the one that just accepted the customer's message — so the widget writes the turn.
   *
   * Without this, a desk whose assistant could not act at all was silent in exactly
   * the way a slow one is: the customer's message sat in the thread, no turn existed,
   * and the worker's bare `catch` had eaten the reason. Same row, same `failed`
   * outcome, same card in the desk; no tokens, because nothing ran.
   */
  'ticket0/record-assistant-failure': {
    summary: 'Record that the assistant could not act on a message',
    permission: { key: 'conversation:widget', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({
      conversationId: z.string(),
      /** The customer message that went unanswered — the turn's id, so a retry finds it. */
      turnId: z.string(),
      model: z.string(),
      error: z.string().min(1).max(ASSISTANT_ERROR_MAX),
    }),
    output: ticket0Entities.aiTurn.fields,
    http: { method: 'POST', path: '/conversations/{conversationId}/assistant-failures' },
    emits: {
      entity: 'aiTurn',
      entityIdFrom: 'id',
      type: 'ticket0.assistant-failed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'model', 'error'],
    },
  },

  /**
   * Is the assistant answering? The desk admin's view of the failed turns.
   *
   * A failed turn is visible on its conversation, but an admin asking "is the
   * assistant working" should not have to open conversations one by one to find out.
   * The counts are the last 24 hours; `recent` is the newest failures, each naming
   * its conversation so the card links to it. The host wraps this in
   * `GET /api/assistant/status` and adds the one fact the module cannot know — which
   * model this install would run, and whether it is a model at all.
   */
  'ticket0/assistant-health': {
    summary: 'Recent assistant failures, for the admin deciding whether it is working',
    permission: 'desk:configure',
    output: z.object({
      since: z.string(),
      turns: z.number().int(),
      failed: z.number().int(),
      recent: z.array(
        z.object({
          id: z.string(),
          conversation_id: z.string(),
          subject: z.string(),
          model: z.string(),
          error: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/assistant/health' },
  },

  /**
   * What the assistant produced on this conversation, for the human deciding whether
   * to send it: which model, how confident, and what it cited.
   *
   * **No token counts, deliberately.** They are on the row and they are what cost is
   * computed from, so returning them here would hand an agent the money through a read
   * whose key every agent holds — and "they would have to multiply it themselves" is
   * not a permission model. Cost has exactly one door, and it is `usage:read`.
   *
   * Citations are resolved to titles and URLs rather than left as ids: the point of a
   * citation is that a human can check it before sending, and an id is not checkable.
   */
  'ticket0/list-turns': {
    summary: 'What the assistant produced on this conversation',
    permission: { key: 'conversation:read', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string() }),
    output: z.object({
      id: z.string(),
      conversation_id: z.string(),
      message_id: z.string().nullable(),
      model: z.string(),
      confidence: z.number().nullable(),
      outcome: z.enum(['drafted', 'answered', 'escalated', 'failed']),
      error: z.string().nullable(),
      created_at: z.string(),
      citations: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          headingPath: z.string(),
        }),
      ),
    }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/conversations/{conversationId}/turns' },
  },
  // ─── The money ───────────────────────────────────────────────────────────────

  /**
   * What the desk has spent. One role holds this key, and an agent working the inbox
   * is not in it — not the number, not the screen.
   */
  'ticket0/usage-summary': {
    summary: 'Token usage and what it cost',
    permission: 'usage:read',
    // `conversationId` narrows the same answer to one conversation, which is what the
    // admin's conversation rail renders. Optional and additive: a caller that omits it
    // gets exactly what it got before.
    input: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      conversationId: z.string().optional(),
    }),
    output: z.object({
      from: z.string(),
      to: z.string(),
      currency: z.string(),
      total: z.string(),
      lines: z.array(
        z.object({
          meterKey: z.string(),
          unit: z.string(),
          qty: z.string(),
          unitPrice: z.string(),
          amount: z.string(),
          entryCount: z.number(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/usage' },
  },

  'ticket0/set-usage-rate': {
    summary: 'Set the price of a meter from a date',
    permission: 'usage:read',
    input: z.object({
      meterKey: z.string(),
      unitPrice: z.string(),
      currency: z.string().length(3),
      effectiveFrom: z.string(),
    }),
    output: ticket0Entities.usageRate.fields,
    http: { method: 'POST', path: '/usage/rates' },
    // No `emits`, and this is the one place in the module where that is a decision
    // rather than an omission. A rate is keyed by `(meter_key, effective_from)` —
    // its values ARE its identity, which is what stops a second row silently
    // repricing the same day. An event is about ONE entity and needs one id to
    // point at, so emitting this would mean giving the rate a surrogate id whose
    // only purpose is to be in an event. The price history is already append-only
    // and readable; that is the audit trail, and it is a better one.
  },

  /** Freeze a month. Composes the metering engine's `closePeriod` in this
   *  transaction; the closed lines are what the summary reads afterwards. */
  'ticket0/close-usage-period': {
    summary: 'Close a billing period',
    permission: 'usage:read',
    input: z.object({ from: z.string(), to: z.string() }),
    output: z.object({ periodId: z.string(), from: z.string(), to: z.string(), lines: z.number() }),
    http: { method: 'POST', path: '/usage/periods' },
  },

  // ─── The email relay ─────────────────────────────────────────────────────────
  //
  // Both operations below are held by `conversation:relay`, which no human role has.
  // The email connection holds it and acts as itself — the same authority seam the
  // Scrive connector uses to record a signature back into a scope.
  //
  // The operations work today. What does not exist yet is the webhook ingress that
  // would call the first one when mail actually arrives.

  /**
   * A message arrived from outside.
   *
   * Idempotent on `emailMessageId`: mail providers redeliver, and a redelivered
   * message must not become a second message in the thread. Thread stitching itself
   * is the connector's job — by the time this is called, the decision about which
   * conversation this belongs to has already been made from the mail headers.
   */
  'ticket0/ingest-message': {
    summary: 'Record a message that arrived from outside',
    permission: 'conversation:relay',
    input: z.object({
      conversationId: z.string().nullable(),
      contactEmail: z.string().email(),
      contactName: z.string().nullable().optional(),
      subject: z.string(),
      bodyText: z.string(),
      bodyHtml: z.string().nullable().optional(),
      emailMessageId: z.string(),
      emailInReplyTo: z.string().nullable().optional(),
    }),
    output: ticket0Entities.message.fields,
    http: { method: 'POST', path: '/relay/inbound' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.message-ingested',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'author_kind', 'visibility'],
    },
  },

  /**
   * Read an outbound message's body, at send time.
   *
   * This exists because `ticket0.reply-requested` carries ids and no body — the body
   * is erasable, and an event cannot carry an erasable field. The relay comes back
   * here to fetch it, which means an erasure between the reply and the send makes
   * the send find nothing. That is the correct outcome and the reason for the shape.
   */
  'ticket0/read-outbound': {
    summary: 'Read a message the relay is about to send',
    permission: 'conversation:relay',
    input: z.object({ messageId: z.string() }),
    output: z.object({
      messageId: z.string(),
      conversationId: z.string(),
      subject: z.string(),
      toEmail: z.string().nullable(),
      fromAddress: z.string(),
      agentName: z.string().nullable(),
      bodyText: z.string().nullable(),
      bodyHtml: z.string().nullable(),
      emailInReplyTo: z.string().nullable(),
    }),
    http: { method: 'GET', path: '/relay/outbound/{messageId}' },
  },

  'ticket0/record-delivery': {
    summary: 'Record that the relay delivered a message',
    permission: 'conversation:relay',
    input: z.object({ messageId: z.string(), emailMessageId: z.string() }),
    output: ticket0Entities.message.fields,
    http: { method: 'POST', path: '/relay/outbound/{messageId}/delivered' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.message-delivered',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'delivered_at'],
    },
  },

  // ─── The widget ──────────────────────────────────────────────────────────────
  //
  // The bottom rung of trust. These narrow rather than checking a key, because what
  // a visitor may see is decided by the session they hold, not by a role anybody
  // granted them.

  /**
   * Where this desk is embeddable — what the widget surface asks the desk BEFORE
   * deciding whether to let a page talk to it at all.
   *
   * It reads the same `desk_settings.allowed_origins` array that `widget-start`
   * refuses out of, which is the point: the browser's answer and the operation's
   * answer come from one row, so a preflight cannot say yes to an origin the
   * operation then refuses. They used to disagree, because the dev server's CORS
   * consulted a boot-time list.
   *
   * Note where it sits on the surface. The route is under `/api` — authenticated,
   * behind `conversation:widget`, a key no human role holds — while the public
   * `/widget/*` surface reaches it by INVOKING it as the desk's own widget service.
   * A visitor can neither call it nor enumerate a desk's origins with it.
   */
  'ticket0/widget-origins': {
    summary: 'The origins this desk may be embedded on',
    permission: 'conversation:widget',
    output: z.object({ origins: z.array(z.string()) }),
    http: { method: 'GET', path: '/widget/origins' },
  },

  /**
   * Open a widget session.
   *
   * `identity` is the middle rung: the host page's SERVER signed the user id with
   * the desk's secret, and the browser passes the signature along without ever
   * holding the secret. A valid signature attaches this session to that contact and
   * its whole history; an absent one gets an anonymous contact — made when they first
   * say something, never before — that can see exactly one conversation; an invalid
   * one is refused.
   *
   * `client` is what the host's transport knew about the browser — user agent,
   * language, and whatever geo the edge attached — already normalised by the
   * adapter (`cloudflareClientContext` on Workers, `clientContextOf` anywhere). It
   * arrives as INPUT because module code has no request to read and must not
   * acquire one; and it is optional because a caller with no transport (a test, a
   * seed) has nothing to say. It is display and triage material, never authority.
   * It is recorded on the opening and travels with it onto the session when the
   * first message binds one.
   */
  'ticket0/widget-start': {
    summary: 'Open a chat session from an embedded widget',
    // The desk's widget service holds this, and nobody else. It is the authority to
    // OPEN a conversation; what the visitor may then do with it is the token.
    permission: 'conversation:widget',
    input: z.object({
      origin: z.string().url(),
      client: clientContext.optional(),
      identity: z
        .object({
          externalId: z.string(),
          email: z.string().email().nullable().optional(),
          displayName: z.string().nullable().optional(),
          signature: z.string(),
        })
        .nullable()
        .optional(),
    }),
    /**
     * No `conversationId`, and that is the point: opening the widget opens nothing.
     * The conversation exists from the first `widget-post`, and the widget reaches it
     * through the session token alone, so it never needed the id.
     */
    output: z.object({
      sessionId: z.string(),
      token: z.string(),
      greeting: z.string(),
      verified: z.boolean(),
      origin: z.string(),
      startedAt: z.string(),
    }),
    http: { method: 'POST', path: '/widget/sessions' },
    emits: {
      entity: 'widgetOpening',
      entityIdFrom: 'sessionId',
      type: 'ticket0.widget-session-started',
      // v2: about the opening rather than a conversation — there is none yet — and
      // `conversationId` left the payload, which is the bump the additive rule asks for.
      schemaVersion: 2,
      piiClass: 'none',
      // Never the token. It is the visitor's whole authority over the thread, and an
      // immutable copy of a capability cannot be revoked. Everything else about the
      // session rides, so a consumer never has to come back and ask.
      payload: ['sessionId', 'verified', 'origin', 'startedAt'],
    },
  },

  'ticket0/widget-post': {
    summary: 'Say something in the widget',
    // The key admits the widget service; the TOKEN decides which conversation. Note
    // what is absent from the input: there is no conversation id to widen.
    permission: 'conversation:widget',
    input: z.object({
      sessionId: z.string(),
      token: z.string(),
      body: z.string().min(1),
    }),
    output: ticket0Entities.message.fields,
    http: { method: 'POST', path: '/widget/sessions/{sessionId}/messages' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.message-ingested',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'author_kind', 'visibility'],
    },
  },

  /**
   * The visitor's view of their own thread.
   *
   * A different operation from `list-messages`, not the same one with a flag: this
   * one returns public messages only, and the distinction between the two is the
   * distinction between a note to a colleague and an email to a customer. One
   * operation with a `visibility` branch is how internal notes leak.
   */
  'ticket0/widget-thread': {
    summary: 'The public messages in this session’s conversation',
    permission: 'conversation:widget',
    input: z.object({ sessionId: z.string(), token: z.string() }),
    output: ticket0Entities.message.fields
      .omit({ author_principal: true })
      .extend({ citations: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          headingPath: z.string(),
        }),
      ) }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/widget/sessions/{sessionId}/messages' },
  },

  // ─── The portal ──────────────────────────────────────────────────────────────

  /**
   * A signed-in customer's own conversations.
   *
   * Nobody holds `conversation:read-own` scope-wide, so this is a per-row proof walk
   * rather than a `WHERE contact_id = ?`. The distinction matters: a WHERE clause is
   * a promise the author remembered to keep, and the walk is one the kernel keeps.
   */
  'ticket0/my-conversations': {
    summary: 'Your own conversations',
    narrows: {
      reason: 'Returns only conversations belonging to the calling contact',
      checks: ['conversation:read-own'],
    },
    output: ticket0Entities.conversation.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/me/conversations' },
  },

  'ticket0/my-messages': {
    summary: 'The public messages on one of your conversations',
    permission: {
      key: 'conversation:read-own',
      entity: 'conversation',
      idFrom: 'conversationId',
    },
    input: z.object({ conversationId: z.string() }),
    output: ticket0Entities.message.fields
      .omit({ author_principal: true })
      .extend({ citations: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          headingPath: z.string(),
        }),
      ) }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/me/conversations/{conversationId}/messages' },
  },

  'ticket0/submit-csat': {
    summary: 'Rate how the conversation went',
    permission: {
      key: 'conversation:read-own',
      entity: 'conversation',
      idFrom: 'conversationId',
    },
    input: z.object({
      conversationId: z.string(),
      score: z.number().int().min(1).max(5),
      comment: z.string().nullable().optional(),
    }),
    output: ticket0Entities.csat.fields,
    http: { method: 'POST', path: '/me/conversations/{conversationId}/csat' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'conversation_id',
      type: 'ticket0.csat-submitted',
      schemaVersion: 1,
      // The comment is erasable and cannot ride; the score alone identifies nobody.
      piiClass: 'none',
      payload: ['conversation_id', 'score'],
    },
  },

  // ─── Notifications ───────────────────────────────────────────────────────────

  'ticket0/my-notifications': {
    summary: 'What you have not read yet',
    // Everyone holds this; the handler scopes to the caller's own principal. It is
    // an actor filter rather than a per-row proof walk, and `narrows` would have
    // claimed a check that does not happen.
    permission: 'notification:read-own',
    output: ticket0Entities.notification.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/me/notifications' },
  },

  'ticket0/mark-notification-read': {
    summary: 'Mark a notification read',
    permission: 'notification:read-own',
    input: z.object({ notificationId: z.string() }),
    output: ticket0Entities.notification.fields,
    http: { method: 'POST', path: '/me/notifications/{notificationId}/read' },
    emits: {
      entity: 'notification',
      entityIdFrom: 'id',
      type: 'ticket0.notification-read',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'principal', 'kind', 'conversation_id', 'read_at', 'created_at'],
    },
  },
});

/**
 * The conversation's state machine, declared once.
 *
 * `on` is an edge — the operation moves the conversation. `allow` is a precondition
 * — the operation is legal here and moves nothing. Most of this app's operations
 * appear under `allow`, because tagging, noting and assigning change no state, and a
 * format with only edges would draw a self-loop for every one of them.
 *
 * The three things worth reading twice:
 *
 *  1. **`resolved` is not terminal.** `ticket0/ingest-message` is an edge out of it,
 *     back to `open` — a customer replying to a resolved conversation reopens it, in
 *     place, with its history. That single edge is why a conversation is not a work
 *     order: a work order's machine is deliberately one-way.
 *  2. **`snoozed` has the same edge**, for the same reason.
 *  3. **What is missing is deliberate.** "A conversation may not be resolved before a
 *     public reply has been sent" is a condition, and an edge cannot carry one. That
 *     rule is a guard, wired in the manifest and evaluated inside `ticket0/resolve`'s
 *     own transaction. The moment an edge can carry a condition, this is BPMN.
 */
export const ticket0Lifecycles = defineLifecycles(
  ticket0Entities,
  ticket0Operations,
)({
  conversation: {
    field: 'state',
    initial: 'new',
    states: {
      new: {
        on: {
          'ticket0/post-public-reply': 'open',
          'ticket0/assign': 'open',
          'ticket0/resolve': 'resolved',
        },
        allow: [
          'ticket0/post-note',
          'ticket0/record-answer',
          'ticket0/record-assistant-failure',
          'ticket0/ingest-message',
          'ticket0/widget-post',
          'ticket0/tag-conversation',
          'ticket0/untag-conversation',
          'ticket0/set-priority',
          'ticket0/merge',
        ],
      },
      open: {
        on: {
          'ticket0/snooze': 'snoozed',
          'ticket0/resolve': 'resolved',
        },
        allow: [
          'ticket0/post-public-reply',
          'ticket0/post-note',
          'ticket0/record-answer',
          'ticket0/record-assistant-failure',
          'ticket0/ingest-message',
          'ticket0/widget-post',
          'ticket0/assign',
          'ticket0/tag-conversation',
          'ticket0/untag-conversation',
          'ticket0/set-priority',
          'ticket0/merge',
        ],
      },
      snoozed: {
        on: {
          'ticket0/wake': 'open',
          'ticket0/ingest-message': 'open',
          'ticket0/widget-post': 'open',
          'ticket0/resolve': 'resolved',
        },
        allow: [
          'ticket0/post-note',
          'ticket0/tag-conversation',
          'ticket0/untag-conversation',
          'ticket0/assign',
          'ticket0/set-priority',
        ],
      },
      resolved: {
        on: {
          'ticket0/close': 'closed',
          'ticket0/ingest-message': 'open',
          'ticket0/widget-post': 'open',
          'ticket0/post-public-reply': 'open',
        },
        allow: [
          'ticket0/post-note',
          'ticket0/tag-conversation',
          'ticket0/untag-conversation',
          'ticket0/set-priority',
          'ticket0/submit-csat',
        ],
      },
      closed: { terminal: true },
    },
  },
});

export const ticket0Model = emitModel(ticket0Entities, { lifecycles: ticket0Lifecycles });
