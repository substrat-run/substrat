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
  REAP_ABANDONED_SQL,
  ASSISTANT_HEALTH_COUNTS_SQL,
  ASSISTANT_HEALTH_RECENT_SQL,
  ASSISTANT_HEALTH_WAITING_TOTAL_SQL,
  ASSISTANT_HEALTH_WAITING_SQL,
} from './health-queries.js';
import {
  addDecimal,
  assertTransition,
  LIST_PAGE_DEFAULT,
  listLimitOf,
  mulDecimal,
  operationConcurrencyOf,
  operationInputsOf,
  pageOf,
  permissionKey,
  permissionsUsedBy,
  principalId,
  substratError,
  z,
  type CountedPage,
  type EntityRow,
  type HandlerInput,
  type HandlerOutput,
  type PermissionKey,
  type PrincipalId,
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
  AUTO_CLOSE_MAX_DAYS,
  AUTO_CLOSE_MIN_DAYS,
  AUTO_TAG_RULES_MAX,
  autoTagRule,
  DESK_METRICS_AGENTS,
  DESK_METRICS_MAX_DAYS,
  DESK_METRICS_WINDOW_DAYS,
  likeTerm,
  MACRO_ACTION_OPERATIONS,
  MACRO_REPLY_OPERATIONS,
  macroActions,
  NO_REPLY_MAX_HOURS,
  NO_REPLY_MIN_HOURS,
  PARTICIPANTS_MAX,
  SAVED_REPLY_VARIABLES,
  savedReplyToken,
  SEARCH_OVERFETCH,
  SIGNUP_HOURLY_MAX,
  SIGNUP_RESEND_SECONDS,
  SLA_TARGET_MAX_MINUTES,
  ticket0Entities,
  ticket0Lifecycles,
  ticket0Operations,
  inTheInbox,
  customerMessageRow,
  SPAM_MAX_LINKS_DEFAULT,
  SPAM_MAX_LINKS_MAX,
  SPAM_REPEAT_DEFAULT,
  SPAM_REPEAT_MAX,
  SPAM_REPEAT_MIN_CHARS,
  SPAM_REPEAT_WINDOW_HOURS,
  SUSPENDED_EXCERPT_CHARS,
  suspicionSignal,
  type AutoTagRule,
  type DeskSetting,
  type MacroAction,
  type SuspicionSignal,
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
type SignupRow = EntityRow<typeof ticket0Entities, 'signup'>;
type BlockRuleRow = EntityRow<typeof ticket0Entities, 'blockRule'>;
type BehaviourRunRow = EntityRow<typeof ticket0Entities, 'behaviourRun'>;
type MailDeliveryRow = EntityRow<typeof ticket0Entities, 'mailDelivery'>;
type ParticipantRow = EntityRow<typeof ticket0Entities, 'conversationParticipant'>;

const conversationRef = (id: string) => ({ entityType: 'conversation', entityId: id });
const contactRef = (id: string) => ({ entityType: 'contact', entityId: id });
const sourceRef = (id: string) => ({ entityType: 'kbSource', entityId: id });

/** The desk is a singleton per scope, and this is its id. */
const DESK = 'desk';

/** How many lapsed snoozes one run of `ticket0/wake-snoozed` takes. The rest wait
 *  for the next tick — a batch bounds the transaction, it does not cap the feature. */
const WAKE_BATCH = 200;

/**
 * How long a conversation nobody has touched is left in the inbox before
 * `ticket0/reap-abandoned` closes it (#1088).
 *
 * Thirty days, and the number is chosen against the ONE-WAY-ness of what it triggers:
 * `closed` is terminal in the declared lifecycle, so a reaped conversation cannot be
 * re-opened. Nothing is destroyed — the row, its messages and the contact all stay,
 * and a later message from the same person opens a follow-up that names the closed one
 * through `follows` — but the state does not come back, so the window errs long. A
 * fortnight would reap a desk that went quiet over a holiday; a month does not.
 *
 * Now the DEFAULT rather than the only answer: a desk may say a different number
 * through `ticket0/configure-desk`, and `abandonedAfter()` below is the one place that
 * reads it. This stays the value for a desk that has never said — which is every desk
 * that existed before the column did, so the migration changes nobody's behaviour.
 */
const ABANDONED_AFTER_DAYS = 30;

/** The bounds `ticket0/configure-desk` declares, restated here as the guard on a value
 *  READ BACK from the row — see `abandonedAfter()` for why a re-check is not paranoia. */
const ABANDONED_AFTER_MIN_DAYS = 1;
const ABANDONED_AFTER_MAX_DAYS = 3650;

/**
 * How many abandoned conversations one run of `ticket0/reap-abandoned` closes.
 *
 * Same bargain as `WAKE_BATCH` — a bound on one transaction, not a cap on the feature —
 * and the bargain only holds because the schedule comes back. The scheduler fires a due
 * schedule once per sweep and records the run; a full batch does not invoke it again.
 * So this number and the cadence in `src/manifest.ts` multiply into the desk's real
 * drain rate, and neither may be changed without reading the other.
 */
const REAP_BATCH = 200;

/**
 * The hour `SIGNUP_HOURLY_MAX` counts over.
 *
 * Here rather than in the model beside the ceiling itself, because the model declares
 * what a caller may send and this is how the handler measures — the same split that
 * keeps `HEALTH_WINDOW_MS` down here.
 */
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Every state an unfiltered inbox shows — which is every state the machine has, less
 * the terminal one.
 *
 * Written out rather than derived from the lifecycle by subtracting `closed`: the
 * screen's default is a PRODUCT decision about what an agent should be looking at,
 * and a machine gaining a sixth state should make somebody choose which side of this
 * line it falls on rather than silently answering for them.
 */
const OPEN_STATES = ['new', 'open', 'snoozed', 'resolved'] as const;

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
 *
 * Checked in three pieces rather than one pattern, and that is a runtime limit, not
 * style. A Durable Object's SQLite refuses any LIKE or GLOB pattern longer than 50
 * bytes ("LIKE or GLOB pattern too complex"), and the whole instant as one pattern is
 * 92. Node's SQLite allows 50 000, so every suite on the node host passed while every
 * hosted run of the timer failed on this line (#1646). The pieces are 42, 33 and 17
 * bytes, and together with the length they accept exactly the strings the one pattern
 * did: 24 characters, each piece in its place.
 */
export const CANONICAL_INSTANT_PARTS = [
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',
  'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]',
  '.[0-9][0-9][0-9]Z',
] as const;

/** `column` holds a canonical instant — bind `CANONICAL_INSTANT_PARTS` for its three `?`. */
export function canonicalInstant(column: string): string {
  return `(length(${column}) = 24
          AND substr(${column}, 1, 10) GLOB ?
          AND substr(${column}, 11, 9) GLOB ?
          AND substr(${column}, 20, 5) GLOB ?)`;
}

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

function messageOrNull(ctx: OperationContext, id: string): MessageRow | undefined {
  return ctx.sql.query<MessageRow>('SELECT * FROM ticket0_messages WHERE id = ?', [id])[0];
}

function messageOrThrow(ctx: OperationContext, id: string): MessageRow {
  const row = messageOrNull(ctx, id);
  if (!row) throw substratError('not_found', `message not found: ${id}`);
  return row;
}

/**
 * The row, or nothing — for the ONE caller that must not answer 404: a refusal that
 * distinguishes "no such source" from "wrong token" tells an unauthenticated caller
 * which source ids this desk holds.
 */
function sourceOrNull(ctx: OperationContext, id: string): KbSourceRow | undefined {
  return ctx.sql.query<KbSourceRow>('SELECT * FROM ticket0_kb_sources WHERE id = ?', [id])[0];
}

function sourceOrThrow(ctx: OperationContext, id: string): KbSourceRow {
  const row = sourceOrNull(ctx, id);
  if (!row) throw substratError('not_found', `documentation source not found: ${id}`);
  return row;
}

/** A source as it may leave this module: the hook's hash dropped, its hint kept. */
type PublicKbSource = Omit<KbSourceRow, 'refresh_token_hash'>;

/**
 * Strip the hook's hash off a row on its way out.
 *
 * Every operation that returns a source goes through here, including the paged list —
 * `ctx.page` reads the columns the MODEL declares, so a nullable hash on the entity is
 * a hash on every page of the settings screen unless something takes it off. The
 * model's `kbSourcePublic` says the same thing in the types; this is the half that is
 * true at runtime.
 */
function publicSource<T extends KbSourceRow>(row: T): Omit<T, 'refresh_token_hash'> {
  const { refresh_token_hash: _hash, ...rest } = row;
  return rest;
}

/**
 * The token, and the only shape of it that exists.
 *
 * Two ULIDs is the desk's own idiom for "a token nobody can guess" (`widget-start`
 * mints the same thing), which is 160 bits of randomness in Crockford base32. The
 * prefix is not security — it is so that a token pasted somewhere it should not be is
 * recognisable as one, by a person or by a secret scanner, instead of reading as an id.
 */
function mintRefreshToken(): string {
  return `t0kb_${ulid()}${ulid()}`;
}

/**
 * How much of the token the desk may show afterwards.
 *
 * The tail, not the head: the prefix is the same on every token this desk mints, so a
 * hint taken off the front would distinguish nothing. Six characters of base32 is one
 * in a billion — enough to tell two hooks apart, far too little to help guess either.
 */
function tokenHint(token: string): string {
  return token.slice(-6);
}

/**
 * The floor between two hook-driven reads of one source, in milliseconds.
 *
 * A read is somebody else's 1 MB fetch plus a few hundred hashes and four write
 * transactions, behind a door whose whole credential is one header — so an exposed hook
 * is cheap amplification against the docs site AND this scope. A minute is far below
 * any real publishing cadence and far above what makes a useful hammer.
 *
 * Only the hook path is throttled. The Re-read button is an authenticated person who
 * can already see what they are doing, and making them wait would be pretending they
 * are the risk.
 */
const REFRESH_HOOK_MIN_INTERVAL_MS = 60_000;

/**
 * Every value a saved reply may substitute, and nothing else.
 *
 * Typed off `SAVED_REPLY_VARIABLES` so the closed set is closed in one place: adding
 * a name to the declaration without resolving it here is a compile error, and
 * resolving one the declaration does not list is too.
 */
type SavedReplyValues = Record<(typeof SAVED_REPLY_VARIABLES)[number], string | null>;

/**
 * Fill a canned answer in, and say what it could not fill.
 *
 * Three outcomes per token, and the screen needs all three apart:
 *
 *   - known and set     - substituted;
 *   - known and empty   - substituted with nothing, named in `blank`, because "Hi ,"
 *     is what an anonymous visitor's name renders as and an agent should see that
 *     before the customer does;
 *   - not known at all  - left in the text VERBATIM and named in `unresolved`. A
 *     canned answer about CSS may legitimately contain braces, and neither deleting
 *     the token nor refusing the whole reply is a reasonable thing to do to it.
 */
function renderSavedReplyBody(
  body: string,
  values: SavedReplyValues,
): { body: string; blank: string[]; unresolved: string[] } {
  const known = new Map<string, string | null>(Object.entries(values));
  const blank = new Set<string>();
  const unresolved = new Set<string>();
  const rendered = body.replace(savedReplyToken(), (whole: string, name: string) => {
    if (!known.has(name)) {
      unresolved.add(name);
      return whole;
    }
    const value = known.get(name) ?? '';
    if (value === '') {
      blank.add(name);
      return '';
    }
    return value;
  });
  return {
    body: rendered,
    blank: [...blank].sort(),
    unresolved: [...unresolved].sort(),
  };
}

function savedReplyOrThrow(ctx: OperationContext, id: string): SavedReplyRow {
  const row = ctx.sql.query<SavedReplyRow>('SELECT * FROM ticket0_saved_replies WHERE id = ?', [
    id,
  ])[0];
  if (!row) throw substratError('not_found', `saved reply not found: ${id}`);
  return row;
}

/**
 * The action bag off the row, parsed.
 *
 * A row whose JSON does not parse is refused rather than read as "no actions". This
 * module is the only writer and parses on the way in, so a bad value is a row some
 * other version wrote, and a macro that quietly stopped assigning would be wrong data
 * on a screen. A throw is what somebody notices.
 */
function savedReplyActions(row: Pick<SavedReplyRow, 'id' | 'actions'>): MacroAction[] {
  if (row.actions === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(row.actions);
  } catch {
    raw = undefined;
  }
  const parsed = macroActions.safeParse(raw);
  if (!parsed.success) {
    throw substratError('internal', `saved reply ${row.id} carries actions this version cannot read`);
  }
  return parsed.data;
}

/** A saved reply as every operation hands it out: `actions` parsed, never the JSON. */
function savedReplyPublic(row: SavedReplyRow): Omit<SavedReplyRow, 'actions'> & { actions: MacroAction[] } {
  return { ...row, actions: savedReplyActions(row) };
}

/**
 * A saved reply filled in for one conversation, by the caller. Shared by
 * `render-saved-reply` and `apply-saved-reply`, so what the preview showed is what the
 * macro sends.
 */
function renderFor(
  ctx: OperationContext,
  conversation: ConversationRow,
  reply: SavedReplyRow,
): { body: string; blank: string[]; unresolved: string[] } {
  const contact = ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE id = ?', [
    conversation.contact_id,
  ])[0];
  // The caller's OWN profile, never a principal from the input: a saved reply
  // signs itself with the name of whoever is pasting it.
  const profile = ctx.sql.query<AgentProfileRow>(
    'SELECT * FROM ticket0_agent_profiles WHERE principal = ?',
    [String(ctx.principal)],
  )[0];
  return renderSavedReplyBody(reply.body, {
    'agent.name': profile?.display_name ?? null,
    'agent.signature': profile?.signature ?? null,
    'contact.name': contact?.display_name ?? null,
    'conversation.subject': conversation.subject,
  });
}

/** The bag as the column stores it. An empty bag is stored as null, the same as none. */
function storedActions(actions: readonly MacroAction[]): string | null {
  return actions.length === 0 ? null : JSON.stringify(actions);
}

/**
 * THE MACRO RULE (#1087): the permission keys a macro needs, which is every key its
 * parts need.
 *
 * The parts are this operation itself, the operation that sends the reply, and the
 * operation behind each action. Every key is read off the DECLARATIONS
 * (`MACRO_ACTION_OPERATIONS` and each operation's own `permission`), through
 * `permissionsUsedBy`, the same reading the manifest's permission list is built from.
 * No action carries a key of its own. So the day somebody adds `close` to the bag, the
 * key `ticket0/close` declares is required of every macro that closes, and nobody has to
 * remember to say so.
 *
 * Exported for the test that holds it to that.
 */
export function macroPermissions(
  visibility: keyof typeof MACRO_REPLY_OPERATIONS,
  actions: readonly MacroAction[],
): PermissionKey[] {
  const parts: (keyof typeof ticket0Operations)[] = [
    'ticket0/apply-saved-reply',
    MACRO_REPLY_OPERATIONS[visibility],
    ...actions.map((a) => MACRO_ACTION_OPERATIONS[a.type]),
  ];
  return permissionsUsedBy(Object.fromEntries(parts.map((op) => [op, ticket0Operations[op]]))).map(
    (key) => permissionKey.parse(key),
  );
}

/**
 * Run one part of a macro as the operation it names: that operation's declared input
 * schema, then that operation's own handler.
 *
 * Nothing is reimplemented here, which is the lesson #1640 taught. A macro that wrote
 * the row itself would be a second assignment path, one that could drift from the first
 * on the check, the directory, the lifecycle or the event. Instead it is the first path,
 * called with the conversation filled in. The handler re-checks its own key, which the
 * union has already checked, so the handler's check is a second lock, not the only one.
 */
async function runMacroPart(
  ctx: OperationContext,
  op: keyof typeof ticket0Operations,
  input: Record<string, unknown>,
): Promise<unknown> {
  const declared = ticket0Operations[op] as { input?: z.ZodTypeAny };
  const handler = operations[op] as unknown as OperationHandler<unknown, unknown>;
  return handler(ctx, declared.input ? declared.input.parse(input) : input);
}

/** A colleague's directory row, or nothing. The one read of `ticket0_agent_profiles` by principal. */
function profileOf(ctx: OperationContext, principal: string): AgentProfileRow | undefined {
  return ctx.sql.query<AgentProfileRow>('SELECT * FROM ticket0_agent_profiles WHERE principal = ?', [
    principal,
  ])[0];
}

/**
 * Somebody who is on this desk at all — membership, and only that.
 *
 * The directory is `ticket0_agent_profiles`, for the reason the operation's
 * docblock gives: it is the only in-scope record of a colleague, because nothing
 * lets module code ask who else holds a permission. So a principal with no
 * profile is refused here — `validation_failed` rather than a write, since a
 * typo that sticks is exactly what this is for.
 *
 * Being IN the directory is not the same as being somebody a conversation can be
 * handed to; `assignableStaffOrThrow` below is that second question, and it is the
 * one `assign` asks.
 */
function staffOrThrow(ctx: OperationContext, principal: string): AgentProfileRow {
  const row = profileOf(ctx, principal);
  if (!row) {
    throw substratError(
      'validation_failed',
      `not a member of this desk: ${principal} — they appear here once they have set a profile`,
    );
  }
  return row;
}

/**
 * Whether a directory row IS the assistant — the one rule, in one place.
 *
 * Two callers judge it now, `assign` and `follow-conversation`, and they refuse for
 * different-sounding reasons — so what they share is the test and not the message. The
 * test is the display NAME for the reason the next comment gives: module code cannot
 * ask the kernel which role a principal holds.
 */
const isAssistant = (row: AgentProfileRow): boolean => row.display_name === ASSISTANT_NAME;

/**
 * Somebody this desk can hand a conversation TO — which is narrower (#1154).
 *
 * `ticket0_agent_profiles` is two things at once: the desk's directory of colleagues
 * AND the source of every human-readable byline. The assistant needs the second, so
 * it has a row, so it was in the first — and `assign` accepted it, minting an
 * `assigned` notification for a principal that reads no notifications and parking a
 * conversation with something that will never pick it up.
 *
 * The name is the test, the same way `post-public-reply` decides an author's kind and
 * `notifyStaff` decides who to tell. One rule about who the assistant is, not three —
 * because module code cannot ask the kernel which role a principal holds, which is the
 * wall this whole directory exists to work around.
 *
 * Only the incoming assignee is judged. A conversation already parked on the assistant
 * — reachable from a desk that ran an older version — can still be reassigned to a
 * person or unassigned, because those name a different principal or none.
 */
function assignableStaffOrThrow(ctx: OperationContext, principal: string): AgentProfileRow {
  const row = staffOrThrow(ctx, principal);
  if (isAssistant(row)) {
    throw substratError(
      'validation_failed',
      `the assistant cannot be an assignee: ${principal} — it answers on its own and reads no queue`,
    );
  }
  if (!onTheDesk(row)) {
    throw substratError(
      'validation_failed',
      `not on this desk any more: ${principal} — they were taken off it, and an admin can put them back`,
    );
  }
  return row;
}

/**
 * Is this colleague on the desk — the ONE definition of who may be handed work or told
 * about it (#1083), in the two forms the callers need.
 *
 * Off the desk is `offboarded_at`, which an admin sets through
 * `ticket0/set-agent-offboarded`. It MIRRORS a role revocation and does not derive from
 * one, because module code cannot read another principal's roles; the column's
 * docblock says what that costs. What it does not do is move anything: a conversation
 * already assigned to somebody who has since left stays theirs.
 *
 * `onTheDesk` is the row form, read by `assignableStaffOrThrow`. `ON_THE_DESK_SQL` is
 * the same test as a fragment, read by the round-robin ring and by `notifyStaff`'s
 * broadcast. Two spellings of one rule, side by side and held to each other by
 * `test/off-boarding.test.ts`, which walks every combination through both. The
 * assistant is a separate question (`isAssistant`), asked beside this one at every
 * call site, because it is off the desk for a different reason: it is not a person.
 */
const onTheDesk = (row: AgentProfileRow): boolean => row.offboarded_at === null;
const ON_THE_DESK_SQL = 'offboarded_at IS NULL';

/**
 * The people a conversation can be handed to or a broadcast can reach, as a `WHERE`:
 * on the desk and not the assistant. Binds `[ASSISTANT_NAME]`. The ring and the
 * broadcast both read the directory through this, so the two cannot disagree about who
 * is in it — and `assign` judges the same set a row at a time.
 */
const ASSIGNABLE_STAFF_SQL = `display_name != ? AND ${ON_THE_DESK_SQL}`;

/**
 * Somebody this desk can put ON a conversation — the follower directory (#1086).
 *
 * The same directory `assign` reads and the same assistant rule, because a watcher
 * and an assignee are drawn from the same people. The refusal differs because the act
 * does: the assistant is not refused here for holding a queue it never works, but for
 * already reading every conversation in the scope, which makes following it a grant
 * that confers nothing and a record that says something untrue.
 *
 * Somebody an admin has taken off the desk (`onTheDesk`, #1083) is refused too. A follow is
 * a durable `conversation:read` on a customer's thread, and putting it on an ex-colleague
 * hands them the customer's words. Off-boarding withdraws existing follows from the
 * ledger beside their tuples; a new follow is refused while they are off the desk.
 */
function followableStaffOrThrow(ctx: OperationContext, principal: string): AgentProfileRow {
  const row = staffOrThrow(ctx, principal);
  if (isAssistant(row)) {
    throw substratError(
      'validation_failed',
      `the assistant cannot follow a conversation: ${principal} — it already reads every one of them`,
    );
  }
  if (!onTheDesk(row)) {
    throw substratError(
      'validation_failed',
      `not on this desk any more: ${principal} — they were taken off it, and an admin can put them back`,
    );
  }
  return row;
}

/**
 * A principal id, or a refusal a caller can read.
 *
 * `principalId.parse` alone throws a Zod error, which is not one of this vertical's
 * taxonomy codes and would reach a screen as an internal error rather than a 400.
 * Used where a principal arrives from the input and is NOT read back out of a table
 * first — which, deliberately, is only `unfollow-conversation`.
 */
function principalOrThrow(value: string): PrincipalId {
  const parsed = principalId.safeParse(value);
  if (!parsed.success) {
    throw substratError('validation_failed', `not a principal id: ${value}`);
  }
  return parsed.data;
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
       (id, from_address, greeting, allowed_origins, verification_secret, business_hours,
        assistant_autonomous, abandoned_after_days, settings, round_robin_last,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // Supervised, written down rather than left null: a new desk HAS decided, and the
    // decision is the conservative one.
    //
    // `abandoned_after_days` goes the other way — null, deliberately, and this is the
    // one place the two columns part company. Autonomy is a decision a desk makes; the
    // reaping window is one the platform makes FOR a desk until it says otherwise, and
    // writing 30 here would put the number in two places, so a later change to the
    // default would move it for desks minted after the change and not for the rest.
    //
    // `settings` is null for the same reason as the migration's: nothing switched on,
    // which is what every behaviour reads as off. A new desk starts where an old one
    // does. `round_robin_last` is null because nobody has been handed anything yet.
    [
      DESK,
      'support@example.com',
      'Hi - how can we help?',
      '[]',
      ulid(),
      null,
      0,
      null,
      null,
      null,
      now,
      now,
    ],
  );
  return ctx.sql.query<DeskRow>('SELECT * FROM ticket0_desk_settings WHERE id = ?', [DESK])[0]!;
}

/**
 * Never hand the secret back on an ordinary read — nor the round-robin cursor, which
 * is the sweep's bookkeeping rather than anything the desk decided (`deskPublic` in
 * the model says the same thing to the schema).
 */
function publicDesk(row: DeskRow) {
  const { verification_secret: _secret, round_robin_last: _cursor, ...rest } = row;
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
  heldOrThrow(row, operation);
  const outcome = assertTransition(
    ticket0Lifecycles.conversation,
    `conversation ${row.id}`,
    row.state,
    operation,
    // #1745: the record, so a refused move is counted against it on the process map.
    { entityType: 'conversation', entityId: row.id },
  );
  // `allowed` is not a degenerate transition: writing `state` after one would move
  // an entity the declaration says stays put.
  return outcome.kind === 'transition' ? outcome.to : row.state;
}

/**
 * What may happen to a conversation in the suspended queue (#1088), and nothing else may.
 *
 * Suspension keeps `state = 'new'` (see `quarantine` in the model), so the declared
 * lifecycle would admit an assignment, a public reply or an assistant draft on one. This
 * is the queue's half of the rule, and it lives in `step()` because every operation that
 * touches a conversation already names itself there — one chokepoint, not a guard per
 * handler that the next handler forgets.
 *
 *  - The customer's doors stay open: `ingest-message`, `widget-post` and `request-human`
 *    write what they said into the held conversation, which stays held. Refusing them
 *    would turn a false positive into a customer who cannot even finish a sentence.
 *  - The ways out: `restore`, and the two discards. `suspend` again is a no-op.
 *  - Everything else — reply, note, assign, tag, priority, snooze, resolve, close, merge,
 *    a macro, the assistant recording a draft — is refused with `reason: 'suspended'`,
 *    because each one is the desk working a conversation it has not accepted.
 */
const WHILE_SUSPENDED: ReadonlySet<string> = new Set([
  'ticket0/ingest-message',
  'ticket0/widget-post',
  'ticket0/request-human',
  'ticket0/suspend',
  'ticket0/restore',
  'ticket0/discard',
  'ticket0/discard-suspended',
]);

/** The two edges that destroy content, and they take only what is suspended. */
const DISCARD_EDGES: ReadonlySet<string> = new Set(['ticket0/discard', 'ticket0/discard-suspended']);

function heldOrThrow(row: ConversationRow, operation: string): void {
  if (row.quarantine === 'suspended' && !WHILE_SUSPENDED.has(operation)) {
    throw substratError(
      'conflict',
      `conversation ${row.id} is in the suspended queue — restore it ("not spam") before ` +
        `'${operation}', or discard it`,
      { reason: 'suspended' },
    );
  }
  // The destruction is a decision about junk somebody has looked at, never a faster
  // close: anything not in the suspended queue is refused, whatever its state.
  if (DISCARD_EDGES.has(operation) && row.quarantine !== 'suspended') {
    throw substratError(
      'conflict',
      `conversation ${row.id} is not in the suspended queue — only a suspended conversation can be discarded`,
      { reason: 'not_suspended' },
    );
  }
}

/**
 * The signup machine's answer for one row — `step`, for the other entity that has one.
 *
 * Same shape and same reason: the declaration in `spec/model.ts` decides, and an
 * `allowed` outcome is not a degenerate transition, so a re-submission of an address
 * already pending writes no state at all.
 */
function stepSignup(row: SignupRow, operation: string): string {
  const outcome = assertTransition(
    ticket0Lifecycles.signup,
    `signup ${row.id}`,
    row.state,
    operation,
    { entityType: 'signup', entityId: row.id },
  );
  return outcome.kind === 'transition' ? outcome.to : row.state;
}

/**
 * An unguessable token — the same two-ULID shape the widget session uses.
 *
 * 160 bits of the platform's own id source rather than a hand-rolled random string,
 * for the reason the module rules give: module code has one clock and one source of
 * ids, and inventing a second of either is how they start disagreeing.
 */
function signupToken(): string {
  return `${ulid()}${ulid()}`;
}

/**
 * Never hand back the capability that manufactures a consent record. Mirrors `publicDesk`.
 *
 * The unsubscribe token stays in, deliberately: it grants only removal, and the Monday
 * send needs it to put a way out in every issue. See the field's own comment in the model
 * for why one of the two is hashed and the other is not.
 */
function signupPublic(row: SignupRow) {
  const { confirm_token_hash: _confirm, ...rest } = row;
  return rest;
}

