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
  instant,
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
 * The longest `LIKE` pattern a hosted desk's SQLite accepts, in bytes (#1655).
 *
 * A Durable Object's SQLite refuses any pattern longer than this with `LIKE or GLOB
 * pattern too complex`, where Node's allows 50 000 — so a search that fails on every
 * hosted desk passes every suite on the node host. It is a limit on UTF-8 BYTES of
 * the pattern as sent, which is why the bound on a search term below is a refinement
 * and not a `.max()`: `.max()` counts UTF-16 units, and `å`, `ä` and `ö` are two bytes
 * each, an emoji four.
 */
export const LIKE_PATTERN_MAX_BYTES = 50;

/**
 * A caller's term, as a `LIKE` pattern that means what they typed.
 *
 * `%` and `_` are wildcards inside a pattern, so a search for `100%` matches
 * everything beginning `100` unless they are escaped, and `_` silently matches any
 * character at all. The backslash is escaped first, or escaping the other two would
 * turn a literal backslash into an escape. Every query built from this says
 * `ESCAPE '\'`, which is what makes the escaping mean anything.
 *
 * The match is case-insensitive because SQLite's `LIKE` is, for ASCII, by default —
 * so `lower()` on both sides would buy nothing here and only hide where the
 * behaviour comes from.
 *
 * It lives beside the model, not in the module, because the bound on a term is judged
 * on THIS string — the escaped, wrapped pattern that is sent — and the two must never
 * be able to drift apart.
 */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * A search term: two characters at least, and a pattern a hosted desk can run.
 *
 * Two characters, the same floor `search-kb` takes: a one-character `LIKE '%a%'` is a
 * table scan whose answer is "everyone", which is not a lookup.
 *
 * The ceiling is `byteLength(likeTerm(q)) <= LIKE_PATTERN_MAX_BYTES`. That is the
 * pattern actually sent, so the two `%` wrappers and the escape byte in front of every
 * `%`, `_` or `\` in the term all count: 48 bytes for a term with none of them, fewer
 * for one with. Refused at the door as `validation_failed`, a 400 naming the limit —
 * on a hosted desk the same input is otherwise a 500 out of the database.
 * Not applied to `search-kb`, which asks the FTS index through `ctx.search` and
 * builds no `LIKE`.
 */
export const searchTerm = z
  .string()
  .min(2)
  .refine((q) => new TextEncoder().encode(likeTerm(q)).length <= LIKE_PATTERN_MAX_BYTES, {
    message:
      `a search term is at most ${LIKE_PATTERN_MAX_BYTES - 2} bytes of UTF-8 (a hosted desk's ` +
      `database refuses a longer LIKE pattern), and each %, _ or \\ in it counts twice — ` +
      'a character outside ASCII is two to four bytes',
  })
  .describe(
    `Two characters at least. At most ${LIKE_PATTERN_MAX_BYTES - 2} bytes of UTF-8, ` +
      'each %, _ or \\ counting twice — a longer term is a 400.',
  );

/**
 * How much of a failure's reason a turn keeps. A provider's error body can be a page
 * of HTML; the first two thousand characters carry the status line and the sentence
 * after it, which is what a person reading the card needs. The harness truncates to
 * this BEFORE recording — a reason too long to record would otherwise turn a
 * recordable failure into an unrecorded one, which is the silence this exists to end.
 */
export const ASSISTANT_ERROR_MAX = 2000;

/**
 * How many people the desk report names. A desk has staff, not a population, and the
 * per-agent breakdown is a leaderboard rather than a directory — an uncapped group-by
 * inside an aggregate is a page nobody declared, discovered in production.
 */
/**
 * How long the free-text box on a signup form may be.
 *
 * Generous for a sentence about what somebody is building, and short of the point
 * where the field becomes a place to paste a document into a table whose contents a
 * human reads one row at a time.
 */
export const SIGNUP_NOTE_MAX = 2000;

/**
 * How long one address must wait before a second submission re-sends its confirmation.
 *
 * A public form that sends mail is a mail cannon aimed at whoever the caller names, so
 * this is the part that stops it being one for a single victim. `SIGNUP_HOURLY_MAX`
 * below is the other half — the one that stops it being one for a list of them.
 */
export const SIGNUP_RESEND_SECONDS = 120;

/**
 * How many NEW addresses one desk will take in an hour.
 *
 * A ceiling rather than a rate limiter: it bounds how much mail a scripted flood can
 * make the platform send before a human notices, and it is set far above what a real
 * launch week produces. Re-submissions of an address already on the list do not count
 * against it — those are governed by `SIGNUP_RESEND_SECONDS` and send at most one mail
 * each.
 */
export const SIGNUP_HOURLY_MAX = 200;

/**
 * The longest a block rule's value may be (#1088).
 *
 * An address, a domain or a ULID — none of them approaches this. It is a ceiling on
 * what a public door's abuser can make an admin paste into a table, not a rule about
 * what a real address looks like: the shape of an address is `z.string().email()`'s
 * business at the point of use, and this table also holds domains and ids, which are
 * neither.
 */
export const BLOCK_VALUE_MAX = 320;

/** How much of a reason the row keeps. A sentence about why, never a case file. */
export const BLOCK_REASON_MAX = 500;

export const DESK_METRICS_AGENTS = 25;

/** The window `ticket0/desk-metrics` reports when the caller names neither end. */
export const DESK_METRICS_WINDOW_DAYS = 30;

/**
 * The widest window it will report at all.
 *
 * The operation runs half a dozen aggregates over the conversation, message, CSAT and
 * turn tables, and every one of them is bounded only by the range the caller picked. A
 * report is a question about a period — a year at the outside — so an unbounded one is
 * a full history scan behind a key an admin holds, and it is refused rather than served
 * slowly. A caller who genuinely wants more asks for it a year at a time.
 */
export const DESK_METRICS_MAX_DAYS = 366;

/**
 * The longest service-level target a desk may set, in minutes: a year (#1082).
 *
 * A ceiling on a typo rather than an opinion about support. A promise measured in
 * years is not a promise anybody escalates on, and a number past this is somebody who
 * meant hours and typed minutes the other way round. The floor is one minute, stated
 * where the schema is: a target of zero is breached by the conversation arriving.
 */
export const SLA_TARGET_MAX_MINUTES = 525_600;

/**
 * Everything a saved reply may say about the conversation it is being pasted into.
 *
 * A CLOSED set, and that is the decision rather than an unfinished start. A template
 * language a tenant authors is a different and much larger thing: it needs a parser,
 * an evaluation budget, an escaping story, and an answer for what happens when the
 * expression reads a column the caller cannot see. Four names, resolved by four
 * explicit reads in `ticket0/render-saved-reply`, need none of that — and each one is
 * a fact the agent pasting the reply is already entitled to read on that screen.
 *
 * A token outside this set is left in the text VERBATIM and named in `unresolved`. It
 * is not an error: a canned answer about CSS may legitimately contain `{{ … }}`, and
 * refusing it would make the substitution feature break unrelated snippets. Silently
 * deleting it would be worse, since the agent would send a sentence with a hole in it.
 */
export const SAVED_REPLY_VARIABLES = [
  'agent.name',
  'agent.signature',
  'contact.name',
  'conversation.subject',
] as const;

/**
 * What a placeholder looks like: `{{name}}`, with optional inner whitespace.
 *
 * Deliberately narrow — letters, digits, `_` and `.` only — so the pattern cannot
 * swallow a JSON or CSS brace pair that happens to sit in a canned answer about
 * either. Declared here beside the variable list because a renderer and a screen
 * that highlights placeholders must agree about what one is.
 *
 * A FUNCTION rather than a shared constant on purpose: a `/g` regular expression
 * carries a mutable `lastIndex`, so a single shared one gives whichever caller runs
 * second a different answer to the same question.
 */
export function savedReplyToken(): RegExp {
  return /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
}

/**
 * What a saved reply may DO besides say something (#1087): the action bag that makes a
 * canned answer a macro.
 *
 * Each action is one of this desk's own operations with the conversation left out, and
 * that is the design rather than a convenience. `tag` is `ticket0/tag-conversation`,
 * `set-priority` is `ticket0/set-priority`, and so on. `MACRO_ACTION_OPERATIONS` below
 * names the operation for every action, and applying a macro RUNS that operation, with
 * its own permission check, its own lifecycle step and its own event. So an action
 * cannot do anything its manual counterpart would not, and it cannot need a key that
 * counterpart does not declare.
 *
 * A CLOSED set, for `SAVED_REPLY_VARIABLES`' reason: every entry is an operation a
 * reviewer has already read. Adding one means adding a member here and an entry in
 * `MACRO_ACTION_OPERATIONS`, and the `satisfies` there makes forgetting the second a
 * compile error. `.strict()` on each, so a typo such as `{ type: 'tag', tags: 'x' }` is
 * refused at save time instead of saving a macro that does nothing.
 */
export const macroAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tag: z.string().min(1) }).strict(),
  z.object({ type: z.literal('set-priority'), priority: z.enum(['low', 'normal', 'urgent']) }).strict(),
  // `null` is "nobody", as it is on `ticket0/assign`. The principal is checked against
  // the directory when the macro is APPLIED, by that operation, not when it is saved:
  // a colleague can leave the desk between the two.
  z.object({ type: z.literal('assign'), assignee: z.string().nullable() }).strict(),
  z.object({ type: z.literal('resolve') }).strict(),
]);
export type MacroAction = z.infer<typeof macroAction>;

/** How many actions one macro may carry. A macro is one click on one ticket, not a script. */
export const MACRO_ACTIONS_MAX = 10;

/** The bag, as a saved reply's input and output carry it. */
export const macroActions = z.array(macroAction).max(MACRO_ACTIONS_MAX);

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

/**
 * One service-level target per priority, in whole minutes (#1082). A priority left
 * out has no target, so a desk can hold `urgent` to an hour and promise nothing about
 * `low`.
 */
const slaTargetMinutes = z.number().int().min(1).max(SLA_TARGET_MAX_MINUTES);
const slaTargetsByPriority = z
  .object({
    low: slaTargetMinutes.optional(),
    normal: slaTargetMinutes.optional(),
    urgent: slaTargetMinutes.optional(),
  })
  .strict();

/**
 * Everything `desk_settings.settings` may say — the built-in behaviours a desk switches
 * on, one key each (#1083).
 *
 * A CLOSED set, and that is the decision rather than an unfinished start. The issue
 * asked for tenant-authored rules; the answer was a fixed set of behaviours, because a
 * condition language evaluated inside a scope is a security surface and a support burden
 * before it has done anything, and because narrowing even one of them — by channel, say
 * — would already be a rule. So there are no conditions here, only switches, and each
 * behaviour behind one is code a reviewer read.
 *
 * `.strict()` because this is also what `ticket0/configure-desk` accepts, and a typo
 * like `roundrobin: true` that saved cleanly and switched nothing on is the one failure
 * a settings screen cannot show anybody.
 *
 * Every key is optional and absent means off. Adding a behaviour is adding a key: no
 * column, no migration.
 */