function signupOrThrow(ctx: OperationContext, id: string): SignupRow {
  const row = ctx.sql.query<SignupRow>('SELECT * FROM ticket0_signups WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `signup not found: ${id}`);
  return row;
}

/**
 * The row a confirm token opens, by its HASH — the only form the table holds, so a
 * reader of this database cannot replay a confirmation, and a caller holding one gets
 * exactly the row it belongs to with no id to widen.
 */
async function signupByConfirmToken(
  ctx: OperationContext,
  token: string,
): Promise<SignupRow | undefined> {
  return ctx.sql.query<SignupRow>(
    'SELECT * FROM ticket0_signups WHERE confirm_token_hash = ?',
    [await sha256(token)],
  )[0];
}

/** The row an unsubscribe token opens. Stored in the clear — see the field's comment. */
function signupByUnsubscribeToken(
  ctx: OperationContext,
  token: string,
): SignupRow | undefined {
  return ctx.sql.query<SignupRow>('SELECT * FROM ticket0_signups WHERE unsubscribe_token = ?', [
    token,
  ])[0];
}

/**
 * An address, as this table keys it.
 *
 * `z.string().email()` rejects surrounding whitespace and accepts any casing, so
 * `Markus@Example.com` and `markus@example.com` reached the lookup as different
 * addresses — two rows, two confirmation emails, and a resend throttle that applied to
 * neither. Domains are case-insensitive by RFC and local parts are technically not; no
 * mail provider anybody signs up from makes that distinction, and treating one person
 * as two is the worse error by a wide margin.
 */
function addressKey(email: string): string {
  return email.toLowerCase();
}

// ---------------------------------------------------------------------------
// The blocklist (#1088)
// ---------------------------------------------------------------------------

/**
 * What a refused sender is told, and it is the same sentence at both doors.
 *
 * It names no rule, and that is deliberate on the widget side: the visitor reads this
 * in a chat bubble, and "the domain example.com is blocked here" would let anyone with
 * a browser enumerate a desk's blocklist one address at a time. It says enough to stop
 * somebody retyping the message, and nothing a probe could learn from.
 *
 * Exported so the suite and the inbound receiver can recognise it without re-typing the
 * prose — see `harness/inbound.ts`, which turns this refusal into a 200 rather than
 * letting Resend retry a mail this desk will never accept.
 */
export const SENDER_BLOCKED = 'this desk is not accepting messages from you';

/**
 * What a redelivery of a DISCARDED mail is told (#1088), and why it is a refusal rather
 * than an answer: the mail was received, a person decided it was junk and destroyed
 * it, and the one honest reply to "here it is again" is that it was already handled.
 * Ingesting it again would put back exactly what was destroyed.
 *
 * `forbidden`, like `SENDER_BLOCKED`, so `harness/inbound.ts` answers the provider a 2xx
 * and the retries stop; exported for the same reason that one is, so the receiver can
 * tell the two apart without re-typing the prose.
 */
export const DELIVERY_DISCARDED = 'this mail was already received here, and discarded';

/**
 * The delivery a mail `Message-ID` names, if this desk has handled it — the ONE dedupe
 * read for mail (#1088). See `mailDelivery` in the model for why it is not the message.
 */
function deliveryOf(ctx: OperationContext, emailMessageId: string): MailDeliveryRow | undefined {
  return ctx.sql.query<MailDeliveryRow>('SELECT * FROM ticket0_mail_deliveries WHERE email_message_id = ?', [
    emailMessageId,
  ])[0];
}

/** Write it down. OR IGNORE: the first message to carry an id keeps it, as the dedupe always read it. */
function recordDelivery(ctx: OperationContext, message: MessageRow, direction: MailDeliveryRow['direction']): void {
  if (!message.email_message_id) return;
  ctx.sql.exec(
    `INSERT OR IGNORE INTO ticket0_mail_deliveries
       (email_message_id, conversation_id, message_id, direction, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [message.email_message_id, message.conversation_id, message.id, direction, ctx.now()],
  );
}

/** What a rule looks like once a person's typing has been taken out of it. */
function blockValueOf(ctx: OperationContext, kind: BlockRuleRow['kind'], raw: string): string {
  const value = raw.trim();
  if (kind === 'contact') {
    // A rule naming nobody would sit in the table refusing no one, and read as
    // protection. `contactOrThrow` is the same check every other contact input gets.
    return contactOrThrow(ctx, value).id;
  }
  if (kind === 'email') {
    const parsed = z.string().email().safeParse(value);
    if (!parsed.success) throw substratError('validation_failed', `${raw} is not an email address`);
    return addressKey(parsed.data);
  }
  // A domain, however it was offered: `@example.com`, `EXAMPLE.com`, or an address
  // somebody pasted whole because that is what was in front of them.
  const domain = addressKey(value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : value);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    throw substratError('validation_failed', `${raw} is not a domain`);
  return domain;
}

/**
 * Every domain a rule could refuse this address by — its own, then each parent.
 *
 * `spam@mail.throwaway.example` → `mail.throwaway.example`, `throwaway.example`. So one
 * rule on `throwaway.example` covers every sub-domain a provider hands out, which is
 * the shape abuse from email actually takes; the alternative is an admin adding a row
 * per sub-domain against a generator that makes them for free.
 *
 * It stops before the bare TLD — not by taste, but because `blockValueOf` will not
 * store a domain without a dot in it, so a rule on `example` cannot exist to be found.
 * The two halves agree by construction rather than by both remembering.
 */
function domainChainOf(email: string): string[] {
  const at = email.lastIndexOf('@');
  if (at < 0) return [];
  const labels = addressKey(email.slice(at + 1))
    .split('.')
    .filter(Boolean);
  return labels
    .map((_, i) => labels.slice(i).join('.'))
    .filter((domain) => domain.includes('.'));
}

/**
 * Whoever is knocking, in the terms a rule can be about.
 *
 * `emails` is a LIST because a caller can hold more than one address for the same
 * knock and they need not agree: `widget-start` has the address stored on the contact
 * AND the one the host page is vouching for this time. Probing only the first lets a
 * rule about the second through, so every address in hand is probed and any of them
 * matching is a refusal. Nulls are tolerated so a call site can pass what it has
 * without a ternary at each one.
 */
interface BlockProbe {
  readonly emails?: readonly (string | null | undefined)[];
  readonly contactId?: string | null;
}

/**
 * The rule that refuses this sender, or nothing.
 *
 * One query over all three kinds rather than three, because the answer is "is anything
 * in this table about them" and three round trips would be three chances for two of
 * them to be about different moments.
 */
function blockedBy(ctx: OperationContext, probe: BlockProbe): BlockRuleRow | undefined {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (probe.contactId) {
    clauses.push("(kind = 'contact' AND value = ?)");
    params.push(probe.contactId);
  }
  // De-duplicated, because the two addresses a caller holds are usually the same one
  // and a repeated clause is a repeated scan for no extra answer.
  for (const address of new Set(
    (probe.emails ?? []).filter((e): e is string => typeof e === 'string' && e.length > 0).map(addressKey),
  )) {
    clauses.push("(kind = 'email' AND value = ?)");
    params.push(address);
    /**
     * And any CONTACT rule about whoever owns this address, found by the address
     * rather than by the id the caller happened to resolve.
     *
     * Without this the contact kind is evadable by one capital letter.
     * `contactByEmail` matches exactly — deliberately, because `threadRepliedTo`
     * must not stitch two people's threads together on a loose comparison — so mail
     * from `Spam@…` resolves to no contact, a second contact row is created, and a
     * rule an agent added against the first one never fires. The blocklist is
     * case-insensitive everywhere else, and this is what makes the third kind agree
     * with the other two. Threading semantics are untouched: this reads contacts, it
     * does not decide which one the message belongs to.
     */
    clauses.push(
      "(kind = 'contact' AND value IN (SELECT id FROM ticket0_contacts WHERE LOWER(email) = ?))",
    );
    params.push(address);
    const domains = domainChainOf(address);
    if (domains.length > 0) {
      // ONE bound JSON array, not a `?` per label: the chain comes from an inbound
      // address, which the sender writes, and a domain has up to ~127 labels while a
      // Durable Object binds 100 parameters in all (#1759).
      clauses.push("(kind = 'domain' AND value IN (SELECT value FROM json_each(?)))");
      params.push(JSON.stringify(domains));
    }
  }
  if (clauses.length === 0) return undefined;
  return ctx.sql.query<BlockRuleRow>(
    `SELECT * FROM ticket0_block_rules WHERE ${clauses.join(' OR ')}
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    params,
  )[0];
}

/**
 * Refuse, before anything is written and before a model is called.
 *
 * `forbidden` rather than `permission_denied`: nothing about a permission key decided
 * this, and the two codes stay distinguishable to a caller that has to tell "this
 * principal may not do that" from "this desk will not hear from this person". It is
 * also what lets `harness/inbound.ts` answer Resend a 200 for a mail that will never be
 * accepted instead of asking it to retry forever.
 */
/**
 * A model id as a log line may carry it (#1747). `model` is declared as any string, and a
 * log line is read across every desk that installed the vertical, so only a value SHAPED
 * like a model id goes out — one token of id characters (`@cf/meta/llama-3.1-8b`,
 * `openai/gpt-4o-mini`), no spaces, no `@` after the first character, which rules out a
 * sentence or an address. Anything else is logged as `unrecognised`; the turn row keeps
 * the value as it came.
 */
const MODEL_ID = /^[A-Za-z0-9@][A-Za-z0-9._:/-]{0,99}$/;
function modelForLog(model: string): string {
  return MODEL_ID.test(model) ? model : 'unrecognised';
}

function refuseIfBlocked(ctx: OperationContext, probe: BlockProbe): void {
  const rule = blockedBy(ctx, probe);
  if (rule) {
    // The rule's id, never the value it matched: that is an address or a domain, and a
    // log line is read by more people than the block list is.
    ctx.log.warn('refused a {sender} blocked by rule {ruleId}', {
      sender: probe.contactId ? 'known contact' : 'new sender',
      ruleId: rule.id,
    });
    throw substratError('forbidden', SENDER_BLOCKED, { reason: 'sender-blocked' });
  }
}

/**
 * The same check for a widget caller, whichever side of its first message they are on.
 *
 * An anonymous visitor who has said nothing has no contact and no address, so there is
 * nothing here to key on and nothing is refused — which is honest rather than a hole:
 * volume from brand-new strangers is what the widget surface's rate limit (#937) is
 * for, and this table cannot and should not pretend to do that job. From the second
 * message on, and from the first for a visitor the host site vouched for, there is a
 * contact, and a rule about them bites here.
 */
function refuseIfBlockedVisitor(ctx: OperationContext, hold: WidgetHold): void {
  const contactId =
    hold.kind === 'session' ? hold.conversation.contact_id : hold.opening.contact_id;
  if (!contactId) return;
  const contact = contactOrThrow(ctx, contactId);
  refuseIfBlocked(ctx, { emails: [contact.email], contactId: contact.id });
}

/**
 * One place that writes `state` and `updated_at`, so they cannot disagree — and so the
 * service-level clocks pause and resume on every edge into and out of `snoozed`, whichever
 * operation took it (#1648, `beginSnooze` / `endSnooze`).
 */
function moveTo(ctx: OperationContext, from: ConversationRow, state: string): ConversationRow {
  if (from.state === 'snoozed' && state !== 'snoozed') endSnooze(ctx, from.id);
  if (state === 'snoozed' && from.state !== 'snoozed') beginSnooze(ctx, from.id);
  ctx.sql.exec('UPDATE ticket0_conversations SET state = ?, updated_at = ? WHERE id = ?', [
    state,
    ctx.now(),
    from.id,
  ]);
  return conversationOrThrow(ctx, from.id);
}

function touch(ctx: OperationContext, id: string): ConversationRow {
  ctx.sql.exec('UPDATE ticket0_conversations SET updated_at = ? WHERE id = ?', [ctx.now(), id]);
  return conversationOrThrow(ctx, id);
}

/** Apply whatever the lifecycle decided, in one place. */
function settle(ctx: OperationContext, row: ConversationRow, next: string): ConversationRow {
  return next === row.state ? touch(ctx, row.id) : moveTo(ctx, row, next);
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
  /** Which contact wrote it, when a contact did (#1086). */
  readonly authorContactId?: string | null;
  /** The third party a `forward` message went to or came from (#1086). */
  readonly thirdPartyContactId?: string | null;
}

function writeMessage(ctx: OperationContext, m: WriteMessage): MessageRow {
  const id = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO ticket0_messages
       (id, conversation_id, author_kind, author_principal, visibility, body_text, body_html,
        email_message_id, email_in_reply_to, delivered_at, author_contact_id,
        third_party_contact_id, cited_article_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
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
      m.authorContactId ?? null,
      m.thirdPartyContactId ?? null,
      m.citedArticleIds && m.citedArticleIds.length > 0
        ? JSON.stringify(m.citedArticleIds)
        : null,
      now,
    ],
  );
  if (m.visibility === 'public') {
    if (m.authorKind === 'contact' || (m.authorKind === 'system' && m.bodyText === HANDED_TO_A_PERSON)) {
      // A nudge keeps the oldest unanswered instant. A new message after a notice
      // re-arms the candidate even if both writes have the same millisecond timestamp.
      ctx.sql.exec(
        `UPDATE ticket0_conversations
            SET no_reply_candidate_at = CASE
                  WHEN no_reply_notified_at > COALESCE(no_reply_waiting_since, ?) THEN no_reply_notified_at
                  ELSE COALESCE(no_reply_waiting_since, ?) END,
                no_reply_waiting_since = COALESCE(no_reply_waiting_since, ?)
          WHERE id = ?`,
        [now, now, now, m.conversationId],
      );
    } else {
      // A public desk answer ends this stretch of waiting. Internal notes never do.
      ctx.sql.exec(
        'UPDATE ticket0_conversations SET no_reply_waiting_since = NULL, no_reply_candidate_at = NULL WHERE id = ?',
        [m.conversationId],
      );
    }
  }
  ctx.link({ entityType: 'message', entityId: id }, conversationRef(m.conversationId));
  return messageOrThrow(ctx, id);
}

/**
 * The first line of the note an inbound mail's attachments leave behind (#1080).
 *
 * Exported so the suite can find the note without re-typing its prose, and so the
 * desk's own screens have one string to look for if they ever want to draw it as
 * something other than a note.
 */
export const ATTACHMENTS_NOT_STORED =
  'Files came with this message and were not stored — this desk has nowhere to put them yet.';

/** The longest a filename or a content type is allowed to be before it is cut short. */
const ATTACHMENT_FIELD_MAX = 200;

/** How many files the note names one by one before it starts counting them instead. */
const ATTACHMENT_NOTE_MAX = 100;

/**
 * One field of one file, flattened to a single line.
 *
 * A filename is the SENDER's text — anyone who can email this desk chooses it — and the
 * relay is a courier rather than a filter, so it arrives here untrusted. A newline in it
 * would forge a second bullet in the note and an agent would read a file that was never
 * sent; a filename the length of a novel would be the whole thread. So control
 * characters become spaces and the rest is cut to a length a person can read.
 *
 * U+2028 and U+2029 are in that class with the C0 controls even though they are not
 * controls: the staff thread draws a note with pre-wrap whitespace, where both break a
 * line exactly as a newline does. What decides this list is what puts text on a new
 * line on a screen, not which Unicode category a code point is filed under.
 */
function oneLine(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return flat.length > ATTACHMENT_FIELD_MAX ? `${flat.slice(0, ATTACHMENT_FIELD_MAX)}…` : flat;
}

/** How one dropped file reads. Exact bytes: a rounded size is a number nobody can act on. */
function attachmentLine(a: { filename: string; contentType: string; sizeBytes: number }): string {
  const name = oneLine(a.filename) || '(unnamed)';
  const type = oneLine(a.contentType) || '(unknown type)';
  return `- ${name} (${type}, ${a.sizeBytes} bytes)`;
}

/**
 * The internal note that stands in for the files themselves.
 *
 * Everything the mail told us about each file, and one sentence saying plainly that
 * the bytes are gone — so an agent reading the thread knows to go to the original mail
 * rather than telling a customer nothing arrived.
 *
 * **Bounded, and that bound is a correctness property rather than a nicety.** This note
 * is written inside the ingest transaction, beside the customer's own message, so a
 * `body_text` big enough to be refused takes the MESSAGE down with it — the mail would
 * arrive nowhere at all, which is worse than the silent drop this exists to fix. A mail
 * carrying more files than a person will read therefore gets a count instead of a list;
 * the fields are cut by `oneLine` for the same reason one level down. The input schema
 * still refuses nothing, deliberately: what is bounded is what this desk WRITES, not
 * what it will accept, so no mail is ever rejected over its attachment count.
 *
 * The filenames are the customer's words, and this note holds them exactly as every
 * other message holds a body: `message.erasable` names `body_text`, which is what keeps
 * it off every event (`shredSubject` redacts the outbox, never a vertical's own table),
 * and it is also why this note emits no event of its own. Whatever erases a customer's
 * messages from this desk reaches the note on the same terms — no better, no worse.
 */
function droppedAttachmentsNote(
  attachments: readonly { filename: string; contentType: string; sizeBytes: number }[],
): string {
  const named = attachments.slice(0, ATTACHMENT_NOTE_MAX).map(attachmentLine);
  const rest = attachments.length - named.length;
  return [
    ATTACHMENTS_NOT_STORED,
    ...named,
    ...(rest > 0 ? [`- and ${rest} more, not named here`] : []),
  ].join('\n');
}

/**
 * What a visitor who asked for a person is told, straight away. One sentence, one
 * place — and deliberately not a promise about how long it will take, which is a thing
 * this code cannot know and the desk's own reply can say.
 */
export const HANDED_TO_A_PERSON =
  'Passing this to a person now \u2014 someone from the team will reply here.';

/**
 * The message the handoff is about, when the visitor typed it rather than clicking.
 *
 * The newest public thing they said. Their request IS a message the thread already
 * holds; the event needs an entity, and it should be that one rather than the
 * acknowledgement, which is the desk talking to itself about them.
 */
function lastCustomerMessage(ctx: OperationContext, conversationId: string): MessageRow {
  const row = ctx.sql.query<MessageRow>(
    `SELECT * FROM ticket0_messages
      WHERE conversation_id = ? AND author_kind = 'contact' AND visibility = 'public'
      ORDER BY id DESC LIMIT 1`,
    [conversationId],
  )[0];
  if (!row) throw substratError('validation_failed', 'nothing has been said in this conversation yet');
  return row;
}

/**
 * Is a request for a person still standing on this conversation?
 *
 * True when the newest thing the DESK said in public is the acknowledgement — nobody
 * has replied since, so the ask is still outstanding and everyone who could pick it up
 * has already been told. A second click is the same request, and telling the desk twice
 * is how a support tool teaches its staff to ignore it.
 *
 * A **public** agent or assistant word clears it, and only a public one: the
 * conversation moved, and the next ask is a new one. An internal note is a colleague
 * thinking out loud — the visitor has been told nothing, so their request is still the
 * one the desk was told about, and treating a note as a reply would ping everybody a
 * second time over an answer nobody has sent.
 *
 * `handoffStandsSql` is the rule; this is its reading for one conversation. Round-robin
 * reads the same fragment inside its scan (#1083), so "handed to a person" cannot mean
 * one thing when the desk decides whether to notify and another when it decides whether
 * to assign.
 */
function handoffStands(ctx: OperationContext, conversationId: string): boolean {
  return (
    ctx.sql.query<{ stands: number }>(`SELECT ${handoffStandsSql('?')} AS stands`, [
      HANDED_TO_A_PERSON,
      conversationId,
    ])[0]?.stands === 1
  );
}

/**
 * "A request for a person still stands on this conversation", as SQL.
 *
 * The newest thing the desk said in public is the acknowledgement `request-human`
 * wrote, so nobody has answered since. `handoffStands` above says why each word of that
 * is what it is.
 *
 * `conversation` is the SQL expression that names the conversation: `?` for one named
 * row, `c.id` inside a scan. The fragment binds ONE parameter of its own,
 * `HANDED_TO_A_PERSON`, and it comes textually BEFORE the conversation's placeholder, so
 * a caller passing `?` binds `[HANDED_TO_A_PERSON, conversationId]` in that order.
 *
 * Answers 1 or 0, never NULL: a conversation where the desk has said nothing in public
 * has no newest word, and `IS 1` reads that as "no request stands" rather than as a
 * third value.
 */
function handoffStandsSql(conversation: string): string {
  return `(SELECT m.author_kind = 'system' AND m.body_text = ?
             FROM ticket0_messages m
            WHERE m.conversation_id = ${conversation}
              AND m.visibility = 'public'
              AND m.author_kind IN ('system', 'agent', 'assistant')
            ORDER BY m.id DESC LIMIT 1) IS 1`;
}

/**
 * "The assistant's latest turn on this conversation handed it to a person", as SQL
 * (#1083).
 *
 * `escalated` (the documentation had nothing) and `failed` (the assistant did not run)
 * are the two outcomes that already tell the whole desk. Only the LATEST turn counts,
 * for the reason only the newest desk word counts in `handoffStandsSql`. A turn that
 * escalated, followed by one the assistant answered, is a conversation the assistant is
 * handling again, and a historical escalation must not hand it to somebody.
 *
 * Binds nothing. Same `conversation` contract as `handoffStandsSql`.
 */
function escalationStandsSql(conversation: string): string {
  return `(SELECT t.outcome IN ('escalated', 'failed')
             FROM ticket0_ai_turns t
            WHERE t.conversation_id = ${conversation}
            ORDER BY t.created_at DESC, t.id DESC LIMIT 1) IS 1`;
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
): boolean {
  // Never tell someone about their own act.
  if (principal === String(ctx.principal)) return false;
  ctx.sql.exec(
    `INSERT INTO ticket0_notifications (id, principal, kind, conversation_id, read_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [ulid(), principal, kind, conversationId, ctx.now()],
  );
  return true;
}

/**
 * Tell whoever is holding this conversation — and when nobody is, tell everybody.
 *
 * The rule used to be the first half alone, and on the path that needs it most the
 * first half tells nobody: a widget conversation is unassigned by construction, so
 * every escalation the assistant made — no documentation, a model that would not
 * run, a visitor asking for a person — wrote its turn, moved on, and pinged thin
 * air. "It is back in the inbox" is a true sentence about an unassigned conversation
 * and a useless one about an escalated conversation, which is the difference: the
 * inbox is somewhere people look eventually, and an escalation is a claim that
 * eventually is too late.
 *
 * "Everybody" is `ticket0_agent_profiles`, which is this desk's only in-scope record
 * of a colleague — the same directory `staffOrThrow` admits an assignee from, and
 * for the same reason: module code cannot ask the kernel who else holds a permission.
 * There is no presence to read, so nobody here pretends to know who is at their desk.
 *
 * Returns how many rows it wrote, which is how many people were actually told.
 */
function notifyStaff(
  ctx: OperationContext,
  conversation: ConversationRow,
  kind: NotificationRow['kind'],
): number {
  // Whoever holds it — unless they have been taken off the desk. Telling somebody who
  // is not there is telling nobody, which is the failure the rest of this function exists
  // to refuse, so a conversation held by a departed colleague is the desk's to hear about.
  // The conversation itself is not moved (`onTheDesk` says why).
  if (conversation.assignee) {
    const holder = profileOf(ctx, conversation.assignee);
    if (holder === undefined || onTheDesk(holder))
      return notify(ctx, conversation.assignee, kind, conversation.id) ? 1 : 0;
  }
  // Not the assistant's own accounts, which are in this directory because they need a
  // byline — and only for that, since #1154: `assignableStaffOrThrow` refuses them as
  // an assignee too. Telling the assistant that the assistant gave up is a notification
  // nobody will ever read, and it would make `notified` claim more people than the desk
  // actually has. The name is the test the same way `post-public-reply` decides an
  // author's kind by it — one rule about who the assistant is, not three.
  const staff = ctx.sql.query<{ principal: string }>(
    `SELECT principal FROM ticket0_agent_profiles WHERE ${ASSIGNABLE_STAFF_SQL} ORDER BY principal`,
    [ASSISTANT_NAME],
  );
  let told = 0;
  for (const row of staff) if (notify(ctx, row.principal, kind, conversation.id)) told++;
  return told;
}

// ---------------------------------------------------------------------------
// Closing — one body, three doors
// ---------------------------------------------------------------------------

/**
 * Close a conversation — everything a closing operation does after its permission check.
 *
 * Three operations run this: a person's `ticket0/close`, the reaper's
 * `ticket0/reap-abandoned` and the desk's `ticket0/auto-close`. The event is the promise
 * they share, and it is written once so it cannot drift: nothing downstream should have to
 * know which door a conversation left through, and the trail already names the operation.
 * `edge` is the operation's own name because the lifecycle declares each door's edge
 * separately — the reaper's only out of `new`, auto-close's only out of `resolved` — so a
 * caller that widened its query is refused by the machine and not by this function.
 */
function closeConversation(
  ctx: OperationContext,
  conversation: ConversationRow,
  edge:
    | 'ticket0/close'
    | 'ticket0/reap-abandoned'
    | 'ticket0/auto-close'
    | 'ticket0/discard'
    | 'ticket0/discard-suspended',
): ConversationRow {
  const row = settle(ctx, conversation, step(conversation, edge));
  ctx.emit({
    type: 'ticket0.conversation-closed',
    schemaVersion: 1,
    entity: conversationRef(row.id),
    piiClass: 'none',
    payload: { id: row.id },
  });
  return row;
}

// ---------------------------------------------------------------------------
// The suspended queue (#1088) — held beside the inbox, and a person decides
// ---------------------------------------------------------------------------

/** The signals a row was held for, parsed — leniently, as every stored JSON here is read. */
function suspicionOfRow(suspicion: string | null): SuspicionSignal[] {
  if (suspicion === null) return [];
  try {
    const parsed = JSON.parse(suspicion) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((s): s is SuspicionSignal => suspicionSignal.safeParse(s).success)
      : [];
  } catch {
    return [];
  }
}

/**
 * Hold a conversation out of the inbox — everything `ticket0/suspend` does after its
 * check, and what the spam filter does at the door. One body, two doors, for
 * `assignConversation`'s reason: the row and the event are the same whoever decided.
 *
 * `step()` with `ticket0/suspend` is what limits it to `new`, by the lifecycle, so the
 * door cannot suspend a conversation somebody worked any more than a person can. Nothing
 * of the conversation but these three columns is written — its messages, tags, follows
 * and contact are untouched — so a restore that clears `quarantine` is the whole undo,
 * which is what "lossless" means here. What it does retire is the desk's notifications
 * about it, which are not the conversation.
 */
function suspendConversation(
  ctx: OperationContext,
  conversation: ConversationRow,
  signals: readonly SuspicionSignal[],
): ConversationRow {
  step(conversation, 'ticket0/suspend');
  if (conversation.quarantine === 'suspended') return conversation;
  ctx.sql.exec(
    `UPDATE ticket0_conversations SET quarantine = 'suspended', suspended_at = ?, suspicion = ?
      WHERE id = ?`,
    [ctx.now(), JSON.stringify(signals), conversation.id],
  );
  // Anything the desk was told about it is retired with it (#1088): an alert pointing at
  // a conversation nobody may now work is a task nobody can do. A restore brings none
  // back — they described a moment that has passed — and what happens after it notifies
  // as anything in the inbox does.
  ctx.sql.exec('DELETE FROM ticket0_notifications WHERE conversation_id = ?', [conversation.id]);
  const row = conversationOrThrow(ctx, conversation.id);
  // The signal NAMES only — never which link or which text tripped one: that is the
  // customer's message, and a log line is read by more people than the queue is.
  ctx.log.info('conversation {conversationId} suspended for {signals}', {
    conversationId: row.id,
    signals: signals.join(','),
  });
  ctx.emit({
    type: 'ticket0.conversation-suspended',
    schemaVersion: 1,
    entity: conversationRef(row.id),
    piiClass: 'none',
    payload: {
      id: row.id,
      quarantine: row.quarantine,
      suspended_at: row.suspended_at,
      suspicion: row.suspicion,
    },
  });
  return row;
}

/**
 * Every follow on a conversation, revoked with its ledger row — what a merge does to the
 * loser and a discard to the tombstone (#1088): neither is a thread anybody should still
 * be holding a read grant on.
 */
async function dropFollowers(ctx: OperationContext, conversationId: string): Promise<void> {
  for (const follower of followersOf(ctx, conversationId)) {
    await ctx.revoke(principalId.parse(follower), T0_PERM.conversationRead, conversationRef(conversationId));
  }
  ctx.sql.exec('DELETE FROM ticket0_conversation_follows WHERE conversation_id = ?', [conversationId]);
}

// ---------------------------------------------------------------------------
// Participants (#1086) — who else is on a conversation
// ---------------------------------------------------------------------------

/** An address, as a recipient list's entries are judged. Built once: the list can be long. */
const EMAIL = z.string().email();

/** Where somebody stands on a conversation: the requester, a participant, or nowhere. */
type Standing = 'requester' | ParticipantRow['role'];

const PARTICIPANT_COLUMNS = 'id, conversation_id, contact_id, role, added_by, created_at';

/** One contact's participant row on one conversation, or nothing. */
function participantOf(
  ctx: OperationContext,
  conversationId: string,
  contactId: string,
): ParticipantRow | undefined {
  return ctx.sql.query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLUMNS} FROM ticket0_conversation_participants
      WHERE conversation_id = ? AND contact_id = ?`,
    [conversationId, contactId],
  )[0];
}