export const deskSettingsBlob = z
  .object({
    /**
     * Hand every conversation nobody has picked up to the next person on the desk, in
     * turn. Swept by `ticket0/assign-round-robin`; `src/module.ts` says who counts as
     * "nobody has picked up" and who counts as "the next person".
     */
    roundRobin: z.boolean().optional(),
    /**
     * The desk's service levels (#1082): how long a conversation of each priority may
     * wait for its first response, and for its resolution.
     *
     * Absent or `null` is a desk with no service levels, and nothing is ever breached
     * on it. `null` is what switches them off again, because this key is set whole: a
     * call that names `sla` replaces every target in it, and one that leaves `sla` out
     * keeps them, as for every key here.
     *
     * A target is stamped onto the conversation as an instant (`first_response_due_at`,
     * `resolution_due_at`) when the conversation arrives and again when its priority
     * changes. So editing these numbers moves nothing that has already been promised.
     * Swept by `ticket0/escalate-sla-breaches`; `src/module.ts` says what counts as a
     * first response and what counts as resolved.
     */
    sla: z
      .object({
        firstResponseMinutes: slaTargetsByPriority.optional(),
        resolutionMinutes: slaTargetsByPriority.optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

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
   *
   * `follows` is the other self-reference and points the other way: this conversation
   * was started by a customer writing into one that had already been CLOSED. The two
   * are not the same fact and must not share a column — a merge says these were always
   * one conversation, a follow-up says the first one is over and this is the next one.
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
      /**
       * When the snooze in progress began, and how long every finished snooze lasted in
       * total, in milliseconds (#1648). Facts about the conversation, not about service
       * levels: which target a snooze pauses is a rule in `src/module.ts` (today the
       * resolution target, never first response), and these two are what that rule reads.
       *
       * `snoozed_at` is written by the one place that moves `state` (`moveTo`), on the way
       * INTO `snoozed`, and cleared on every way out, where the length of the snooze is
       * added to `snoozed_ms`. So it is non-null exactly while a snooze is in progress
       * that began after this column existed. A conversation already snoozed when it was
       * added has a null here, and its clock runs through that one snooze as it always
       * did; its next snooze pauses.
       *
       * `snoozed_ms` is kept so a priority change, which re-aims a running target from
       * `created_at`, re-aims it past the time already spent parked instead of throwing
       * that time away. Null is zero.
       */
      snoozed_at: z.string().nullable(),
      snoozed_ms: z.number().int().nullable(),
      first_public_reply_at: z.string().nullable(),
      /**
       * When somebody's name was first put on this conversation — and never cleared
       * (#1083).
       *
       * `assignee` says who holds it NOW, and null there means two different things: a
       * conversation nobody has ever picked up, and one a person deliberately put back.
       * Round-robin must hand out the first and leave the second alone, or an agent who
       * unassigns a thread watches the next sweep give it straight back to somebody. This
       * column is what tells them apart. It is written by the one body both assignment
       * doors run, so a manual assign and a round-robin one stamp it the same way, and
       * unassigning leaves it where it was.
       *
       * Null on every row that predates the column — including one somebody assigned
       * and then unassigned before it existed, which the column cannot know about.
       * Round-robin reads such a row as never assigned and may hand it out once. A row
       * that is assigned NOW is protected by `assignee` either way. Back-filling from
       * the event log would close the gap, but it would make the audit spine the source
       * of a business rule, so it was not done.
       */
      first_assigned_at: z.string().nullable(),
      resolved_at: z.string().nullable(),
      /**
       * When this conversation's first response is owed, and when it will have been
       * resolved late (#1082). Both are the desk's targets (`deskSettingsBlob.sla`),
       * turned into instants counted from `created_at`.
       *
       * They are written onto the row, not worked out from the desk's settings each time
       * they are needed, and that is a promise kept rather than a cache. The target a
       * conversation is held to is the one in force when its priority was decided: when
       * it arrived, and again when somebody changes its priority. An admin who tightens
       * the targets on Tuesday does not make Monday's mail late after the fact.
       *
       * Null is NO target, and a conversation with no target is never breached. That
       * covers a desk with no service levels, a priority the desk set no target for, and
       * every row older than these columns: nothing is back-filled, so a desk's backlog
       * does not breach all at once the day this ships.
       */
      first_response_due_at: z.string().nullable(),
      resolution_due_at: z.string().nullable(),
      /**
       * When the desk recorded that the target was missed. Stamped ONCE and never
       * cleared, by whichever notices first: `ticket0/escalate-sla-breaches` while the
       * conversation is still waiting, or a priority change that would otherwise re-aim
       * the missed target (both of these tell the desk), or the public reply or resolve
       * that meets the target late (which tells nobody, because it is done). Every door
       * reads one definition of late, strictly after the due instant, so a miss is on
       * record whether or not a sweep ran in between.
       *
       * This is when the desk NOTICED. It is not when the conversation became late:
       * that is the `_due_at` beside it. The stamp is also why a breach is announced
       * exactly once. A conversation already carrying one is not in the sweep's scan, so
       * a second run finds nothing to tell anybody.
       *
       * A breach is history. Answering afterwards does not clear it, and neither does a
       * priority change: the promise was missed when it was missed.
       */
      first_response_breached_at: z.string().nullable(),
      resolution_breached_at: z.string().nullable(),
      merged_into: z.string().nullable(),
      follows: z.string().nullable(),
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
      /**
       * The action bag (#1087), as JSON: a `macroActions` array. It is never read as
       * a string anywhere outside `src/module.ts`. Every operation hands it out parsed
       * (`savedReplyPublic`).
       *
       * Null is a reply with no actions, and so is every row older than the column.
       * Nothing is back-filled, so every existing canned answer stays text only.
       */
      actions: z.string().nullable(),
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
      /**
       * May the assistant answer a customer directly, or does a person send?
       *
       * 1 = the desk answers as `assistant-autonomous`; anything else = SUPERVISED,
       * the default and what a desk that has never decided gets. Nullable because it
       * arrived after the table shipped and SQLite cannot add a required column to a
       * table holding rows — and the null reads correctly: nobody has decided yet, so
       * the desk keeps a human in the loop.
       *
       * The column does not itself enforce anything. It picks WHICH service principal
       * the host answers as, and the kernel then decides what that principal may do —
       * `assistant` holds no `conversation:reply-public` and `assistant-autonomous`
       * does. A flipped flag with no matching principal grants nothing.
       */
      assistant_autonomous: z.number().nullable(),
      /**
       * How many days of SILENCE before `ticket0/reap-abandoned` closes a conversation
       * nobody ever picked up (#1088).
       *
       * Null is the desk that has never said, and it reads as the platform's thirty —
       * the window the reaper shipped with, so a desk that was reaping at thirty the
       * day before this column existed is still reaping at thirty the day after.
       * Nullable for the same two reasons `assistant_autonomous` is: it arrived after
       * the table shipped, and the absence means something on its own.
       *
       * Days rather than an instant, because what the desk is choosing is a LENGTH of
       * silence it will tolerate, and the sweep measures that against `updated_at`
       * every time it runs. Not named `retention`: nothing here is deleted. The row,
       * its messages and the contact all stay — the conversation leaves the inbox.
       */
      abandoned_after_days: z.number().nullable(),
      /**
       * The desk's switches, as one JSON object (#1083) — `deskSettingsBlob` above says
       * which keys exist.
       *
       * One column rather than a column per switch, and that is the whole reason it is
       * here. Every setting before it was a column, and a column on a table that has
       * shipped is a migration, which is a human checkpoint: a boolean cost the same
       * review as a new table. The built-in behaviours a desk turns on one at a time
       * (#1083 chose those over a rule language) would each have paid it again. This
       * pays it once; the next switch is a key in `deskSettingsBlob` and no DDL.
       *
       * Null is a desk that has switched nothing on, and every behaviour reads it as
       * off. Nothing is back-filled, so every desk that existed before the column
       * behaves exactly as it did the day before.
       */
      settings: z.string().nullable(),
      /**
       * Where round-robin stands: the principal it last handed a conversation to.
       *
       * State the sweep keeps, not a setting anybody chose — which is why it is its own
       * column rather than a key in `settings`, and why neither desk read returns it. A
       * setting and a cursor in one blob would have `configure-desk` and the sweep both
       * writing the same value for different reasons, and the desk read showing
       * bookkeeping as though somebody had decided it.
       */
      round_robin_last: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  },

  /**
   * One sender this desk refuses, checked before it spends anything on them (#1088).
   *
   * ## Its own table rather than a column on `deskSettings`
   *
   * A JSON array on the desk row was the cheaper shape and it gets two things wrong,
   * both of which are the whole reason a desk keeps a list like this:
   *
   *  1. **Removing one rule would be a read-modify-write of every rule.** Two admins
   *     unblocking two different people in the same minute, and one of them is silently
   *     back. Here a removal is a `DELETE` of one row and touches nothing else.
   *  2. **"Who added this, and when" would have nowhere to live.** A blocklist is a
   *     record of decisions somebody made about named people, and the first question
   *     asked of a wrong one is who made it. `created_by` and `created_at` are columns
   *     because that question has to be answerable months later.
   *
   * ## What it is keyed on, and what it deliberately is not
   *
   * Three kinds, and each is something the desk actually holds at the moment it has to
   * decide:
   *
   *  - `email` — one address, lower-cased the way `addressKey` keys every other address
   *    in this desk. What inbound mail carries.
   *  - `domain` — everything after the `@`, and its sub-domains. One rule for a whole
   *    throwaway-mailbox provider, which is the shape abuse from email actually takes.
   *  - `contact` — a contact id. The only handle the WIDGET has: an anonymous visitor
   *    types no address, and per the client-context seam there is deliberately no IP to
   *    key on. It bites from the visitor's second message onwards, and on every later
   *    session of a visitor the host site vouched for.
   *
   * **No `origin` kind**, and that is a decision rather than an omission: refusing an
   * origin is what `desk_settings.allowed_origins` already does, and an origin rule
   * beside it would be a second place to say the same thing — which is how the two come
   * to disagree. The issue asks for one because the allowlist is blunt; it is blunt for
   * origins in exactly the way this table is precise for senders, and nothing here
   * makes a per-site widget less all-or-nothing.
   *
   * ## `value` is NOT `erasable`, and that is the uncomfortable half
   *
   * `contact.email` is erasable; this is the same address written down again, and it
   * stays. A suppression list that erasure empties silently starts accepting the person
   * it was built to refuse, which is the one failure mode worse than holding the row.
   * The cost is real and is stated rather than hidden: erasing a contact leaves their
   * address legible here, reachable by whoever holds `desk:configure`. A human should
   * agree with that before it ships.
   */
  blockRule: {
    table: 'ticket0_block_rules',
    fields: z.object({
      id: z.string(),
      kind: z.enum(['email', 'domain', 'contact']),
      /** Normalised by the handler that writes it — never whatever was typed. */
      value: z.string(),
      /** Why, in the words of whoever decided. Null when they said nothing. */
      reason: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    // One rule per (kind, value): blocking an address twice is the same decision made
    // twice, and two rows would mean removing it once leaves it in force.
    key: ['kind', 'value'],
  },

  /**
   * Where knowledge-base articles come from.
   *
   * `refresh_token_hash`, never the token. A source may carry ONE refresh hook — the
   * credential a docs pipeline presents to say "I just published, re-read me" — and it
   * is stored the way every other token in this desk is: hashed, shown once at mint,
   * and omitted from every operation that returns this row. `refresh_token_hint` is the
   * tail of the token, which is not a secret and is the only way a person looking at
   * two desks can tell which hook they are holding.
   *
   * `token_last_used_at` is the column that earns its place: a hook that silently
   * stopped firing is exactly how a knowledge base goes stale without anyone noticing,
   * and this is what puts that on the screen instead of in a wrong answer.
   */
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
      refresh_token_hash: z.string().nullable(),
      refresh_token_hint: z.string().nullable(),
      token_created_at: z.string().nullable(),
      token_last_used_at: z.string().nullable(),
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

  /**
   * Somebody who asked to be told something — a place on a waiting list, or the
   * weekly changelog by email.
   *
   * The two are ONE table because they differ in a single word — what was asked for —
   * and agree on everything that is hard: an address, where it was typed, and what its
   * owner has consented to. Two tables would be two copies of the consent rules, and
   * consent is the part that must not be got wrong twice.
   *
   * `state` is a real column with a declared machine, which is the opposite of what
   * `contact` above does with its rungs of trust, and the difference is the point. A
   * contact's rung is a fact about what was PROVEN, and nothing moves through it. A
   * signup genuinely moves — asked, confirmed, gone — each move is something a person
   * did, and each is a thing the record has to be able to show afterwards.
   *
   * `key: ['kind', 'email']` — one address may be on both lists, and is on neither
   * twice. So a second submission finds the row that already exists rather than
   * sending a second confirmation to somebody who is already holding one.
   *
   * `email` and `note` are `erasable`, and that is most of why this table belongs in a
   * vertical rather than in whatever form service was the alternative: it makes the
   * address uncarryable by any event, and reachable by the erasure the desk already
   * has. What the events carry is the id, the kind and the state — never the person.
   */
  signup: {
    table: 'ticket0_signups',
    fields: z.object({
      id: z.string(),
      kind: z.enum(['waitlist', 'newsletter']),
      email: z.string(),
      /** Whatever they typed in the free-text box — theirs, so erasable with the address. */
      note: z.string().nullable(),
      state: z.enum(['pending', 'confirmed', 'unsubscribed']),
      /** The page it was typed on: a real origin, checked against the desk's allowlist. */
      origin: z.string(),
      /**
       * The confirm token as a HASH, and it is nulled the moment it is spent — so a
       * confirmation link works exactly once rather than becoming a permanent
       * re-confirm door, and a spent link is indistinguishable from a forged one.
       *
       * This is the high-value capability in the row: it manufactures a record that
       * somebody consented. A plaintext copy at rest would let anybody holding the
       * table forge that consent for every pending address at once, which is the one
       * thing double opt-in exists to make impossible.
       */
      confirm_token_hash: z.string().nullable(),
      /**
       * The unsubscribe token in PLAINTEXT, and the asymmetry with the line above is
       * deliberate rather than an oversight.
       *
       * Two reasons, and the second is the one that decides it:
       *
       *  1. It is the lowest-value capability here. All it can do is take an address
       *     off a mailing list. Anybody holding a copy of this table already holds
       *     every address in it, which is strictly worse than being able to
       *     unsubscribe them — so hashing buys close to nothing.
       *  2. It has to be READ BACK, forever. Every issue sent to this person needs an
       *     unsubscribe link for them, and a hash cannot produce one. Hashing it made
       *     the link unbuildable: the token was minted, digested and dropped on the
       *     floor, so the "unsubscribe link that always works" the signup form
       *     promises could never have been put in an email.
       *
       * It is never nulled, for the reason the promise implies: the link is read out
       * of a mail archive years later by somebody who is annoyed, and a link that has
       * expired is a complaint. It is safe to leave live precisely because removal is
       * the only thing it does.
       */
      unsubscribe_token: z.string(),
      /**
       * When they last asked, beside `created_at`'s when-this-row-first-appeared.
       * They differ after somebody unsubscribes and later signs up again, which is a
       * thing people do and a thing this table should be able to say happened.
       */
      requested_at: z.string(),
      confirmed_at: z.string().nullable(),
      unsubscribed_at: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['kind', 'email'],
    erasable: ['email', 'note'],
  },
});

/**
 * Eighteen keys of ticket0's own, and the interesting ones are the last three.
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
 *
 * One array, two readers, and that is what makes it checked (#1208). `defineOperations`
 * takes it below as the union a mistyped `permission:` fails against; `definePermissions`
 * in `src/provision.ts` takes the SAME array as `keys` and throws at module load if it and
 * `MODULES` disagree in either direction. That is why the four `metering:*` keys are here:
 * they are the ENGINE's, declared by `@substrat-run/engine-metering`, and a ticket0 scope
 * declares them because `MODULES` registers that engine. Listing them is the vocabulary an
 * operation's `permission` may draw on, not a second declaration of who owns the key.
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
  /**
   * Record that a conversation has missed a service-level target, and tell the desk
   * (#1082).
   *
   * Its own key rather than `conversation:assign`, which the two other sweeps hold,
   * because the audit trail records the key a check passed. A breach recorded under
   * `assign` would read as an assignment, and nothing about it is one. No person's role
   * holds this key: only the desk's own schedule does, so the key is the whole of what
   * that schedule may do, and revoking the one tuple turns SLA escalation off for one
   * desk.
   */
  'conversation:escalate',
  'contact:read',
  'kb:read',
  'kb:manage',
  /**
   * Re-read a source and write what it found — the mechanical half of `kb:manage`.
   *
   * Its own key so the refresh hook's service principal can hold ONE thing. `kb:manage`
   * also adds and re-points sources, and a principal reachable from a public door
   * holding THAT could aim the desk's knowledge base at a site of its own choosing —
   * which is answer-poisoning, the failure this desk exists to avoid. Same argument as
   * the two service accounts behind the widget and the signup form: each door holds
   * exactly one key.
   */
  'kb:refresh',
  'desk:configure',
  'usage:read',
  'notification:read-own',
  'signup:submit',
  'signup:read',
  // @substrat-run/engine-metering — the engine ticket0 meters its assistant spend with.
  'metering:read',
  'metering:record',
  'metering:configure',
  'metering:close',
] as const;

/**
 * A source as anyone may read it: everything except the hook's hash.
 *
 * Declared once rather than omitted per operation, because "every read of this table
 * drops that column" is the property, and four independent `.omit()`s are four chances
 * to forget the fifth. `refresh_token_hint` deliberately stays — it is the tail of the
 * token, and a person holding two hooks needs to know which one this row is.
 */
const kbSourcePublic = ticket0Entities.kbSource.fields.omit({ refresh_token_hash: true });

/**
 * The desk as its admin reads it: everything except the secret and the sweep's cursor.
 *
 * Declared once for the reason `kbSourcePublic` is. The secret is omitted because it is
 * shown exactly once, by `rotate-verification-secret`. `round_robin_last` is omitted
 * because it is bookkeeping rather than a setting: publishing it would freeze a cursor
 * into the API contract for a reader nobody has.
 */
const deskPublic = ticket0Entities.deskSettings.fields.omit({
  verification_secret: true,
  round_robin_last: true,
});

/**
 * A saved reply as every operation hands it out: the action bag parsed, never the JSON
 * text it is stored as. Declared once for `kbSourcePublic`'s reason.
 */
const savedReplyPublic = ticket0Entities.savedReply.fields
  .omit({ actions: true })
  .extend({ actions: macroActions });

export const ticket0Operations = defineOperations(ticket0Entities, TICKET0_PERMISSIONS)({
  // ─── The desk ────────────────────────────────────────────────────────────────

  'ticket0/get-desk': {
    summary: 'The desk’s settings',
    permission: 'desk:configure',
    output: deskPublic,
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
      /**
       * Hand the assistant the autonomous role, or take it back. Optional with a
       * behaviour-preserving absence, like every other field here: a desk that does
       * not mention it keeps whatever it had, and one that has never mentioned it is
       * supervised.
       */
      assistantAutonomous: z.boolean().optional(),
      /**
       * How long this desk leaves an untouched conversation before the sweep closes
       * it, in days — or `null` to hand the decision back to the platform's thirty.
       *
       * Three states on purpose, the same three `businessHours` has: absent keeps
       * whatever the desk had, `null` clears the desk's own answer, and a number is
       * the desk's answer. Without the middle one there is no way back to the default
       * once a desk has typed a number over it.
       *
       * Bounded at both ends, and each bound is about what `closed` costs: it is
       * TERMINAL in the declared lifecycle, so a conversation this sweep takes cannot
       * be re-opened. A zero would close mail that arrived this morning, and the floor
       * of one day is what keeps "reap" from meaning "empty the inbox on the next
       * tick". The ceiling of ten years is where a number stops being a retention
       * window and starts being a way of saying never — which a desk already has, by
       * leaving this null and having its abandoned mail closed at thirty, or by
       * answering the mail.
       */
      abandonedAfterDays: z.number().int().min(1).max(3650).nullable().optional(),
      /**
       * Switch a built-in behaviour on or off (#1083).
       *
       * A patch, key by key. A key the call names is set, and a key it leaves out keeps
       * whatever the desk had. So `{ roundRobin: false }` turns round-robin off and
       * touches nothing else, and a form that only knows today's keys cannot switch
       * off a behaviour a later version added.
       */
      settings: deskSettingsBlob.optional(),
    }),
    output: deskPublic,
    http: { method: 'PATCH', path: '/desk' },
    emits: {
      entity: 'deskSettings',
      entityIdFrom: 'id',
      type: 'ticket0.desk-configured',
      schemaVersion: 1,
      piiClass: 'none',
      // `assistant_autonomous` is on the payload because "this desk was allowed to
      // answer customers unattended" is exactly the kind of thing a trail should
      // carry. Additive to a shipped payload, so no schemaVersion bump —
      // `abandoned_after_days` joins it on the same terms, and for the same reason:
      // it decides what silently leaves this desk's inbox. `settings` joins for the
      // reason both do: a switch that hands conversations to people on its own is
      // a decision the trail should be able to date.
      payload: [
        'id',
        'from_address',
        'allowed_origins',
        'assistant_autonomous',
        'abandoned_after_days',
        'settings',
      ],
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

  // ─── The blocklist ───────────────────────────────────────────────────────────
  //
  // Three operations under `desk:configure`, and no fourth key. Deciding who may
  // reach this desk is the same authority as deciding which sites may embed it and
  // which address it answers from — `allowed_origins` is the blunt version of this
  // very list and already lives there. A `conversation:moderate` key would have been
  // a second answer to "who governs the door", held by the same role, and the second
  // answer is the one that later disagrees.

  'ticket0/list-block-rules': {
    summary: 'Who this desk refuses',
    permission: 'desk:configure',
    input: z.object({ kind: z.enum(['email', 'domain', 'contact']).optional() }),
    output: ticket0Entities.blockRule.fields,
    paged: {
      over: {
        entity: 'blockRule',
        sortable: ['created_at'],
        filterable: ['kind'],
      },
      order: 'desc',
      total: true,
    },
    http: { method: 'GET', path: '/desk/block-rules' },
  },

  /**
   * Stop hearing from someone.
   *
   * `value` is whatever a person typed and is normalised before it is stored — an
   * address is lower-cased, a domain loses a leading `@` and any casing. That happens
   * in the handler rather than here because the schema's job is to say what may be
   * SENT, and refusing `Mailer@Example.com` for its capital M would be a rule about
   * typing rather than about senders.
   *
   * Adding a rule that already exists answers with the rule that already exists, and
   * writes nothing. A second click on Block is the same decision, not a conflict, and
   * a 409 there would be the desk arguing with an admin who agrees with it.
   */
  'ticket0/add-block-rule': {
    summary: 'Refuse a sender',
    permission: 'desk:configure',
    input: z.object({
      kind: z.enum(['email', 'domain', 'contact']),
      value: z.string().min(1).max(BLOCK_VALUE_MAX),
      reason: z.string().max(BLOCK_REASON_MAX).nullable().optional(),
    }),
    output: ticket0Entities.blockRule.fields,
    http: { method: 'POST', path: '/desk/block-rules' },
    emits: {
      entity: 'blockRule',
      entityIdFrom: 'id',
      type: 'ticket0.block-rule-added',
      schemaVersion: 1,
      /**
       * `none`, because `value` is NOT on the payload — and that is the decision, not
       * an oversight about fatness.
       *
       * An event is immutable. Putting the address on it would write a person's
       * direct identifier into the outbox permanently in order to announce that the
       * desk has decided to stop hearing from them, where no erasure can reach it.
       * The same reasoning that keeps a message body off `ticket0.reply-requested`,
       * which is why `ticket0/read-outbound` exists: what the event carries is that a
       * rule changed, which one, and who decided. WHICH SENDER is read back from the
       * table by a caller that holds `desk:configure`, which is exactly the set of
       * people entitled to know.
       */
      piiClass: 'none',
      payload: ['id', 'kind', 'created_by', 'created_at'],
    },
  },

  'ticket0/remove-block-rule': {
    summary: 'Hear from them again',
    permission: 'desk:configure',
    input: z.object({ ruleId: z.string() }),
    output: z.object({ id: z.string(), kind: z.enum(['email', 'domain', 'contact']) }),
    http: { method: 'DELETE', path: '/desk/block-rules/{ruleId}' },
    emits: {
      entity: 'blockRule',
      entityIdFrom: 'id',
      type: 'ticket0.block-rule-removed',
      schemaVersion: 1,
      // Same reason as the add: the id says which rule, and the table says who.
      piiClass: 'none',
      payload: ['id', 'kind'],
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
    output: kbSourcePublic,
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
    output: kbSourcePublic,
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
    permission: { key: 'kb:refresh', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string() }),
    output: kbSourcePublic,
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
    // Not a tool: the harness writes its own result back here — a connector's return path, not a verb.
    mcp: false,
    summary: 'Record the articles an ingest produced',
    permission: { key: 'kb:refresh', entity: 'kbSource', idFrom: 'sourceId' },
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
    // Not a tool: the harness writes its own result back here — a connector's return path, not a verb.
    mcp: false,
    summary: 'Record that a documentation source could not be read',
    permission: { key: 'kb:refresh', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string(), error: z.string().min(1) }),
    output: kbSourcePublic,
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
   * Mint this source's refresh hook, and hand back the token ONCE.
   *
   * The token is the whole authority — there is no id to go with it, because the URL
   * already names the source — so this is the only moment it exists in readable form.
   * The row keeps `sha256` of it and the last six characters; a caller who loses the
   * token mints a new one, which is also how rotation works.
   *
   * One hook per source, deliberately. Two would need names, an expiry each and a UI
   * to manage them, and the thing being authorised is a single mechanical verb — so a
   * second hook is a second mint, and the first stops working the moment it happens.
   */
  'ticket0/mint-kb-refresh-token': {
    summary: 'Mint a refresh hook for a documentation source',
    permission: { key: 'kb:manage', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string() }),
    /**
     * The row with the token added — flat, like every other source-returning operation,
     * so a caller that just minted one holds the same shape it already renders. It is
     * still the public projection underneath: the hash never leaves, not even here.
     */
    output: kbSourcePublic.extend({ token: z.string() }),
    http: { method: 'POST', path: '/kb/sources/{sourceId}/token' },
    /**
     * The event carries the HINT, never the token — an event is the one row in this
     * system designed to be read later by someone who was not there.
     */
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-refresh-token-minted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'url', 'refresh_token_hint'],
    },
  },

  /**
   * Take the hook back. Idempotent: a source with no hook is already in this state.
   */
  'ticket0/revoke-kb-refresh-token': {
    summary: 'Revoke a documentation source’s refresh hook',
    permission: { key: 'kb:manage', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string() }),
    output: kbSourcePublic,
    http: { method: 'DELETE', path: '/kb/sources/{sourceId}/token' },
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-refresh-token-revoked',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'url'],
    },
  },

  /**
   * Spend a refresh hook: is this token this source's, and may it read again yet.
   *
   * The host calls this FIRST, as the desk's `ingest` service, and only runs the read
   * if it returns. So the token check is module code — inside the transaction, against
   * the stored hash, with the throttle read off the same row — rather than a comparison
   * in a route handler that each host would have had its own copy of.
   *
   * Not a tool, and not something a person invokes: the operation exists to be the
   * verification step of one HTTP door.
   */
  'ticket0/redeem-kb-refresh-token': {
    mcp: false,
    summary: 'Verify a refresh hook and record that it was used',
    permission: { key: 'kb:refresh', entity: 'kbSource', idFrom: 'sourceId' },
    input: z.object({ sourceId: z.string(), token: z.string() }),
    output: kbSourcePublic,
    http: { method: 'POST', path: '/kb/sources/{sourceId}/token/redeem' },
    /**
     * A spent hook is an EVENT, like the mint and the revoke beside it. This one
     * writes `token_last_used_at`, and a mutation that leaves no event leaves the
     * one question a hook raises unanswerable from the history: who has been
     * pushing on this door, and when did they stop. The hint identifies WHICH
     * hook without being one — the token itself never enters an event, which is
     * the row most likely to be read later by somebody who was not here.
     */
    emits: {
      entity: 'kbSource',
      entityIdFrom: 'id',
      type: 'ticket0.kb-refresh-hook-redeemed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'url', 'refresh_token_hint', 'token_last_used_at'],
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

  /**
   * Find a person by the address or the name they gave — the top-of-the-app lookup.
   *
   * A separate operation rather than another `filterable` column on the walk below,
   * because `filterable` is equality only and says so: a support agent holds "she
   * wrote from something-at-kestrel" and an `external_id = ?` cannot answer that.
   * `PagedOver` names this exact fork — *"a read that needs more than equality is an
   * operation with its own name and its own arguments"* — so this is that operation.
   *
   * `email` and `display_name` are the desk's two erasable columns, which has a
   * consequence worth stating: an erased contact is unfindable by either, because
   * there is nothing left to match. That is the erasure working, not a gap.
   *
   * `/contacts/search` is a static segment where a sibling read could one day take a
   * parameter, and `mountOperations` already registers static before parameter
   * (`comparePaths`, #785) — so the order here is for a reader, not for the router.
   */
  'ticket0/search-contacts': {
    summary: 'Find a person by email or name',
    permission: 'contact:read',
    // `searchTerm` carries the floor and the ceiling — see there for both.
    input: z.object({ q: searchTerm }),
    output: ticket0Entities.contact.fields,
    // The handler composes its own `LIKE`, so the cursor is read off the ENTRY.
    // Newest first: the person who wrote most recently is the one being looked for.
    paged: { sortKey: 'id', order: 'desc' },
    http: { method: 'GET', path: '/contacts/search' },
  },

  'ticket0/list-contacts': {
    summary: 'The people who have asked something',
    permission: 'contact:read',
    output: ticket0Entities.contact.fields,
    paged: { over: { entity: 'contact', sortable: ['created_at'], filterable: ['external_id'] } },
    http: { method: 'GET', path: '/contacts' },
  },

  // ─── The inbox ───────────────────────────────────────────────────────────────

  'ticket0/list-conversations': {
    summary: 'The desk’s conversations — everything but the closed ones, unless asked',
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
      // Declared last and for the reason the comment above gives: `contact_id` has
      // been `filterable` since the beginning and had no input beside it, so the
      // emitted document advertised a parameter that reached no handler. It is the
      // whole of "what did this customer write last time" — a person found through
      // `search-contacts`, then their history — so it is wired rather than dropped.
      contact_id: z.string().optional(),
      /**
       * The default is NOT "every conversation" — it is every conversation that is
       * not `closed`, and this is the flag that says otherwise.
       *
       * An inbox whose default is literally everything grows monotonically and can
       * never be emptied: closing a thread bumps `updated_at`, so the sort this
       * screen defaults to puts the thing you just got rid of at the top. The
       * exclusion is stated here rather than left to the screen because a default
       * a caller cannot see is a default the API is lying about.
       *
       * `state` still wins when it is given — asking for `state=closed` means
       * closed, flag or no flag. This one only widens the unfiltered read.
       */
      include_closed: z.boolean().optional(),
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

  /**
   * Free text over what the desk holds — the subject, and every message body.
   *
   * The primary navigation an incumbent puts above the inbox, and until now the desk
   * had none: `list-conversations` narrows on six columns and can answer "every open
   * urgent one", never "the thread about the failed export".
   *
   * Three decisions worth reading, because each closes off an obvious alternative.
   *
   * **It is its own operation, not a `q` on the walk.** `paged.over` composes
   * equality predicates and provisions the index behind each one; a `LIKE` over a
   * joined child table is neither, and bolting one on would make `filterable` mean
   * two different things.
   *
   * **It matches with `LIKE`, not with an FTS index.** A `searchables` entry would
   * be better and is what this should become — but it is a kernel-derived FTS5 table
   * and a schema change, and a schema change is a human checkpoint this could not
   * self-approve. So the scan is deliberate and stated rather than quiet: it is
   * bounded by the page, and #1081 keeps the FTS half.
   *
   * **It is staff-only, and that is what makes an internal note searchable.** The key
   * is `conversation:read`, which no customer and no widget principal holds, so notes
   * are matched here and cannot reach `my-conversations` or the widget thread — those
   * are different operations over `visibility = 'public'` and this one does not touch
   * them. A match is the CONVERSATION, never the message, so a hit on a note leaks no
   * part of the note.
   *
   * The same four filters as the walk, so a search inside a filtered inbox stays
   * filtered rather than silently widening to the whole desk.
   *
   * `/conversations/search` does collide with `/conversations/{conversationId}` as a
   * URL, and the host resolves it rather than this declaration doing so: routes mount
   * static-segment-first (`comparePaths`, #785), so `search` cannot be swallowed as an
   * id whatever order they are written in here.
   */
  'ticket0/search-conversations': {
    summary: 'Find a conversation by subject or by what was said in it',
    permission: 'conversation:read',
    input: z.object({
      q: searchTerm,
      state: z.enum(['new', 'open', 'snoozed', 'resolved', 'closed']).optional(),
      assignee: z.string().optional(),
      channel: z.enum(['widget', 'email']).optional(),
      priority: z.enum(['low', 'normal', 'urgent']).optional(),
    }),
    output: ticket0Entities.conversation.fields,
    // `sortKey`, because the handler composes its own SQL. Newest first, like the
    // inbox: the conversation being looked for is nearly always a recent one.
    paged: { sortKey: 'id', order: 'desc' },
    http: { method: 'GET', path: '/conversations/search' },
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
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
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
      /**
       * The drafted turn this reply is sending, if it is sending one.
       *
       * The turn is recorded BEFORE the send and must be — a turn that has been paid
       * for has to survive a refused send. What was missing is the other half: nothing
       * marked it sent afterwards, so an answer the customer had already read stayed
       * `drafted` forever. The draft card offered to send it again, the deflection
       * report counted it unsent, and a "waiting for a person" list would list it.
       *
       * It rides on THIS operation rather than a second one because the two facts must
       * not come apart: a follow-up call that failed after the reply went out would
       * leave the desk saying an answer is waiting that the customer has already read.
       * Same transaction, one act. Optional and behaviour-preserving — a human reply
       * that is not sending a draft names no turn.
       */
      turnId: z.string().optional(),
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
   *
   * Being in the directory is necessary and not sufficient: the assistant is in it
   * too, because its messages need a byline, and the handler refuses it as an
   * assignee for the same reason it refuses a stranger — it reads no notifications,
   * so the conversation would sit with something that never picks it up (#1154).
   * The directory is judged by DISPLAY NAME, because module code cannot ask the
   * kernel which role a principal holds; a row's `kind` would be the honest test and
   * is still open on that issue.
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
   * Round-robin — the first of the desk's built-in behaviours (#1083), and `assign` done
   * by the desk rather than by a person.
   *
   * A SCHEDULE and not an event consumer, which is the decision the rest of this rests on.
   * A consumer runs as an override actor whose every `ctx.check` is allowed
   * unconditionally, on both adapters, and nothing records the authorisation. That is
   * assignment going AROUND the permission a person's `assign` has to pass. A schedule
   * runs as the module's system principal against a real grant — the one provisioning
   * projects from the schedules the manifest declares, which `wake-snoozed` already holds
   * for this same key — so revoking that tuple switches the behaviour off for one desk,
   * and every assignment it makes carries the check it passed and the name of this
   * operation on its event. The trail says which behaviour acted.
   *
   * The price is latency, and it is named rather than hidden: the declared cadence is a
   * floor, and a hosted desk's schedules fire when the platform sweep does. A conversation
   * can therefore wait in the inbox, unassigned and visible, for up to one sweep interval
   * before it has a name on it.
   *
   * Not an HTTP operation, for `wake-snoozed`'s reason: the schedule is its only caller,
   * and a person handing out one conversation has `ticket0/assign`. The permission is a
   * NODE check here because a sweep cannot name its rows in advance, and the handler then
   * makes the per-conversation check `assign` makes before each one it hands out.
   *
   * `output` is a count, so no `emits` here: each conversation it hands out publishes
   * `ticket0.conversation-assigned`, the same event a person's assign publishes, from
   * the same code.
   */
  'ticket0/assign-round-robin': {
    // Not a tool: a schedule's entry point; nothing calls it by hand.
    mcp: false,
    summary: 'Hand each conversation nobody has picked up to the next person in turn',
    permission: 'conversation:assign',
    output: z.object({ assigned: z.number().int() }),
  },

  /**
   * Service levels (#1082): notice that a conversation has missed its first-response or
   * resolution target, record it once, and tell the desk.
   *
   * A SCHEDULE for round-robin's reason. The system principal checks a real grant, and
   * the trail names this operation on every breach it records. The key is
   * `conversation:escalate`, held by this schedule and by no person's role. A person has
   * nothing to call here: a breach is a fact about time passing, and nobody declares one
   * by hand.
   *
   * It does not decide what a target IS. The desk's `sla` settings do that, and the
   * conversation's own `first_response_due_at` / `resolution_due_at` carry the instant it
   * was held to. This only compares those instants with now, for the conversations whose
   * target is still running. `src/module.ts` says what "running" means for each.
   *
   * `output` is a count, so there are no `emits` here: it publishes
   * `ticket0.sla-breached` once per target missed, and the notification it writes is the
   * `escalated` kind the assistant's own hand-offs already use.
   */
  'ticket0/escalate-sla-breaches': {
    // Not a tool: a schedule's entry point; nothing calls it by hand.
    mcp: false,
    summary: 'Record each conversation that missed a response or resolution target, and tell the desk once',
    permission: 'conversation:escalate',
    output: z.object({ breached: z.number().int() }),
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
      // The two due instants joined in #1082, additively, so no schemaVersion bump. A
      // priority change is what re-aims a conversation's service-level targets, and a
      // consumer keeping score of them should not have to read the row to learn where
      // they moved.
      payload: ['id', 'priority', 'state', 'first_response_due_at', 'resolution_due_at'],
    },
  },

  /**
   * `until` is an `instant`, not a string, and that is load-bearing now that a timer
   * reads it (#1082). It validates ISO-8601 and NORMALISES to UTC, so the sweep's
   * `snoozed_until <= ctx.now()` is comparing two canonical instants as text. Left as
   * a bare string, `…T11:00:00+02:00` sorts as though it were 11:00 UTC and the
   * conversation comes back two hours early, while a value that is not a timestamp at
   * all either wakes immediately or never — none of which any test would have caught
   * while the column was only ever displayed.
   */
  'ticket0/snooze': {
    summary: 'Park a conversation until a time',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), until: instant }),
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
   * The timer `snooze` promises.
   *
   * Snooze is the one thing in this desk that is a claim about the FUTURE: park it
   * and it comes back. Without a schedule it came back only when somebody
   * remembered, which is the opposite of what it says — and `notification.kind`
   * declared `snooze-woke` for an event nothing minted (#1082).
   *
   * It is deliberately not an HTTP operation. The schedule the manifest declares is
   * its only caller, invoked under the module's own system actor on the cadence
   * there; a person changing their mind has `ticket0/wake`, which is per-conversation
   * and entity-checked. So the permission is a NODE check of the same key: a sweep
   * acts on whatever is due and cannot name the conversations in advance.
   *
   * `output` is a count, not a conversation, so this declares no `emits` — it emits
   * `ticket0.conversation-woke` per woken conversation instead, the same event
   * `ticket0/wake` publishes. A consumer must not have to care which of the two
   * doors a conversation came back through.
   */
  'ticket0/wake-snoozed': {
    // Not a tool: a schedule's entry point; nothing calls it by hand.
    mcp: false,
    summary: 'Wake every conversation whose snooze has elapsed',
    permission: 'conversation:assign',
    output: z.object({ woke: z.number().int() }),
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

  /**
   * Close, from wherever it stands.
   *
   * Reachable from every non-terminal state, deliberately, and that is a REVERSAL of
   * the original machine — which admitted `closed` only from `resolved`. The reversal
   * is what a desk needs and the old shape could not give: an empty thread, a spam
   * one, a widget session somebody opened and abandoned, is never going to earn a
   * public reply, and `ticket0/resolve` refuses without one. So it could not be
   * resolved and therefore could not be closed — a conversation with no way out of
   * the inbox at all.
   *
   * What the reversal does NOT do is launder a metric. `resolved_at` is written by
   * `ticket0/resolve` and by nothing else, so a conversation closed straight from
   * `new` carries none, and the reports — which count `resolved_at`, not `state` —
   * still count only the conversations somebody actually answered. Closing is the
   * desk saying "not ours to answer"; resolving is the desk saying "answered". The
   * two were conflated only because one was the sole route to the other.
   */
  'ticket0/close': {
    summary: 'Close a conversation for good, answered or not',
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

  /**
   * The reaper concept §9.1 named and nothing ever built (#1088).
   *
   * Two of this desk's doors are open to the whole internet — the widget and the
   * inbox — and each of them mints a conversation from one sentence by someone with
   * no account. A desk that never closes those accumulates them for the rest of its
   * life, and the inbox is where they accumulate: `new` is the state a conversation
   * arrives in and, absent a person, never leaves.
   *
   * So the sweep takes exactly the conversations nobody at the desk ever touched.
   * `new` is that set by construction rather than by a guard: the only two edges out
   * of `new` toward `open` are `ticket0/post-public-reply` and `ticket0/assign`, so a
   * row still in `new` has no public reply and no assignee. The one way a `new`
   * conversation HAS been worked on is an assistant draft, which is an `allow` rather
   * than an edge and so moves nothing; the handler excludes those, and `src/module.ts`
   * says why. Silence is measured on `updated_at`, which every arriving message
   * refreshes through `settle()` — so a customer who writes in again on day 29 resets
   * the window, and the window is about silence rather than about age.
   *
   * It CLOSES. It does not delete, and the difference is the whole of why this is the
   * slice that could be built unattended: closing moves a declared edge and leaves the
   * conversation, its messages and the contact exactly where they are. The retention
   * setting the issue also asked for is not here — a setting is a column, a column is a
   * migration, and a migration is a human checkpoint. The window is a constant in
   * `src/module.ts` beside `WAKE_BATCH`.
   *
   * Not an HTTP operation, for `ticket0/wake-snoozed`'s reason: the declared schedule
   * is its only caller and a person closing one conversation has `ticket0/close`,
   * which is per-conversation and entity-checked. The permission is therefore a NODE
   * check of `conversation:resolve` — the same key `ticket0/close` holds, because this
   * does the same thing to a conversation, and a sweep cannot name its rows in advance.
   *
   * `output` is a count, so no `emits` here: it publishes `ticket0.conversation-closed`
   * per conversation instead, the same event `ticket0/close` publishes. Nothing
   * downstream should have to know whether a person or a timer said "not ours".
   */
  'ticket0/reap-abandoned': {
    // Not a tool: a schedule's entry point; nothing calls it by hand.
    mcp: false,
    summary: 'Close conversations nobody ever picked up and nobody has added to',
    permission: 'conversation:resolve',
    output: z.object({ reaped: z.number().int() }),
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
   * Put a colleague on one thread — the followers half of #1086, at its smallest.
   *
   * The mechanism is the platform's rather than this app's: `ctx.grant` narrows
   * `conversation:read` onto THIS conversation for THIS person, and every read that
   * was already entity-narrowed — `get-conversation`, `list-messages`, the tags, the
   * CSAT — honours it without being told the feature exists. That is the whole reason
   * this adds no table, no column and no permission key: the reads a follower needs
   * narrowed on the conversation before anybody asked for followers.
   *
   * **Who may add one** is `conversation:assign` on that conversation — the key that
   * already decides who WORKS a thread, and the one `assign`, `snooze` and the tags
   * take. Putting a watcher on a conversation is routing; a second key would be one
   * no desk ever grants apart from this one.
   *
   * **Who may BE one** is somebody in the desk's directory — a row
   * `ticket0/list-agents` returns, judged by exactly the test `assign` applies
   * (#1079). A stranger's ULID would otherwise mint a durable grant for a principal
   * nobody at the desk can name, which is the one thing an access decision must not
   * do quietly. The assistant fails it here for the reason it fails as an assignee
   * (#1154): it reads every conversation in the scope already and watches none.
   *
   * **No lifecycle entry, deliberately.** Following is an access decision about a
   * conversation, not work on it, so it takes no `step` and appears in no state's
   * `allow` — the same standing the reads have. A `closed` thread is precisely one
   * you may still need to show a colleague, and a machine that refused there would be
   * answering a question nobody asked it.
   *
   * **What this does NOT do**, both halves needing the side table this slice does not
   * add: nothing can LIST who follows a conversation, and the inbox
   * (`ticket0/list-conversations`) is gated on scope-wide `conversation:read`, which
   * an entity-narrowed grant deliberately does not satisfy — so a follower is not
   * shown the thread in any list and opens it by link. See #1086.
   *
   * Nothing to do with `conversation.follows`, which names the conversation a
   * follow-UP continues.
   */
  'ticket0/follow-conversation': {
    summary: 'Put a colleague on a conversation',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), follower: z.string().min(1) }),
    /**
     * The resulting state, not a row — there is no followers table to return one from,
     * and saying so in the shape is more honest than inventing an id.
     */
    output: z.object({
      conversation_id: z.string(),
      follower: z.string(),
      following: z.boolean(),
    }),
    http: { method: 'POST', path: '/conversations/{conversationId}/followers' },
    emits: {
      // About the CONVERSATION. There is no follower entity to point at, and "somebody
      // was given a read of this thread" is the fact an audit wants anyway.
      entity: 'conversation',
      entityIdFrom: 'conversation_id',
      type: 'ticket0.conversation-followed',
      schemaVersion: 1,
      // A staff principal and nothing else, which is how `ticket0/set-agent-profile`
      // already classifies the same value. The name behind it is in the directory and
      // is erasable there; it may not ride an immutable event.
      piiClass: 'none',
      payload: ['conversation_id', 'follower'],
    },
  },

  /**
   * Take them off again — the revoke half, and the reason a grant is the right
   * mechanism rather than a `ctx.link` edge, which is permanent.
   *
   * **It asks nothing about the person it removes** — not the directory, not the
   * assistant rule. A refusal to ADD somebody withholds access; a refusal to REMOVE
   * them leaves access standing, so only the first is safe to get wrong. Every fact
   * this could test is one the follower controls (`display_name` is set by its own
   * principal, with no reserved names) or one another operation could take away, and
   * either would let a follower's grant become unrevocable. See `src/module.ts`.
   *
   * `following: false` is the resulting STATE, not a `removed` flag like
   * `untag-conversation`'s. The difference is what the kernel can honestly report:
   * untagging reads its row first and knows whether there was one, while `ctx.revoke`
   * is a tombstoning delete that returns nothing, so an app claiming "there was a
   * grant and I took it away" would be claiming something it never learned. Calling
   * this on somebody who never followed is a no-op that says where they now stand.
   */
  'ticket0/unfollow-conversation': {
    summary: 'Take a colleague off a conversation',
    permission: { key: 'conversation:assign', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), follower: z.string().min(1) }),
    output: z.object({
      conversation_id: z.string(),
      follower: z.string(),
      following: z.boolean(),
    }),
    http: { method: 'DELETE', path: '/conversations/{conversationId}/followers/{follower}' },
    emits: {
      entity: 'conversation',
      entityIdFrom: 'conversation_id',
      type: 'ticket0.conversation-unfollowed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['conversation_id', 'follower'],
    },
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

  /**
   * The conversations that carry one tag — the third clause of #1081, and the one
   * `search-conversations` (text) and `search-contacts` (a person) left open.
   *
   * Its own paged read rather than a `tag` entry in `list-conversations`'
   * `filterable`, and the reason is what `filterable` means: an equality predicate on
   * a COLUMN of the walked entity, with an index provisioned behind it. A tag is not a
   * column — it is a row in `ticket0_conversation_tags`, keyed by both halves — so a
   * declared `tag` filter would advertise a narrowing the pager cannot apply. The two
   * alternatives that would make it a column are a denormalized `tags` column (a
   * migration, a human checkpoint) and a join-aware `ctx.page` (a kernel change), and
   * neither belongs in a demo's PR.
   *
   * The match is EXACT, which is the other reason this is not a search: a tag is a
   * word an agent chose from `list-tags`, not a phrase to be found inside. So the
   * floor is one character, the same one `tag-conversation` accepts — a two-character
   * floor here would make a one-character tag writable and unfindable.
   *
   * `/conversations/by-tag` is a static segment beside `/conversations/search`, and
   * the host mounts static before parameter (`comparePaths`, #785), so neither is
   * swallowed as a `{conversationId}`. The tag rides the query string rather than the
   * path because it is free text: a tag with a slash in it is legal, and a path
   * segment is the wrong container for one.
   */
  'ticket0/list-conversations-by-tag': {
    summary: 'The conversations carrying a tag',
    permission: 'conversation:read',
    input: z.object({ tag: z.string().min(1) }),
    output: ticket0Entities.conversation.fields,
    // `sortKey`, because the handler composes its own join. Newest first, like the
    // inbox and the text search.
    paged: { sortKey: 'id', order: 'desc' },
    http: { method: 'GET', path: '/conversations/by-tag' },
  },

  // ─── Saved replies ───────────────────────────────────────────────────────────

  'ticket0/list-saved-replies': {
    summary: 'The desk’s canned answers',
    permission: 'conversation:draft',
    output: savedReplyPublic,
    paged: { over: { entity: 'savedReply', sortable: ['title', 'created_at'] } },
    http: { method: 'GET', path: '/saved-replies' },
  },

  'ticket0/create-saved-reply': {
    summary: 'Save a canned answer',
    permission: 'conversation:draft',
    input: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      /** What the reply also does when it is applied (#1087). Absent is none. */
      actions: macroActions.optional(),
    }),
    output: savedReplyPublic,
    http: { method: 'POST', path: '/saved-replies' },
    emits: {
      entity: 'savedReply',
      entityIdFrom: 'id',
      type: 'ticket0.saved-reply-created',
      schemaVersion: 1,
      piiClass: 'none',
      // `actions` joined in #1087, additively. What a macro DOES is the part of it a
      // reviewer of the trail cares about, so it rides on the event.
      payload: ['id', 'title', 'body', 'created_by', 'created_at', 'actions'],
    },
  },

  /**
   * One canned answer, and the version tag an edit of it will be checked against.
   *
   * This exists because of what a guard needs to be armed. A version is handed back
   * on a concurrency-checked response, and the list is a PAGE — one response about
   * many rows, so there is no single entity for a tag to be about. Without a read
   * of one row, an editor's first save is the unconditional one, and `If-Match`
   * only starts protecting the row after the first time somebody has already
   * overwritten something.
   *
   * So it declares `concurrency` despite being a GET, which reads oddly and is
   * right: the host forwards `If-Match` on unsafe methods only — on a GET the
   * header means a conditional read, and honouring it would answer a screen with a
   * 412 where it asked for a body — but it still hands the tag back. Declaring it
   * here is exactly "this is the read an edit is checked against".
   */
  'ticket0/get-saved-reply': {
    summary: 'One canned answer',
    permission: 'conversation:draft',
    input: z.object({ savedReplyId: z.string() }),
    output: savedReplyPublic,
    http: { method: 'GET', path: '/saved-replies/{savedReplyId}' },
    concurrency: { over: 'savedReply', idFrom: 'savedReplyId' },
  },

  /**
   * Change a canned answer's title, its text or its actions.
   *
   * A partial field-bag over `savedReply` — `savedReplyId` names the row, the other
   * fields are optional — which is read-modify-write, and the model refuses that
   * shape without a `concurrency` declaration (#129). It is right here rather than
   * merely required: a saved reply is a SHARED row on a desk, so two agents editing
   * the same one is the ordinary case rather than the exotic one, and the second
   * save silently discarding the first is exactly what nobody would notice.
   *
   * `set-agent-profile` answers the same hazard by stating the whole row instead,
   * because its row is keyed by the caller and so has no id for `concurrency` to
   * name. This one does have an id, so it takes the better answer.
   *
   * The title stays unique — `savedReply.key` says so — and a rename onto another
   * reply's title is a `conflict` rather than a silent no-op, since the caller
   * plainly meant to end up with the name they typed.
   */
  'ticket0/update-saved-reply': {
    summary: 'Change a canned answer',
    permission: 'conversation:draft',
    input: z.object({
      savedReplyId: z.string(),
      title: z.string().min(1).optional(),
      body: z.string().min(1).optional(),
      /** The whole bag, replaced. `[]` empties it; absent leaves it. */
      actions: macroActions.optional(),
    }),
    output: savedReplyPublic,
    http: { method: 'PATCH', path: '/saved-replies/{savedReplyId}' },
    concurrency: { over: 'savedReply', idFrom: 'savedReplyId' },
    emits: {
      entity: 'savedReply',
      entityIdFrom: 'id',
      type: 'ticket0.saved-reply-updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title', 'body', 'created_by', 'created_at', 'actions'],
    },
  },

  /**
   * Take a canned answer out of the library.
   *
   * A missing id is `not_found`, NOT a no-op that says `removed: false`. That is the
   * opposite of what `untag-conversation` does one screen up, and the difference is
   * where the identifier came from: a tag is a string a person typed, so untagging
   * something never tagged is a plausible thing to mean, while a saved reply is
   * addressed by a ULID that can only have come from a list — an id that names
   * nothing is a stale client, and saying so is more useful than pretending.
   *
   * Guarded like the update, and deliberately so: the two hazards are one hazard.
   * A delete over a version the caller has not seen destroys someone else's edit
   * just as completely as an overwrite does, and more permanently.
   *
   * The title rides on the way out, and on the event, because after this there is
   * nowhere left to read it from.
   */
  'ticket0/delete-saved-reply': {
    summary: 'Delete a canned answer',
    permission: 'conversation:draft',
    input: z.object({ savedReplyId: z.string() }),
    output: z.object({ id: z.string(), title: z.string() }),
    http: { method: 'DELETE', path: '/saved-replies/{savedReplyId}' },
    concurrency: { over: 'savedReply', idFrom: 'savedReplyId' },
    emits: {
      entity: 'savedReply',
      entityIdFrom: 'id',
      type: 'ticket0.saved-reply-deleted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title'],
    },
  },

  /**
   * A canned answer with this conversation's facts filled in.
   *
   * The substitution happens on the SERVER, and that is the whole point: the four
   * values in `SAVED_REPLY_VARIABLES` are read here, inside a permission check
   * narrowed to this conversation, so a reply cannot be used as a way to read a
   * contact's name out of a conversation the caller does not hold. A browser doing
   * its own substitution would need those values handed to it first, which is the
   * same read without the check in front of it.
   *
   * It writes nothing and emits nothing. Rendering a reply is not using one — the
   * agent may read the result and discard it, and a usage counter that ticked here
   * would count previews.
   *
   * Three lists come back, not one string, because the screen has three different
   * things to say. `body` is what to paste. `blank` names the variables that were
   * real but empty — an anonymous visitor has no name, an agent may have set no
   * signature — so the composer can warn before "Hi ," goes to a customer. And
   * `unresolved` names the tokens left verbatim because nothing declares them.
   */
  'ticket0/render-saved-reply': {
    summary: 'A canned answer with this conversation’s facts filled in',
    permission: { key: 'conversation:draft', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({ conversationId: z.string(), savedReplyId: z.string() }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      blank: z.array(z.string()),
      unresolved: z.array(z.string()),
    }),
    http: {
      method: 'GET',
      path: '/conversations/{conversationId}/saved-replies/{savedReplyId}/render',
    },
  },

  /**
   * Use a macro: send its reply and run its actions, as one act (#1087).
   *
   * THE RULE, and the reason this operation is shaped the way it is: **a macro needs
   * every key its parts need.** The key it declares here, `conversation:draft`, is only
   * the first of them. Before anything is written, the handler checks the union of that
   * key, the key of the operation that sends the reply (`post-public-reply` or
   * `post-note`), and the key of the operation behind every action in the bag. It
   * derives that union from the declarations (`macroPermissions` in `src/module.ts`
   * reads `MACRO_ACTION_OPERATIONS` and each operation's own `permission`), so an action
   * added to the bag next year is covered without anybody writing a new check. Without
   * it, a key you hold (draft) becomes a wrapper around keys you do not (assign,
   * resolve), and the bag is a privilege-escalation path.
   *
   * Then every part RUNS the operation it names, through the same handler a person's
   * click runs. That handler makes its own check again, takes its own lifecycle step and
   * emits its own event. So a macro's assignment looks the same on the trail as a
   * person's, and it is refused where theirs would be: an assignee outside the
   * directory, or a resolve with no public reply before it.
   *
   * All or nothing. It is one transaction, so a refusal anywhere, whether a missing key
   * up front or a lifecycle or directory refusal halfway through, rolls back the reply
   * and every action before it. Nothing goes out to the customer from a macro that
   * could not finish.
   *
   * The reply goes first and the actions follow in the order the bag lists them. That
   * is what lets a "reply and resolve" macro work: `resolve` refuses a conversation
   * nobody has answered, and by then somebody has.
   *
   * `body` is the text the agent is actually sending. It is the rendered reply after
   * whatever edits they made in the composer. Absent, the saved reply is rendered here
   * exactly as `render-saved-reply` renders it. No key is needed to choose your own
   * words, because the reply operation's key is already in the union.
   */
  'ticket0/apply-saved-reply': {
    summary: 'Send a canned answer and run its actions, all or nothing',
    permission: { key: 'conversation:draft', entity: 'conversation', idFrom: 'conversationId' },
    input: z.object({
      conversationId: z.string(),
      savedReplyId: z.string(),
      body: z.string().min(1).optional(),
      /** Public by default: that is what a canned answer is for. `internal` posts it as a note. */
      visibility: z.enum(['public', 'internal']).optional(),
    }),
    output: z.object({
      saved_reply_id: z.string(),
      conversation_id: z.string(),
      message_id: z.string(),
      /** The action types, in the order they ran. */
      actions: z.array(z.string()),
      /** The conversation as the last action left it. */
      conversation: ticket0Entities.conversation.fields,
    }),
    http: {
      method: 'POST',
      path: '/conversations/{conversationId}/saved-replies/{savedReplyId}/apply',
    },
    emits: {
      // About the MACRO: the reply and each action already publish their own event
      // about the conversation. This one says which canned answer did it, which is the
      // fact a usage count will be read from.
      entity: 'savedReply',
      entityIdFrom: 'saved_reply_id',
      type: 'ticket0.saved-reply-applied',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['saved_reply_id', 'conversation_id', 'message_id', 'actions'],
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
    // Not a tool: the harness writes its own result back here — a connector's return path, not a verb.
    mcp: false,
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
    // Not a tool: the harness writes its own result back here — a connector's return path, not a verb.
    mcp: false,
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
      /**
       * Turns the assistant wrote and was not allowed to send.
       *
       * Reported beside `failed` because a supervised desk produces NOTHING ELSE, and
       * counting only failures is what let a desk withhold every answer while this
       * read called it healthy. A drafted turn is not an error — it is the desk
       * working as configured — but it is the difference between a customer who has
       * an answer and one who is still waiting.
       */
      drafted: z.number().int(),
      /** The desk answers through the supervised principal: it drafts, a person sends. */
      supervised: z.boolean(),
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
      /**
       * How many answers are waiting for a person, ALL of them — not the window's.
       *
       * An unsent answer from three days ago is more urgent than one from an hour ago,
       * not less, so this is the one number here that is not about the last 24 hours.
       */
      waitingTotal: z.number().int(),
      /** The newest of them, so the panel can send somebody to them. */
      waiting: z.array(
        z.object({
          id: z.string(),
          conversation_id: z.string(),
          subject: z.string(),
          model: z.string(),
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

  // ─── The desk, measured ──────────────────────────────────────────────────────

  /**
   * What the desk did over a window: how much came in, how fast it was answered,
   * what is still waiting, and what the assistant actually settled.
   *
   * **Under `usage:read`, and that is a decision rather than convenience.** The
   * headline here is cost per resolved conversation, which is the cost number with a
   * denominator — so it is the same fact `ticket0/usage-summary` guards, and giving it
   * a second, weaker key would mean an agent could divide their way to the money.
   * Everything else in the answer travels with it because it is one screen.
   *
   * Every input is a column something already writes. `first_public_reply_at` and
   * `resolved_at` were stamped on every conversation from the first migration and read
   * by nothing but an unread dot; `aiTurn.outcome` has always been the difference
   * between the assistant answering and a human having to. So there is no new table
   * here and no new write — only the reads nobody had written yet.
   *
   * **Rates, not raw counts, are what a reader can act on**, so the assistant panel
   * answers in fractions of the turns in the window: deflection is `answered / turns`,
   * escalation `escalated / turns`, failure `failed / turns`. A turn the assistant only
   * drafted is neither — a human still sent it — which is why `drafted` is reported and
   * not folded into deflection.
   *
   * `agents` is capped at `DESK_METRICS_AGENTS`. A desk has staff, not a population,
   * and an uncapped group-by in an aggregate is a page waiting to be discovered in
   * production. The **window** is capped too, at `DESK_METRICS_MAX_DAYS`: every
   * aggregate below is bounded only by the range the caller picked, so an unbounded
   * range is a full history scan and is refused rather than served slowly.
   *
   * `currency` is one code because the answer is one number. The desk prices its input
   * and output meters independently, so it *can* price them in different currencies —
   * and if it has, this refuses rather than adding one to the other and labelling the
   * sum with whichever it saw first.
   */
  'ticket0/desk-metrics': {
    summary: 'Volume, speed, backlog, satisfaction and what the assistant settled',
    permission: 'usage:read',
    // Both ends optional and defaulted: a caller that asks for nothing gets the trailing
    // window rather than an error.
    //
    // `instant`, not `string`, and that is load-bearing for the same reason it is on
    // `ticket0/snooze`. Every timestamp this reads is canonical UTC text, so the window
    // is applied as a TEXT comparison — which is only the same as comparing instants
    // while both ends are canonical too. A `from` of `''`, `'0'` or `…T11:00:00-02:00`
    // sorts arbitrarily against real timestamps, and the failure is not an error: it is
    // a plausible-looking report with the wrong rows in it. The host parses this before
    // the handler, so a string that is not an instant is refused at the door and one
    // written with an offset is converted rather than compared as it was typed.
    input: z.object({ from: instant.optional(), to: instant.optional() }),
    output: z.object({
      from: z.string(),
      to: z.string(),
      volume: z.object({
        opened: z.number().int(),
        resolved: z.number().int(),
        byChannel: z.array(
          z.object({
            channel: z.enum(['widget', 'email']),
            opened: z.number().int(),
            resolved: z.number().int(),
          }),
        ),
      }),
      // `measured` is the population each percentile was taken over, and it is part of
      // the answer rather than a footnote: "median 4 minutes" over two conversations is
      // a different claim from the same number over four hundred.
      firstResponse: z.object({
        measured: z.number().int(),
        medianSeconds: z.number().int().nullable(),
        p90Seconds: z.number().int().nullable(),
      }),
      resolution: z.object({
        measured: z.number().int(),
        medianSeconds: z.number().int().nullable(),
        p90Seconds: z.number().int().nullable(),
      }),
      // Backlog is a fact about NOW, not about the window — what is waiting does not
      // care which dates the reader picked. Stated here so the screen can say so.
      backlog: z.object({
        open: z.number().int(),
        snoozed: z.number().int(),
        unassigned: z.number().int(),
        oldestUntouchedId: z.string().nullable(),
        oldestUntouchedAgeSeconds: z.number().int().nullable(),
      }),
      agents: z.array(
        z.object({
          principal: z.string(),
          displayName: z.string().nullable(),
          resolved: z.number().int(),
          replies: z.number().int(),
        }),
      ),
      csat: z.object({
        responses: z.number().int(),
        average: z.number().nullable(),
      }),
      assistant: z.object({
        turns: z.number().int(),
        answered: z.number().int(),
        drafted: z.number().int(),
        escalated: z.number().int(),
        failed: z.number().int(),
        deflectionRate: z.number().nullable(),
        escalationRate: z.number().nullable(),
        failureRate: z.number().nullable(),
        // Money is a decimal string here as everywhere, including the quotient.
        currency: z.string(),
        cost: z.string(),
        costPerResolved: z.string().nullable(),
      }),
    }),
    http: { method: 'GET', path: '/desk-metrics' },
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
   *
   * `attachments` is METADATA ONLY, and deliberately so (#1080). This desk still has
   * nowhere to put the bytes — no `attachment` entity, no blob-store seam reachable
   * from module code — so a mail whose whole point was the invoice still loses the
   * invoice. What it stops losing is the FACT: the handler writes a second, internal
   * message naming every file that came with the mail, so an agent reading the thread
   * can see that something arrived and go and get it, instead of answering a customer
   * who is sure they sent it. Drop the bytes if we must; drop the record of them and
   * the desk is lying to its own staff.
   *
   * Optional, so every caller that predates it is unchanged, and the schema itself
   * refuses nothing: a `.max()` or a `.min(1)` here rejects the whole mail — body and
   * all — over a file count or an empty filename nobody has a rule about yet, which is
   * a worse drop than the one this fixes. The bound lives one step in, on what the desk
   * WRITES: the note names at most a hundred files and counts the rest, and cuts each
   * field to one readable line. That is what keeps an oversized note from failing the
   * ingest transaction and taking the customer's message down with it — the caller is
   * the relay principal, but the mail it carries came from whoever chose to send it.
   */
  'ticket0/ingest-message': {
    // Not a tool: the email relay's own surface — it brings mail in and reports what it sent.
    mcp: false,
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
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            contentType: z.string(),
            sizeBytes: z.number().int().nonnegative(),
          }),
        )
        .optional(),
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
   * The relay's worklist: what this desk has decided to send and nobody has sent yet.
   *
   * A public reply on an EMAIL conversation with no `delivered_at` is, by definition,
   * a message the desk promised a customer and did not keep. Widget conversations are
   * excluded because the widget IS the delivery — the visitor reads the reply in the
   * thread, and emailing it as well would be a second copy nobody asked for.
   *
   * IDS ONLY, deliberately: the body is erasable and this read is a LIST, so carrying
   * it here would put every waiting customer's words in one response, which is the
   * exact copy `read-outbound` exists to avoid. The relay picks a row, comes back
   * through `read-outbound` for the body, sends, and records — and an erasure in
   * between makes the send find nothing, which stays true with this read in front.
   *
   * Idempotence lives in the DATA rather than in the runner: a delivered message
   * leaves this list because `record-delivery` stamped `delivered_at`, so a sweep
   * that ran twice, or two relays running at once, converge on sending each message
   * once rather than on a lock somebody has to hold.
   */
  'ticket0/list-pending-outbound': {
    // Not a tool: the email relay's own surface — it brings mail in and reports what it sent.
    mcp: false,
    summary: 'Public replies on email conversations that have not been sent yet',
    permission: 'conversation:relay',
    output: z.object({
      messageId: z.string(),
      conversationId: z.string(),
      createdAt: z.string(),
    }),
    // `sortKey`, because the handler composes its own SQL: the predicate spans two
    // tables (the conversation's channel, the message's delivery) and neither is a
    // `filterable` column on a single entity. Oldest first — a queue, not an inbox:
    // the reply that has been waiting longest is the one a customer is waiting on.
    paged: { sortKey: 'messageId', order: 'asc' },
    http: { method: 'GET', path: '/relay/outbound' },
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
    // Not a tool: the email relay's own surface — it brings mail in and reports what it sent.
    mcp: false,
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
    // Not a tool: the email relay's own surface — it brings mail in and reports what it sent.
    mcp: false,
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
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
    summary: 'The origins this desk may be embedded on',
    permission: 'conversation:widget',
    output: z.object({ origins: z.array(z.string()) }),
    http: { method: 'GET', path: '/widget/origins' },
  },

  /**
   * Which assistant principal this desk answers as — the host's second pre-flight
   * read, and it sits beside `widget-origins` because it is the same kind of thing:
   * a fact about the desk that the HOST needs before it can act, read as the desk's
   * own widget service rather than as anybody's session.
   *
   * It is deliberately not `desk:configure`. The host reads this on the path where a
   * customer has just said something and nobody is signed in; gating it on the admin
   * key would mean the answer path could not ask the question. It says nothing a
   * visitor could use — whether a person reviews answers is not a secret, and the flag
   * grants nothing on its own: the principal it selects is where the authority lives.
   */
  'ticket0/assistant-mode': {
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
    summary: 'Whether this desk’s assistant sends its own answers',
    permission: 'conversation:widget',
    output: z.object({ autonomous: z.boolean() }),
    http: { method: 'GET', path: '/widget/assistant-mode' },
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
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
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
     *
     * `businessHours` is the desk's stored line, verbatim: free text a person typed
     * in Settings, never parsed here and never parsed in the widget. Nothing in the
     * desk decides anything by it — it exists so a visitor can read when somebody
     * will be there, which is the question they are actually asking. `null` when the
     * desk has not said, and the widget then says nothing rather than guessing.
     */
    output: z.object({
      sessionId: z.string(),
      token: z.string(),
      greeting: z.string(),
      businessHours: z.string().nullable(),
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
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
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
   * The visitor is asking for a person, and that is not a question to answer.
   *
   * The widget has had a "Talk to a human" button all along, and it worked by TYPING
   * one — it posted `Can a person take a look at this, please?` through `widget-post`
   * like any other message, so retrieval ran, the model ran, and the customer got a
   * paragraph out of whichever documentation page bm25 liked best. The intent was
   * there in the click and the pipeline threw it away.
   *
   * So the ask has its own operation. It writes what the visitor said, writes the
   * desk's acknowledgement in the same transaction, and tells the people who can
   * act on it — `notified` is how many were told, which is a fact worth having on
   * the event: a desk with nobody to tell says zero, and that is a real answer.
   *
   * Same permission and the same session token as `widget-post`, because it is the
   * same visitor doing the same kind of thing. What it never does is call a model.
   */
  'ticket0/request-human': {
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
    summary: 'Ask for a person to take over the conversation',
    permission: 'conversation:widget',
    input: z.object({
      sessionId: z.string(),
      token: z.string(),
      /**
       * What the visitor said, when they have not said it yet — the button's own
       * sentence, posted and escalated in ONE call so a desk can never end up
       * holding the request without having told anybody about it.
       *
       * Omitted when the message is already in the thread: a visitor who TYPED
       * "can I talk to a human" has posted through `widget-post` already, and
       * writing their sentence a second time would put it in the thread twice.
       */
      body: z.string().min(1).optional(),
    }),
    output: ticket0Entities.message.fields.extend({
      /**
       * How many people were told. Zero is never a failure: it is a desk with no
       * agents, or an ask that already stands — a second click while the first
       * request is still outstanding is the same request, and the desk hears once.
       */
      notified: z.number(),
    }),
    http: { method: 'POST', path: '/widget/sessions/{sessionId}/handoff' },
    emits: {
      entity: 'message',
      entityIdFrom: 'id',
      type: 'ticket0.human-requested',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'conversation_id', 'notified'],
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
    // Not a tool: the widget service's surface — held by the desk's `widget` principal, driven by a browser.
    mcp: false,
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

  // ─── The waiting list ────────────────────────────────────────────────────────

  /**
   * The origins this desk takes signups from — the signup service's pre-flight read.
   *
   * The same array `ticket0/widget-origins` returns, under a different key, and the
   * duplication is the point rather than an oversight. The list belongs to the DESK;
   * what differs is which service is asking, and each of the two public services holds
   * exactly one key. Reading it through the widget's key would have made the signup
   * surface need the widget's authority to answer a preflight, which is the whole thing
   * a second service principal exists to avoid.
   *
   * Both doors refuse out of `allowedOrigins(ctx)`, so the browser's answer and the
   * operation's answer cannot disagree about where a form may live.
   */
  'ticket0/signup-origins': {
    // Not a tool: the signup service's surface — held by one principal, driven by a browser.
    mcp: false,
    summary: 'The origins this desk takes signups from',
    permission: 'signup:submit',
    output: z.object({ origins: z.array(z.string()) }),
    http: { method: 'GET', path: '/signup/origins' },
  },

  /**
   * Ask to be told — the one write the open internet may make to this table.
   *
   * ## What confines the caller
   *
   * The same answer the widget gives, and for the same reason: `signup:submit` admits
   * the desk's SIGNUP SERVICE and nobody else, and what the caller may do with it is
   * decided by the token they hold afterwards, not by this key. A visitor has no
   * principal and needs none. The origin is checked here against the desk's own
   * allowlist, out of the same array the browser's preflight was answered from, so the
   * two cannot disagree about where this form is allowed to live.
   *
   * ## Why it is idempotent, and what "idempotent" means for each state
   *
   * A form gets submitted twice — a double click, a back button, an impatient reload —
   * and none of those should produce a second confirmation email or a second row.
   * `key: ['kind', 'email']` makes the second submission find the first, and what
   * happens then depends on where that row had got to:
   *
   *  - **pending** — re-issue the confirmation, at most once per `SIGNUP_RESEND_SECONDS`.
   *    This is the "the mail never arrived" path, and it has to work.
   *  - **confirmed** — nothing to do, and `confirmToken` comes back null. Deliberately
   *    NOT an error: telling a stranger which addresses are already on the list turns
   *    a signup form into a membership oracle.
   *  - **unsubscribed** — back to pending with a fresh confirmation. Somebody who left
   *    and returned is asking again, and the way to honour that without ever guessing
   *    is to make them confirm again.
   *
   * ## What comes back
   *
   * `confirmToken` is the one field here that is a secret, and it is handed to the HOST
   * — which sends the mail — rather than to the browser. Nothing in the response the
   * form reads carries it, and nothing on this path is told whether the address was
   * already known.
   */
  'ticket0/submit-signup': {
    // Not a tool: the signup service's surface — held by one principal, driven by a browser.
    mcp: false,
    summary: 'Ask for a place on the waiting list, or for the changelog by email',
    permission: 'signup:submit',
    input: z.object({
      kind: z.enum(['waitlist', 'newsletter']),
      email: z.string().email(),
      note: z.string().max(SIGNUP_NOTE_MAX).nullable().optional(),
      origin: z.string().url(),
    }),
    output: z.object({
      id: z.string(),
      kind: z.enum(['waitlist', 'newsletter']),
      state: z.enum(['pending', 'confirmed', 'unsubscribed']),
      /**
       * The confirmation token, for the host that is about to put it in an email —
       * null when there is nothing to confirm. It is a capability over this row, so
       * it is minted here, returned once, and stored only as a hash.
       */
      confirmToken: z.string().nullable(),
      /**
       * The unsubscribe token, which is NOT null even when `confirmToken` is.
       *
       * Every mail this desk ever sends this person needs a way out, including the
       * confirmation itself, and the row's token is stable — so this is a read of what
       * is already stored rather than something minted per call. An address that was
       * already confirmed still gets one back, because the caller may be about to send
       * them something.
       */
      unsubscribeToken: z.string(),
    }),
    http: { method: 'POST', path: '/signup' },
    emits: {
      entity: 'signup',
      entityIdFrom: 'id',
      type: 'ticket0.signup-requested',
      schemaVersion: 1,
      // Never the address. It is `erasable`, which makes it uncarryable by an
      // immutable event — the same rule that keeps message bodies out of the
      // outbound-email event and sends the relay back for them at send time.
      piiClass: 'none',
      payload: ['id', 'kind', 'state'],
    },
  },

  /**
   * Spend a confirmation token.
   *
   * The token is the whole authority and the input carries nothing else — no id, no
   * address — so there is no wider request to make. Spending it nulls the hash, which
   * is what makes a confirmation link once-only.
   *
   * Reached by a NAVIGATION out of an email, not by script on an embedded page, so the
   * host mounts this outside the origin-guarded surface: a mail client sends no
   * `Origin`, and a door that demanded one would refuse every real click.
   */
  'ticket0/confirm-signup': {
    mcp: false,
    summary: 'Confirm an address from the link in its email',
    permission: 'signup:submit',
    input: z.object({ token: z.string() }),
    output: ticket0Entities.signup.fields.omit({ confirm_token_hash: true }),
    http: { method: 'POST', path: '/signup/confirm' },
    emits: {
      entity: 'signup',
      entityIdFrom: 'id',
      type: 'ticket0.signup-confirmed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'state', 'confirmed_at'],
    },
  },

  /**
   * Leave the list.
   *
   * Works from every state and stays working forever, which is the one property an
   * unsubscribe link must have: it is read out of a mail archive by somebody who is
   * annoyed, and a link that has expired is a complaint. It is safe to leave live
   * precisely because removal is the only thing it can do.
   */
  'ticket0/unsubscribe-signup': {
    mcp: false,
    summary: 'Take an address off the list',
    permission: 'signup:submit',
    input: z.object({ token: z.string() }),
    output: ticket0Entities.signup.fields.omit({ confirm_token_hash: true }),
    http: { method: 'POST', path: '/signup/unsubscribe' },
    emits: {
      entity: 'signup',
      entityIdFrom: 'id',
      type: 'ticket0.signup-unsubscribed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'state', 'unsubscribed_at'],
    },
  },

  /**
   * The list, for the person who writes to it.
   *
   * Staff-only and desk-admin-only: it is a table of real addresses, so it sits with
   * the money rather than with the inbox. The CONFIRM hash is omitted the same way the
   * desk's verification secret is — a read must not hand back the capability that
   * manufactures a consent record.
   *
   * The unsubscribe token is returned, and that is what makes this read the export the
   * Monday send is written against: every issue needs a per-recipient way out, and a
   * sender that cannot see the token cannot put one in the mail. It grants nothing but
   * removal, and this door is already the narrowest one the desk has.
   */
  'ticket0/list-signups': {
    summary: 'Who is waiting, and who is subscribed',
    permission: 'signup:read',
    // Declared as input as well as `filterable`, because the two say different things:
    // this tells the transport what to accept, `filterable` tells the kernel what a
    // walk may narrow on. See `ticket0/list-conversations` for the long version.
    input: z.object({
      kind: z.enum(['waitlist', 'newsletter']).optional(),
      state: z.enum(['pending', 'confirmed', 'unsubscribed']).optional(),
    }),
    output: ticket0Entities.signup.fields.omit({ confirm_token_hash: true }),
    paged: {
      over: {
        entity: 'signup',
        sortable: ['created_at', 'confirmed_at'],
        filterable: ['kind', 'state'],
      },
      order: 'desc',
      total: true,
    },
    http: { method: 'GET', path: '/signups' },
  },

  /**
   * The counts, as one read.
   *
   * The screen wants six numbers above a table and would otherwise get them by walking
   * six filtered pages for their totals — six round trips to render a header. Every
   * (kind, state) pair the table holds, and pairs with no rows are simply absent.
   */
  'ticket0/signup-counts': {
    summary: 'How many are waiting, confirmed and gone, per list',
    permission: 'signup:read',
    output: z.object({
      counts: z.array(
        z.object({
          kind: z.enum(['waitlist', 'newsletter']),
          state: z.enum(['pending', 'confirmed', 'unsubscribed']),
          count: z.number(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/signups/counts' },
  },
});

/**
 * The operation behind every macro action (#1087), which is where its permission comes
 * from.
 *
 * An action has no permission of its own to declare, and that is the point. Its key is
 * whatever this operation declares, read from the declaration by `macroPermissions` in
 * `src/module.ts`, and the action is applied by running this operation's handler. The
 * `satisfies` is the gate: a new member of `macroAction` with no entry here fails to
 * compile, so an action cannot exist without the operation, and therefore the key, that
 * governs it.
 */
export const MACRO_ACTION_OPERATIONS = {
  tag: 'ticket0/tag-conversation',
  'set-priority': 'ticket0/set-priority',
  assign: 'ticket0/assign',
  resolve: 'ticket0/resolve',
} as const satisfies Record<MacroAction['type'], keyof typeof ticket0Operations>;

/** The operation that sends a macro's reply, by visibility. Its key is in the union too. */
export const MACRO_REPLY_OPERATIONS = {
  public: 'ticket0/post-public-reply',
  internal: 'ticket0/post-note',
} as const satisfies Record<'public' | 'internal', keyof typeof ticket0Operations>;

/**
 * The conversation's state machine, declared once.
 *
 * `on` is an edge — the operation moves the conversation. `allow` is a precondition
 * — the operation is legal here and moves nothing. Most of this app's operations
 * appear under `allow`, because tagging, noting and assigning change no state, and a
 * format with only edges would draw a self-loop for every one of them.
 *
 * The five things worth reading twice:
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
 *  4. **`closed` is reachable from every state, not only from `resolved`.** It was
 *     once reachable only from `resolved`, and that combined with rule 3 to trap a
 *     conversation nobody would ever reply to: unanswerable, therefore unresolvable,
 *     therefore in the inbox for good. The two verbs are kept apart by what they
 *     WRITE rather than by where they sit — only `ticket0/resolve` stamps
 *     `resolved_at`, and the reports count that stamp — so an escape hatch out of
 *     the inbox cannot be mistaken for work done.
 *  5. **`closed` is terminal, and that is not the same as a customer being silenced.**
 *     The absence of an inbound edge here is the whole point of the state — a thread
 *     anyone could climb back into by writing one more line is not an escape hatch —
 *     but read alone it says a visitor who types into their chat bubble after an agent
 *     closed the thread gets a 409, which is what happened on substrat.net. Where that
 *     message goes is not a question a state machine can answer, so it is not asked
 *     here: `widget-post` and `ingest-message` start a FOLLOW-UP conversation for the
 *     same contact (`conversation.follows` names the closed one) and land the message
 *     in that. See `followUp` in `src/module.ts`. The closed row is untouched and goes
 *     on counting as closed, which is the property this terminal state exists to hold.
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
          'ticket0/close': 'closed',
          // The reaper (#1088), and it is declared HERE rather than on every state
          // deliberately: `new` is the only state that means "nobody at this desk has
          // touched it", and the sweep may not reach a conversation somebody parked,
          // picked up or answered. Because the edge exists nowhere else, a reaper that
          // one day widened its query would be refused by the machine rather than
          // quietly closing worked conversations.
          'ticket0/reap-abandoned': 'closed',
        },
        allow: [
          'ticket0/post-note',
          'ticket0/record-answer',
          'ticket0/record-assistant-failure',
          'ticket0/ingest-message',
          'ticket0/widget-post',
          'ticket0/request-human',
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
          'ticket0/close': 'closed',
        },
        allow: [
          'ticket0/post-public-reply',
          'ticket0/post-note',
          'ticket0/record-answer',
          'ticket0/record-assistant-failure',
          'ticket0/ingest-message',
          'ticket0/widget-post',
          'ticket0/request-human',
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
          'ticket0/wake-snoozed': 'open',
          'ticket0/ingest-message': 'open',
          'ticket0/widget-post': 'open',
          'ticket0/request-human': 'open',
          'ticket0/resolve': 'resolved',
          'ticket0/close': 'closed',
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
          'ticket0/request-human': 'open',
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

  /**
   * A signup's machine — three states, and the one worth reading is the way back in.
   *
   * `unsubscribed` is NOT terminal: `ticket0/submit-signup` is an edge out of it, back
   * to `pending`. Somebody who left the list and later typed their address in again is
   * asking a second time, and the only honest way to honour that is to make them
   * confirm a second time — which is what the edge does. A terminal `unsubscribed`
   * would instead have produced the worst available outcome: a form that accepts the
   * address, reports success, and silently never adds it.
   *
   * `ticket0/submit-signup` also appears under `allow` in both other states, because a
   * re-submission of an address already on the list moves nothing. Confirming again is
   * not possible at all — the token's hash is nulled when it is spent, so there is no
   * second confirmation to present, and the machine never has to say so.
   */
  signup: {
    field: 'state',
    initial: 'pending',
    states: {
      pending: {
        on: {
          'ticket0/confirm-signup': 'confirmed',
          'ticket0/unsubscribe-signup': 'unsubscribed',
        },
        allow: ['ticket0/submit-signup'],
      },
      confirmed: {
        on: { 'ticket0/unsubscribe-signup': 'unsubscribed' },
        allow: ['ticket0/submit-signup'],
      },
      unsubscribed: {
        on: { 'ticket0/submit-signup': 'pending' },
        // A second click on an unsubscribe link in a mail archive. It changes nothing
        // and must not be an error — the person is telling us something we agree with.
        allow: ['ticket0/unsubscribe-signup'],
      },
    },
  },
});

export const ticket0Model = emitModel(ticket0Entities, { lifecycles: ticket0Lifecycles });