/** Every participant row on a conversation, in the order they joined. */
function participantsOf(ctx: OperationContext, conversationId: string): ParticipantRow[] {
  return ctx.sql.query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLUMNS} FROM ticket0_conversation_participants
      WHERE conversation_id = ? ORDER BY created_at, id`,
    [conversationId],
  );
}

/** How many CCs and third parties a conversation carries — what `PARTICIPANTS_MAX` bounds. */
function participantCount(ctx: OperationContext, conversationId: string): number {
  return Number(
    ctx.sql.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ticket0_conversation_participants WHERE conversation_id = ?',
      [conversationId],
    )[0]?.n ?? 0,
  );
}

/** Who follows a conversation, from #1941's ledger beside the grants. */
function followersOf(ctx: OperationContext, conversationId: string): string[] {
  return ctx.sql
    .query<{ principal: string }>(
      'SELECT principal FROM ticket0_conversation_follows WHERE conversation_id = ? ORDER BY principal',
      [conversationId],
    )
    .map((f) => f.principal);
}

/**
 * Where a contact stands on a conversation — the ONE reading of it, for threading, for
 * which audience an inbound mail is written to, and for who may add people by mail.
 * Null is a stranger to this conversation.
 */
function standingOn(ctx: OperationContext, conversation: ConversationRow, contactId: string): Standing | null {
  if (conversation.contact_id === contactId) return 'requester';
  return participantOf(ctx, conversation.id, contactId)?.role ?? null;
}

/**
 * The contact an address names, made when there is none — the same exact lookup an inbound
 * sender gets (`contactByEmail`), so a CC who later writes in from that address is the
 * contact they were copied in as. `verified_at` stays null: nobody has heard from them.
 */
function contactForAddress(ctx: OperationContext, email: string, name?: string | null): ContactRow {
  return contactByEmail(ctx, email) ?? createContact(ctx, { email, display_name: name ?? null });
}

/**
 * The contact a person may put on a conversation by address, or the refusal naming why
 * not (`recipientRefusal`) — what `add-participant` and `forward-message` both call.
 */
function recipientOrThrow(ctx: OperationContext, email: string, name?: string | null): ContactRow {
  const known = contactByEmail(ctx, email);
  const refusal = recipientRefusal(ctx, email, known, addressKey(desk(ctx).from_address));
  if (refusal) throw substratError('validation_failed', refusal);
  return known ?? createContact(ctx, { email, display_name: name ?? null });
}

/**
 * Why an address may not be put on a conversation, or null — the rule itself, which
 * `recipientOrThrow` refuses on and a mail's recipient list (`captureRecipients`) skips
 * on, so the three doors that add people cannot disagree about who may be.
 *
 *  - Not the desk itself (#1086): a CC on it would copy every reply back to the desk as
 *    inbound mail — the one loop this feature could otherwise open. `deskKey` is the
 *    desk's own address as `addressKey` keys it, read once by the caller.
 *  - Not a sender this desk blocks: their reply would be refused at the door, which makes
 *    adding them a side thread that can never come back.
 */
function recipientRefusal(
  ctx: OperationContext,
  email: string,
  known: ContactRow | undefined,
  deskKey: string,
): string | null {
  if (addressKey(email) === deskKey) return 'that is this desk’s own address — its mail would come straight back';
  if (blockedBy(ctx, { emails: [email], contactId: known?.id ?? null }))
    return 'this desk blocks that sender, so nothing they wrote back would arrive';
  return null;
}

/**
 * Put a contact on a conversation in a role — everything the three doors share after their
 * own checks: a person's `add-participant`, a forward's third party, and a mail's To and Cc.
 *
 * Idempotent on the person: somebody already on it in this role is answered with their
 * row, and nothing is written or announced. Somebody on it in the OTHER role is a
 * conflict, because one address on both the customer's thread and a side thread is a
 * forward the customer can read. The requester is never added — they are the
 * conversation. `PARTICIPANTS_MAX` is checked last, so a repeat of somebody already on a
 * full conversation still answers.
 *
 * The event carries ids and the role, never the address, which is the contact's and
 * erasable.
 */
function putParticipant(
  ctx: OperationContext,
  conversation: ConversationRow,
  contactId: string,
  role: ParticipantRow['role'],
  addedBy: string | null,
): { row: ParticipantRow; added: boolean } {
  if (contactId === conversation.contact_id) {
    throw substratError('validation_failed', 'that is the person this conversation is with — they are already on it');
  }
  const existing = participantOf(ctx, conversation.id, contactId);
  if (existing) {
    if (existing.role === role) return { row: existing, added: false };
    throw substratError(
      'conflict',
      existing.role === 'cc'
        ? 'they are copied in on the customer’s thread — a forward to them is a reply the customer can read'
        : 'they are a third party on this conversation — copying them in would show them the customer’s thread',
      { reason: 'participant_role' },
    );
  }
  if (participantCount(ctx, conversation.id) >= PARTICIPANTS_MAX) {
    throw substratError('conflict', `a conversation carries at most ${PARTICIPANTS_MAX} people besides the customer`, {
      reason: 'participants_full',
    });
  }
  const row: ParticipantRow = {
    id: ulid(),
    conversation_id: conversation.id,
    contact_id: contactId,
    role,
    added_by: addedBy,
    created_at: ctx.now(),
  };
  ctx.sql.exec(
    `INSERT INTO ticket0_conversation_participants (${PARTICIPANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.conversation_id, row.contact_id, row.role, row.added_by, row.created_at],
  );
  ctx.emit({
    type: 'ticket0.participant-added',
    schemaVersion: 1,
    entity: conversationRef(conversation.id),
    piiClass: 'none',
    payload: {
      id: row.id,
      conversation_id: row.conversation_id,
      contact_id: row.contact_id,
      role: row.role,
      added_by: row.added_by,
    },
  });
  return { row, added: true };
}

/**
 * The people an inbound mail was addressed to, put on the conversation as CCs (#1086).
 *
 * Only when the mail came from somebody on the customer's thread — the requester or a CC.
 * A third party's mail adds nobody: their recipient list is theirs, and copying it onto
 * the customer's thread is the side thread leaking into it. A stranger's mail into a
 * conversation it was bound to by id adds nobody either.
 *
 * Never refuses the mail. An address that does not parse, the sender, the requester, the
 * desk itself, a blocked sender, a third party already on it, and everyone past
 * `PARTICIPANTS_MAX` are left out — and the count of those left out for being past the
 * cap is logged, because a mail whose recipients were dropped is a fact somebody should be
 * able to find. Never which addresses: a log is read by more people than the thread is.
 */
function captureRecipients(
  ctx: OperationContext,
  conversation: ConversationRow,
  sender: ContactRow,
  addresses: readonly string[],
): void {
  const standing = standingOn(ctx, conversation, sender.id);
  if (standing !== 'requester' && standing !== 'cc') return;
  const deskKey = addressKey(desk(ctx).from_address);
  const seen = new Set<string>([addressKey(sender.email ?? '')]);
  // Counted once and kept here: the list is the sender's, and a long one must not cost a
  // query per address past the point where nobody more can be added.
  let count = participantCount(ctx, conversation.id);
  let overCap = 0;
  for (const raw of addresses) {
    const parsed = EMAIL.safeParse(raw.trim());
    if (!parsed.success) continue;
    const email = parsed.data;
    const key = addressKey(email);
    if (seen.has(key)) continue;
    seen.add(key);
    if (count >= PARTICIPANTS_MAX) {
      overCap++;
      continue;
    }
    const known = contactByEmail(ctx, email);
    if (known && standingOn(ctx, conversation, known.id) !== null) continue;
    if (recipientRefusal(ctx, email, known, deskKey)) continue;
    putParticipant(ctx, conversation, (known ?? contactForAddress(ctx, email)).id, 'cc', null);
    count++;
  }
  if (overCap > 0) {
    ctx.log.warn('{overCap} recipients of a mail on {conversationId} were not copied in: the conversation is full', {
      overCap,
      conversationId: conversation.id,
    });
  }
}

/**
 * Every CC on `closed`, carried onto the follow-up that continues it — the people on a
 * thread are on its continuation. Third parties are not: a side thread belonged to the
 * conversation it was about.
 */
function carryCcs(ctx: OperationContext, closed: ConversationRow, followUp: ConversationRow): void {
  for (const p of participantsOf(ctx, closed.id)) {
    if (p.role !== 'cc') continue;
    putParticipant(ctx, followUp, p.contact_id, 'cc', p.added_by);
  }
}

/**
 * The conversations among `conversationIds` the caller reads as a CC (#1086) — the
 * portal's second proof, beside the kernel's own walk.
 *
 * A `cc` row names a contact on a conversation, and the caller is checked by the KERNEL
 * for `conversation:read-own` on that contact — the grant a customer's portal is made of.
 * So nothing is granted to make a CC visible and nothing has to be revoked to stop it:
 * the row is the fact, the check is the proof, and deleting the row ends it at once.
 * `third-party` rows are not read here at all.
 *
 * One read for the whole page and one check per distinct contact on it.
 */
async function readableAsCc(ctx: OperationContext, conversationIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (conversationIds.length === 0) return out;
  const rows = ctx.sql.query<{ conversation_id: string; contact_id: string }>(
    // One bound JSON array: a page can name more conversations than a DO binds (#1759).
    `SELECT conversation_id, contact_id FROM ticket0_conversation_participants
      WHERE role = 'cc' AND conversation_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(conversationIds)],
  );
  const verdicts = new Map<string, boolean>();
  for (const row of rows) {
    let allowed = verdicts.get(row.contact_id);
    if (allowed === undefined) {
      allowed = (await ctx.check(T0_PERM.conversationReadOwn, contactRef(row.contact_id))).allowed;
      verdicts.set(row.contact_id, allowed);
    }
    if (allowed) out.add(row.conversation_id);
  }
  return out;
}

/**
 * The portal's door to one conversation: the kernel's walk (the requester's own grant,
 * through the parent edge), or a CC's proof (`readableAsCc`). Refused with the walk's own
 * denial, so a caller who is neither learns nothing new about why.
 */
async function assertReadsAsCustomer(ctx: OperationContext, conversationId: string): Promise<void> {
  const walk = await ctx.check(T0_PERM.conversationReadOwn, conversationRef(conversationId));
  if (walk.allowed) return;
  if ((await readableAsCc(ctx, [conversationId])).has(conversationId)) return;
  assertAllowed(walk);
}

/**
 * Take a discarded conversation's participants away, and with them the contacts that
 * junk alone brought into this desk (#1086).
 *
 * A mail's recipient list is the sender's text, and a discard is the desk deciding the
 * mail was junk. So a contact made to be a CC or a third party on it, who is on nothing
 * else here, goes with it: no other conversation is theirs, they are on no other one, no
 * message elsewhere names them, no rule blocks them, and neither a host site nor a login
 * vouched for them. A contact anything else names stays, exactly as the requester stays
 * (`ticket0/discard` says why).
 *
 * The widget's two tables are not asked, and need not be: a session's contact is its
 * conversation's (`bindOpening`), which "no conversation is theirs" already rules out, and
 * an opening names a contact only for a visitor the host site vouched for, which carries
 * an `external_id`. Every question asked is answered by an index.
 */
function dropParticipants(ctx: OperationContext, conversationId: string): void {
  const people = participantsOf(ctx, conversationId);
  ctx.sql.exec('DELETE FROM ticket0_conversation_participants WHERE conversation_id = ?', [conversationId]);
  if (people.length === 0) return;
  ctx.sql.exec(ORPHAN_CONTACTS_DELETE, [JSON.stringify(people.map((p) => p.contact_id))]);
}

/**
 * `dropParticipants`' delete: the contacts among a JSON array of ids that nothing else here
 * names. Exported so `test/participants.test.ts` holds its plan to an index per question —
 * a discard of a hundred conversations runs it a hundred times, and a scan of the message
 * table in any one of its questions would be a scan per discard. Binds `[json ids]`.
 */
export const ORPHAN_CONTACTS_DELETE = `DELETE FROM ticket0_contacts AS k
      WHERE k.id IN (SELECT value FROM json_each(?))
        AND k.external_id IS NULL AND k.principal IS NULL
        AND NOT EXISTS (SELECT 1 FROM ticket0_conversations c WHERE c.contact_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM ticket0_conversation_participants p WHERE p.contact_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM ticket0_messages m WHERE m.author_contact_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM ticket0_messages m WHERE m.third_party_contact_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM ticket0_block_rules b WHERE b.kind = 'contact' AND b.value = k.id)`;

/**
 * Destroy a suspended conversation's content — `ticket0/discard`, once per conversation
 * for the bulk one too, so the trail and the events are per conversation.
 *
 * The close goes FIRST, through `closeConversation`, because its `step()` is where the
 * refusals live: not suspended (`heldOrThrow`), or not `new` (the lifecycle). Nothing is
 * deleted for a conversation either one refuses.
 *
 * Then the content, and the list is the whole of where a customer's words live in this
 * desk's tables: `ticket0_messages` (their messages, the desk's notes, any draft, and the
 * note that names a mail's attachments — the bytes were never stored), the tags, and the
 * widget sessions (whose browser columns are about the person, and whose token must stop
 * working). Notifications go too: they point at a conversation nobody should open. So do
 * its CCs and third parties, and the contacts the junk alone brought in for them
 * (`dropParticipants`, #1086): a recipient list is the sender's text as much as the body
 * is. The subject is blanked, because on mail it is the sender's line. The contact and the
 * assistant's turns stay, and the model's `ticket0/discard` says why — and says exactly
 * what the guarantee covers: these tables and every event emitted from now on, and not
 * the copies older events already put in the outbox and the lake (#1692).
 */
async function discardConversation(
  ctx: OperationContext,
  conversation: ConversationRow,
  edge: 'ticket0/discard' | 'ticket0/discard-suspended',
): Promise<ConversationRow> {
  closeConversation(ctx, conversation, edge);
  // A follow is a read grant on this thread, and a tombstone is no thread to read.
  await dropFollowers(ctx, conversation.id);
  for (const table of [
    'ticket0_messages',
    'ticket0_conversation_tags',
    'ticket0_widget_sessions',
    'ticket0_notifications',
  ] as const) {
    ctx.sql.exec(`DELETE FROM ${table} WHERE conversation_id = ?`, [conversation.id]);
  }
  // The people the junk named, and the contacts it alone brought in (#1086). After the
  // messages, which are what would otherwise still name them.
  dropParticipants(ctx, conversation.id);
  // The turns stay, for what they billed; the provider's error text goes, because it can
  // quote the message back (#1973 review).
  ctx.sql.exec('UPDATE ticket0_ai_turns SET error = NULL WHERE conversation_id = ?', [conversation.id]);
  // The mail stays RECEIVED — that is what stops a redelivery from bringing the words
  // back — and stops pointing at a message that no longer exists.
  ctx.sql.exec('UPDATE ticket0_mail_deliveries SET message_id = NULL WHERE conversation_id = ?', [
    conversation.id,
  ]);
  ctx.sql.exec(
    `UPDATE ticket0_conversations SET quarantine = 'discarded', subject = '' WHERE id = ?`,
    [conversation.id],
  );
  const row = conversationOrThrow(ctx, conversation.id);
  ctx.log.info('conversation {conversationId} discarded', { conversationId: row.id });
  ctx.emit({
    type: 'ticket0.conversation-discarded',
    schemaVersion: 1,
    entity: conversationRef(row.id),
    piiClass: 'none',
    payload: { id: row.id, quarantine: row.quarantine, suspicion: row.suspicion },
  });
  return row;
}

/**
 * How many links a text holds: `https://…`, `http://…` or `www.…`, each up to the next
 * space or delimiter. One pass and no nesting, so a hostile message cannot make it run
 * away. Counted in the text the customer wrote, never in a mail's HTML, whose footer
 * links say nothing about the sender.
 */
function linksIn(text: string): number {
  return text.match(/\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi)?.length ?? 0;
}

/**
 * Why the spam filter would hold this message back — the empty list when it would not
 * (#1088). Read at the door, before the message is written and before any model is
 * asked, which is the issue's whole cost argument: junk is held for the price of two
 * indexed reads and a regex, never an inference.
 *
 * Two questions, in this order, and the first is what keeps the false positives down:
 *
 *  1. **Is this a stranger?** A contact the host site vouched for (`external_id`) or who
 *     signed in (`principal`) is not; neither is one with any conversation the desk
 *     accepted — in the inbox now, or ever restored from the queue. Everybody else is,
 *     which on its own means nothing: every first-time visitor is a stranger.
 *  2. **Does what the stranger wrote look like junk?** Any of `links`, `repeated` or
 *     `discarded-before` (see `SUSPICION_SIGNALS`) holds it back.
 *
 * `conversationId` is the conversation the door has just opened for this message, so it
 * is not counted as the stranger's accepted history.
 */
function suspicionOf(
  ctx: OperationContext,
  filter: { maxLinks: number; repeatAfter: number },
  contact: ContactRow,
  conversationId: string,
  body: string,
): SuspicionSignal[] {
  if (contact.external_id !== null || contact.principal !== null) return [];
  // One walk of the contact's conversations answers both history questions.
  const history = ctx.sql.query<{ accepted: number | null; discarded: number | null }>(
    `SELECT MAX(id != ? AND ${inTheInbox()}) AS accepted, MAX(quarantine = 'discarded') AS discarded
       FROM ticket0_conversations WHERE contact_id = ?`,
    [conversationId, contact.id],
  )[0];
  if (history?.accepted) return [];

  const signals: SuspicionSignal[] = [];
  if (linksIn(body) > filter.maxLinks) signals.push('links');
  // Compared by SQLite on BOTH sides — `lower(trim(…))` of the stored text against the same
  // of this one — so ASCII-only `lower()` and space-only `trim()` mean one thing to both.
  // Bounded by the window, over the kernel's `(visibility, created_at, id)` message index.
  if (body.trim().length >= SPAM_REPEAT_MIN_CHARS) {
    // The AUTHOR of each copy (#1086): a CC's message on somebody else's conversation is
    // the CC writing, and the requester of that conversation did not send it. Migration
    // 0022 filled the column for every older contact message; the COALESCE covers a row
    // a version before it writes after a rollback, which carries none.
    const others = ctx.sql.query<{ n: number }>(
      `SELECT COUNT(DISTINCT COALESCE(m.author_contact_id, c.contact_id)) AS n
         FROM ticket0_messages m
         JOIN ticket0_conversations c ON c.id = m.conversation_id
        WHERE m.visibility = 'public'
          AND m.created_at >= ?
          AND m.author_kind = 'contact'
          AND COALESCE(m.author_contact_id, c.contact_id) != ?
          AND lower(trim(m.body_text)) = lower(trim(?))`,
      [shiftInstant(ctx.now(), -SPAM_REPEAT_WINDOW_HOURS * 3_600_000), contact.id, body],
    )[0];
    if (Number(others?.n ?? 0) >= filter.repeatAfter) signals.push('repeated');
  }
  if (history?.discarded) signals.push('discarded-before');
  return signals;
}

/**
 * The spam filter, at a door that has just opened `conversation` for `body` (#1088):
 * hold it back when `suspicionOf` says so, and say that the filter acted.
 */
function screenAtTheDoor(
  ctx: OperationContext,
  conversation: ConversationRow,
  body: string,
): ConversationRow {
  // Off is the default, and costs one desk read: no contact, no history, no scan.
  const filter = spamFilterOf(desk(ctx));
  if (!filter) return conversation;
  const signals = suspicionOf(ctx, filter, contactOrThrow(ctx, conversation.contact_id), conversation.id, body);
  if (signals.length === 0) return conversation;
  const row = suspendConversation(ctx, conversation, signals);
  recordFired(ctx, 'spamFilter', 1);
  return row;
}

// ---------------------------------------------------------------------------
// Tagging — one body, two doors
// ---------------------------------------------------------------------------

/**
 * Put a tag on a conversation — everything `ticket0/tag-conversation` does after its
 * permission check (#1083).
 *
 * Two operations run this, a person's `tag-conversation` and the desk's `auto-tag`, for
 * `assignConversation`'s reason: the lifecycle rule, the row and the event are one piece
 * of code, and only who passed the check differs. `added` is whether this call put the
 * tag on: tagging twice is not a second tagging, so it emits nothing, and a consumer
 * counting the event is counting the tag going ON, once.
 */
function putTag(
  ctx: OperationContext,
  conversation: ConversationRow,
  tag: string,
): { row: TagRow; added: boolean } {
  step(conversation, 'ticket0/tag-conversation');
  const existing = ctx.sql.query<TagRow>(
    'SELECT * FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?',
    [conversation.id, tag],
  )[0];
  if (existing) return { row: existing, added: false };
  ctx.sql.exec(
    'INSERT INTO ticket0_conversation_tags (conversation_id, tag, created_at) VALUES (?, ?, ?)',
    [conversation.id, tag, ctx.now()],
  );
  const row = ctx.sql.query<TagRow>(
    'SELECT * FROM ticket0_conversation_tags WHERE conversation_id = ? AND tag = ?',
    [conversation.id, tag],
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
  return { row, added: true };
}

/**
 * Tell whoever holds a conversation about something that happened on it, and nobody when
 * nobody does (#1083).
 *
 * The four notices that go to a HOLDER (`replied`, `mentioned`, `snooze-woke`, and
 * `notifyStaff`'s own first branch) are one rule: a departed holder is not told, because
 * telling somebody who is not there is telling nobody. `notifyStaff` already falls back to
 * the whole desk in that case, so this is that function with its "nobody holds it" broadcast
 * switched off — an unassigned conversation is still nobody's to be told about, which is
 * the rule these call sites had before and the one the inbox already answers.
 */
function notifyHolder(
  ctx: OperationContext,
  conversation: ConversationRow,
  kind: NotificationRow['kind'],
): void {
  if (conversation.assignee) notifyStaff(ctx, conversation, kind);
}

// ---------------------------------------------------------------------------
// Assignment — one body, two doors
// ---------------------------------------------------------------------------

/**
 * Put a conversation in somebody's hands, or nobody's — everything `ticket0/assign`
 * does after its permission check (#1083).
 *
 * Two operations run this: a person's `assign` and the desk's own
 * `assign-round-robin`. They share it so that round-robin cannot become a second,
 * looser way to assign. The directory test, the lifecycle edge, the notification and
 * the event are the same code for both, and the only thing that differs is who passed
 * the permission check before calling it. Each caller makes that check itself, on the
 * same key and the same conversation.
 *
 * `first_assigned_at` is stamped here the first time a name goes on, and never cleared
 * — so unassigning leaves it standing, which is exactly how round-robin tells "nobody
 * has picked this up" from "somebody put it back".
 */
function assignConversation(
  ctx: OperationContext,
  conversation: ConversationRow,
  assignee: string | null,
): ConversationRow {
  // Before the write, not after: an assignee nobody can resolve is a queue entry
  // that never gets worked and a notification nobody receives.
  //
  // `!== null` rather than truthiness, because `''` is a string the schema accepts
  // and truthiness would wave it through — and an empty assignee is the exact
  // failure this check exists for: not null, so the row reads as assigned, and not
  // a person, so nobody is told and nobody works it.
  //
  // The assistant fails the same test for the same reason (#1154): it has a profile
  // row so its messages carry a name, not so it can hold a queue. The app stopped
  // offering it in #1323; this is the half that makes the API agree.
  if (assignee !== null) assignableStaffOrThrow(ctx, assignee);
  const next = step(conversation, 'ticket0/assign');
  ctx.sql.exec(
    `UPDATE ticket0_conversations
        SET assignee = ?, first_assigned_at = COALESCE(first_assigned_at, ?)
      WHERE id = ?`,
    [assignee, assignee === null ? null : ctx.now(), conversation.id],
  );
  const row = settle(ctx, conversation, next);
  if (assignee) notify(ctx, assignee, 'assigned', conversation.id);
  if (assignee) ctx.log.info('conversation {conversationId} assigned', { conversationId: row.id });
  else ctx.log.info('conversation {conversationId} put back unassigned', { conversationId: row.id });
  ctx.emit({
    type: 'ticket0.conversation-assigned',
    schemaVersion: 1,
    entity: conversationRef(row.id),
    piiClass: 'none',
    payload: { id: row.id, assignee: row.assignee, state: row.state },
  });
  return row;
}

/**
 * How many waiting conversations one run of `ticket0/assign-round-robin` hands out.
 * `WAKE_BATCH`'s bargain: a bound on one transaction, not a cap on the feature, because
 * the schedule comes back.
 */
const ROUND_ROBIN_BATCH = 200;

/**
 * The conversations round-robin may hand out, oldest first: the sweep's whole scan, as
 * one statement (#1083). `ticket0/assign-round-robin` says why each clause is there.
 *
 * It runs on every tick of every desk that has switched round-robin on, so it has
 * indexes of its own in migration 0011, one per table it reads:
 *
 *   - `ticket0_conversations_waiting`, PARTIAL over exactly this WHERE's first four
 *     terms, so it holds the waiting conversations and nothing else. A closed
 *     conversation the reaper took, which is never assigned and accumulates for the
 *     life of the desk, is not in it. It is led by `assignee`, although every row in it
 *     has NULL there. SQLite has no statistics for these tables, and without the
 *     equality on a leading column it prefers the kernel's own `(assignee, created_at,
 *     id)` list index. That index holds every unassigned conversation ever, reaped ones
 *     included.
 *   - `ticket0_ai_turns_by_conversation` for `escalationStandsSql`: seek to the
 *     conversation, newest turn first, no sort.
 *   - `ticket0_messages_public_by_conversation` for `handoffStandsSql`. The kernel's
 *     `(conversation_id, created_at, id)` list index exists, but with no statistics the
 *     planner picks `(visibility, created_at, id)` for this subquery instead, which
 *     reads every public message on the desk per candidate. Two equalities beat one.
 *
 * The four waiting terms must stay textually the same as the partial index's WHERE, or
 * SQLite stops using it. `test/round-robin.test.ts` holds the PLAN to all three
 * indexes, which is why this is exported.
 *
 * Binds `[autonomous ? 1 : 0, HANDED_TO_A_PERSON, limit]`.
 */
export const ROUND_ROBIN_WAITING = `SELECT * FROM ticket0_conversations c
        WHERE c.assignee IS NULL
          AND c.first_assigned_at IS NULL
          AND c.state IN ('new', 'open')
          AND c.merged_into IS NULL
          AND ${inTheInbox('c')}
          AND (? = 0
               OR c.channel != 'widget'
               OR ${escalationStandsSql('c.id')}
               OR ${handoffStandsSql('c.id')})
        ORDER BY c.created_at, c.id LIMIT ?`;

/** How many conversations one run of `ticket0/auto-tag` reads. `WAKE_BATCH`'s bargain. */
export const AUTO_TAG_BATCH = 200;
/** How many resolved conversations one run of `ticket0/auto-close` closes. `REAP_BATCH`'s bargain. */
export const AUTO_CLOSE_BATCH = 200;
/** How many customers one run of `ticket0/notify-no-reply` announces. `WAKE_BATCH`'s bargain. */
export const NO_REPLY_BATCH = 200;

/**
 * The conversations auto-tag has not looked at yet, oldest first (#1083). Binds
 * `[limit]`. Oldest first and bounded by `AUTO_TAG_BATCH`: a conversation the desk
 * permanently may not act on stays unstamped at the head, and enough of them could starve
 * the batch (theoretical today; the sweep logs how many it refused, and a keyset cursor on
 * `(created_at, id)` is the fix). The WHERE is textually the partial index's (`ticket0_conversations_untagged`
 * in migration 0016), which is why it is exported: `test/automation.test.ts` holds the
 * PLAN to it. Live work only: a resolved or closed conversation is done.
 */
export const AUTO_TAG_PENDING = `SELECT * FROM ticket0_conversations
        WHERE auto_tagged_at IS NULL
          AND state IN ('new', 'open', 'snoozed')
          AND merged_into IS NULL
          AND ${inTheInbox()}
        ORDER BY created_at, id LIMIT ?`;

/**
 * The resolved conversations left alone since `cutoff`, longest-idle first (#1083).
 * Binds `[cutoff, limit]`. Bounded by `AUTO_CLOSE_BATCH`, longest-idle first: a conversation the
 * desk permanently may not act on stays at the head and enough of them could starve the
 * batch (theoretical today; the sweep logs how many it refused, and a keyset cursor on
 * `(updated_at, id)` is the fix). `<=` is the boundary: idle EXACTLY the window is closed, a
 * second short is not.
 *
 * No index of its own, and that is measured rather than assumed: the kernel already
 * provisions `(state, updated_at)` for the conversation list's declared sort, and a
 * partial index of this shape lost to it or tied with it. `test/automation.test.ts`
 * holds the PLAN to a seek on both columns and no sort, so the day that list index goes
 * away this scan says so instead of quietly reading every conversation.
 */
export const AUTO_CLOSE_DUE = `SELECT * FROM ticket0_conversations
        WHERE state = 'resolved'
          AND merged_into IS NULL
          AND ${inTheInbox()}
          AND updated_at <= ?
        ORDER BY updated_at, id LIMIT ?`;

/**
 * Indexed candidates whose wait and notice throttle have both reached `cutoff` (#1083).
 * Binds `[cutoff, limit]`. `writeMessage` maintains the oldest unanswered instant and
 * re-arms a candidate on a new public customer message. A notice clears the candidate;
 * merely waiting longer never re-announces it. The candidate is the later of the oldest
 * unanswered message and the previous notice, so one window must pass on both clocks.
 * This also re-arms messages written in the notice's millisecond: the message write,
 * rather than a timestamp comparison, makes the candidate eligible again.
 *
 * The partial index excludes finished and parked conversations and orders due work.
 * A permanently refused candidate can still occupy the bounded batch repeatedly; a
 * cursor or retry time for refusals would address that separately.
 */
export const NO_REPLY_WAITING = `SELECT c.*, c.no_reply_waiting_since AS waiting_since
        FROM ticket0_conversations c INDEXED BY ticket0_conversations_no_reply_candidate
        WHERE c.no_reply_candidate_at IS NOT NULL
          AND c.state IN ('new', 'open')
          AND c.merged_into IS NULL
          AND ${inTheInbox('c')}
          AND c.no_reply_candidate_at <= ?
        ORDER BY c.no_reply_candidate_at, c.id LIMIT ?`;

/**
 * Who is next, after `after` — or who is first, when nobody has been handed anything
 * yet or `after` was the last in line.
 *
 * The ring is the desk's directory less the assistant: exactly the set `assign` accepts
 * as an assignee, by exactly the same test (`notifyStaff` reads the same set for the
 * same reason). Ordered by principal, which is stable and unique — a rename does not
 * reshuffle the ring, and two people who joined in the same millisecond still have an
 * order. The comparison runs in SQL, in the same collation the `ORDER BY` uses, so
 * "after" means the same thing on both sides of it.
 *
 * `after` need not still be in the ring. Somebody who was last in line and has since
 * become unassignable still marks a place in the order, and the next person after that
 * place is next.
 *
 * What the ring does NOT know is who is at their desk: there is no presence to read
 * (see `notifyStaff`). It does know who has been taken off the desk — `ON_THE_DESK_SQL`,
 * which an admin sets with `ticket0/set-agent-offboarded` — and an off-boarded agent is
 * not in line, so no sweep ever hands them a conversation. That is a mirror of a role
 * revocation and not a derivation of it, because module code cannot ask the kernel who
 * still holds a role; until an admin records the departure here, the profile reads as on
 * the desk. Somebody who was last in line and has since left still marks a place in the
 * order, exactly as the paragraph above says of anyone who became unassignable.
 *
 * `undefined` is a desk with nobody to hand anything to.
 */
function nextInTurn(ctx: OperationContext, after: string | null): string | undefined {
  const ring = `SELECT principal FROM ticket0_agent_profiles WHERE ${ASSIGNABLE_STAFF_SQL}`;
  if (after !== null) {
    const next = ctx.sql.query<{ principal: string }>(
      `${ring} AND principal > ? ORDER BY principal LIMIT 1`,
      [ASSISTANT_NAME, after],
    )[0];
    if (next) return next.principal;
  }
  return ctx.sql.query<{ principal: string }>(`${ring} ORDER BY principal LIMIT 1`, [
    ASSISTANT_NAME,
  ])[0]?.principal;
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

function contactOrNull(ctx: OperationContext, id: string): ContactRow | undefined {
  return ctx.sql.query<ContactRow>('SELECT * FROM ticket0_contacts WHERE id = ?', [id])[0];
}

function contactOrThrow(ctx: OperationContext, id: string): ContactRow {
  const row = contactOrNull(ctx, id);
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
  follows: string | null = null,
): ConversationRow {
  const id = ulid();
  const now = ctx.now();
  // Arrival is the first moment a priority is decided ('normal', always), so it is the
  // first moment the desk's service levels are stamped on (#1082). Null on a desk that
  // has none, and for a priority it set no target for.
  const due = slaDue(slaPolicy(desk(ctx)), now, 'normal');
  ctx.sql.exec(
    `INSERT INTO ticket0_conversations
       (id, contact_id, channel, subject, state, assignee, priority, snoozed_until,
        first_public_reply_at, first_assigned_at, resolved_at, first_response_due_at,
        resolution_due_at, first_response_breached_at, resolution_breached_at,
        merged_into, follows, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', NULL, 'normal', NULL, NULL, NULL, NULL, ?, ?, NULL, NULL,
             NULL, ?, ?, ?)`,
    [id, contact.id, channel, subject, due.firstResponse, due.resolution, follows, now, now],
  );
  // The edge the permission walk follows: a contact's grant on their own entity
  // reaches their conversations through this, and reaches nobody else's.
  ctx.link(conversationRef(id), contactRef(contact.id));
  return conversationOrThrow(ctx, id);
}

/**
 * The conversation a customer is talking in, once the one they were talking in is closed.
 *
 * `closed` is terminal on purpose — it is the escape hatch out of the inbox, and a
 * thread that anyone could climb back into by writing one more line would not be one.
 * So this does not reopen anything: the closed conversation stays closed, keeps its
 * history and keeps counting as closed, and the message lands in a NEW conversation
 * for the same contact whose `follows` says which one it continues.
 *
 * The alternative the state machine offers unaided is a 409 — which reached an actual
 * visitor of substrat.net as `invalid transition: conversation … is 'closed'`, and left
 * them unable to say anything at all in a chat bubble that was still inviting them to.
 * A customer writing in is never a rule violation; where their words go is a question
 * this app has to answer, and the answer is here rather than in the machine.
 */
function followUp(
  ctx: OperationContext,
  closed: ConversationRow,
  contact: ContactRow,
  subject: string,
): ConversationRow {
  const next = openConversation(ctx, contact, closed.channel, subject, closed.id);
  carryCcs(ctx, closed, next);
  return next;
}

/**
 * The conversation an inbound mail's `In-Reply-To` names, when it is the sender's own (#934).
 *
 * A reply the customer's mail client sends carries the `Message-ID` of the mail it
 * answers, and every message this desk sent or received records that id — so the
 * header alone finds the thread. The header is also the one part of a mail the sender
 * writes freely, which is why it is not enough on its own: anyone who has seen one
 * `Message-ID` from a thread (a forwarded mail, a CC) could otherwise post into
 * somebody else's conversation, where an agent reads it as that customer and answers
 * them. So the thread is taken only when the sending address is somebody ON that
 * conversation — its contact, a CC, or a third party it was forwarded to (#1086,
 * `standingOn`); anything else falls back to a conversation of its own, which is what
 * every inbound mail got before this, and loses nothing but the stitch. Being on it is
 * something only the requester's own mail or a person at the desk decides, so nobody
 * puts themselves on a stranger's thread by mailing it.
 *
 * `contactByEmail` matches exactly, so a sender whose address differs in case from the
 * contact's is also a new conversation. The conservative miss, on purpose: an agent can
 * merge two conversations from one person, and nobody can un-read a misdelivered one.
 *
 * A merged-away conversation needs no case of its own — merging moves its messages, so
 * the id already resolves to the survivor.
 */
function threadRepliedTo(
  ctx: OperationContext,
  sender: ContactRow,
  inReplyTo: string | null | undefined,
): ConversationRow | undefined {
  if (!inReplyTo) return undefined;
  // One id in angle brackets is the header's shape; tolerate the whitespace and
  // trailing comments some clients add around it.
  const id = /<[^<>\s]+>/.exec(inReplyTo)?.[0] ?? inReplyTo.trim();
  if (!id) return undefined;
  // A LIVE message, not the delivery record (#1088): threading needs a thread to join,
  // and a discarded one has none, so a reply to junk is a new conversation the spam
  // filter judges. The dedupe is `deliveryOf`'s job, and it does read the record.
  const repliedTo = ctx.sql.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM ticket0_messages WHERE email_message_id = ?',
    [id],
  )[0];
  if (!repliedTo) return undefined;
  const conversation = conversationOrThrow(ctx, repliedTo.conversation_id);
  return standingOn(ctx, conversation, sender.id) !== null ? conversation : undefined;
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
 * Has this desk said its assistant may answer customers directly?
 *
 * Only an explicit 1 counts. Null is a desk that has never decided — the column
 * arrived after the table shipped — and anything else is a value nobody wrote on
 * purpose; both read as supervised, because the safe answer to "may a machine talk
 * to my customers unattended" is the one you have to opt into.
 *
 * This decides which PRINCIPAL the host answers as. It is not itself the enforcement:
 * flip it with no `assistant-autonomous` principal minted and the desk still cannot
 * send, because the permission lives on the principal and not on this row.
 */
function isAutonomous(ctx: OperationContext): boolean {
  return desk(ctx).assistant_autonomous === 1;
}

/**
 * The desk's switches as they are STORED — read leniently, where they are written
 * strictly (#1083).
 *
 * `configure-desk` accepts only the keys `deskSettingsBlob` declares, so everything
 * this vertical writes is well-formed. The leniency is for what it did not write:
 * a key a later version added, still on the row after a rollback, is carried through
 * untouched rather than refused, so the rollback does not quietly switch that
 * behaviour off for good. Anything that is not a JSON object at all reads as nothing
 * switched on — every behaviour's safe answer is the one the desk never opted into.
 *
 * Readers ask for one key and compare it to exactly `true`; see `roundRobinOn`.
 */
function storedSettings(row: DeskRow): Record<string, unknown> {
  if (row.settings === null) return {};
  try {
    return asRecord(JSON.parse(row.settings) as unknown) ?? {};
  } catch {
    return {};
  }
}

/** A JSON object, or null for anything else — an array, a scalar, null. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Has this desk switched round-robin on? Only an explicit `true` counts — the rule
 * `isAutonomous` applies to its column, for the same reason: a behaviour that hands
 * conversations to people unattended is one a desk has to opt into.
 */
function roundRobinOn(row: DeskRow): boolean {
  return storedSettings(row).roundRobin === true;
}

/**
 * The desk's auto-tag rules — read leniently, as `slaPolicy` reads its targets (#1083).
 *
 * A rule counts only when it parses against the schema `configure-desk` writes it
 * with; one that does not (a shape a later version wrote, then a rollback) is dropped
 * on its own, not the list with it. The list is capped on the way OUT as well as in,
 * for `abandonedAfter`'s reason: the row outlives the parse that wrote it. No usable
 * rule is an empty list, which is off.
 */
function autoTagRules(row: DeskRow): AutoTagRule[] {
  const rules = asRecord(storedSettings(row).autoTag)?.rules;
  if (!Array.isArray(rules)) return [];
  const usable: AutoTagRule[] = [];
  for (const candidate of rules.slice(0, AUTO_TAG_RULES_MAX)) {
    const parsed = autoTagRule.safeParse(candidate);
    if (parsed.success) usable.push(parsed.data);
  }
  return usable;
}

/**
 * One whole number from a switch's object, or null — off. Inside the bounds the schema
 * declares or nothing: a value this version did not write, or one nobody chose, must not
 * become "close everything resolved yesterday" (`closed` is terminal).
 */
function switchNumber(row: DeskRow, key: string, field: string, min: number, max: number): number | null {
  const value = asRecord(storedSettings(row)[key])?.[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** Days a resolved conversation is left alone before auto-close takes it, or null: off. */
const autoCloseDays = (row: DeskRow): number | null =>
  switchNumber(row, 'autoClose', 'afterDays', AUTO_CLOSE_MIN_DAYS, AUTO_CLOSE_MAX_DAYS);

/** Hours a customer waits before the desk is told, or null: off. */
const noReplyHours = (row: DeskRow): number | null =>
  switchNumber(row, 'noReplyNotify', 'afterHours', NO_REPLY_MIN_HOURS, NO_REPLY_MAX_HOURS);

/**
 * The spam filter's bounds, or null: off (#1088). On is an OBJECT under `spamFilter` —
 * `{}` included, which is on with the defaults — and a number this version would not have
 * written falls back to its default rather than to something nobody chose.
 */
function spamFilterOf(row: DeskRow): { maxLinks: number; repeatAfter: number } | null {
  const spam = asRecord(storedSettings(row).spamFilter);
  if (spam === null) return null;
  const bounded = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    maxLinks: bounded(spam.maxLinks, 0, SPAM_MAX_LINKS_MAX, SPAM_MAX_LINKS_DEFAULT),
    repeatAfter: bounded(spam.repeatAfter, 1, SPAM_REPEAT_MAX, SPAM_REPEAT_DEFAULT),
  };
}

/**
 * The built-in behaviours, by the key each has in `deskSettingsBlob` — the closed set
 * `ticket0_behaviour_runs.behaviour` holds. Not a CHECK in the table, so the next
 * behaviour costs no migration; this type is where the set is closed.
 */
type Behaviour = DeskSetting;

/**
 * A behaviour ACTED: stamp when, and how many things it did (#1083).
 *
 * `count` is CONVERSATIONS acted on, not tags put on or targets missed: the row answers
 * "how many conversations did this touch", the same unit for every behaviour. Called only
 * with a positive count. A sweep that found nothing to do writes nothing, so
 * the row answers "when did this last do something" and a switch that has quietly
 * stopped matching stays visibly old. It is bookkeeping about the desk's automation, so
 * it carries no event and no person — `round_robin_last`'s precedent — and it is written
 * in the sweep's own transaction, so a rolled-back sweep leaves no stamp claiming it ran.
 */
function recordFired(ctx: OperationContext, behaviour: Behaviour, count: number): void {
  if (count <= 0) return;
  ctx.sql.exec(
    `INSERT INTO ticket0_behaviour_runs (behaviour, last_fired_at, last_count) VALUES (?, ?, ?)
     ON CONFLICT (behaviour) DO UPDATE SET last_fired_at = excluded.last_fired_at,
                                           last_count = excluded.last_count`,
    [behaviour, ctx.now(), count],
  );
}

// ---------------------------------------------------------------------------
// Service levels (#1082)
// ---------------------------------------------------------------------------

type Priority = ConversationRow['priority'];

/** Minutes per priority. A priority that is absent has no target. */
type SlaTargets = Partial<Record<Priority, number>>;

/** The desk's service levels, as the handlers use them. */
interface SlaPolicy {
  readonly firstResponseMinutes: SlaTargets;
  readonly resolutionMinutes: SlaTargets;
}

const PRIORITIES: readonly Priority[] = ['low', 'normal', 'urgent'];

/**
 * The desk's service levels, or null when it has none — read leniently, the way
 * `storedSettings` reads every switch.
 *
 * A target counts only when it is a whole number of minutes inside the bounds
 * `deskSettingsBlob` declares. Anything else in the row reads as no target: a value
 * this version did not write, a later version's shape after a rollback, or a number
 * nobody chose. Re-checked on the way OUT for `abandonedAfter`'s reason: the row
 * outlives the parse that wrote it, so the guard sits where the value is used.
 *
 * Null when no priority has a target at all, whatever the row says. That is what
 * "off" means: `sla: null`, an absent `sla`, and an `sla` holding nothing usable all
 * leave the sweep with nothing to do, and it does nothing.
 */
function slaPolicy(row: DeskRow): SlaPolicy | null {
  const raw = storedSettings(row).sla;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const targetsOf = (value: unknown): SlaTargets => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: SlaTargets = {};
    for (const priority of PRIORITIES) {
      const minutes = (value as Record<string, unknown>)[priority];
      if (
        typeof minutes === 'number' &&
        Number.isInteger(minutes) &&
        minutes >= 1 &&
        minutes <= SLA_TARGET_MAX_MINUTES
      )
        out[priority] = minutes;
    }
    return out;
  };
  const policy: SlaPolicy = {
    firstResponseMinutes: targetsOf((raw as Record<string, unknown>).firstResponseMinutes),
    resolutionMinutes: targetsOf((raw as Record<string, unknown>).resolutionMinutes),
  };
  const any =
    Object.keys(policy.firstResponseMinutes).length > 0 ||
    Object.keys(policy.resolutionMinutes).length > 0;
  return any ? policy : null;
}

/**
 * The instants a conversation of this priority, arriving at `createdAt`, is held to.
 *
 * Counted from `created_at` whenever it is called, including from a priority change
 * made days later. The customer started waiting when they wrote, not when somebody
 * triaged them, so a conversation marked urgent after an hour has already used an hour
 * of its urgent target. That is how a desk finds out that triage was late. It is also
 * why re-prioritising an old conversation can make it overdue at once: it IS overdue for
 * the priority it now has.
 *
 * Plus `snoozedMs`, the time already spent in finished snoozes, for each target that
 * pauses on a snooze (#1648). Waiting on the customer is not the desk's time, and a
 * priority change must not take it back: without this, marking a conversation `urgent`
 * after a two-day snooze would re-aim its resolution from `created_at` alone and make it
 * late at once, for time it was parked on purpose. A snooze still in progress is not in
 * it yet; `endSnooze` adds it when the snooze ends, to whatever due this wrote.
 */
function slaDue(
  policy: SlaPolicy | null,
  createdAt: string,
  priority: Priority,
  snoozedMs = 0,
): { firstResponse: string | null; resolution: string | null } {
  const at = (minutes: number | undefined, t: SlaTarget) =>
    minutes === undefined
      ? null
      : shiftInstant(createdAt, minutes * 60_000 + (t.pausesOnSnooze ? snoozedMs : 0));
  return {
    firstResponse: at(policy?.firstResponseMinutes[priority], SLA_FIRST_RESPONSE),
    resolution: at(policy?.resolutionMinutes[priority], SLA_RESOLUTION),
  };
}

/** A canonical instant `ms` later. */
function shiftInstant(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

/**
 * "This conversation's first-response target is still running", as SQL: nobody has
 * met it and nobody has missed it.
 *
 * MET is `first_public_reply_at`, and that column is the definition, not a stand-in
 * for one. It is written by exactly one path, `ticket0/post-public-reply`, the first
 * time the desk says something the customer receives. That makes the definition:
 *
 *   - a person's public reply COUNTS;
 *   - the assistant's public reply COUNTS. On a desk that lets it answer, what the
 *     customer received was the desk's answer, sent under the same permission a
 *     person's is, and `post-public-reply` cannot tell the two apart by design;
 *   - an internal note does NOT count. The customer has been told nothing;
 *   - an assistant turn that was only drafted, or that escalated, does NOT count. Both
 *     are internal messages until somebody sends them;
 *   - the acknowledgement `request-human` writes does NOT count. It is a system
 *     message saying a person will come, which is the promise, not the response;
 *   - the customer's own messages do NOT count.
 *
 * It is also the column `ticket0/desk-metrics` measures its first-response percentile
 * on, so the target a desk sets and the number its report shows are one measurement.
 *
 * MISSED is `first_response_breached_at`, which only `recordBreach` writes (for the
 * sweep, or for the reply that meets the target late). `ticket0/set-priority` (to decide
 * which targets a new priority re-aims) and `slaOverdueSql` (to decide what has breached)
 * both read this one fragment. Column names are bare so it serves an UPDATE as well as a
 * SELECT.
 */
const FIRST_RESPONSE_RUNNING = 'first_response_breached_at IS NULL AND first_public_reply_at IS NULL';

/**
 * "This conversation's resolution target is still running", as SQL.
 *
 * MET is `resolved_at`: set by `ticket0/resolve` and by nothing else, and never cleared.
 * So the target is met the first time the desk resolves the conversation, and a
 * customer who writes again afterwards reopens the conversation without un-meeting it.
 * A reopened thread carries no running target, and a "thanks!" does not escalate a
 * conversation that was answered in an hour. This is also the column the report's
 * resolution percentile reads. A conversation closed WITHOUT being resolved never meets
 * the target, but it never breaches either: the sweep takes only the live states, and
 * `closed` is the desk saying the conversation was not its to answer.
 */
const RESOLUTION_RUNNING = 'resolution_breached_at IS NULL AND resolved_at IS NULL';

/**
 * Live work, for the sweep: a conversation that can still be late.
 *
 * `snoozed` is in it: a snooze stops a target's clock only where that target says it
 * pauses (`SLA_PAUSED`, below). `resolved` and `closed` are done. The losing half of a
 * merge is folded into its survivor, which keeps its own targets.
 */
const SLA_LIVE = `state IN ('new', 'open', 'snoozed') AND merged_into IS NULL AND ${inTheInbox()}`;

/**
 * "No snooze is holding this target's clock right now", as SQL (#1648).
 *
 * Keyed on `snoozed_at`, not on `state = 'snoozed'`, and the difference is the rows that
 * were already snoozed when the column arrived. They carry no start instant, so nothing
 * could ever push their due back for that snooze; leaving them out of the running set
 * would hide them from the sweep and from `recordIfLate` without ever giving the time
 * back. Keyed on the column, they keep exactly the behaviour they were snoozed under
 * (the clock runs) until they wake, and their next snooze pauses.
 */
const SLA_PAUSED = 'snoozed_at IS NULL';

/**
 * The two targets, each with the columns and the running test that belong to it.
 *
 * `pausesOnSnooze` is the product rule, and the ONE place it is stated (#1648):
 *
 *   - RESOLUTION pauses. A snooze usually means "answered, now waiting on the customer",
 *     and a two-day wait on them must not burn an eight-hour resolution target.
 *   - FIRST RESPONSE does not. A conversation parked before anybody answered it still
 *     has a customer waiting for a first word, and the snooze hides nothing from them.
 *
 * Everything else reads the flag: which rows can be late (`slaOverdueSql`), which due
 * instants a finished snooze pushes back (`endSnooze`), which ones a priority change
 * re-aims past the time already parked (`slaDue`), and which misses a snooze must record
 * before it stops the clock (`beginSnooze`). Flipping first response to `true` is the whole code
 * change for a desk that wants both paused, and it is correct on its own: the scan's WHERE
 * still implies migration 0012's wider first-response index, so SQLite still uses it. That
 * index would then also hold paused rows the scan skips, so narrowing it the way 0014
 * narrowed the resolution one is the migration that should follow. `test/sla.test.ts`
 * pins which index carries the term, so that test has to move with the flag.
 */
const SLA_TARGETS = [
  {
    target: 'first_response',
    due: 'first_response_due_at',
    breached: 'first_response_breached_at',
    running: FIRST_RESPONSE_RUNNING,
    pausesOnSnooze: false,
  },
  {
    target: 'resolution',
    due: 'resolution_due_at',
    breached: 'resolution_breached_at',
    running: RESOLUTION_RUNNING,
    pausesOnSnooze: true,
  },
] as const;
type SlaTarget = (typeof SLA_TARGETS)[number];
const [SLA_FIRST_RESPONSE, SLA_RESOLUTION] = SLA_TARGETS;

/**
 * "This target has been missed and nobody has recorded it yet", as SQL: a due instant,
 * still running, on live work, and now strictly past. Binds `[now]`.
 *
 * STRICTLY past. A reply at exactly the due instant is on time, because "within an hour"
 * includes the hour.
 *
 * The ONE definition of a breach, read by every place that records one, so they cannot
 * disagree:
 *
 *   - the sweep, which finds a target missed while it is still running and tells the
 *     desk (`slaOverdueScan`);
 *   - an act that is about to take a missed target out of the running set
 *     (`recordIfLate`): the reply or resolve that meets it late, or the priority change
 *     that re-aims it. Without this, a reply sent after the due instant but before the
 *     next sweep would meet the target, take the conversation out of the sweep's scan,
 *     and leave a late answer on record as an on-time one. On a host that runs no sweep
 *     at all — every hosted desk before #1646, and any desk still on no sweep roster —
 *     that would be every late answer.
 */
function slaOverdueSql(t: SlaTarget): string {
  const live = t.pausesOnSnooze ? `${SLA_LIVE} AND ${SLA_PAUSED}` : SLA_LIVE;
  return `${t.due} IS NOT NULL AND ${t.running} AND ${live} AND ${t.due} < ?`;
}

/**
 * The sweep's scan for one target: every conversation `slaOverdueSql` says was missed,
 * soonest-due first.
 *
 * Each target has a PARTIAL index of its own in migration 0012, over exactly the running,
 * live set that has a due instant, so the scan never reads a desk's whole history. A
 * conversation drops out of the index the moment its target is met, missed, resolved,
 * closed or merged.
 *
 * Each index is led by its `*_breached_at` column, although every row in it has NULL
 * there. That is `ticket0_conversations_waiting`'s trick, for its reason: SQLite has no
 * statistics for these tables, and without an equality on a leading column it prefers
 * the kernel's own `(state, priority, id)` list index for the `state IN (…)` term, then
 * sorts. The leading equality is what makes the partial index win outright. It also
 * keeps the index in `due, id` order, so the scan sorts nothing.
 *
 * The index's WHERE must stay implied by this WHERE, or SQLite stops using it.
 * `test/sla.test.ts` pins the plan, which is why this is exported.
 *
 * Binds `[now, limit]`.
 */
export function slaOverdueScan(target: SlaTarget['target']): string {
  const t = SLA_TARGETS.find((x) => x.target === target)!;
  return `SELECT * FROM ticket0_conversations
        WHERE ${slaOverdueSql(t)}
        ORDER BY ${t.due}, id LIMIT ?`;
}

/** The same indexed running set, restricted to a future horizon. Binds [now, until, limit]. */
export function slaUpcomingScan(target: SlaTarget['target']): string {
  const t = SLA_TARGETS.find((x) => x.target === target)!;
  const live = t.pausesOnSnooze ? `${SLA_LIVE} AND ${SLA_PAUSED}` : SLA_LIVE;
  return `SELECT id, subject, priority, state, assignee, ${t.due} AS dueAt
        FROM ticket0_conversations
        WHERE ${t.due} IS NOT NULL AND ${t.running} AND ${live}
          AND ${t.due} >= ? AND ${t.due} <= ?
        ORDER BY ${t.due}, id LIMIT ?`;
}

/** Bounded across both target indexes; the extra row reports that the queue was cut. */
const SLA_SOON_LIMIT = 20;

/**
 * How many overdue conversations one run records, per target. `WAKE_BATCH`'s bargain: a
 * bound on one transaction, not a cap on the feature, because the schedule comes back.
 */
const SLA_BATCH = 200;

/**
 * Write one breach down: the stamp, and the event that says so.
 *
 * Notifying is NOT here, on purpose, because whether to tell anybody depends on whether
 * the conversation is still waiting. The sweep and `set-priority` tell the desk: nothing
 * has met the target, and somebody should act. The reply or resolution that noticed a
 * late target does not, because it has just met that target, and a notice to act on
 * something already done is the kind people learn to ignore.
 *
 * The event is the same from every door. The kernel stamps the operation that recorded
 * it (`ticket0/escalate-sla-breaches`, `ticket0/post-public-reply`, `ticket0/resolve`,
 * `ticket0/set-priority`), so the trail says which one noticed without a payload field
 * to say it again.
 */
function recordBreach(
  ctx: OperationContext,
  conversation: ConversationRow,
  t: SlaTarget,
  now: string,
): void {
  ctx.sql.exec(`UPDATE ticket0_conversations SET ${t.breached} = ? WHERE id = ?`, [
    now,
    conversation.id,
  ]);
  ctx.emit({
    type: 'ticket0.sla-breached',
    schemaVersion: 1,
    entity: conversationRef(conversation.id),
    piiClass: 'none',
    payload: {
      id: conversation.id,
      target: t.target,
      due_at: conversation[t.due],
      breached_at: now,
      priority: conversation.priority,
      state: conversation.state,
      assignee: conversation.assignee,
    },
  });
}

/**
 * Record a breach the sweep has not noticed yet, at a moment that is about to take the
 * target out of the running set. Three callers, each BEFORE its own write, since
 * afterwards the miss would no longer be visible:
 *
 *   - `post-public-reply`, which meets the first-response target;
 *   - `resolve`, which meets the resolution target;
 *   - `set-priority`, which re-aims every running target. Without this, lowering the
 *     priority of a conversation already past its due would move the due later and
 *     erase a miss nobody had recorded yet.
 *
 * Gated on the desk's service levels exactly as the sweep is: a desk that has switched
 * them off records no breach from any door. The due column is tested first, so a
 * conversation that was never given a target costs nothing beyond the row the caller
 * already read. Returns whether it recorded one, for the caller that must decide
 * whether to tell anybody.
 */
function recordIfLate(ctx: OperationContext, conversation: ConversationRow, t: SlaTarget): boolean {
  if (conversation[t.due] === null) return false;
  if (slaPolicy(desk(ctx)) === null) return false;
  const now = ctx.now();
  const late = ctx.sql.query<ConversationRow>(
    `SELECT * FROM ticket0_conversations WHERE id = ? AND ${slaOverdueSql(t)}`,
    [conversation.id, now],
  )[0];
  if (!late) return false;
  recordBreach(ctx, late, t, now);
  return true;
}

/**
 * A conversation goes to sleep: the clocks that pause on a snooze stop (#1648).
 *
 * Called by `moveTo` on the way INTO `snoozed` and from nowhere else, so no door can
 * snooze a conversation without it.
 *
 * A target that pauses leaves the running set the moment `snoozed_at` is written, so a
 * miss already past its due is recorded FIRST, exactly as `recordIfLate`'s other callers
 * do before their own writes. Otherwise snoozing a late conversation would be a way to
 * hide that it was late, and on a host whose sweep had not run yet, every late
 * conversation someone snoozed would be. Nobody is told, like a late reply: the person
 * snoozing it is looking at it, and has just decided what happens next.
 */
function beginSnooze(ctx: OperationContext, id: string): void {
  const conversation = conversationOrThrow(ctx, id);
  for (const t of SLA_TARGETS) if (t.pausesOnSnooze) recordIfLate(ctx, conversation, t);
  ctx.sql.exec('UPDATE ticket0_conversations SET snoozed_at = ? WHERE id = ?', [ctx.now(), id]);
}

/**
 * A conversation wakes: the time it slept is given back to every target that paused
 * (#1648).
 *
 * Every way out of `snoozed` comes through here — the `wake-snoozed` timer, a person's
 * `wake`, the customer writing (`ingest-message`, `widget-post`, `request-human`),
 * `resolve` and `close` — because `moveTo`, the one writer of `state`, calls it. So the
 * timer and a person cannot disagree about how long the conversation slept.
 *
 * The due instant of a paused target that is still running moves later by exactly the
 * length of the snooze. One already met or already missed stays where it was, the rule
 * `set-priority` follows. The length is also added to `snoozed_ms`, which is what lets a
 * later priority change re-aim past it (`slaDue`), and repeated snoozes add up because
 * each one moves the due from wherever the last one left it.
 *
 * A due that fell INSIDE the snooze is never a breach: it is pushed past the moment of
 * waking before anything reads it. A conversation that was not late when it went to sleep
 * (`beginSnooze` recorded it otherwise) wakes with its due as far ahead of now as it was
 * ahead of the moment it slept, so nothing it wakes into can call it late. The one way to
 * wake late is a priority change made while it slept that re-aimed the due into the past:
 * that is late exactly as the same change made awake would be, and the first sweep or
 * `recordIfLate` after the wake records it.
 *
 * A row with no `snoozed_at` has nothing to give back and is left as it is: one that is
 * not snoozed, or one snoozed before the column existed, whose clock ran throughout.
 *
 * Idempotent, and it reads the row itself, so `resolve` can call it before its own
 * writes and `moveTo` again after them without counting the snooze twice.
 */
function endSnooze(ctx: OperationContext, id: string): void {
  const conversation = conversationOrThrow(ctx, id);
  if (conversation.snoozed_at === null) return;
  const slept = Math.max(0, Date.parse(ctx.now()) - Date.parse(conversation.snoozed_at));
  const paused = SLA_TARGETS.filter((t) => t.pausesOnSnooze);
  const shifts = paused.map(
    (t) => `${t.due} = CASE WHEN ${t.due} IS NOT NULL AND ${t.running} THEN ? ELSE ${t.due} END`,
  );
  const shifted = paused.map((t) => {
    const due = conversation[t.due];
    return due === null ? null : shiftInstant(due, slept);
  });
  ctx.sql.exec(
    `UPDATE ticket0_conversations
        SET ${[...shifts, 'snoozed_ms = COALESCE(snoozed_ms, 0) + ?', 'snoozed_at = NULL'].join(', ')}
      WHERE id = ?`,
    [...shifted, slept, id],
  );
}

/**
 * How many days of silence this desk leaves a conversation before the sweep closes it.
 *
 * Read the same way `isAutonomous` reads its column, and refused the same way: only a
 * value inside the declared bounds counts, and everything else — the null of a desk
 * that has never said, a desk minted before the column existed, a number nobody wrote
 * on purpose — is `ABANDONED_AFTER_DAYS`. Re-checking the bounds on the way OUT is not
 * paranoia about the operation's own Zod parse: this row outlives the parse that wrote
 * it, so the guard has to sit where the value is USED. `closed` is terminal, and the
 * failure this refuses is a desk quietly reaping at zero days.
 *
 * The one reader. The sweep calls it per run rather than caching a number, because a
 * desk that changes the window at noon means it from the next sweep, not the next
 * deploy.
 */
function abandonedAfter(ctx: OperationContext): number {
  const configured = desk(ctx).abandoned_after_days;
  return typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured >= ABANDONED_AFTER_MIN_DAYS &&
    configured <= ABANDONED_AFTER_MAX_DAYS
    ? configured
    : ABANDONED_AFTER_DAYS;
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
 * Point a live widget session at the conversation it is talking in NOW.
 *
 * The visitor's token is unchanged and their browser learns nothing: what they have is
 * a chat bubble, and which row it writes into is the desk's business. The link to the
 * conversation they have left is not removed — `ctx.link` is permanent by design, and
 * it is also true: this session did belong to that thread, and the timeline should
 * still say so.
 */
function moveSession(
  ctx: OperationContext,
  sessionId: string,
  conversation: ConversationRow,
): ConversationRow {
  ctx.sql.exec('UPDATE ticket0_widget_sessions SET conversation_id = ? WHERE id = ?', [
    conversation.id,
    sessionId,
  ]);
  ctx.link({ entityType: 'widgetSession', entityId: sessionId }, conversationRef(conversation.id));
  return conversation;
}

/**
 * Which conversation this widget session is writing into, right now.
 *
 * Three cases, and only the middle one is interesting. A bound session has its
 * conversation; an opening has none yet and gets one; a session whose conversation an
 * agent CLOSED gets the follow-up that continues it, and is re-pointed at it — because
 * `closed` is terminal and the alternative is a chat bubble that has silently gone
 * read-only while still inviting the visitor to type.
 *
 * Both widget writes go through here, so the two cannot disagree about it. They did,
 * for one commit: `widget-post` learned the follow-up rule and `request-human` was
 * written against the version before it, which would have handed the visitor the same
 * `invalid transition` on the route they press when nothing else is working.
 */
function heldConversation(
  ctx: OperationContext,
  sessionId: string,
  hold: WidgetHold,
  /** What the visitor is about to write — what the spam filter reads if a thread opens. */
  body: string,
): ConversationRow {
  // Only the session branch can be closed: `bindOpening` has just made the other one.
  const bound = hold.kind === 'session' ? hold.conversation : bindOpening(ctx, hold.opening);
  const conversation =
    bound.state === 'closed'
      ? moveSession(
          ctx,
          sessionId,
          followUp(ctx, bound, contactOrThrow(ctx, bound.contact_id), bound.subject),
        )
      : bound;
  // A conversation THIS call opened is screened (#1088); one the desk already holds is not
  // re-judged, in either queue — a thread the desk accepted stays accepted, and a held one
  // stays held until a person decides.
  return hold.kind === 'session' && conversation.id === hold.conversation.id
    ? conversation
    : screenAtTheDoor(ctx, conversation, body);
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
          // One bound JSON array, not a `?` per article: a page can cite past the 100
          // parameters a Durable Object binds in all (#1759).
          'SELECT * FROM ticket0_kb_articles WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
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
      // Through the model's own customer shape, which drops every column a customer never
      // sees — the one list of them (`customerMessageRow`).
      rows.map((row) => customerMessageRow.parse(row)),
    ),
    limit,
    (row) => row.id,
  );
}

// ---------------------------------------------------------------------------
// Free-text lookup - the two search reads (#1081)
// ---------------------------------------------------------------------------

/** Named rather than `SELECT c.*`: a search read returns the published entity, not the table. */
const CONVERSATION_COLUMNS = `c.id, c.contact_id, c.channel, c.subject, c.state, c.assignee,
  c.priority, c.snoozed_until, c.snoozed_at, c.snoozed_ms, c.first_public_reply_at,
  c.first_assigned_at, c.resolved_at, c.first_response_due_at, c.resolution_due_at, c.first_response_breached_at,
  c.resolution_breached_at, c.merged_into, c.follows, c.created_at, c.updated_at,
  c.quarantine, c.suspended_at, c.suspicion`;

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
 * One meter's tokens over a window, priced by the rate in force when each turn happened.
 *
 * The rate card is append-only and keyed by the date a price takes effect, which is what
 * makes a closed month reproducible at the price it was closed under. Reading one rate —
 * the current one — and applying it to a whole window throws that away: a re-pricing
 * today would silently move last month's number. So each turn is joined to the latest
 * rate that had taken effect by its own `created_at`, and the segments are summed.
 *
 * Tokens recorded before any price existed contribute nothing, which is the same answer
 * as pricing them at zero and an honest one — nobody had said what they were worth.
 *
 * `column` is one of two literals written at the call sites below, never caller input.
 */
function meterCost(
  ctx: OperationContext,
  meterKey: string,
  column: 'input_tokens' | 'output_tokens',
  from: string,
  to: string,
): { amount: string; currencies: string[] } {
  const rows = ctx.sql.query<{ unit_price: string; currency: string; qty: number | null }>(
    `SELECT r.unit_price, r.currency, SUM(t.${column}) AS qty
       FROM ticket0_ai_turns t
       JOIN ticket0_usage_rates r
         ON r.meter_key = ?
        AND r.effective_from = (
              SELECT MAX(r2.effective_from)
                FROM ticket0_usage_rates r2
               WHERE r2.meter_key = r.meter_key AND r2.effective_from <= t.created_at)
      WHERE t.created_at >= ? AND t.created_at <= ?
      GROUP BY r.unit_price, r.currency`,
    [meterKey, from, to],
  );
  return {
    amount: rows.reduce(
      (sum, r) => addDecimal(sum, mulDecimal(String(Number(r.qty ?? 0)), r.unit_price)),
      '0',
    ),
    // A segment nobody spent a token in does not get a vote on the currency — otherwise
    // an old price in another currency, never used, would refuse a report about today.
    currencies: rows.filter((r) => Number(r.qty ?? 0) > 0).map((r) => r.currency),
  };
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
          SET from_address = ?, greeting = ?, allowed_origins = ?, business_hours = ?,
              assistant_autonomous = ?, abandoned_after_days = ?, settings = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.fromAddress ?? current.from_address,
        input.greeting ?? current.greeting,
        input.allowedOrigins ? JSON.stringify(originsOf(input.allowedOrigins)) : current.allowed_origins,
        input.businessHours === undefined ? current.business_hours : input.businessHours,
        // Stored as 0/1 rather than left null once decided, so "supervised" is a
        // choice on the row and not merely the absence of one.
        input.assistantAutonomous === undefined
          ? current.assistant_autonomous
          : input.assistantAutonomous
            ? 1
            : 0,
        // Absent keeps what the desk had; an explicit null hands the window back to
        // the platform default. `?? current` would collapse those two into one and
        // make the default unreachable once a desk had typed a number over it —
        // `business_hours` above is written this way for the same reason.
        input.abandonedAfterDays === undefined
          ? current.abandoned_after_days
          : input.abandonedAfterDays,
        // Merged key by key over what is stored, never replaced wholesale: a call that
        // names `roundRobin` changes `roundRobin`, and a key this version does not know
        // — from a later one, before a rollback — rides through. Absent keeps the column
        // exactly as it was, null included.
        input.settings === undefined
          ? current.settings
          : JSON.stringify({ ...storedSettings(current), ...input.settings }),
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
      payload: {
        id: row.id,
        from_address: row.from_address,
        allowed_origins: row.allowed_origins,
        assistant_autonomous: row.assistant_autonomous,
        abandoned_after_days: row.abandoned_after_days,
        settings: row.settings,
      },
    });
    return publicDesk(row);
  },

  'ticket0/list-behaviour-runs': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    return {
      runs: ctx.sql.query<BehaviourRunRow>(
        'SELECT behaviour, last_fired_at, last_count FROM ticket0_behaviour_runs ORDER BY behaviour',
      ),
    };
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

  // --- The blocklist (#1088) -----------------------------------------------

  'ticket0/list-block-rules': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    // Same shape as `list-signups`: an absent filter must be absent rather than an
    // explicit undefined, which becomes a `WHERE kind IS NULL` that returns nothing.
    const filters: Record<string, unknown> = {};
    if (input.kind !== undefined) filters.kind = input.kind;
    return (await ctx.page<BlockRuleRow>('blockRule', {
      ...input,
      filters,
      total: true,
    })) as CountedPage<BlockRuleRow>;
  },

  /**
   * Block somebody. Idempotent on the rule rather than on the click.
   *
   * A second Block on an address already blocked answers with the row that is already
   * there and writes nothing — no second row (the key forbids one), no second event,
   * and in particular no new `created_by`: the person who decided is the person who
   * decided first, and overwriting that would quietly reassign a decision.
   */
  'ticket0/add-block-rule': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    const value = blockValueOf(ctx, input.kind, input.value);
    const existing = ctx.sql.query<BlockRuleRow>(
      'SELECT * FROM ticket0_block_rules WHERE kind = ? AND value = ?',
      [input.kind, value],
    )[0];
    if (existing) return existing;

    const id = ulid();
    const now = ctx.now();
    ctx.sql.exec(
      `INSERT INTO ticket0_block_rules (id, kind, value, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.kind, value, input.reason ?? null, String(ctx.principal), now],
    );
    const row = ctx.sql.query<BlockRuleRow>('SELECT * FROM ticket0_block_rules WHERE id = ?', [
      id,
    ])[0]!;
    ctx.emit({
      type: 'ticket0.block-rule-added',
      schemaVersion: 1,
      entity: { entityType: 'blockRule', entityId: row.id },
      // Never `value`. An event is immutable, and this one would be an immutable copy
      // of a person's address kept in order to say the desk has stopped hearing from
      // them — see the declaration for the whole of that argument.
      piiClass: 'none',
      payload: {
        id: row.id,
        kind: row.kind,
        created_by: row.created_by,
        created_at: row.created_at,
      },
    });
    return row;
  },

  /**
   * Unblock one rule, and only that one.
   *
   * By `id`, which is the half the JSON-column shape could not have offered: two
   * admins unblocking two different people in the same minute each delete their own
   * row, and neither rewrites the other's list.
   */
  'ticket0/remove-block-rule': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    const row = ctx.sql.query<BlockRuleRow>('SELECT * FROM ticket0_block_rules WHERE id = ?', [
      input.ruleId,
    ])[0];
    if (!row) throw substratError('not_found', `block rule not found: ${input.ruleId}`);
    ctx.sql.exec('DELETE FROM ticket0_block_rules WHERE id = ?', [row.id]);
    ctx.emit({
      type: 'ticket0.block-rule-removed',
      schemaVersion: 1,
      entity: { entityType: 'blockRule', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, kind: row.kind },
    });
    return { id: row.id, kind: row.kind };
  },

  'ticket0/set-agent-offboarded': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.deskConfigure));
    const profile = staffOrThrow(ctx, input.principal);
    // The assistant is not staff, so it is never on the desk to be taken off — a row
    // saying it was would only be read as if it meant something.
    if (isAssistant(profile)) {
      throw substratError(
        'validation_failed',
        `the assistant is not on the desk as staff: ${input.principal}`,
      );
    }
    // Revoke first, even when this is an idempotent OFF retry. Migration 0019 backfills
    // follows made before the ledger existed, including on a desk already off-boarded.
    // `ctx.revoke` and the ledger delete share the operation transaction: a refusal
    // cannot leave the profile marked off while one of its recorded grants survives.
    if (input.offboarded) {
      const follows = ctx.sql.query<{ conversation_id: string }>(
        'SELECT conversation_id FROM ticket0_conversation_follows WHERE principal = ? ORDER BY conversation_id',
        [profile.principal],
      );
      for (const follow of follows) {
        await ctx.revoke(
          principalId.parse(profile.principal),
          T0_PERM.conversationRead,
          conversationRef(follow.conversation_id),
        );
        ctx.emit({
          type: 'ticket0.conversation-unfollowed',
          schemaVersion: 1,
          entity: conversationRef(follow.conversation_id),
          piiClass: 'none',
          payload: { conversation_id: follow.conversation_id, follower: profile.principal },
        });
      }
      ctx.sql.exec('DELETE FROM ticket0_conversation_follows WHERE principal = ?', [profile.principal]);
    }
    // Idempotent both ways. Taking off somebody already off keeps the FIRST instant, so
    // the record says when they left rather than when somebody last clicked; putting back
    // somebody who is on changes nothing. Neither emits another profile-change event.
    if (input.offboarded === !onTheDesk(profile)) return profile;
    ctx.sql.exec('UPDATE ticket0_agent_profiles SET offboarded_at = ? WHERE principal = ?', [
      input.offboarded ? ctx.now() : null,
      profile.principal,
    ]);
    const row = staffOrThrow(ctx, input.principal);
    // The principal and the instant. The name is erasable and never rides an event.
    ctx.emit({
      type: 'ticket0.agent-offboarding-set',
      schemaVersion: 1,
      entity: { entityType: 'agentProfile', entityId: row.principal },
      piiClass: 'none',
      payload: { principal: row.principal, offboarded_at: row.offboarded_at },
    });
    return row;
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
    if (existing) return publicSource(existing);
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
    return publicSource(row);
  },

  'ticket0/list-kb-sources': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRead));
    const page = await ctx.page<KbSourceRow>('kbSource', input);
    return { ...page, entries: page.entries.map(publicSource) };
  },

  'ticket0/ingest-kb-source': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRefresh, sourceRef(input.sourceId)));
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
    return publicSource(updated);
  },

  'ticket0/record-kb-articles': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRefresh, sourceRef(input.sourceId)));
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
    assertAllowed(await ctx.check(T0_PERM.kbRefresh, sourceRef(input.sourceId)));
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
      schemaVersion: 2,
      entity: sourceRef(row.id),
      piiClass: 'none',
      // Not the reason: a remote site's text stays on the row, never on an event (#1088).
      payload: { id: row.id, url: row.url },
    });
    return publicSource(row);
  },

  'ticket0/mint-kb-refresh-token': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage, sourceRef(input.sourceId)));
    sourceOrThrow(ctx, input.sourceId);
    const token = mintRefreshToken();
    // Minting over an existing hook REPLACES it: the old token stops working here, in
    // the same statement that makes the new one work. That is what rotation is, and
    // doing it in one write is what stops a window where both are live.
    ctx.sql.exec(
      `UPDATE ticket0_kb_sources
          SET refresh_token_hash = ?, refresh_token_hint = ?, token_created_at = ?, token_last_used_at = NULL
        WHERE id = ?`,
      [await sha256(token), tokenHint(token), ctx.now(), input.sourceId],
    );
    const row = sourceOrThrow(ctx, input.sourceId);
    ctx.emit({
      type: 'ticket0.kb-refresh-token-minted',
      schemaVersion: 1,
      entity: sourceRef(row.id),
      piiClass: 'none',
      // The hint, never the token: an event is read later, by people who were not here.
      payload: { id: row.id, url: row.url, refresh_token_hint: row.refresh_token_hint },
    });
    return { ...publicSource(row), token };
  },

  'ticket0/revoke-kb-refresh-token': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbManage, sourceRef(input.sourceId)));
    sourceOrThrow(ctx, input.sourceId);
    // Idempotent on purpose: revoking a source that has no hook is a request to be in
    // a state it is already in, and answering that with an error would make the safe
    // reflex — revoke it again, just in case — look like a failure.
    // `token_last_used_at` goes with them. It is the hook's column, not the source's:
    // left behind, the row says a hook it does not have fired on Tuesday, and the next
    // reader of that column has to know to check the hint first. When the old hook last
    // fired is not lost — `ticket0.kb-refresh-hook-redeemed` is in the history, which is
    // where a fact about a credential that no longer exists belongs.
    ctx.sql.exec(
      `UPDATE ticket0_kb_sources
          SET refresh_token_hash = NULL, refresh_token_hint = NULL, token_created_at = NULL,
              token_last_used_at = NULL
        WHERE id = ?`,
      [input.sourceId],
    );
    const row = sourceOrThrow(ctx, input.sourceId);
    ctx.emit({
      type: 'ticket0.kb-refresh-token-revoked',
      schemaVersion: 1,
      entity: sourceRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, url: row.url },
    });
    return publicSource(row);
  },

  /**
   * Spend a hook. Three ways to fail, and they are deliberately one answer.
   *
   * No hook minted, the wrong token, a token for a different source — all `forbidden`,
   * with one message. A caller holding a bad token learns that it is bad and nothing
   * else: telling them "this source has no hook" separates a source that exists from
   * one that does not, and telling them "wrong token" confirms the source has one worth
   * guessing. The desk's own screen is where a person finds out which it was.
   */
  'ticket0/redeem-kb-refresh-token': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRefresh, sourceRef(input.sourceId)));
    // Looked up WITHOUT throwing, unlike every other operation here: `sourceOrThrow`
    // answers 404, and a 404 beside the 403 below is the separation this refusal is
    // written to avoid — a caller holding a token would learn which source ids exist
    // on this desk by watching the status change. A missing row folds into the same
    // one answer.
    const row = sourceOrNull(ctx, input.sourceId);
    const presented = await sha256(input.token);
    // Both sides are hex of a fixed length. This leaks nothing but equality: the hash
    // is of a 160-bit random token, so a timing oracle on it has nothing to walk.
    if (!row || !row.refresh_token_hash || row.refresh_token_hash !== presented) {
      throw substratError('forbidden', 'this refresh hook is not valid for this source');
    }
    if (row.token_last_used_at) {
      const since = Date.parse(ctx.now()) - Date.parse(row.token_last_used_at);
      if (Number.isFinite(since) && since < REFRESH_HOOK_MIN_INTERVAL_MS) {
        // With `retryAfter`, so a pipeline that fires twice on one merge can wait the
        // remainder instead of guessing or giving up.
        throw substratError(
          'rate_limited',
          `this source was read ${Math.round(since / 1000)}s ago; hooks may read once a minute`,
          { retryAfter: Math.ceil((REFRESH_HOOK_MIN_INTERVAL_MS - since) / 1000) },
        );
      }
    }
    // Recorded BEFORE the read rather than after it, and that is the point: a hook that
    // fires and then fails to fetch has still been used, and the throttle has to know.
    // It is also what puts "last fired" on the screen for a hook whose reads are failing.
    ctx.sql.exec('UPDATE ticket0_kb_sources SET token_last_used_at = ? WHERE id = ?', [
      ctx.now(),
      row.id,
    ]);
    const spent = sourceOrThrow(ctx, row.id);
    // The mint and the revoke each leave an event; so does spending one. Without it
    // the only mutation a HOOK can cause is the one nothing records, and "has this
    // pipeline been firing?" — the question a knowledge base going stale actually
    // raises — has no answer in the history. The hint, never the token.
    ctx.emit({
      type: 'ticket0.kb-refresh-hook-redeemed',
      schemaVersion: 1,
      entity: sourceRef(spent.id),
      piiClass: 'none',
      payload: {
        id: spent.id,
        url: spent.url,
        refresh_token_hint: spent.refresh_token_hint,
        token_last_used_at: spent.token_last_used_at,
      },
    });
    return publicSource(spent);
  },

  'ticket0/search-kb': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.kbRead));
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const fetch = overfetch(limit);
    const hits = ctx.search('kbArticle', input.q, { limit: fetch });
    if (hits.length === 0) return { results: [], limit, capped: false };

    // The hits go in as ONE bound JSON array: up to MAX_SEARCH_LIMIT (100) of them plus
    // `source_id` is 101 parameters, one past what a Durable Object binds (#1759).
    const params: string[] = [JSON.stringify(hits.map((h) => h.id))];
    let sql = 'SELECT * FROM ticket0_kb_articles WHERE id IN (SELECT value FROM json_each(?))';
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

  /**
   * Who is this — by the address or the name, not by an id nobody has.
   *
   * Both matched columns are erasable, so an erased contact matches neither and is
   * simply absent. `external_id` is deliberately not searched: it is the caller's
   * own key, exact by construction, and `list-contacts` already narrows on it.
   */
  'ticket0/search-contacts': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.contactRead));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const like = likeTerm(input.q);
    const params: SqlValue[] = [like, like];
    // Newest first by default, and the caller's `?order=` is honoured rather than
    // ignored — a walk advertised in the emitted document and quietly overridden here
    // is a page that lies. The comparison follows the direction: descending excludes
    // what has been seen with `id < ?`, ascending with `id > ?`. A ULID sorts
    // chronologically, which is why the id is the key.
    const desc = (input.order ?? 'desc') === 'desc';
    let sql = `SELECT id, external_id, principal, email, display_name, verified_at, created_at
                 FROM ticket0_contacts
                WHERE (email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`;
    if (input.cursor) {
      sql += desc ? ' AND id < ?' : ' AND id > ?';
      params.push(input.cursor);
    }
    sql += ` ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);
    return pageOf(ctx.sql.query<ContactRow>(sql, params), limit, (row) => row.id);
  },

  'ticket0/get-contact': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.contactRead));
    return contactOrThrow(ctx, input.contactId);
  },

  'ticket0/list-contacts': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.contactRead));
    return ctx.page<ContactRow>('contact', input);
  },

  // --- The inbox -----------------------------------------------------------

  /**
   * The search box above the inbox.
   *
   * `EXISTS` rather than a join, and it is not a style choice: a conversation whose
   * subject and three messages all match the term would come back four times from a
   * join, and de-duplicating afterwards would break the page — the LIMIT would have
   * counted rows the caller never sees. `EXISTS` asks the only question this read
   * has, which is whether the conversation matches at all.
   *
   * A hit on an INTERNAL note returns the conversation and nothing of the note, and
   * the key is `conversation:read`, which only staff hold. So a note stays internal
   * on every path out: this one returns no message text at all, and the two
   * customer-facing reads are separate operations over `visibility = 'public'`.
   */
  'ticket0/search-conversations': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const like = likeTerm(input.q);
    const params: SqlValue[] = [like, like];
    let sql = `SELECT ${CONVERSATION_COLUMNS}
                 FROM ticket0_conversations c
                WHERE (c.subject LIKE ? ESCAPE '\\'
                       OR EXISTS (SELECT 1 FROM ticket0_messages m
                                   WHERE m.conversation_id = c.id
                                     AND m.body_text LIKE ? ESCAPE '\\'))`;
    // The same four narrowings the walk offers, so searching inside a filtered inbox
    // stays inside it. Only the ones asked for: an undefined column must not become a
    // `WHERE state IS NULL` that quietly returns nothing.
    for (const key of ['state', 'assignee', 'channel', 'priority'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      sql += ` AND c.${key} = ?`;
      params.push(value);
    }
    // Every queue unless one is named (#1088) — the held message is often the one being
    // looked for. Each row says which queue it is in.
    if (input.queue === 'inbox') sql += ` AND ${inTheInbox('c')}`;
    else if (input.queue !== undefined) {
      sql += ' AND c.quarantine = ?';
      params.push(input.queue);
    }
    // Newest first by default, and the caller's `?order=` honoured — see the note on
    // `search-contacts` for why an advertised direction is not optional to obey.
    const desc = (input.order ?? 'desc') === 'desc';
    if (input.cursor) {
      sql += desc ? ' AND c.id < ?' : ' AND c.id > ?';
      params.push(input.cursor);
    }
    sql += ` ORDER BY c.id ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);
    return pageOf(ctx.sql.query<ConversationRow>(sql, params), limit, (row) => row.id);
  },

  'ticket0/list-conversations': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    // Only the filters actually asked for: an undefined column must not become a
    // `WHERE state IS NULL` that quietly returns nothing.
    const filters: Record<string, unknown> = {};
    for (const key of ['state', 'assignee', 'channel', 'priority', 'contact_id'] as const) {
      if (input[key] !== undefined) filters[key] = input[key];
    }
    // The unfiltered inbox is every state but the terminal one — declared on the
    // input, and applied here as a SET rather than as four requests a screen would
    // have to page separately. An explicit `state` outranks it, so asking for
    // `closed` still means closed; `include_closed` is what widens the read back to
    // the whole desk. The count follows the same `WHERE`, so the total the screen
    // shows is the total of what it is showing.
    // Not for the discarded queue: a discard closes, so every row in it is `closed`, and
    // the open-states default would empty it.
    if (input.state === undefined && input.include_closed !== true && input.queue !== 'discarded') {
      filters['state'] = OPEN_STATES;
    }
    // Which queue, always (#1088): absent is the inbox, whatever `state` or
    // `include_closed` asked, so `state=new` means the new conversations the desk
    // accepted and never the junk held beside them. `null` is how the walk says
    // `quarantine IS NULL` — the same predicate `inTheInbox()` spells for the sweeps.
    filters['quarantine'] = input.queue === undefined || input.queue === 'inbox' ? null : input.queue;
    return ctx.page<ConversationRow>('conversation', {
      ...input,
      filters,
      total: true,
    }) as CountedPage<ConversationRow>;
  },

  'ticket0/breaching-soon': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    if (slaPolicy(desk(ctx)) === null) {
      return { withinMinutes: input.withinMinutes, rows: [], truncated: false };
    }
    const now = ctx.now();
    const until = new Date(Date.parse(now) + input.withinMinutes * 60_000).toISOString();
    const rows = SLA_TARGETS.flatMap((target) =>
      ctx.sql.query<{
        id: string; subject: string; priority: ConversationRow['priority'];
        state: 'new' | 'open' | 'snoozed'; assignee: string | null; dueAt: string;
      }>(slaUpcomingScan(target.target), [now, until, SLA_SOON_LIMIT + 1]).map((row) => ({
        conversationId: row.id,
        subject: row.subject,
        priority: row.priority,
        state: row.state,
        assignee: row.assignee,
        target: target.target,
        dueAt: row.dueAt,
      })),
    ).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.conversationId.localeCompare(b.conversationId));
    return { withinMinutes: input.withinMinutes, rows: rows.slice(0, SLA_SOON_LIMIT), truncated: rows.length > SLA_SOON_LIMIT };
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
    notifyHolder(ctx, conversation, 'mentioned');
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
      // This reply meets the first-response target. If it meets it late, the breach
      // goes on record now, while the target is still running (#1082).
      if (recordIfLate(ctx, conversation, SLA_FIRST_RESPONSE)) {
        ctx.log.warn('first response on {conversationId} was late', { conversationId: conversation.id });
      }
      ctx.sql.exec('UPDATE ticket0_conversations SET first_public_reply_at = ? WHERE id = ?', [
        ctx.now(),
        conversation.id,
      ]);
    }
    settle(ctx, conversation, next);

    /**
     * If this reply is SENDING a drafted turn, the turn stops being a draft — here,
     * in the same transaction as the message it went out on.
     *
     * Only a draft moves. An `escalated` or `failed` turn stayed what it was for a
     * reason, and an `answered` one is already there, so a retry writes nothing. A
     * turnId naming a turn on another conversation moves nothing either: the reply is
     * still posted, because the caller's authority was over THIS conversation and the
     * turn is bookkeeping attached to it.
     */
    if (input.turnId) {
      ctx.sql.exec(
        `UPDATE ticket0_ai_turns SET outcome = 'answered'
          WHERE id = ? AND conversation_id = ? AND outcome = 'drafted'`,
        [input.turnId, conversation.id],
      );
    }

    // Ids only, as on the event below: the body is erasable, and a log line is not.
    ctx.log.info('{authorKind} replied on {conversationId}', { authorKind: row.author_kind, conversationId: conversation.id });
    // Ids only: the body is erasable, so it cannot ride an immutable event. The relay
    // comes back for it at send time through `ticket0/read-outbound`.
    ctx.emit(messageEvent(row, 'ticket0.reply-requested'));
    return row;
  },

  'ticket0/assign': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    // Everything after the check is `assignConversation`, which round-robin runs too.
    return assignConversation(ctx, conversationOrThrow(ctx, input.conversationId), input.assignee);
  },

  /**
   * Round-robin (#1083) — the schedule's only entry point, never a route.
   *
   * Off unless the desk switched it on, and then it hands out the conversations nobody
   * has picked up, oldest first, one person at a time around the ring `nextInTurn`
   * reads. Every hand-out is `assignConversation`, behind the same per-conversation
   * check `ticket0/assign` makes, so the desk's own assignment and a person's are the
   * same act under the same key.
   *
   * WHICH conversations is the predicate below, and every clause is a decision:
   *
   *   - `assignee IS NULL AND first_assigned_at IS NULL` — nobody has EVER had it. An
   *     agent who puts a conversation back has made a decision, and the next sweep must
   *     not overrule it by handing the thread straight to somebody else. Only the
   *     never-assigned are the desk's to distribute. That does include the backlog a
   *     desk already has when it switches this on: "everything unassigned" was the
   *     decision, and the backlog is what that means.
   *   - `state IN ('new', 'open')` — work that is live. A snoozed conversation was
   *     parked on purpose and comes back through `wake-snoozed` as `open`, when this
   *     picks it up. A resolved or closed one is done, and the lifecycle would refuse to
   *     assign it anyway.
   *   - `merged_into IS NULL` — the losing half of a merge is already folded into a
   *     survivor, and the survivor is the one to hand out.
   *   - the assistant's own conversations are left to it. On a desk that lets the
   *     assistant answer, a widget conversation belongs to the assistant until a
   *     hand-off to a person STANDS. Either its latest turn is `escalated` or `failed`
   *     (`escalationStandsSql`), or the newest thing the desk said in public is the
   *     acknowledgement `request-human` writes (`handoffStandsSql`, the very fragment
   *     `handoffStands` reads). "Stands", not "happened once": a hand-off the assistant
   *     or an agent has since answered is not an open request for a person, and handing
   *     that conversation to somebody would act on history. Without this clause, every
   *     widget conversation the assistant was answering would get a human assignee and
   *     a notification. The assistant never answers mail, and on a supervised desk it
   *     cannot send at all, so both of those are a person's work from the start.
   *
   * Idempotent by construction rather than by bookkeeping: what it assigns no longer
   * matches the predicate, so a second run — a duplicate fire, a retried sweep — finds
   * nothing it has already handled. The cursor moves only past people it actually handed
   * something to, so a desk with nobody in the ring leaves the cursor where it was and
   * every conversation where it was: unassigned, in the inbox, and not an error.
   */
  'ticket0/assign-round-robin': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationAssign));
    const settings = desk(ctx);
    if (!roundRobinOn(settings)) return { assigned: 0 };
    const waiting = ctx.sql.query<ConversationRow>(ROUND_ROBIN_WAITING, [
      isAutonomous(ctx) ? 1 : 0,
      HANDED_TO_A_PERSON,
      ROUND_ROBIN_BATCH,
    ]);
    let last = settings.round_robin_last;
    let assigned = 0;
    for (const conversation of waiting) {
      assertAllowed(
        await ctx.check(T0_PERM.conversationAssign, conversationRef(conversation.id)),
      );
      const next = nextInTurn(ctx, last);
      if (next === undefined) break;
      assignConversation(ctx, conversation, next);
      last = next;
      assigned++;
    }
    if (assigned > 0) {
      ctx.sql.exec('UPDATE ticket0_desk_settings SET round_robin_last = ? WHERE id = ?', [
        last,
        DESK,
      ]);
      recordFired(ctx, 'roundRobin', assigned);
    }
    // The one case worth a warning: work was waiting and nobody was in the ring to take it.
    if (assigned < waiting.length) {
      ctx.log.warn('round-robin left {waiting} conversations unassigned: nobody is in the ring', {
        waiting: waiting.length - assigned,
      });
    } else if (assigned > 0) {
      ctx.log.info('round-robin handed out {assigned} conversations', { assigned });
    }
    return { assigned };
  },

  /**
   * Service levels (#1082): the schedule's only entry point, never a route.
   *
   * Off unless the desk has set a target, and it says so before reading a single
   * conversation: a desk with no service levels breaches nothing, even a conversation
   * stamped while it had some. Then, for each target, it takes every conversation
   * `slaOverdueSql` says was missed (`slaOverdueScan`), and for each one it:
   *
   *   - records the breach (`recordBreach`): stamps `*_breached_at` with now, and
   *     publishes `ticket0.sla-breached`, one per target missed, carrying everything a
   *     consumer needs to know which promise was missed, by how much and whose it was.
   *     The stamp is what makes this idempotent: a breached target is no longer running,
   *     so it is no longer in the scan, and a second run, a duplicate fire or a retried
   *     sweep finds nothing to repeat;
   *   - tells the desk through `notifyStaff`, with the `escalated` kind the assistant's
   *     own hand-offs use. That goes to whoever holds the conversation or, when nobody
   *     does, to everybody on the desk. It goes out ONCE per conversation per run, so a
   *     conversation that missed both targets while the sweep was not running produces
   *     two breaches on the trail and one notification per person, not two identical
   *     ones.
   *
   * It does not touch `updated_at`, and that is deliberate. That column means the
   * customer or the desk did something. A breach is neither, and bumping it would float a
   * late conversation to the top of an inbox sorted by activity, and restart the silence
   * `reap-abandoned` measures on exactly the conversation nobody is working.
   *
   * Every conversation it stamps passes the per-conversation check first, as round-robin
   * does before each hand-out, on the same key as the node check.
   */
  'ticket0/escalate-sla-breaches': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationEscalate));
    if (slaPolicy(desk(ctx)) === null) return { breached: 0 };
    const now = ctx.now();
    const told = new Set<string>();
    let breached = 0;
    for (const target of SLA_TARGETS) {
      const overdue = ctx.sql.query<ConversationRow>(slaOverdueScan(target.target), [
        now,
        SLA_BATCH,
      ]);
      for (const conversation of overdue) {
        assertAllowed(
          await ctx.check(T0_PERM.conversationEscalate, conversationRef(conversation.id)),
        );
        recordBreach(ctx, conversation, target, now);
        breached++;
        if (told.has(conversation.id)) continue;
        told.add(conversation.id);
        notifyStaff(ctx, conversation, 'escalated');
      }
    }
    recordFired(ctx, 'sla', told.size);
    if (breached > 0) {
      ctx.log.warn('{breached} service-level targets breached across {conversations} conversations', {
        breached,
        conversations: told.size,
      });
    }
    return { breached };
  },

  /**
   * Auto-tag (#1083) — the schedule's only entry point, never a route.
   *
   * Off unless the desk wrote rules. Each conversation it has not looked at yet is read
   * ONCE against them — its subject and the first thing the customer wrote, matched as a
   * case-insensitive substring, no pattern language — and every tag a matching rule names
   * goes on through `putTag`, behind the same per-conversation check `tag-conversation`
   * makes, on the same key. The desk's tagging and a person's are the same act.
   *
   * IDEMPOTENT by a mark and not by the tags themselves: `auto_tagged_at` is stamped on
   * every conversation it reads, whether or not a rule matched, and the scan is "not
   * stamped yet". So a second run finds nothing it has handled, and — the property a
   * tag-present test could not give — a person who removes an automatic tag does not
   * watch the next sweep put it back. Editing the rules later does not re-read what was
   * already read; that is the price of that property, and it is deliberate.
   *
   * WHICH conversations: live work (`new`, `open`, `snoozed`) not merged away. That
   * includes the backlog a desk already has when it writes its first rule, which is what
   * "everything not yet looked at" means, and is bounded per pass (`AUTO_TAG_BATCH`).
   *
   * It does not touch `updated_at`. A tag is not the customer or the desk doing
   * something, and bumping it would float the conversation up an activity-sorted inbox
   * and restart the silence the sweeps measure — `escalate-sla-breaches`' reasoning.
   */
  'ticket0/auto-tag': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationAssign));
    const rules = autoTagRules(desk(ctx)).map((r) => ({ ...r, needle: r.contains.toLowerCase() }));
    if (rules.length === 0) return { tagged: 0 };
    // A desk whose rules all read the subject never needs a message read.
    const readsBody = rules.some((r) => r.in !== 'subject');
    const pending = ctx.sql.query<ConversationRow>(AUTO_TAG_PENDING, [AUTO_TAG_BATCH]);
    let tagged = 0;
    let conversationsTagged = 0;
    let refused = 0;
    for (const conversation of pending) {
      // A refusal on ONE conversation leaves that one alone and the pass goes on: the
      // node check above is what stops the behaviour, and a row the desk may not act on
      // must not take the rest of the batch down with it. It is not stamped, so it is
      // looked at again once the desk may act on it.
      if (!(await ctx.check(T0_PERM.conversationAssign, conversationRef(conversation.id))).allowed) {
        refused++;
        continue;
      }
      const first = readsBody
        ? ctx.sql.query<{ body: string }>(
            `SELECT body_text AS body FROM ticket0_messages
              WHERE conversation_id = ? AND author_kind = 'contact' AND visibility = 'public'
              ORDER BY id LIMIT 1`,
            [conversation.id],
          )[0]
        : undefined;
      const subject = conversation.subject.toLowerCase();
      const body = (first?.body ?? '').toLowerCase();
      // Two rules naming one tag put it on once: `putTag` finds the row the first left.
      const before = tagged;
      for (const rule of rules) {
        const hit =
          (rule.in !== 'body' && subject.includes(rule.needle)) ||
          (rule.in !== 'subject' && body.includes(rule.needle));
        if (hit && putTag(ctx, conversation, rule.tag).added) tagged++;
      }
      if (tagged > before) conversationsTagged++;
      ctx.sql.exec('UPDATE ticket0_conversations SET auto_tagged_at = ? WHERE id = ?', [
        ctx.now(),
        conversation.id,
      ]);
    }
    recordFired(ctx, 'autoTag', conversationsTagged);
    if (refused > 0) ctx.log.warn('auto-tag skipped {refused} conversations it may not act on', { refused });
    if (tagged > 0) ctx.log.info('auto-tagged {tagged} tags', { tagged });
    return { tagged };
  },

  /**
   * Auto-close (#1083) — the schedule's only entry point, never a route.
   *
   * `ticket0/close` for the conversations the desk is done with and the customer has not
   * come back to. Off unless the desk set a window; then it closes each RESOLVED
   * conversation idle that many days, through the `ticket0/auto-close` edge, which the
   * lifecycle declares out of `resolved` alone — so a query that one day widened would
   * be refused by the machine. Behind `close`'s key, checked per conversation first.
   *
   * IDLE is `updated_at`, the column the reaper measures: every message and every
   * lifecycle move refreshes it through `settle()`, so the clock is "since anybody
   * last did anything". A customer's reply reopens the conversation (`resolved` →
   * `open`, an edge out of `resolved`) and it leaves this scan; when it is resolved
   * again it has a new `updated_at` and a new clock. `<=` makes the boundary exact:
   * idle for the whole window is closed, a second short is not.
   *
   * IDEMPOTENT by construction: `closed` is terminal, so what it closes is no longer
   * `resolved` and a second run finds nothing. `resolved_at` is untouched, so the
   * reports keep counting what was answered, and the event is the one `close`
   * publishes — nothing downstream has to know which door it came through. Nobody is
   * notified: the desk resolved it, and closing it later changes nothing they need.
   * Bounded per pass, oldest idle first.
   */
  'ticket0/auto-close': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationResolve));
    const days = autoCloseDays(desk(ctx));
    if (days === null) return { closed: 0 };
    const due = ctx.sql.query<ConversationRow>(AUTO_CLOSE_DUE, [
      shiftDays(ctx.now(), -days),
      AUTO_CLOSE_BATCH,
    ]);
    let closed = 0;
    let refused = 0;
    for (const conversation of due) {
      // A refusal on one conversation skips it and the pass goes on (see `auto-tag`).
      if (!(await ctx.check(T0_PERM.conversationResolve, conversationRef(conversation.id))).allowed) {
        refused++;
        continue;
      }
      closeConversation(ctx, conversation, 'ticket0/auto-close');
      closed++;
    }
    recordFired(ctx, 'autoClose', closed);
    if (refused > 0) ctx.log.warn('auto-close skipped {refused} conversations it may not act on', { refused });
    if (closed > 0) ctx.log.info('auto-closed {closed} resolved conversations', { closed });
    return { closed };
  },

  /**
   * No-reply notify (#1083) — the schedule's only entry point, never a route.
   *
   * Tells the desk about each customer who has been waiting longer than the desk said it
   * would let them, through `notifyStaff` and the `escalated` notification the SLA sweep
   * and the assistant's hand-offs already use: whoever holds the conversation, or when
   * nobody does, everybody on the desk. The notification is the conversation's id and
   * nothing else, and nothing is sent to the customer — there is no email on this path
   * at all, so nothing personal can leave with it.
   *
   * WHO is waiting is `NO_REPLY_WAITING`'s predicate, and it says why each clause is
   * there. The wait is counted from the OLDEST customer message the desk has not answered,
   * so a customer who chases is not forgiven for it. A notice clears the indexed
   * candidate until another public customer message re-arms it. The notice time then
   * holds the next candidate back for a whole window, including when that message has
   * the same timestamp as the notice. A run that found nobody to tell stamps nothing,
   * so the day somebody joins the desk is the day it is told.
   *
   * Emits `ticket0.no-reply-notified` per conversation, carrying ids, the state, the
   * holder and when the wait began — never a word of the customer's. It does not touch
   * `updated_at`: telling the desk is neither the customer nor the desk acting, and
   * bumping it would restart the silence the reaper and auto-close measure on exactly
   * the conversation nobody is answering.
   */
  'ticket0/notify-no-reply': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationEscalate));
    const hours = noReplyHours(desk(ctx));
    if (hours === null) return { notified: 0 };
    const now = ctx.now();
    const cutoff = shiftInstant(now, -hours * 3_600_000);
    const waiting = ctx.sql.query<ConversationRow & { waiting_since: string }>(NO_REPLY_WAITING, [cutoff, NO_REPLY_BATCH]);
    let notified = 0;
    let refused = 0;
    for (const conversation of waiting) {
      // A refusal on one conversation skips it and the pass goes on (see `auto-tag`).
      if (!(await ctx.check(T0_PERM.conversationEscalate, conversationRef(conversation.id))).allowed) {
        refused++;
        continue;
      }
      const told = notifyStaff(ctx, conversation, 'escalated');
      if (told === 0) continue;
      const latest = ctx.sql.query<{ id: string }>(
        `SELECT id FROM ticket0_messages WHERE conversation_id = ? AND visibility = 'public'
         ORDER BY id DESC LIMIT 1`,
        [conversation.id],
      )[0];
      ctx.sql.exec(
        `UPDATE ticket0_conversations
            SET no_reply_notified_at = ?, no_reply_notified_message_id = ?, no_reply_candidate_at = NULL
          WHERE id = ?`,
        [now, latest?.id ?? null, conversation.id],
      );
      ctx.emit({
        type: 'ticket0.no-reply-notified',
        schemaVersion: 1,
        entity: conversationRef(conversation.id),
        piiClass: 'none',
        payload: {
          id: conversation.id,
          state: conversation.state,
          assignee: conversation.assignee,
          waiting_since: conversation.waiting_since,
          told,
        },
      });
      notified++;
    }
    recordFired(ctx, 'noReplyNotify', notified);
    if (refused > 0) ctx.log.warn('notify-no-reply skipped {refused} conversations it may not act on', { refused });
    if (notified + refused < waiting.length) {
      ctx.log.warn('{waiting} waiting customers could not be announced: nobody is on the desk', {
        waiting: waiting.length - notified - refused,
      });
    }
    if (notified > 0) ctx.log.info('told the desk about {notified} waiting customers', { notified });
    return { notified };
  },

  'ticket0/set-priority': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const next = step(conversation, 'ticket0/set-priority');
    /**
     * A new priority re-aims the service-level targets (#1082), but only the ones still
     * RUNNING. A target already met is history, and so is one already missed: marking a
     * conversation `low` after it breached its urgent first-response target does not
     * un-breach it, and marking an answered one `urgent` does not re-open its first
     * response. The running test is the same fragment the sweep reads, evaluated here
     * against the row as it stands before this write.
     *
     * Re-aimed from the policy in force NOW, counted from `created_at` (`slaDue` says
     * why). A desk with no service levels re-aims a running target to null, so a
     * conversation stamped under an old policy stops being held to it the next time
     * somebody decides its priority.
     *
     * A target already past its due that no sweep has recorded yet is recorded FIRST
     * (`recordIfLate`), so it is missed rather than running when the re-aim reads it. A
     * priority change must not be a way to erase a miss. That conversation is still
     * waiting, so unlike a late reply, somebody is told, as the sweep would have told
     * them: whoever holds it, or the whole desk, never the person changing the priority,
     * who is looking at it.
     *
     * The re-aim counts past the time already spent in finished snoozes, for the targets
     * a snooze pauses (#1648, `slaDue`). A snooze in progress is not counted yet, and
     * need not be: a paused target cannot be recorded late while it sleeps, and
     * `endSnooze` adds this snooze to whatever due this writes, when it ends.
     */
    let missed = false;
    for (const t of SLA_TARGETS) if (recordIfLate(ctx, conversation, t)) missed = true;
    if (missed) notifyStaff(ctx, conversation, 'escalated');
    const due = slaDue(
      slaPolicy(desk(ctx)),
      conversation.created_at,
      input.priority,
      conversation.snoozed_ms ?? 0,
    );
    ctx.sql.exec(
      `UPDATE ticket0_conversations
          SET priority = ?,
              first_response_due_at =
                CASE WHEN ${FIRST_RESPONSE_RUNNING} THEN ? ELSE first_response_due_at END,
              resolution_due_at =
                CASE WHEN ${RESOLUTION_RUNNING} THEN ? ELSE resolution_due_at END
        WHERE id = ?`,
      [input.priority, due.firstResponse, due.resolution, conversation.id],
    );
    const row = settle(ctx, conversation, next);
    ctx.emit({
      type: 'ticket0.conversation-priority-set',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: {
        id: row.id,
        priority: row.priority,
        state: row.state,
        first_response_due_at: row.first_response_due_at,
        resolution_due_at: row.resolution_due_at,
      },
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
          AND ${inTheInbox()}
          AND ${canonicalInstant('snoozed_until')}
          AND snoozed_until <= ?
        ORDER BY snoozed_until LIMIT ?`,
      [...CANONICAL_INSTANT_PARTS, ctx.now(), WAKE_BATCH],
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
      notifyHolder(ctx, row, 'snooze-woke');
    }
    if (due.length > 0) ctx.log.info('woke {woke} snoozed conversations', { woke: due.length });
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
    // Resolving meets the resolution target, the first time. Late is recorded before
    // `resolved_at` takes the conversation out of the running set (#1082). A snooze this
    // resolve ends is ended FIRST (#1648), so the late test reads the due the snooze
    // pushed back rather than the paused one: resolving a snoozed conversation is judged
    // on the time the desk actually had, and `moveTo` finds nothing left to give back.
    endSnooze(ctx, conversation.id);
    recordIfLate(ctx, conversation, SLA_RESOLUTION);
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
    return closeConversation(ctx, conversationOrThrow(ctx, input.conversationId), 'ticket0/close');
  },

  /**
   * The reaper (#1088) — `ticket0/close`, for the conversations no person is ever
   * going to reach.
   *
   * Written against `ticket0/wake-snoozed` line for line, and for the same reasons:
   * bounded batch, `ctx.now()` as the only clock, and the move taken through the
   * declared `step()` edge so the lifecycle stays the one place that says what a
   * conversation may do. A sweep that wrote `state` itself would be a second state
   * machine, and the second one is always the one that drifts.
   *
   * The window is the DESK's — `abandonedAfter(ctx)`, read on every run, defaulting to
   * `ABANDONED_AFTER_DAYS` for a desk that has never said. Read per run and not hoisted
   * into a constant: a desk that lengthens its window at noon means it on the next
   * sweep, and one that has never touched the setting cannot tell that the column
   * exists.
   *
   * The predicate is four clauses and each is load-bearing:
   *   - `state = 'new'` is the whole definition of abandoned. The two edges out of
   *     `new` toward `open` are a public reply and an assignment, so a row still here
   *     has neither — there is no `first_public_reply_at IS NULL` to add, because the
   *     machine already said it.
   *   - `merged_into IS NULL` leaves the losing half of a merge alone. It is already
   *     folded into a survivor and out of every list the desk reads; closing it would
   *     emit a second event about a conversation that stopped being one.
   *   - `updated_at <= cutoff` measures SILENCE, not age. Every arriving message runs
   *     `settle()`, which touches `updated_at`, so a thread the customer added to
   *     yesterday is a day old here no matter when it opened.
   *   - no `drafted` turn. `ticket0/record-answer` is an `allow` on `new`, not an edge
   *     out of it, so the assistant writing an answer for a human to send leaves the
   *     conversation exactly where it was — and a draft IS the desk having touched it.
   *     Reaping one would strand it twice over: `closed` is terminal, so the draft can
   *     never be sent, while `ticket0/assistant-health` goes on listing it as waiting
   *     (its predicate asks whether a public reply followed the turn, and a reaped
   *     conversation never gets one). That is precisely the "sits on this list forever
   *     with nothing able to clear it" the health read was written to avoid.
   *     `outcome = 'drafted'` alone is enough here, without health's "still the last
   *     word" clause: a public reply from the desk moves a conversation to `open`, so
   *     one still in `new` cannot have had one.
   *
   * No `canonicalInstant` guard, unlike the snooze sweep, and the asymmetry is
   * deliberate rather than an omission: `snoozed_until` was a caller-supplied string
   * before it was an `instant`, so a desk may hold values that sort wrongly as text.
   * `updated_at` has only ever been written by `moveTo`/`touch` from `ctx.now()`, so
   * every value in the column is already canonical UTC and a text comparison is a
   * comparison of instants.
   *
   * Nobody is notified. A `new` conversation has no assignee by construction, so there
   * is no one holding it to tell, and a notification to the whole desk about mail
   * nobody read for a month is the sort of thing people turn off.
   */
  'ticket0/reap-abandoned': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationResolve));
    const cutoff = shiftDays(ctx.now(), -abandonedAfter(ctx));
    const abandoned = ctx.sql.query<ConversationRow>(
      REAP_ABANDONED_SQL,
      [cutoff, REAP_BATCH],
    );
    // The same body `ticket0/close` runs, so the same event: a consumer must not have to
    // know which door a conversation was closed through — and `resolved_at` stays null
    // either way, so the reports go on counting only what was answered.
    for (const conversation of abandoned) closeConversation(ctx, conversation, 'ticket0/reap-abandoned');
    if (abandoned.length > 0) {
      ctx.log.info('closed {reaped} abandoned conversations', { reaped: abandoned.length });
    }
    return { reaped: abandoned.length };
  },

  // --- The suspended queue (#1088) -----------------------------------------

  /**
   * The queue, newest first, with what a person needs to decide without opening each
   * row: the sender, the signals, and the start of the first thing they wrote. One
   * statement, over the partial index migration 0021 keeps for exactly this queue.
   * `substr` cuts the excerpt in SQL so a ten-megabyte mail is not read to show a line.
   */
  'ticket0/list-suspended': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const desc = (input.order ?? 'desc') === 'desc';
    const params: SqlValue[] = [SUSPENDED_EXCERPT_CHARS];
    let sql = `SELECT c.id, c.channel, c.subject, c.contact_id, k.email AS contact_email,
                      k.display_name AS contact_name, c.suspended_at, c.suspicion,
                      c.created_at, c.updated_at,
                      (SELECT substr(m.body_text, 1, ?) FROM ticket0_messages m
                        WHERE m.conversation_id = c.id AND m.visibility = 'public'
                          AND m.author_kind = 'contact'
                        ORDER BY m.id LIMIT 1) AS excerpt,
                      (SELECT COUNT(*) FROM ticket0_messages m WHERE m.conversation_id = c.id)
                        AS messages
                 FROM ticket0_conversations c
                 JOIN ticket0_contacts k ON k.id = c.contact_id
                WHERE c.quarantine = 'suspended'`;
    if (input.cursor) {
      sql += desc ? ' AND c.id < ?' : ' AND c.id > ?';
      params.push(input.cursor);
    }
    sql += ` ORDER BY c.id ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);
    const rows = ctx.sql.query<{
      id: string;
      channel: ConversationRow['channel'];
      subject: string;
      contact_id: string;
      contact_email: string | null;
      contact_name: string | null;
      suspended_at: string | null;
      suspicion: string | null;
      excerpt: string | null;
      messages: number;
      created_at: string;
      updated_at: string;
    }>(sql, params);
    return pageOf(
      rows.map(({ suspicion, ...row }) => ({
        ...row,
        reasons: suspicionOfRow(suspicion),
        messages: Number(row.messages),
      })),
      limit,
      (row) => row.id,
    );
  },

  'ticket0/suspend': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    return suspendConversation(ctx, conversationOrThrow(ctx, input.conversationId), ['marked']);
  },

  /**
   * "Not spam". `step()` is what keeps it to a `new` conversation — the only state the
   * queue holds — and clearing `quarantine` is the whole restore, so it is lossless by
   * construction. `updated_at` is touched: the reaper measures silence, and the desk has
   * only just seen this one.
   */
  'ticket0/restore': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/restore');
    // Already in the inbox: the same decision made twice, not a conflict.
    if (conversation.quarantine !== 'suspended') return conversation;
    ctx.sql.exec('UPDATE ticket0_conversations SET quarantine = NULL WHERE id = ?', [conversation.id]);
    const row = touch(ctx, conversation.id);
    ctx.log.info('conversation {conversationId} restored to the inbox', { conversationId: row.id });
    ctx.emit({
      type: 'ticket0.conversation-restored',
      schemaVersion: 1,
      entity: conversationRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, state: row.state, suspicion: row.suspicion },
    });
    return row;
  },

  'ticket0/discard': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationDiscard, conversationRef(input.conversationId)),
    );
    return await discardConversation(ctx, conversationOrThrow(ctx, input.conversationId), 'ticket0/discard');
  },

  /**
   * Each conversation through the one body, with the per-conversation check
   * `ticket0/discard` makes, so each publishes its own events. All or nothing is the
   * operation's own transaction: the first id that is not found, not the caller's, or not
   * suspended throws, and every discard before it in this call is rolled back with it. A
   * repeated id is the same conversation selected twice, and counted once.
   */
  'ticket0/discard-suspended': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDiscard));
    const ids = [...new Set(input.conversationIds)];
    for (const id of ids) {
      assertAllowed(await ctx.check(T0_PERM.conversationDiscard, conversationRef(id)));
      await discardConversation(ctx, conversationOrThrow(ctx, id), 'ticket0/discard-suspended');
    }
    return { discarded: ids };
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
    // The loser's queue is `step()`'s business; the survivor's is checked here (#1088).
    // Folding an accepted thread into a held or discarded one would hide it from the inbox
    // — or, for a discarded one, put fresh words inside a tombstone.
    if (survivor.quarantine !== null) {
      throw substratError(
        'conflict',
        `conversation ${survivor.id} is ${survivor.quarantine} — merge into a conversation in the inbox`,
        { reason: 'survivor_not_in_inbox' },
      );
    }

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

    // A follower of the loser does not automatically inherit the survivor's earlier
    // messages. Remove the grant and its ledger row together with the merge. The ledger
    // includes follows that predate it (migration 0019), so old grants are covered too.
    const loserRef = conversationRef(conversation.id);
    await dropFollowers(ctx, conversation.id);

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
    const survivorRef = conversationRef(survivor.id);
    for (const [table, entityType] of [
      ['ticket0_messages', 'message'],
      ['ticket0_ai_turns', 'aiTurn'],
      ['ticket0_widget_sessions', 'widgetSession'],
    ] as const) {
      const moved = ctx.sql.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE conversation_id = ?`,
        [conversation.id],
      );
      ctx.sql.exec(`UPDATE ${table} SET conversation_id = ? WHERE conversation_id = ?`, [
        survivor.id,
        conversation.id,
      ]);
      for (const row of moved) {
        ctx.relink({ entityType, entityId: row.id }, loserRef, survivorRef);
      }
    }
    // A mail's delivery record names the conversation its message is in, so it moves
    // with the message (#1088).
    ctx.sql.exec('UPDATE ticket0_mail_deliveries SET conversation_id = ? WHERE conversation_id = ?', [
      survivor.id,
      conversation.id,
    ]);
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
     * The loser's CCs and third parties move with it (#1086), the way its tags do: one row
     * per person per conversation, so somebody already on the survivor keeps the survivor's
     * row — and its role — and the loser's copy goes. Both conversations are one contact's,
     * so nobody moved can be the survivor's requester. A merge can carry the survivor past
     * `PARTICIPANTS_MAX`: the cap bounds what is ADDED, and dropping somebody already on
     * the thread to honour it would stop mailing a person nobody decided to stop mailing.
     */
    ctx.sql.exec(
      `UPDATE ticket0_conversation_participants SET conversation_id = ? WHERE conversation_id = ?
         AND contact_id NOT IN (SELECT contact_id FROM ticket0_conversation_participants WHERE conversation_id = ?)`,
      [survivor.id, conversation.id, survivor.id],
    );
    ctx.sql.exec('DELETE FROM ticket0_conversation_participants WHERE conversation_id = ?', [
      conversation.id,
    ]);
    /**
     * `csat` deliberately stays. It is keyed by the conversation and it is a rating OF
     * that conversation — moving it would either collide with the survivor's own
     * rating or silently reattribute one exchange's score to another.
     */

    // relink above moves each row's permission parent as well as its SQL owner. A
    // grant on the loser no longer reaches a moved row through a stale second edge.
    /**
     * The survivor changed too, and until #1088 nothing said so.
     *
     * It just absorbed another thread's messages, turns and sessions — that is
     * activity on it by any reading, and `updated_at` is the column that means "last
     * activity". Only the loser's was written, so a survivor could take on a week of
     * new messages and go on reading as untouched since whenever it last spoke.
     *
     * The reaper is what turned that from a cosmetic ordering wrinkle into a real one:
     * an old, still-`new` conversation chosen as the SURVIVOR of a merge a person made
     * this morning was reapable on the very next sweep, because its own clock had not
     * moved. Touching it here is the honest fix — the alternative, exempting every
     * merge target from the sweep, would make a genuinely abandoned survivor immortal.
     */
    touch(ctx, survivor.id);
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
    // Everything after the check is `putTag`, which auto-tag runs too.
    return putTag(ctx, conversationOrThrow(ctx, input.conversationId), input.tag).row;
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
   * Put a colleague on a thread — one `ctx.grant`, and that is the entire feature.
   *
   * `ctx.grant` DELEGATES: the kernel re-checks that the caller holds
   * `conversation:read` on this conversation before writing the tuple, so this
   * operation can never hand out more than the person calling it was given. That
   * check is separate from the `conversation:assign` above, and both have to pass —
   * deciding who works a thread is not the same statement as being able to read it,
   * even though every staff role here happens to hold both.
   *
   * Idempotent, because the tuple write is: following somebody already following is
   * the same end state. It still emits, unlike tagging twice — a grant has no row to
   * read first, so this cannot tell a repeat from a first time, and announcing every
   * call is the honest half of that. A consumer counting these counts CALLS.
   *
   * No `step`: see the operation's declaration. Following is an access decision about
   * the conversation, not work on it, so a closed thread can still be shown to
   * somebody.
   */
  'ticket0/follow-conversation': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    // Following is not in the lifecycle — it moves nothing — so it does not pass through
    // `step()`, and the queue's rule is asked of it directly (#1088): a new read grant on
    // a conversation the desk has not accepted is the desk handing junk to a colleague.
    // Unfollow stays open, because removing access is always safe to allow.
    heldOrThrow(conversation, 'ticket0/follow-conversation');
    // Before the grant, not after: a durable read handed to a principal this desk
    // cannot name is the failure the directory exists to stop, and it is one nobody
    // would see — the grant confers access and leaves no row anyone lists.
    const follower = followableStaffOrThrow(ctx, input.follower);
    // The directory's own value rather than the input's, so the principal the grant
    // names is provably the row that was just checked.
    const principal = principalId.parse(follower.principal);
    await ctx.grant(principal, T0_PERM.conversationRead, conversationRef(conversation.id));
    ctx.sql.exec(
      'INSERT OR IGNORE INTO ticket0_conversation_follows (principal, conversation_id) VALUES (?, ?)',
      [principal, conversation.id],
    );
    ctx.emit({
      type: 'ticket0.conversation-followed',
      schemaVersion: 1,
      entity: conversationRef(conversation.id),
      piiClass: 'none',
      payload: { conversation_id: conversation.id, follower: principal },
    });
    return { conversation_id: conversation.id, follower: principal, following: true };
  },

  /**
   * Take them off again — and this one asks NOTHING about the person it is removing.
   *
   * Not the directory, not the assistant rule, nothing. That asymmetry with
   * `follow-conversation` is the whole point, and it is not symmetry lost by
   * accident: a refusal to ADD somebody withholds access, and a refusal to REMOVE
   * them LEAVES ACCESS STANDING. Only one of those is safe to get wrong, so an
   * eligibility test belongs only on the way in.
   *
   * It matters because every fact this could have tested is one the follower controls
   * or that another operation could take away. `display_name` is set by its own
   * principal through `ticket0/set-agent-profile`, with no reserved names — so a
   * follower who renamed themselves to the assistant's name would have failed the
   * follow rule here and made their own grant unrevocable. Checking directory
   * membership instead only moves the problem: nothing deletes a profile row TODAY,
   * and an operation that one day removes a colleague from the desk would break
   * revocation exactly when it is most wanted. So the rule is that revocation depends
   * on nothing about its subject, which is the only version of it that stays true.
   *
   * What still holds: the CALLER is checked, the conversation must exist, and
   * `ctx.revoke` delegates the same way `ctx.grant` does — a caller may only withdraw
   * a grant it could have made. Revoking what was never granted is a no-op, so a
   * principal nobody followed gets the honest answer rather than a refusal.
   *
   * `ctx.revoke` is a delete that reports nothing, which is why the answer is
   * `following: false`, the resulting state, and not `removed` — and why this emits
   * on every call for the reason the one above does.
   */
  'ticket0/unfollow-conversation': async (ctx, input) => {
    assertAllowed(
      await ctx.check(T0_PERM.conversationAssign, conversationRef(input.conversationId)),
    );
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const principal = principalOrThrow(input.follower);
    await ctx.revoke(principal, T0_PERM.conversationRead, conversationRef(conversation.id));
    ctx.sql.exec('DELETE FROM ticket0_conversation_follows WHERE principal = ? AND conversation_id = ?', [
      principal,
      conversation.id,
    ]);
    ctx.emit({
      type: 'ticket0.conversation-unfollowed',
      schemaVersion: 1,
      entity: conversationRef(conversation.id),
      piiClass: 'none',
      payload: { conversation_id: conversation.id, follower: principal },
    });
    return { conversation_id: conversation.id, follower: principal, following: false };
  },

  // --- Participants (#1086) -------------------------------------------------

  /**
   * The four roles from the three places they live, requester first, then everyone else
   * in the order they joined, then the followers by principal. Ids only — see the
   * declaration for why an address is not this read's to hand out.
   */
  'ticket0/list-participants': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    return {
      participants: [
        {
          role: 'requester' as const,
          contact_id: conversation.contact_id,
          principal: null,
          added_by: null,
          created_at: conversation.created_at,
        },
        ...participantsOf(ctx, conversation.id).map((p) => ({
          role: p.role,
          contact_id: p.contact_id,
          principal: null,
          added_by: p.added_by,
          created_at: p.created_at,
        })),
        ...followersOf(ctx, conversation.id).map((principal) => ({
          role: 'follower' as const,
          contact_id: null,
          principal,
          added_by: null,
          created_at: null,
        })),
      ],
    };
  },

  /**
   * Copy somebody in. Not in the lifecycle, like a follow: it is a decision about who is
   * on the conversation, not work on it — but the suspended queue's rule is asked
   * directly, because copying somebody in on junk is the desk mailing it on.
   */
  'ticket0/add-participant': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationForward, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    heldOrThrow(conversation, 'ticket0/add-participant');
    const contact = recipientOrThrow(ctx, input.email, input.name);
    return putParticipant(ctx, conversation, contact.id, 'cc', String(ctx.principal)).row;
  },

  /**
   * Take somebody off. Asks nothing about them, for `unfollow-conversation`'s reason, and
   * is open in every queue: removing a recipient is always safe to allow. Announced only
   * when somebody was actually taken off, the way untagging is.
   */
  'ticket0/remove-participant': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationForward, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    if (input.contactId === conversation.contact_id) {
      throw substratError('validation_failed', 'the person this conversation is with cannot be taken off it');
    }
    const existing = participantOf(ctx, conversation.id, input.contactId);
    if (!existing) return { conversation_id: conversation.id, contact_id: input.contactId, removed: false };
    ctx.sql.exec('DELETE FROM ticket0_conversation_participants WHERE id = ?', [existing.id]);
    ctx.emit({
      type: 'ticket0.participant-removed',
      schemaVersion: 1,
      entity: conversationRef(conversation.id),
      piiClass: 'none',
      payload: { conversation_id: conversation.id, contact_id: existing.contact_id },
    });
    return { conversation_id: conversation.id, contact_id: existing.contact_id, removed: true };
  },

  /**
   * A side thread: the third party on, the message written as `forward`, and the relay
   * told — by `ticket0.forward-requested`, which carries ids, and by
   * `list-pending-outbound`, which is what it actually sweeps.
   *
   * `step()` with this operation is where closed and suspended conversations are refused.
   * It moves nothing, and it is not a response: the customer has been told nothing, so
   * neither service-level target and neither no-reply clock hears of it (`writeMessage`
   * arms and clears those for `public` only). `updated_at` is touched — the desk did work
   * the conversation.
   */
  'ticket0/forward-message': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationForward, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    step(conversation, 'ticket0/forward-message');
    const contact = recipientOrThrow(ctx, input.to, input.name);
    if (contact.id === conversation.contact_id) {
      throw substratError('validation_failed', 'that is the customer — a reply is how the desk writes to them');
    }
    putParticipant(ctx, conversation, contact.id, 'third-party', String(ctx.principal));
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'agent',
      authorPrincipal: String(ctx.principal),
      visibility: 'forward',
      bodyText: input.body,
      bodyHtml: input.bodyHtml ?? null,
      thirdPartyContactId: contact.id,
    });
    touch(ctx, conversation.id);
    ctx.log.info('forwarded a question on {conversationId}', { conversationId: conversation.id });
    ctx.emit({
      type: 'ticket0.forward-requested',
      schemaVersion: 1,
      entity: { entityType: 'message', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        conversation_id: row.conversation_id,
        visibility: row.visibility,
        third_party_contact_id: row.third_party_contact_id,
      },
    });
    return row;
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

  /**
   * The conversations under one tag.
   *
   * `EXISTS` rather than a join, for the reason `search-conversations` gives: the
   * tag table is keyed by both columns, so one conversation matches one tag at most
   * once today — but the page is built on that staying true, and an `EXISTS` does not
   * care whether it does. Exact match, not `LIKE`: the tag is a word chosen from the
   * vocabulary, so `billing` must not find `billing-dispute`.
   *
   * Desk-wide `conversation:read`, like the inbox and the text search — a tag is a
   * staff word and this read hands back nothing a customer could see anyway.
   */
  'ticket0/list-conversations-by-tag': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRead));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const params: SqlValue[] = [input.tag];
    let sql = `SELECT ${CONVERSATION_COLUMNS}
                 FROM ticket0_conversations c
                WHERE EXISTS (SELECT 1 FROM ticket0_conversation_tags t
                               WHERE t.conversation_id = c.id AND t.tag = ?)`;
    // Newest first by default, and the caller's `?order=` honoured — see the note on
    // `search-contacts` for why an advertised direction is not optional to obey.
    const desc = (input.order ?? 'desc') === 'desc';
    if (input.cursor) {
      sql += desc ? ' AND c.id < ?' : ' AND c.id > ?';
      params.push(input.cursor);
    }
    sql += ` ORDER BY c.id ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);
    return pageOf(ctx.sql.query<ConversationRow>(sql, params), limit, (row) => row.id);
  },

  // --- Saved replies -------------------------------------------------------

  'ticket0/list-saved-replies': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    const page = ctx.page<SavedReplyRow>('savedReply', input);
    return { ...page, entries: page.entries.map(savedReplyPublic) };
  },

  'ticket0/create-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    const existing = ctx.sql.query<SavedReplyRow>(
      'SELECT * FROM ticket0_saved_replies WHERE title = ?',
      [input.title],
    )[0];
    if (existing) return savedReplyPublic(existing);
    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at, actions) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.title, input.body, String(ctx.principal), ctx.now(), storedActions(input.actions ?? [])],
    );
    const row = savedReplyPublic(savedReplyOrThrow(ctx, id));
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
        actions: row.actions,
      },
    });
    return row;
  },

  /**
   * One reply. The read an editor arms its guard with - a page is about many rows
   * and so carries no entity tag, which would leave the first save unconditional.
   */
  'ticket0/get-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    return savedReplyPublic(savedReplyOrThrow(ctx, input.savedReplyId));
  },

  /**
   * Change the title, the text, or both.
   *
   * Absent means "leave it", which is why this is a PATCH and why the model makes it
   * declare `concurrency`: the caller read the row, changed one field and sent the
   * bag back, so an unguarded save would destroy a colleague's edit to the other
   * field without either of them seeing anything.
   *
   * A rename onto a title another reply already holds is a `conflict` rather than a
   * silent no-op - `savedReply.key` is `title`, and the caller plainly meant to end
   * up with the name they typed. Changing nothing announces nothing, so a consumer
   * counting this event counts real edits.
   */
  'ticket0/update-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    const existing = savedReplyOrThrow(ctx, input.savedReplyId);
    const title = input.title ?? existing.title;
    const body = input.body ?? existing.body;
    const clash = ctx.sql.query<SavedReplyRow>(
      'SELECT * FROM ticket0_saved_replies WHERE title = ? AND id <> ?',
      [title, existing.id],
    )[0];
    if (clash) {
      throw substratError('conflict', `another saved reply is already called "${title}"`);
    }
    const actions =
      input.actions !== undefined ? storedActions(input.actions) : existing.actions;
    if (title === existing.title && body === existing.body && actions === existing.actions) {
      return savedReplyPublic(existing);
    }
    ctx.sql.exec('UPDATE ticket0_saved_replies SET title = ?, body = ?, actions = ? WHERE id = ?', [
      title,
      body,
      actions,
      existing.id,
    ]);
    const row = savedReplyPublic(savedReplyOrThrow(ctx, existing.id));
    ctx.emit({
      type: 'ticket0.saved-reply-updated',
      schemaVersion: 1,
      entity: { entityType: 'savedReply', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        title: row.title,
        body: row.body,
        created_by: row.created_by,
        created_at: row.created_at,
        actions: row.actions,
      },
    });
    return row;
  },

  /**
   * Take one out of the library.
   *
   * A ULID that names nothing is a stale client rather than a second deletion, so
   * this refuses instead of answering emptily - the reverse of `untag-conversation`,
   * whose identifier is a string a person typed. The title goes out with the answer
   * and on the event because afterwards there is nowhere left to read it from.
   */
  'ticket0/delete-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft));
    const existing = savedReplyOrThrow(ctx, input.savedReplyId);
    ctx.sql.exec('DELETE FROM ticket0_saved_replies WHERE id = ?', [existing.id]);
    ctx.emit({
      type: 'ticket0.saved-reply-deleted',
      schemaVersion: 1,
      entity: { entityType: 'savedReply', entityId: existing.id },
      piiClass: 'none',
      payload: { id: existing.id, title: existing.title },
    });
    return { id: existing.id, title: existing.title };
  },

  /**
   * The reply with this conversation's facts in it.
   *
   * Four reads behind one permission check narrowed to this conversation, which is
   * the reason the substitution is here rather than in the browser: handing a client
   * the contact's name so it can do its own replacement is the same read with
   * nothing in front of it.
   *
   * A read - it writes nothing and emits nothing. Rendering a reply is not using
   * one, and the agent may well look at the result and pick a different one.
   */
  'ticket0/render-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const reply = savedReplyOrThrow(ctx, input.savedReplyId);
    return { id: reply.id, title: reply.title, ...renderFor(ctx, conversation, reply) };
  },

  /**
   * A macro, applied (#1087): the union check, then the reply, then each action, each
   * through its own operation. The model's docblock states the rule; `macroPermissions`
   * is where it is derived and `runMacroPart` is where each part runs.
   *
   * Every key is checked before anything is written, so a caller short of one is
   * refused and nothing moves. Each handler then makes its own check again, on the key
   * it declares, which is the key the union was read from. The union is what does not
   * depend on every future handler remembering its check. The transaction is the last
   * line: anything that throws after the reply, such as an assignee outside the
   * directory, rolls the reply back with it.
   */
  'ticket0/apply-saved-reply': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationDraft, conversationRef(input.conversationId)));
    const conversation = conversationOrThrow(ctx, input.conversationId);
    const reply = savedReplyOrThrow(ctx, input.savedReplyId);
    const actions = savedReplyActions(reply);
    const visibility = input.visibility ?? 'public';
    for (const key of macroPermissions(visibility, actions)) {
      assertAllowed(await ctx.check(key, conversationRef(conversation.id)));
    }

    const body = input.body ?? renderFor(ctx, conversation, reply).body;
    if (body.trim() === '') {
      // Everything in it was a placeholder that resolved to nothing. Sending a blank
      // reply is never what somebody meant.
      throw substratError('validation_failed', 'this reply renders to nothing for this conversation');
    }
    const message = (await runMacroPart(ctx, MACRO_REPLY_OPERATIONS[visibility], {
      conversationId: conversation.id,
      body,
    })) as MessageRow;
    for (const action of actions) {
      const { type, ...rest } = action;
      await runMacroPart(ctx, MACRO_ACTION_OPERATIONS[type], {
        ...rest,
        conversationId: conversation.id,
      });
    }

    const out = {
      saved_reply_id: reply.id,
      conversation_id: conversation.id,
      message_id: message.id,
      actions: actions.map((a) => a.type),
    };
    ctx.emit({
      type: 'ticket0.saved-reply-applied',
      schemaVersion: 1,
      entity: { entityType: 'savedReply', entityId: reply.id },
      piiClass: 'none',
      payload: out,
    });
    return { ...out, conversation: conversationOrThrow(ctx, conversation.id) };
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
    // documentation had nothing, one because the assistant itself did not run. Whoever
    // holds it, or everybody when nobody does: a widget conversation is unassigned,
    // which is exactly the shape this used to tell nobody about.
    if (input.outcome === 'escalated' || input.outcome === 'failed')
      notifyStaff(ctx, conversation, 'escalated');
    // The outcome is the pattern's point: `drafted` and `answered` are the assistant working,
    // `escalated` is it handing over, `failed` is it not managing to.
    const answerLog =
      input.outcome === 'failed' ? ctx.log.error : input.outcome === 'escalated' ? ctx.log.warn : ctx.log.info;
    answerLog('assistant turn on {conversationId} {outcome} ({model}, {inputTokens} in / {outputTokens} out)', {
      conversationId: conversation.id,
      outcome: input.outcome,
      model: modelForLog(input.model),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });
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
    notifyStaff(ctx, conversation, 'escalated');
    // The model, not the error text: that is whatever the provider said, and it can quote
    // the conversation back.
    ctx.log.error('assistant could not act on {conversationId} ({model})', {
      conversationId: conversation.id,
      model: modelForLog(input.model),
    });
    ctx.emit({
      type: 'ticket0.assistant-failed',
      schemaVersion: 2,
      entity: { entityType: 'aiTurn', entityId: row.id },
      piiClass: 'none',
      // Not the error, for the log line's reason above: it can quote the customer, and
      // an event is where a discard or an erasure cannot reach (#1088).
      payload: { id: row.id, conversation_id: row.conversation_id, model: row.model },
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
    const counts = ctx.sql.query<{ turns: number; failed: number | null; drafted: number | null }>(
      ASSISTANT_HEALTH_COUNTS_SQL,
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
      ASSISTANT_HEALTH_RECENT_SQL,
      [HEALTH_RECENT],
    );
    /**
     * The answers nobody has sent — the other half of "is the assistant working".
     *
     * NOT windowed, unlike everything above it. An answer written three days ago and
     * never sent is more urgent than one written an hour ago, not less, and a list that
     * forgot it would be telling an admin the queue is empty when it is not.
     *
     * "Waiting" means the draft is still the last word: no public reply from the desk
     * on that conversation since the turn was written. That excludes a draft somebody
     * answered in their own words — including every one sent before a reply carried its
     * `turnId`, which would otherwise sit on this list forever with nothing able to
     * clear it. `author_kind != 'contact'` because the CUSTOMER writing back is not the
     * desk answering; it is the thing that makes an unsent draft worse.
     */
    const waitingTotal = ctx.sql.query<{ n: number }>(ASSISTANT_HEALTH_WAITING_TOTAL_SQL, [])[0];
    const waiting = ctx.sql.query<{
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      created_at: string;
    }>(
      ASSISTANT_HEALTH_WAITING_SQL,
      [HEALTH_RECENT],
    );
    return {
      since,
      turns: counts?.turns ?? 0,
      failed: Number(counts?.failed ?? 0),
      drafted: Number(counts?.drafted ?? 0),
      supervised: !isAutonomous(ctx),
      recent,
      waitingTotal: waitingTotal?.n ?? 0,
      waiting,
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
          // One bound JSON array, not a `?` per article: a page can cite past the 100
          // parameters a Durable Object binds in all (#1759).
          'SELECT * FROM ticket0_kb_articles WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
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
    // Every aggregate below is bounded only by this range, so the range is bounded here
    // — an unbounded one is a full history scan, and a report that takes a minute is a
    // report nobody opens twice. Refused rather than served slowly.
    const span = Date.parse(to) - Date.parse(from);
    if (span < 0)
      throw substratError('validation_failed', '`to` is before `from`', {
        errors: [{ path: 'to', message: 'the window ends before it begins' }],
      });
    if (span > DESK_METRICS_MAX_DAYS * 86_400_000)
      throw substratError(
        'validation_failed',
        `a report window is at most ${DESK_METRICS_MAX_DAYS} days; ask for a year at a time`,
        { errors: [{ path: 'from', message: `at most ${DESK_METRICS_MAX_DAYS} days before \`to\`` }] },
      );

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
                            AND ${inTheInbox()}
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
    //
    // The suspended queue is counted apart (#1088): junk is not backlog, so a spam run
    // must not read as the desk falling behind, and every other count here is the inbox's.
    const backlogCounts = ctx.sql.query<{
      open: number;
      snoozed: number;
      unassigned: number;
      suspended: number;
    }>(
      `SELECT SUM(CASE WHEN state IN ('new', 'open') AND ${inTheInbox()} THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN state = 'snoozed' AND ${inTheInbox()} THEN 1 ELSE 0 END) AS snoozed,
              SUM(CASE WHEN state IN ('new', 'open') AND assignee IS NULL AND ${inTheInbox()}
                       THEN 1 ELSE 0 END) AS unassigned,
              SUM(CASE WHEN quarantine = 'suspended' THEN 1 ELSE 0 END) AS suspended
         FROM ticket0_conversations
        WHERE merged_into IS NULL`,
    )[0];
    // "Oldest untouched" is by `updated_at`, not `created_at`: a week-old thread somebody
    // replied to an hour ago is not the one going stale.
    const oldest = ctx.sql.query<{ id: string; seconds: number }>(
      `SELECT id, ${elapsed('updated_at', '?')} AS seconds
         FROM ticket0_conversations
        WHERE state IN ('new', 'open') AND merged_into IS NULL AND ${inTheInbox()}
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

    // Priced from the desk's own rate card, each turn at the rate in force WHEN IT
    // HAPPENED — not at the rate in force now. The card is append-only and keyed by the
    // date a price takes effect precisely so a re-pricing does not reach backwards; a
    // report that read one rate and applied it to the whole window would undo that, and
    // last month's number would move every time somebody changed a price.
    const priced = [
      meterCost(ctx, METERS.inputTokens, 'input_tokens', from, to),
      meterCost(ctx, METERS.outputTokens, 'output_tokens', from, to),
    ];
    // The two meters are priced independently and each price carries its own currency,
    // so a desk CAN hold EUR input and USD output — across meters or across periods of
    // one meter. Adding those and labelling the sum with whichever was read first is the
    // quiet kind of wrong, a number that looks right on the screen, so it refuses
    // instead. The fix is one `ticket0/set-usage-rate` call, and the message says so.
    const currencies = [...new Set(priced.flatMap((p) => p.currencies))];
    if (currencies.length > 1)
      throw substratError(
        'conflict',
        `the tokens in this window are priced in more than one currency ` +
          `(${currencies.join(', ')}); re-price them in one before this desk can be costed`,
        { reason: 'mixed_currency' },
      );
    const cost = priced.reduce((sum, p) => addDecimal(sum, p.amount), '0');
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
        suspended: Number(backlogCounts?.suspended ?? 0),
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
        currency: currencies[0] ?? rateFor(ctx, METERS.inputTokens, to)?.currency ?? 'EUR',
        cost,
        costPerResolved: resolved === 0 ? null : divDecimal(cost, resolved),
      },
    };
  },

  // --- The email relay -----------------------------------------------------

  'ticket0/ingest-message': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));

    // Idempotent on the provider's message id: mail providers redeliver, and a
    // redelivered message must not become a second message in the thread. Read from the
    // delivery record, which outlives the message (#1088): a mail the desk DISCARDED is
    // still a mail it received, and a redelivery of it is refused rather than ingested.
    const delivered = deliveryOf(ctx, input.emailMessageId);
    if (delivered) {
      const seen = delivered.message_id ? messageOrNull(ctx, delivered.message_id) : undefined;
      // The conversation id, not the Message-ID: that header names the sender's host.
      if (seen) {
        ctx.log.debug('mail already ingested into {conversationId}', { conversationId: seen.conversation_id });
        return seen;
      }
      ctx.log.info('redelivery of a mail discarded from {conversationId} refused', {
        conversationId: delivered.conversation_id,
      });
      throw substratError('forbidden', DELIVERY_DISCARDED, { reason: 'delivery-discarded' });
    }

    /**
     * The blocklist, and it sits BELOW the idempotency check on purpose (#1088).
     *
     * A redelivery of a mail this desk already accepted must still answer with the
     * message that is in the thread: the words are recorded, blocking the sender
     * afterwards does not unsay them, and throwing here would make Resend retry a
     * delivery that has already succeeded until it gives up.
     *
     * Above every write, though — no contact, no conversation, no message, and on the
     * widget's side no model call. That is the whole point of the table: junk a human
     * would delete in a second is junk the desk has not paid for.
     */
    const known = contactByEmail(ctx, input.contactEmail);
    refuseIfBlocked(ctx, { emails: [input.contactEmail], contactId: known?.id ?? null });

    const contact =
      known ??
      createContact(ctx, {
        email: input.contactEmail,
        display_name: input.contactName ?? null,
        verified_at: ctx.now(),
      });

    const threaded = input.conversationId ? undefined : threadRepliedTo(ctx, contact, input.emailInReplyTo);
    const bound = input.conversationId
      ? conversationOrThrow(ctx, input.conversationId)
      : (threaded ?? openConversation(ctx, contact, 'email', input.subject));
    // Where the sender stands on the conversation the mail found (#1086). A third party
    // writes on a side thread, and that decides both where a reply to a closed thread
    // goes (below) and who may read what they wrote.
    const standing = standingOn(ctx, bound, contact.id);
    // A reply to a thread the desk has closed is a new thread, for the reason
    // `followUp` gives. The relay is told which conversation the message landed in by
    // the row it gets back, so a threading header pointing at the closed one does not
    // have to be right for the mail to arrive somewhere a person will read it.
    //
    // The follow-up belongs to the CLOSED thread's contact, not to whoever the sending
    // address resolves to. Those can differ — `contactByEmail` matches exactly, so one
    // capital letter is a second contact — and a follow-up that crossed contacts would
    // put another person's conversation id in `follows` on a row its owner can read.
    // It is also what already happens one line up: a message the relay binds to a live
    // conversation BY ID lands in it whatever address it came from, because a message
    // carries no contact of its own. The two paths agree rather than differ. (Binding by
    // `In-Reply-To` is the one path that does compare addresses — see `threadRepliedTo`
    // — because there the sender chose the thread, not the relay.)
    //
    // Except a THIRD PARTY's mail (#1086). A follow-up is the customer's conversation, and
    // what lands in one is public — so a supplier answering a forward after the thread
    // was closed would be read by the customer. Their mail opens a conversation of their
    // own instead, as any stranger's does: nothing is lost, and nothing crosses over.
    // Where it lands, and — the first question when one lands in the wrong place — how the
    // mail found it. One decision, so the two cannot be read off different branches.
    let landed = bound;
    let binding: string;
    if (bound.state === 'closed' && standing === 'third-party') {
      landed = openConversation(ctx, contact, 'email', input.subject);
      binding = 'a conversation of its own, from a third party on a closed one';
    } else if (bound.state === 'closed') {
      landed = followUp(ctx, bound, contactOrThrow(ctx, bound.contact_id), input.subject);
      binding = 'a follow-up to a closed conversation';
    } else if (standing === 'third-party') {
      binding = 'a third party on the conversation they were forwarded';
    } else if (input.conversationId) {
      binding = 'the conversation it named';
    } else {
      binding = threaded ? 'the thread it replied to' : 'a new conversation';
    }
    // A side thread: the third party writing into the conversation they were forwarded.
    const sideThread = standing === 'third-party' && landed.id === bound.id;
    // The spam filter (#1088), for a conversation this mail OPENED — a new one or a
    // follow-up. Mail into a thread the desk already holds is not re-judged, in either
    // queue. Read before the message is written, so the repeat count is of OTHER mail.
    const opened = landed.id !== bound.id || (!input.conversationId && !threaded);
    const conversation = opened ? screenAtTheDoor(ctx, landed, input.bodyText) : landed;
    ctx.log.info('mail ingested into {conversationId} as {binding}', { conversationId: conversation.id, binding });

    const next = step(conversation, 'ticket0/ingest-message');
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'contact',
      authorPrincipal: null,
      // A third party's words are the side thread's (#1086): the desk reads them, and no
      // customer-facing read ever returns them — each of those asks for `public` by name.
      visibility: sideThread ? 'forward' : 'public',
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      emailMessageId: input.emailMessageId,
      emailInReplyTo: input.emailInReplyTo ?? null,
      authorContactId: contact.id,
      thirdPartyContactId: sideThread ? contact.id : null,
    });
    recordDelivery(ctx, row, 'inbound');
    // Whoever else the mail was addressed to, as CCs — when it came from somebody on the
    // customer's thread (`captureRecipients` says who may add people by mail).
    captureRecipients(ctx, conversation, contact, [...(input.to ?? []), ...(input.cc ?? [])]);

    // The files, as a note rather than as files (#1080). There is still nowhere to put
    // the bytes, so this does not pretend otherwise — it makes the loss AUDIBLE, which
    // is the half of the complaint that costs nothing to fix. INTERNAL, because it is
    // the desk talking to itself about the customer's mail: the customer knows what
    // they attached, and `publicThread` never returns it to them.
    //
    // No event of its own, deliberately. The ingestion is one fact, and a second
    // `ticket0.message-ingested` would have a consumer counting two inbound messages
    // for one mail. The escalation acknowledgement is written the same way.
    if (input.attachments && input.attachments.length > 0) {
      ctx.log.warn('{count} attachments dropped from mail on {conversationId}: the desk has no file store', {
        count: input.attachments.length,
        conversationId: conversation.id,
      });
      writeMessage(ctx, {
        conversationId: conversation.id,
        authorKind: 'system',
        authorPrincipal: String(ctx.principal),
        visibility: 'internal',
        bodyText: droppedAttachmentsNote(input.attachments),
      });
    }

    settle(ctx, conversation, next);
    notifyHolder(ctx, conversation, 'replied');
    ctx.emit(messageEvent(row, 'ticket0.message-ingested'));
    return row;
  },

  /**
   * What is waiting to go out. Named columns and nothing else — see the declaration
   * for why a list of outbound mail must not carry the bodies.
   *
   * `author_kind <> 'contact'` and not `IN ('agent','assistant')`: what makes a
   * message outbound is that the DESK wrote it, and a `system` message on an email
   * conversation is the desk speaking too. The one kind that can never be sent back
   * to where it came from is the customer's own, which is what this excludes.
   *
   * Two kinds of mail, named by visibility and never by exclusion (#1086): a `public`
   * reply on an EMAIL conversation (a widget visitor reads theirs in the widget), and a
   * `forward` on ANY conversation, while its third party is still on it — a forward is
   * always mail, and one whose third party was taken off is never sent, so it must not
   * sit at the head of this queue being skipped on every sweep either.
   */
  'ticket0/list-pending-outbound': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const desc = (input.order ?? 'asc') === 'desc';
    const params: SqlValue[] = [];
    let sql = `SELECT m.id AS messageId, m.conversation_id AS conversationId,
                      m.created_at AS createdAt
                 FROM ticket0_messages m
                 JOIN ticket0_conversations c ON c.id = m.conversation_id
                WHERE m.author_kind <> 'contact'
                  AND m.delivered_at IS NULL
                  AND ((m.visibility = 'public' AND c.channel = 'email')
                       OR (m.visibility = 'forward'
                           AND EXISTS (SELECT 1 FROM ticket0_conversation_participants p
                                        WHERE p.conversation_id = m.conversation_id
                                          AND p.contact_id = m.third_party_contact_id
                                          AND p.role = 'third-party')))
                  AND ${inTheInbox('c')}`;
    if (input.cursor) {
      sql += desc ? ' AND m.id < ?' : ' AND m.id > ?';
      params.push(input.cursor);
    }
    sql += ` ORDER BY m.id ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(limit);
    return pageOf(
      ctx.sql.query<{ messageId: string; conversationId: string; createdAt: string }>(sql, params),
      limit,
      (row) => row.messageId,
    );
  },

  'ticket0/read-outbound': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationRelay));
    const message = messageOrThrow(ctx, input.messageId);
    // Named, not excluded: a visibility this read does not know is never mailed (#1086).
    const visibility = message.visibility;
    if (visibility !== 'public' && visibility !== 'forward')
      throw substratError('permission_denied', 'internal notes are never sent to a customer');
    const conversation = conversationOrThrow(ctx, message.conversation_id);
    // The relay reads a body to SEND it, so a held conversation is refused here as it is
    // left out of `list-pending-outbound` (#1088): the desk never mails a sender it has not
    // accepted, and a relay holding an id from before the suspension is refused too.
    // `record-delivery` stays open — it records a send that already happened.
    heldOrThrow(conversation, 'ticket0/read-outbound');
    /**
     * Who it goes to (#1086). A public reply: the requester, with every CC copied. A
     * forward: its third party alone, and only while they are still on the conversation —
     * taken off, a forward still waiting is not sent (`toEmail` null, which the relay
     * skips). Never both: the customer's thread and a side thread do not share a mail.
     */
    const settings = desk(ctx);
    // Who a participant row reaches, by role: one read, joined to the address it names.
    const addressesOf = (role: ParticipantRow['role'], contactId?: string | null) =>
      ctx.sql
        .query<{ email: string }>(
          `SELECT k.email FROM ticket0_conversation_participants p
             JOIN ticket0_contacts k ON k.id = p.contact_id
            WHERE p.conversation_id = ? AND p.role = ? AND k.email IS NOT NULL
              ${contactId === undefined ? '' : 'AND p.contact_id = ?'}
            ORDER BY p.created_at, p.id`,
          contactId === undefined ? [conversation.id, role] : [conversation.id, role, contactId],
        )
        .map((r) => r.email);
    let toEmail: string | null;
    let ccEmails: string[] = [];
    if (visibility === 'forward') {
      toEmail = addressesOf('third-party', message.third_party_contact_id)[0] ?? null;
    } else {
      toEmail = contactOrNull(ctx, conversation.contact_id)?.email ?? null;
      const deskKey = addressKey(settings.from_address);
      ccEmails = addressesOf('cc').filter((email) => addressKey(email) !== deskKey);
    }
    const author = message.author_principal
      ? ctx.sql.query<AgentProfileRow>('SELECT * FROM ticket0_agent_profiles WHERE principal = ?', [
          message.author_principal,
        ])[0]
      : undefined;

    return {
      messageId: message.id,
      conversationId: conversation.id,
      subject: conversation.subject,
      toEmail,
      ccEmails,
      visibility,
      fromAddress: settings.from_address,
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
    recordDelivery(ctx, row, 'outbound');
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

  'ticket0/assistant-mode': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    return { autonomous: isAutonomous(ctx) };
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
      const known = contactByExternalId(ctx, input.identity.externalId);

      /**
       * Refused BEFORE the contact row is written, and on BOTH addresses.
       *
       * The ordering is **defence in depth, and no test can currently see it** — that
       * was checked by moving the call back below `createContact`, where the whole
       * suite stays green, because the operation's transaction unwinds the row either
       * way. It is written this way regardless: leaning on the unwind is what stops
       * being true the day somebody wraps this region in a `ctx.atomic`, and resolving
       * first costs one read and needs no argument about rollback at all. Stated
       * rather than dressed up as something the suite proves.
       *
       * Both addresses, because they need not agree: `known.email` is what the desk
       * recorded, `identity.email` is what the host page is asserting this time, and
       * `verifyIdentity` signs only `externalId` — so the supplied address is neither
       * trusted nor checked unless it is checked here. Probing the stored one alone
       * let a rule about the supplied one through.
       */
      refuseIfBlocked(ctx, {
        emails: [known?.email, input.identity.email],
        contactId: known?.id ?? null,
      });

      contact =
        known ??
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

    // The blocklist check for this door is ABOVE, before the contact row is created —
    // see the block beside `contactByExternalId`. An anonymous visitor reaches nothing
    // to key on here and is refused at their second message instead, once there is a
    // contact to be about.

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
      // Verbatim, and nothing here reads it. The desk stores whatever a person typed
      // in Settings — "Mon–Fri · 09:00–18:00 · Europe/Stockholm", or a sentence — so
      // parsing it would be inventing a grammar nobody was offered. It travels to the
      // widget as text and is displayed as text; `null` means the desk has not said.
      businessHours: settings.business_hours,
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
    // Before the conversation is bound and before a model is ever asked (#1088).
    refuseIfBlockedVisitor(ctx, hold);
    // The first message opens the conversation, every later one finds it bound — and a
    // conversation an agent has closed hands over to the follow-up that continues it.
    const conversation = heldConversation(ctx, input.sessionId, hold, input.body);
    const next = step(conversation, 'ticket0/widget-post');
    const row = writeMessage(ctx, {
      conversationId: conversation.id,
      authorKind: 'contact',
      authorPrincipal: null,
      visibility: 'public',
      bodyText: input.body,
      // The visitor holding the session is the conversation's own contact (`bindOpening`).
      authorContactId: conversation.contact_id,
    });
    settle(ctx, conversation, next);
    notifyHolder(ctx, conversation, 'replied');
    ctx.emit(messageEvent(row, 'ticket0.message-ingested'));
    // What the widget surface reads before it hands this message to the assistant: a
    // held conversation is never answered, so the inference is never spent (#1088).
    return { ...row, suspended: conversation.quarantine === 'suspended' };
  },

  /**
   * "Talk to a human" — the click, rather than a sentence that happens to say so.
   *
   * Three writes and no model: what the visitor said (when the caller has it), the
   * desk's acknowledgement, and a notification for everyone who could pick it up. All
   * in one transaction, because the failure this closes is a request for a person that
   * is recorded and never announced.
   *
   * The acknowledgement is written by the DESK, not by the assistant, and that is why
   * it does not go through `post-public-reply`: a desk that keeps a human in the loop
   * refuses the assistant a public word, correctly, and a visitor who asked for a
   * person must still be told that one is coming. Confirming receipt is not answering.
   */
  'ticket0/request-human': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.conversationWidget));
    const hold = await holdOrThrow(ctx, input.sessionId, input.token);
    // The same refusal as `widget-post`, for the same visitor — this door writes two
    // messages and notifies the desk, so it is the more expensive one to leave open.
    refuseIfBlockedVisitor(ctx, hold);
    const conversation = heldConversation(ctx, input.sessionId, hold, input.body ?? '');
    const next = step(conversation, 'ticket0/request-human');

    /**
     * The visitor's own words, when they are not already in the thread.
     *
     * With a `body` this is the button: one call posts and escalates. Without one the
     * visitor typed the request and `widget-post` has already written it — so the
     * message this returns is that one, found rather than written, and the thread
     * shows the ask once.
     */
    const asked = input.body
      ? writeMessage(ctx, {
          conversationId: conversation.id,
          authorKind: 'contact',
          authorPrincipal: null,
          visibility: 'public',
          bodyText: input.body,
          authorContactId: conversation.contact_id,
        })
      : lastCustomerMessage(ctx, conversation.id);

    /**
     * Held in the suspended queue (#1088): the visitor's words are written, as
     * `widget-post` would write them, and that is all. No acknowledgement — it promises
     * that "someone from the team will reply", which nobody has agreed to — and no
     * notification, because a sender the filter held must not be able to page the whole
     * desk with a button. A restore puts the conversation, and this message, in the
     * inbox where every person sees it.
     */
    if (conversation.quarantine === 'suspended') {
      settle(ctx, conversation, next);
      if (input.body) ctx.emit(messageEvent(asked, 'ticket0.message-ingested'));
      return { ...asked, notified: 0 };
    }

    /**
     * Ask twice, and the desk hears once. The acknowledgement and the notifications
     * both belong to a request that is outstanding, and a second click while the first
     * one still stands is the same request being made again — impatience, not news.
     * What the visitor SAID is written either way, above: they may have added
     * something, and the thread is theirs.
     */
    const standing = handoffStands(ctx, conversation.id);
    if (!standing)
      writeMessage(ctx, {
        conversationId: conversation.id,
        authorKind: 'system',
        authorPrincipal: String(ctx.principal),
        visibility: 'public',
        bodyText: HANDED_TO_A_PERSON,
      });
    settle(ctx, conversation, next);

    const notified = standing ? 0 : notifyStaff(ctx, conversation, 'escalated');
    ctx.emit({
      type: 'ticket0.human-requested',
      schemaVersion: 1,
      entity: { entityType: 'message', entityId: asked.id },
      piiClass: 'none',
      // Never the body — it is erasable, and what a consumer needs is that somebody
      // asked, on which conversation, and how many people the desk could tell.
      payload: { id: asked.id, conversation_id: conversation.id, notified },
    });
    return { ...asked, notified };
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
   *
   * Two proofs per row since #1086, and either is enough: the walk (the caller's own
   * conversation, through the parent edge) or a CC's (`readableAsCc`). `pageVisible`'s one
   * batch and filter, written out so the CC proof is asked once for the rows the walk
   * refused rather than once per row — a customer whose every conversation is their own
   * pays nothing more than before.
   */
  'ticket0/my-conversations': async (ctx, input) => {
    const batch = ctx.page<ConversationRow>('conversation', {
      limit: listLimitOf(input?.limit),
      cursor: input?.cursor,
    });
    const own = new Set<string>();
    for (const c of batch.entries) {
      if ((await ctx.check(T0_PERM.conversationReadOwn, conversationRef(c.id))).allowed) own.add(c.id);
    }
    const asCc = await readableAsCc(ctx, batch.entries.filter((c) => !own.has(c.id)).map((c) => c.id));
    return { entries: batch.entries.filter((c) => own.has(c.id) || asCc.has(c.id)), nextCursor: batch.nextCursor };
  },

  'ticket0/my-messages': async (ctx, input) => {
    await assertReadsAsCustomer(ctx, input.conversationId);
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

  // --- The waiting list ----------------------------------------------------

  'ticket0/signup-origins': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.signupSubmit));
    return { origins: allowedOrigins(ctx) };
  },

  'ticket0/submit-signup': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.signupSubmit));
    // Refused at the door, out of the same array the browser's preflight was answered
    // from. The widget does this identically and for the identical reason: two lists
    // of allowed origins is how the browser's answer and the operation's answer start
    // disagreeing about where a form may live.
    if (!allowedOrigins(ctx).includes(input.origin))
      throw substratError('permission_denied', `this desk takes no signups from ${input.origin}`);

    const now = ctx.now();
    const note = input.note ?? null;
    // One person is one row per list, whatever they capitalised. See `addressKey`.
    const email = addressKey(input.email);
    const existing = ctx.sql.query<SignupRow>(
      'SELECT * FROM ticket0_signups WHERE kind = ? AND email = ?',
      [input.kind, email],
    )[0];

    /**
     * Announce it, whatever happened — one place, so the three paths below cannot
     * drift on what an event about a signup says. Never the address: it is `erasable`,
     * which makes it uncarryable by an immutable event.
     */
    const announce = (row: SignupRow) =>
      ctx.emit({
        type: 'ticket0.signup-requested',
        schemaVersion: 1,
        entity: { entityType: 'signup', entityId: row.id },
        piiClass: 'none',
        payload: { id: row.id, kind: row.kind, state: row.state },
      });

    if (!existing) {
      /**
       * The ceiling, and it is checked for a NEW address only.
       *
       * This is the guard against the flood that matters: a script POSTing ten
       * thousand different addresses would otherwise have the platform send ten
       * thousand confirmation emails to ten thousand people who never asked, from a
       * domain whose reputation is the platform's. A re-submission of an address
       * already here sends at most one mail and is governed by the throttle below.
       */
      const since = new Date(new Date(now).getTime() - SIGNUP_WINDOW_MS).toISOString();
      const recent = ctx.sql.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM ticket0_signups WHERE created_at > ?',
        [since],
      )[0];
      if (Number(recent?.n ?? 0) >= SIGNUP_HOURLY_MAX)
        throw substratError(
          'rate_limited',
          'this desk has taken as many new signups this hour as it will',
          { retryAfter: SIGNUP_WINDOW_MS / 1000 },
        );

      const id = ulid();
      const confirmToken = signupToken();
      const unsubscribeToken = signupToken();
      ctx.sql.exec(
        `INSERT INTO ticket0_signups
           (id, kind, email, note, state, origin, confirm_token_hash, unsubscribe_token,
            requested_at, confirmed_at, unsubscribed_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?)`,
        [
          id,
          input.kind,
          email,
          note,
          input.origin,
          await sha256(confirmToken),
          unsubscribeToken,
          now,
          now,
        ],
      );
      const row = signupOrThrow(ctx, id);
      announce(row);
      return { id: row.id, kind: row.kind, state: row.state, confirmToken, unsubscribeToken };
    }

    // A row already exists. Where it had got to decides what a second submission means
    // — and the machine, not this handler, is what says which of those are legal.
    const to = stepSignup(existing, 'ticket0/submit-signup');

    if (existing.state === 'confirmed') {
      /**
       * Nothing to do, and deliberately NOT an error.
       *
       * "That address is already subscribed" turns a public signup form into a
       * membership oracle: anybody could ask it, one address at a time, who is on the
       * list. So this path is indistinguishable from a first submission to everything
       * outside the desk — the form says check your email either way, and no mail is
       * sent because there is nothing to confirm.
       */
      announce(existing);
      return {
        id: existing.id,
        kind: existing.kind,
        state: existing.state,
        confirmToken: null,
        // Not null, and that is the point: the caller may be about to send this person
        // something, and every mail needs a way out even when there is nothing to confirm.
        unsubscribeToken: existing.unsubscribe_token,
      };
    }

    /**
     * The mail never arrived — so re-issue, but not on every keypress.
     *
     * The previous confirmation is still valid while this holds: the throttle declines
     * to mint a SECOND token, it does not invalidate the first. Somebody who clicks
     * submit twice in ten seconds has one working link in their inbox, which is the
     * outcome they wanted.
     */
    const throttled =
      existing.state === 'pending' &&
      new Date(existing.requested_at).getTime() >
        new Date(now).getTime() - SIGNUP_RESEND_SECONDS * 1000;
    if (throttled) {
      announce(existing);
      return {
        id: existing.id,
        kind: existing.kind,
        state: existing.state,
        confirmToken: null,
        unsubscribeToken: existing.unsubscribe_token,
      };
    }

    const confirmToken = signupToken();
    ctx.sql.exec(
      `UPDATE ticket0_signups
          SET state = ?, note = ?, origin = ?, confirm_token_hash = ?, requested_at = ?,
              unsubscribed_at = NULL
        WHERE id = ?`,
      [
        to,
        // A new note replaces the old one; an empty box leaves what they said before.
        note ?? existing.note,
        input.origin,
        await sha256(confirmToken),
        now,
        existing.id,
      ],
    );
    /**
     * `unsubscribed_at` is cleared on the way back in, and the history is not lost by
     * clearing it: the unsubscribe emitted an event, and the event log is the immutable
     * record. What a column must not do is contradict the state beside it — a row
     * reading `pending` with a date on it saying it left is a fact two ways.
     */
    const row = signupOrThrow(ctx, existing.id);
    announce(row);
    /**
     * The unsubscribe token is the row's existing one, NOT a fresh one, and re-minting
     * it here would be the bug: a link in a mail archive has to keep working, and
     * replacing the token would silently break every copy of it this person still holds.
     */
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      confirmToken,
      unsubscribeToken: row.unsubscribe_token,
    };
  },

  'ticket0/confirm-signup': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.signupSubmit));
    const held = await signupByConfirmToken(ctx, input.token);
    // A spent link and a forged one are the same answer on purpose: the hash is nulled
    // when it is spent, so neither the caller nor this handler can tell them apart, and
    // there is nothing here for a guess to learn.
    if (!held)
      throw substratError('not_found', 'this confirmation link is not valid — it may already have been used');

    const to = stepSignup(held, 'ticket0/confirm-signup');
    ctx.sql.exec(
      'UPDATE ticket0_signups SET state = ?, confirmed_at = ?, confirm_token_hash = NULL WHERE id = ?',
      [to, ctx.now(), held.id],
    );
    const row = signupOrThrow(ctx, held.id);
    ctx.emit({
      type: 'ticket0.signup-confirmed',
      schemaVersion: 1,
      entity: { entityType: 'signup', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, kind: row.kind, state: row.state, confirmed_at: row.confirmed_at },
    });
    return signupPublic(row);
  },

  'ticket0/unsubscribe-signup': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.signupSubmit));
    const held = signupByUnsubscribeToken(ctx, input.token);
    if (!held) throw substratError('not_found', 'this unsubscribe link is not valid');

    const to = stepSignup(held, 'ticket0/unsubscribe-signup');
    // A second click from a mail archive: the machine allows it, it changes nothing,
    // and it must not become a second event. The person is telling us something we
    // already agree with.
    if (held.state === 'unsubscribed') return signupPublic(held);

    ctx.sql.exec(
      `UPDATE ticket0_signups
          SET state = ?, unsubscribed_at = ?, confirm_token_hash = NULL
        WHERE id = ?`,
      // The confirm hash goes too. Leaving a live confirmation link on a row somebody
      // has just left is a door back in that they did not open — the machine would
      // refuse the transition, but the tidier answer is for the door not to be there.
      [to, ctx.now(), held.id],
    );
    const row = signupOrThrow(ctx, held.id);
    ctx.emit({
      type: 'ticket0.signup-unsubscribed',
      schemaVersion: 1,
      entity: { entityType: 'signup', entityId: row.id },
      piiClass: 'none',
      payload: {
        id: row.id,
        kind: row.kind,
        state: row.state,
        unsubscribed_at: row.unsubscribed_at,
      },
    });
    return signupPublic(row);
  },

  'ticket0/list-signups': async (ctx, input) => {
    assertAllowed(await ctx.check(T0_PERM.signupRead));
    // Only the narrowings actually asked for: an undefined column must not become a
    // `WHERE kind IS NULL` that quietly returns nothing.
    const filters: Record<string, unknown> = {};
    for (const key of ['kind', 'state'] as const) {
      if (input[key] !== undefined) filters[key] = input[key];
    }
    const page = (await ctx.page<SignupRow>('signup', {
      ...input,
      filters,
      total: true,
    })) as CountedPage<SignupRow>;
    // The walk reads whole rows; this is the one place they are handed out, and the
    // two hashes are what must not leave with them.
    return { ...page, entries: page.entries.map(signupPublic) };
  },

  'ticket0/signup-counts': async (ctx) => {
    assertAllowed(await ctx.check(T0_PERM.signupRead));
    const rows = ctx.sql.query<{ kind: string; state: string; n: number }>(
      'SELECT kind, state, COUNT(*) AS n FROM ticket0_signups GROUP BY kind, state',
    );
    return {
      counts: rows.map((row) => ({
        kind: row.kind as 'waitlist' | 'newsletter',
        state: row.state as 'pending' | 'confirmed' | 'unsubscribed',
        count: Number(row.n),
      })),
    };
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
  // #129, and the same reasoning one line up: the DECLARATION is what a reader
  // trusts, so the host has to be handed it rather than the handlers remembering.
  // Without this the `concurrency` on the saved-reply operations is a promise
  // nothing keeps — the header arrives, nothing compares it, and every write lands.
  operationConcurrency: operationConcurrencyOf(ticket0Operations),
  operations: operations as ModuleRegistration['operations'],
};
