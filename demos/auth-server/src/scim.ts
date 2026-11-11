import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JSONWebKeySet, JWTPayload } from 'jose';
import type { SqlExec } from './introspect.js';
import { ensureMachineResource, machineCaller, machineTokenVerifier, type MachineCallerDeps } from './machine-caller.js';
import { looksLikePersonalNumber, normalizePersonalNumber } from './personal-number.js';
import { bankidPlaceholderAddress, isPlaceholderAddress } from './placeholder-address.js';
import { wallClock } from './user-import.js';

/**
 * A SCIM 2.0 server (RFC 7643, RFC 7644) for provisioning people ahead of their first sign-in
 * (#2941). The caller is an IDENTITY MASTER — a portal, or a vertical that manages its own
 * people — which owns each person and pushes them here; the `id` it gets back is the person's
 * `sub`, the one key every relying party already holds.
 *
 * What it adds over an ordinary user create is BankID. A person's personal number arrives in the
 * extension `urn:substrat:params:scim:schemas:extension:bankid:2.0:User` and becomes the `bankid`
 * account row a BankID sign-in looks up (`bankid-plugin.ts`), so the first BankID sign-in lands
 * on this account rather than on a placeholder that has to be merged later. That works with
 * sign-ups closed: the account exists, so nothing consults `ALLOW_SIGNUP` or BankID's
 * "may create accounts". The number is declared `writeOnly` / `returned: never` (RFC 7643 §7)
 * and never appears in a response, an error message or a log line; the response says only that
 * a BankID is `linked`.
 *
 * THE THREE RULES THAT GUARD A PERSON:
 *
 *  - A conflict is reported, never resolved. An address or a personal number another account
 *    holds is a 409 `uniqueness`; nothing is linked, merged or overwritten. This issuer is shared
 *    across a team's apps, so attaching a BankID to someone else's account would hand one
 *    vertical's writer that person in all of them.
 *  - SCIM WRITES only to accounts the same client provisioned (`scim_user.client_id`). Every
 *    other account — one that signed up, one another client provisioned, any administrator — can
 *    be found and read, never changed or deleted: changing an address is the first step of
 *    taking an account over.
 *  - An address set here is stored unverified: the master only claims it.
 *
 * DRY RUN is this server's extension, not SCIM's: `?dryRun=true` on every write and on `/Bulk`
 * runs the request for real inside a transaction that is then rolled back. So the answer is the
 * real run's own — a duplicate on operation 10 and operation 400 of one Bulk seen together, as
 * the real run will see them — and nothing persists. A would-be-created resource carries no `id`,
 * since the real run mints its own.
 *
 * WHO MAY CALL: a machine client's `client_credentials` token for the audience `{issuer}/scim/v2`
 * holding `users:provision`, which must also be in the operator's `MACHINE_SCOPES` ceiling. Both
 * are re-checked on every request (`machine-caller.ts`), as the Management API does.
 *
 * Every place this differs from the RFCs is a row in `SCIM.md`, beside `package.json`.
 */

export const SCIM_SCOPES = ['users:provision'] as const;
type ScimScope = (typeof SCIM_SCOPES)[number];

/** Where the server is mounted, relative to the issuer. */
export const SCIM_PATH = '/scim/v2';

/** The SCIM audience: the server's own base URL. */
export function scimAudience(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}${SCIM_PATH}`;
}

const RESOURCE_MARKER = JSON.stringify({ substrat: { scim: true } });

/** Register the SCIM audience, only while the ceiling holds a SCIM scope (`ensureMachineResource`). */
export function ensureScimResource(sql: SqlExec, issuer: string, machineScopes: readonly string[]): void {
  ensureMachineResource(
    sql,
    { identifier: scimAudience(issuer), name: 'SCIM provisioning', marker: RESOURCE_MARKER, scopes: SCIM_SCOPES },
    machineScopes,
  );
}

export function scimTokenVerifier(jwks: () => Promise<JSONWebKeySet>, issuer: string): (token: string) => Promise<JWTPayload | null> {
  return machineTokenVerifier(jwks, issuer, scimAudience(issuer));
}

export interface ScimDeps extends MachineCallerDeps {
  /** The issuer's public origin, for `meta.location`. */
  issuer: string;
  /** Run `fn` as one transaction: the DO's `transactionSync`, better-sqlite3's `transaction`. */
  transaction: <T>(fn: () => T) => T;
}

/* ---- the protocol's vocabulary ---- */

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const BANKID_SCHEMA = 'urn:substrat:params:scim:schemas:extension:bankid:2.0:User';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const BULK_REQUEST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const BULK_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse';
const SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

const MEDIA_TYPE = 'application/scim+json';
/** The response header that marks a dry run's answer. */
export const DRY_RUN_HEADER = 'Substrat-Dry-Run';

export const BULK_MAX_OPERATIONS = 1000;
export const BULK_MAX_PAYLOAD = 1_048_576;
const MAX_RESULTS = 200;

/** `ban_reason` of a ban SCIM set, which is the only kind `active: true` lifts. */
const SCIM_BAN_REASON = 'Deactivated by SCIM provisioning';

type ScimType =
  | 'invalidFilter'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'invalidValue'
  | 'mutability'
  | 'uniqueness'
  | 'noTarget'
  | 'tooMany';

/** A refusal, in RFC 7644 §3.12's error shape. Its detail never carries a submitted value. */
class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimType,
  ) {
    super(detail);
  }
}

const errorBody = (e: ScimError) => ({
  schemas: [ERROR_SCHEMA],
  status: String(e.status),
  ...(e.scimType ? { scimType: e.scimType } : {}),
  detail: e.detail,
});

function scim(c: Context, body: unknown, status: ContentfulStatusCode = 200, headers: Record<string, string> = {}): Response {
  return c.body(JSON.stringify(body), status, { 'content-type': MEDIA_TYPE, ...headers });
}

/* ---- people, as SCIM sees them ---- */

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  updated_at: number;
  banned: number | null;
  ban_reason: string | null;
  role: string | null;
  user_name: string | null;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  client_id: string | null;
}

const SELECT_USER = `SELECT u.id, u.email, u.name, u.created_at, u.updated_at, u.banned, u.ban_reason, u.role,
  s.user_name, s.external_id, s.given_name, s.family_name, s.client_id
  FROM user u LEFT JOIN scim_user s ON s.user_id = u.id`;

const userById = (sql: SqlExec, id: string): UserRow | undefined =>
  sql.exec(`${SELECT_USER} WHERE u.id = ?`, id).toArray()[0] as unknown as UserRow | undefined;

/**
 * What SCIM names a person by. A provisioned person keeps the `userName` their master gave them;
 * anyone else is named by their address, or, with none (a BankID sign-in that gave none), by
 * their `sub` — never by anything derived from a personal number.
 */
const userNameOf = (row: UserRow): string => row.user_name ?? (isPlaceholderAddress(row.email) ? row.id : row.email);

/** The `sub` of whoever SCIM names `userName`, matched case-insensitively (`caseExact: false`). */
function idByUserName(sql: SqlExec, userName: string): string | undefined {
  const lowered = userName.trim().toLowerCase();
  const provisioned = sql.exec('SELECT user_id FROM scim_user WHERE user_name = ?', lowered).toArray()[0] as { user_id: string } | undefined;
  if (provisioned) return provisioned.user_id;
  const unprovisioned = (sql: SqlExec, where: string, value: string) =>
    sql.exec(`SELECT u.id, u.email FROM user u WHERE ${where} = ? AND NOT EXISTS (SELECT 1 FROM scim_user s WHERE s.user_id = u.id)`, value)
      .toArray() as { id: string; email: string }[];
  const byEmail = unprovisioned(sql, 'u.email', lowered).find((r) => !isPlaceholderAddress(r.email));
  if (byEmail) return byEmail.id;
  return unprovisioned(sql, 'u.id', userName.trim()).find((r) => isPlaceholderAddress(r.email))?.id;
}

const hasBankId = (sql: SqlExec, userId: string): boolean =>
  sql.exec(`SELECT 1 FROM account WHERE user_id = ? AND provider_id = 'bankid'`, userId).toArray().length > 0;

const iso = (ms: number): string => new Date(Number(ms)).toISOString();

/** A person as a SCIM User resource. A BankID placeholder address is never served as an email. */
function toResource(sql: SqlExec, row: UserRow, base: string): Record<string, unknown> {
  const placeholder = isPlaceholderAddress(row.email);
  const bankid = hasBankId(sql, row.id);
  return {
    schemas: bankid ? [USER_SCHEMA, BANKID_SCHEMA] : [USER_SCHEMA],
    id: row.id,
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    userName: userNameOf(row),
    name: {
      formatted: row.name,
      ...(row.given_name !== null ? { givenName: row.given_name } : {}),
      ...(row.family_name !== null ? { familyName: row.family_name } : {}),
    },
    displayName: row.name,
    ...(placeholder ? {} : { emails: [{ value: row.email, type: 'work', primary: true }] }),
    active: !row.banned,
    ...(bankid ? { [BANKID_SCHEMA]: { linked: true } } : {}),
    meta: {
      resourceType: 'User',
      created: iso(row.created_at),
      lastModified: iso(row.updated_at),
      location: `${base}/Users/${encodeURIComponent(row.id)}`,
    },
  };
}

/** A would-be-created resource, as a dry run answers it: the real run mints its own `id`. */
function withoutIdentity(resource: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, meta, ...rest } = resource;
  const { location: _location, ...keptMeta } = meta as Record<string, unknown>;
  return { ...rest, meta: keptMeta };
}

/* ---- the state a write asks for ---- */

/**
 * Everything SCIM may set on a person. A create starts blank and a PATCH starts from the person
 * as they are; both then go through `writeUser`, which judges the whole result at once.
 */
interface Draft {
  userName: string | null;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  email: string | null;
  active: boolean;
  /** A number to attach, as submitted. Never read back from storage. */
  personalNumber?: string;
}

const blankDraft = (): Draft => ({
  userName: null,
  externalId: null,
  givenName: null,
  familyName: null,
  displayName: null,
  email: null,
  active: true,
});

function draftOf(row: UserRow): Draft {
  return {
    userName: userNameOf(row),
    externalId: row.external_id,
    givenName: row.given_name,
    familyName: row.family_name,
    displayName: row.name,
    email: isPlaceholderAddress(row.email) ? null : row.email,
    active: !row.banned,
  };
}

const CORE_PREFIX = `${USER_SCHEMA.toLowerCase()}:`;
const BANKID_KEY = BANKID_SCHEMA.toLowerCase();
const PERSONAL_NUMBER_PATH = `${BANKID_KEY}:personalnumber`;

/** An attribute path, lowercased (RFC 7643 §2.1: attribute names are case-insensitive), with the core schema's URN prefix dropped. */
function normalPath(path: string): string {
  const lowered = path.trim().toLowerCase();
  return lowered.startsWith(CORE_PREFIX) ? lowered.slice(CORE_PREFIX.length) : lowered;
}

function stringOrNull(value: unknown, attribute: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ScimError(400, `${attribute} must be a string`, 'invalidValue');
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** `active`, as a boolean. Entra ID sends `"True"`/`"False"` as strings, and that spelling is accepted too. */
function booleanOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  throw new ScimError(400, 'active must be a boolean', 'invalidValue');
}

/** The one address in an `emails` value. This server holds one address per person. */
function emailOfList(value: unknown): string | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new ScimError(400, 'emails must be an array', 'invalidValue');
  if (value.length === 0) return null;
  const chosen = value.length === 1 ? value[0] : value.filter((e) => (e as { primary?: unknown })?.primary === true);
  const entry = Array.isArray(chosen) ? (chosen.length === 1 ? chosen[0] : undefined) : chosen;
  if (!entry || typeof entry !== 'object') {
    throw new ScimError(400, 'emails may hold one address, or several with exactly one primary', 'invalidValue');
  }
  for (const key of Object.keys(entry)) {
    if (!['value', 'type', 'primary', 'display'].includes(key.toLowerCase())) {
      throw new ScimError(400, `emails.${key} is not an attribute this server stores`, 'invalidValue');
    }
  }
  const raw = Object.entries(entry).find(([k]) => k.toLowerCase() === 'value')?.[1];
  return stringOrNull(raw ?? null, 'emails.value');
}

/** `emails[type eq "work"].value`, `emails[primary eq true].value`: Entra ID's spelling for the address. */
const EMAIL_VALUE_PATH = /^emails\[[^\]]*\]\.value$/;

/** Set one attribute on a draft, from a POST body key or a PATCH path. `op` is how a PATCH reached it. */
function setAttribute(draft: Draft, path: string, value: unknown, op: 'set' | 'remove' = 'set'): void {
  const key = normalPath(path);
  const v = op === 'remove' ? null : value;
  switch (key) {
    case 'schemas':
    case 'id':
    case 'meta':
      // Read-only, and RFC 7643 §3.3 has a server ignore them in a body. A PATCH naming one by
      // path is refused in `applyPatch` before it gets here.
      return;
    case 'username': {
      const userName = stringOrNull(v, 'userName');
      if (userName === null) throw new ScimError(400, 'userName is required', op === 'remove' ? 'mutability' : 'invalidValue');
      draft.userName = userName;
      return;
    }
    case 'externalid':
      draft.externalId = stringOrNull(v, 'externalId');
      return;
    case 'displayname':
      draft.displayName = stringOrNull(v, 'displayName');
      return;
    case 'name.formatted':
      draft.displayName = stringOrNull(v, 'name.formatted');
      return;
    case 'name.givenname':
      draft.givenName = stringOrNull(v, 'name.givenName');
      return;
    case 'name.familyname':
      draft.familyName = stringOrNull(v, 'name.familyName');
      return;
    case 'name': {
      if (v === null) {
        draft.givenName = null;
        draft.familyName = null;
        return;
      }
      if (typeof v !== 'object' || Array.isArray(v)) throw new ScimError(400, 'name must be an object', 'invalidValue');
      for (const [sub, subValue] of Object.entries(v)) {
        if (!['formatted', 'givenname', 'familyname'].includes(sub.toLowerCase())) {
          throw new ScimError(400, `name.${sub} is not an attribute this server stores`, 'invalidValue');
        }
        setAttribute(draft, `name.${sub}`, subValue);
      }
      return;
    }
    case 'emails':
      draft.email = emailOfList(v);
      return;
    case 'active':
      if (op === 'remove') throw new ScimError(400, 'active cannot be removed', 'mutability');
      draft.active = booleanOf(v);
      return;
    case 'password':
      throw new ScimError(400, 'password is not supported: a person sets their own at the issuer', 'invalidValue');
    case BANKID_KEY: {
      if (v === null) throw new ScimError(400, 'a linked BankID cannot be removed over SCIM', 'mutability');
      if (typeof v !== 'object' || Array.isArray(v)) throw new ScimError(400, `${BANKID_SCHEMA} must be an object`, 'invalidValue');
      for (const [sub, subValue] of Object.entries(v)) {
        if (sub.toLowerCase() === 'linked') continue; // read-only
        if (sub.toLowerCase() !== 'personalnumber') {
          throw new ScimError(400, `${BANKID_SCHEMA}:${sub} is not an attribute this server stores`, 'invalidValue');
        }
        setAttribute(draft, `${BANKID_SCHEMA}:personalNumber`, subValue);
      }
      return;
    }
    case PERSONAL_NUMBER_PATH:
      if (v === null) throw new ScimError(400, 'a linked BankID cannot be removed over SCIM', 'mutability');
      if (typeof v !== 'string') throw new ScimError(400, 'personalNumber must be a string', 'invalidValue');
      draft.personalNumber = v;
      return;
    default:
      if (EMAIL_VALUE_PATH.test(key)) {
        draft.email = stringOrNull(v, 'emails.value');
        return;
      }
      throw new ScimError(400, `${path} is not an attribute this server stores`, op === 'remove' ? 'invalidPath' : 'invalidValue');
  }
}

/** A POST body as a draft. The core schema is required, and an extension's attributes need its URN in `schemas`. */
function draftFromResource(body: unknown): Draft {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScimError(400, 'the body must be a JSON object', 'invalidSyntax');
  const record = body as Record<string, unknown>;
  const schemas = Array.isArray(record.schemas) ? record.schemas.filter((s): s is string => typeof s === 'string') : [];
  if (!schemas.includes(USER_SCHEMA)) throw new ScimError(400, `schemas must include ${USER_SCHEMA}`, 'invalidSyntax');
  const draft = blankDraft();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === BANKID_KEY && !schemas.includes(BANKID_SCHEMA)) {
      throw new ScimError(400, `schemas must include ${BANKID_SCHEMA} when its attributes are sent`, 'invalidSyntax');
    }
    setAttribute(draft, key, value);
  }
  return draft;
}

/** A PatchOp (RFC 7644 §3.5.2) applied to a draft. */
function applyPatch(draft: Draft, body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScimError(400, 'the body must be a JSON object', 'invalidSyntax');
  const record = body as { schemas?: unknown; Operations?: unknown };
  if (!Array.isArray(record.schemas) || !record.schemas.includes(PATCH_SCHEMA)) {
    throw new ScimError(400, `schemas must include ${PATCH_SCHEMA}`, 'invalidSyntax');
  }
  if (!Array.isArray(record.Operations) || record.Operations.length === 0) {
    throw new ScimError(400, 'Operations must be a non-empty array', 'invalidSyntax');
  }
  for (const operation of record.Operations as unknown[]) {
    const { op, path, value } = (operation ?? {}) as { op?: unknown; path?: unknown; value?: unknown };
    const verb = typeof op === 'string' ? op.toLowerCase() : '';
    if (!['add', 'replace', 'remove'].includes(verb)) throw new ScimError(400, 'op must be add, replace or remove', 'invalidSyntax');
    if (path !== undefined && typeof path !== 'string') throw new ScimError(400, 'path must be a string', 'invalidPath');
    if (path !== undefined && ['id', 'meta', 'schemas'].includes(normalPath(path))) {
      throw new ScimError(400, `${path} is read-only`, 'mutability');
    }
    if (verb === 'remove') {
      if (path === undefined) throw new ScimError(400, 'remove needs a path', 'noTarget');
      setAttribute(draft, path, undefined, 'remove');
      continue;
    }
    if (path !== undefined) {
      setAttribute(draft, path, value);
      continue;
    }
    // No path: the value is a partial resource, each of its attributes set in turn.
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ScimError(400, 'an operation without a path needs an object value', 'invalidValue');
    }
    for (const [key, attributeValue] of Object.entries(value)) setAttribute(draft, key, attributeValue);
  }
}

/* ---- the one write path ---- */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const localPart = (email: string): string => email.slice(0, email.indexOf('@'));

/**
 * Judge `draft` as a whole and, only if all of it holds, write it: a create when `existing` is
 * undefined, an update otherwise. Every check comes before the first write, so a refusal leaves
 * nothing behind — which is also what lets a dry run walk a whole Bulk inside one transaction.
 * Returns the person's `sub`.
 */
function writeUser(sql: SqlExec, draft: Draft, existing: UserRow | undefined, clientId: string, now: number): string {
  const self = existing?.id;

  const userName = draft.userName;
  if (userName === null) throw new ScimError(400, 'userName is required', 'invalidValue');
  if (userName.length > 255) throw new ScimError(400, 'userName is longer than 255 characters', 'invalidValue');
  if (looksLikePersonalNumber(userName)) {
    throw new ScimError(400, 'userName must not be a personal number: use the master’s own id for the person', 'invalidValue');
  }
  const named = idByUserName(sql, userName);
  if (named !== undefined && named !== self) throw new ScimError(409, 'userName is already in use', 'uniqueness');

  const email = draft.email?.toLowerCase() ?? null;
  if (email !== null) {
    if (email.length > 320 || !EMAIL_SHAPE.test(email) || isPlaceholderAddress(email)) {
      throw new ScimError(400, 'emails.value is not an email address', 'invalidValue');
    }
    const holder = sql.exec('SELECT id FROM user WHERE email = ?', email).toArray()[0] as { id: string } | undefined;
    if (holder && holder.id !== self) throw new ScimError(409, 'That email address belongs to another account', 'uniqueness');
  }

  let personalNumber: string | undefined;
  if (draft.personalNumber !== undefined) {
    const normal = normalizePersonalNumber(draft.personalNumber);
    if ('refused' in normal) throw new ScimError(400, normal.refused, 'invalidValue');
    const linked = sql
      .exec(`SELECT user_id FROM account WHERE provider_id = 'bankid' AND account_id = ?`, normal.value)
      .toArray()[0] as { user_id: string } | undefined;
    if (linked && linked.user_id !== self) throw new ScimError(409, 'That personal number belongs to another account', 'uniqueness');
    if (!linked) {
      if (self && hasBankId(sql, self)) {
        throw new ScimError(400, 'This account already has a BankID; only an administrator can change it', 'mutability');
      }
      personalNumber = normal.value;
    }
  }
  const bankid = personalNumber !== undefined || (self !== undefined && hasBankId(sql, self));
  if (email === null && !bankid) {
    throw new ScimError(400, 'A person needs an email address or a personal number to sign in with', 'invalidValue');
  }

  const wasActive = existing ? !existing.banned : true;
  if (existing && !wasActive && draft.active && existing.ban_reason !== SCIM_BAN_REASON) {
    throw new ScimError(400, 'An administrator blocked this account; only an administrator can unblock it', 'mutability');
  }

  const name =
    draft.displayName ??
    ([draft.givenName, draft.familyName].filter((p): p is string => p !== null).join(' ') ||
      (email !== null ? localPart(email) : userName));

  /* every check has passed; from here on, only writes */
  let id: string;
  if (!existing) {
    id = crypto.randomUUID();
    sql.exec(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 0, ?, ?, 'user')`,
      id,
      name,
      email ?? bankidPlaceholderAddress(),
      now,
      now,
    );
    sql.exec(
      'INSERT INTO scim_user (user_id, user_name, external_id, given_name, family_name, client_id) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      userName.toLowerCase(),
      draft.externalId,
      draft.givenName,
      draft.familyName,
      clientId,
    );
  } else {
    id = existing.id;
    const currentEmail = isPlaceholderAddress(existing.email) ? null : existing.email;
    if (email !== currentEmail) {
      // A new address is a claim, so it is unverified; dropping the address gives the account a
      // placeholder, which only a BankID can sign in to (checked above).
      sql.exec('UPDATE user SET email = ?, email_verified = 0 WHERE id = ?', email ?? bankidPlaceholderAddress(), id);
    }
    sql.exec('UPDATE user SET name = ?, updated_at = ? WHERE id = ?', name, now, id);
    sql.exec(
      'UPDATE scim_user SET user_name = ?, external_id = ?, given_name = ?, family_name = ? WHERE user_id = ?',
      userName.toLowerCase(),
      draft.externalId,
      draft.givenName,
      draft.familyName,
      id,
    );
  }
  if (personalNumber !== undefined) {
    // The row a BankID sign-in looks the person up by (`bankid-plugin.ts`).
    sql.exec(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'bankid', ?, ?, ?)`,
      crypto.randomUUID(),
      personalNumber,
      id,
      now,
      now,
    );
  }
  if (wasActive && !draft.active) {
    sql.exec('UPDATE user SET banned = 1, ban_reason = ?, ban_expires = NULL WHERE id = ?', SCIM_BAN_REASON, id);
    endSignIns(sql, id);
  } else if (!wasActive && draft.active) {
    sql.exec('UPDATE user SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?', id);
  }
  return id;
}

/**
 * End everything a person is signed in with: sessions, and the stored access and refresh tokens
 * the OAuth plugin issued. A JWT access token is not stored, so one already issued lives out its
 * hour; nothing new can be minted for a banned account.
 */
function endSignIns(sql: SqlExec, userId: string): void {
  // An access token references its refresh token, so it goes first.
  for (const table of ['oauth_access_token', 'oauth_refresh_token', 'session']) {
    sql.exec(`DELETE FROM ${table} WHERE user_id = ?`, userId);
  }
}

/**
 * The account a write may change, or why not. SCIM writes only to whom the same client
 * provisioned, and never to an administrator — see the header.
 */
function writable(sql: SqlExec, id: string, clientId: string): UserRow {
  const row = userById(sql, id);
  if (!row) throw new ScimError(404, `User ${id} not found`);
  if (row.client_id !== clientId) {
    throw new ScimError(403, 'This account was not provisioned by this client, so SCIM cannot change it');
  }
  if (row.role === 'admin') throw new ScimError(403, 'An administrator cannot be changed over SCIM');
  return row;
}

function deleteUser(sql: SqlExec, row: UserRow): void {
  endSignIns(sql, row.id);
  // The OAuth tables do not cascade from `user` (`account-merge.ts` deletes the same way).
  sql.exec('DELETE FROM oauth_consent WHERE user_id = ?', row.id);
  sql.exec('UPDATE oauth_client SET user_id = NULL WHERE user_id = ?', row.id);
  sql.exec('DELETE FROM user WHERE id = ?', row.id);
}

/* ---- operations, shared by the single routes and Bulk ---- */

type Inner = <T>(fn: () => T) => T;

interface OpResult {
  status: 200 | 201 | 204;
  resource?: Record<string, unknown>;
  id?: string;
}

interface OpContext {
  sql: SqlExec;
  clientId: string;
  base: string;
  now: number;
  /** Per-operation atomicity: the real transaction, or a pass-through inside a dry run's. */
  inner: Inner;
}

function createOp(ctx: OpContext, body: unknown): OpResult {
  const draft = draftFromResource(body);
  return ctx.inner(() => {
    const id = writeUser(ctx.sql, draft, undefined, ctx.clientId, ctx.now);
    return { status: 201, id, resource: toResource(ctx.sql, userById(ctx.sql, id)!, ctx.base) };
  });
}

function patchOp(ctx: OpContext, id: string, body: unknown): OpResult {
  return ctx.inner(() => {
    const row = writable(ctx.sql, id, ctx.clientId);
    const draft = draftOf(row);
    applyPatch(draft, body);
    writeUser(ctx.sql, draft, row, ctx.clientId, ctx.now);
    return { status: 200, id, resource: toResource(ctx.sql, userById(ctx.sql, id)!, ctx.base) };
  });
}

function deleteOp(ctx: OpContext, id: string): OpResult {
  return ctx.inner(() => {
    deleteUser(ctx.sql, writable(ctx.sql, id, ctx.clientId));
    return { status: 204, id };
  });
}

const ROLLBACK = Symbol('dry run');

/**
 * Run `fn` for real, or — on a dry run — inside one transaction that is rolled back once `fn` has
 * answered, so the answer is the real run's and nothing persists.
 */
function runMaybeDry<T>(transaction: ScimDeps['transaction'], dryRun: boolean, fn: (inner: Inner) => T): T {
  if (!dryRun) return fn(transaction);
  let answer: { value: T } | undefined;
  try {
    transaction(() => {
      answer = { value: fn((f) => f()) };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return answer!.value;
}

/* ---- filters ---- */

/**
 * The filters a provisioning client needs to look a person up before it creates them: one `eq`
 * on `userName`, `emails.value`, `externalId` or `id`. Anything else is `invalidFilter`, never a
 * filter half-applied.
 */
const FILTER = /^\s*([A-Za-z][\w.:]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

function filterIds(sql: SqlExec, filter: string): string[] {
  const match = FILTER.exec(filter);
  if (!match) throw new ScimError(400, 'Only one eq comparison on userName, emails.value, externalId or id is supported', 'invalidFilter');
  const value = match[2]!.replace(/\\(.)/g, '$1');
  switch (normalPath(match[1]!)) {
    case 'username': {
      const id = idByUserName(sql, value);
      return id ? [id] : [];
    }
    case 'emails.value':
    case 'emails': {
      if (isPlaceholderAddress(value)) return [];
      return (sql.exec('SELECT id FROM user WHERE email = ?', value.trim().toLowerCase()).toArray() as { id: string }[]).map((r) => r.id);
    }
    case 'externalid':
      return (sql.exec('SELECT user_id FROM scim_user WHERE external_id = ? ORDER BY user_id', value).toArray() as { user_id: string }[]).map(
        (r) => r.user_id,
      );
    case 'id':
      return userById(sql, value) ? [value] : [];
    default:
      throw new ScimError(400, 'Only one eq comparison on userName, emails.value, externalId or id is supported', 'invalidFilter');
  }
}

/** `attributes` / `excludedAttributes` (RFC 7644 §3.4.2.5), on top-level attributes. `id` and `schemas` are always returned. */
function projectionOf(c: Context): ((r: Record<string, unknown>) => Record<string, unknown>) | undefined {
  const parse = (v: string | undefined) => (v ? new Set(v.split(',').map((a) => normalPath(a).split('.')[0]!).filter(Boolean)) : undefined);
  const only = parse(c.req.query('attributes'));
  const excluded = parse(c.req.query('excludedAttributes'));
  if (!only && !excluded) return undefined;
  const always = new Set(['id', 'schemas']);
  return (r) =>
    Object.fromEntries(
      Object.entries(r).filter(([key]) => {
        const k = key.toLowerCase();
        if (always.has(k)) return true;
        if (only) return only.has(k);
        return !excluded!.has(k);
      }),
    );
}

/* ---- discovery ---- */

const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

const USER_SCHEMA_DOC = {
  id: USER_SCHEMA,
  name: 'User',
  description: 'A person who signs in at this issuer. Only the attributes this server stores are listed.',
  attributes: [
    attribute('userName', 'string', { required: true, uniqueness: 'server', description: 'The master’s name for the person. Never a personal number.' }),
    attribute('name', 'complex', {
      subAttributes: [attribute('formatted', 'string'), attribute('givenName', 'string'), attribute('familyName', 'string')],
    }),
    attribute('displayName', 'string'),
    attribute('emails', 'complex', {
      multiValued: true,
      description: 'At most one address. An address set over SCIM is stored unverified.',
      subAttributes: [
        attribute('value', 'string', { uniqueness: 'server' }),
        attribute('type', 'string', { canonicalValues: ['work'] }),
        attribute('primary', 'boolean'),
      ],
    }),
    attribute('active', 'boolean', { description: 'false blocks the account and ends its sessions and stored tokens.' }),
  ],
};

const BANKID_SCHEMA_DOC = {
  id: BANKID_SCHEMA,
  name: 'BankID',
  description: 'A Swedish BankID to attach to the account, so the person’s first BankID sign-in lands on it.',
  attributes: [
    attribute('personalNumber', 'string', {
      caseExact: true,
      mutability: 'writeOnly',
      returned: 'never',
      uniqueness: 'server',
      description: 'Twelve digits, YYYYMMDDNNNN, with a valid check digit. Never returned or logged.',
    }),
    attribute('linked', 'boolean', { mutability: 'readOnly', description: 'True when a BankID is attached.' }),
  ],
};

/* ---- the app ---- */

type Env = { Variables: { scopes: readonly string[]; clientId: string } };

function requireScope(c: Context<Env>, scope: ScimScope): void {
  if (!c.get('scopes').includes(scope)) throw new ScimError(403, `Insufficient scope, expected ${scope}`);
}

/** Hold a request's query to the parameters this route takes: an unknown one is refused, never ignored. */
function refuseQuery(c: Context, accepted: readonly string[]): void {
  for (const key of new URL(c.req.url).searchParams.keys()) {
    if (!accepted.includes(key)) throw new ScimError(400, `Unsupported query parameter: ${key}`, 'invalidSyntax');
  }
}

function dryRunOf(c: Context): boolean {
  const value = c.req.query('dryRun');
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new ScimError(400, 'dryRun must be true or false', 'invalidValue');
}

async function bodyOf(c: Context): Promise<unknown> {
  const type = c.req.header('content-type')?.toLowerCase() ?? '';
  if (!type.startsWith(MEDIA_TYPE) && !type.startsWith('application/json')) {
    throw new ScimError(400, `The body must be ${MEDIA_TYPE} or application/json`, 'invalidSyntax');
  }
  const text = await c.req.text();
  if (text.length > BULK_MAX_PAYLOAD) throw new ScimError(413, `The body is larger than ${BULK_MAX_PAYLOAD} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScimError(400, 'The body is not JSON', 'invalidSyntax');
  }
}

/** The SCIM app. Mount it at `/scim/v2`. */
export function createScimApi(deps: ScimDeps): Hono<Env> {
  const api = new Hono<Env>();
  const base = scimAudience(deps.issuer);

  api.onError((err, c) => {
    if (err instanceof ScimError) {
      const headers: Record<string, string> = err.status === 401 ? { 'www-authenticate': 'Bearer' } : {};
      return scim(c, errorBody(err), err.status as ContentfulStatusCode, headers);
    }
    // The message only: a request body, which may hold a personal number, is never logged.
    console.error('scim: unexpected error', err instanceof Error ? err.message : 'unknown');
    return scim(c, errorBody(new ScimError(500, 'Internal Server Error')), 500);
  });

  api.use('*', async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match?.[1]) throw new ScimError(401, 'Missing authentication');
    const caller = await machineCaller(deps, match[1]);
    if ('refused' in caller) throw new ScimError(401, caller.refused);
    c.set('scopes', caller.scopes);
    c.set('clientId', caller.clientId);
    requireScope(c, 'users:provision');
    await next();
  });

  const opContext = (c: Context<Env>, inner: Inner): OpContext => ({ sql: deps.sql, clientId: c.get('clientId'), base, now: wallClock(), inner });

  /** Answer one write, as the real run would, marking a dry run's answer. */
  const answer = (c: Context, result: OpResult, dryRun: boolean): Response => {
    const headers: Record<string, string> = dryRun ? { [DRY_RUN_HEADER]: 'true' } : {};
    if (result.status === 204) return c.body(null, 204, headers);
    const resource = dryRun && result.status === 201 ? withoutIdentity(result.resource!) : result.resource!;
    if (result.status === 201 && !dryRun) headers.location = (result.resource!.meta as { location: string }).location;
    return scim(c, resource, result.status, headers);
  };

  api.get('/ServiceProviderConfig', (c) => {
    refuseQuery(c, []);
    return scim(c, {
      schemas: [SPC_SCHEMA],
      documentationUri: 'https://github.com/substrat-run/substrat/blob/main/demos/auth-server/SCIM.md',
      patch: { supported: true },
      bulk: { supported: true, maxOperations: BULK_MAX_OPERATIONS, maxPayloadSize: BULK_MAX_PAYLOAD },
      filter: { supported: true, maxResults: MAX_RESULTS },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: `A client_credentials access token for the audience ${base}, holding users:provision`,
          specUri: 'https://www.rfc-editor.org/info/rfc6750',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
    });
  });

  const userType = {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'A person who signs in at this issuer',
    schema: USER_SCHEMA,
    schemaExtensions: [{ schema: BANKID_SCHEMA, required: false }],
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
  };
  const list = (resources: unknown[]) => ({
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
  api.get('/ResourceTypes', (c) => (refuseQuery(c, []), scim(c, list([userType]))));
  api.get('/ResourceTypes/:id', (c) => {
    if (c.req.param('id') !== 'User') throw new ScimError(404, 'Resource type not found');
    return scim(c, userType);
  });
  const schemaDocs = [USER_SCHEMA_DOC, BANKID_SCHEMA_DOC].map((s) => ({
    schemas: [SCHEMA_SCHEMA],
    ...s,
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${s.id}` },
  }));
  api.get('/Schemas', (c) => (refuseQuery(c, []), scim(c, list(schemaDocs))));
  api.get('/Schemas/:id', (c) => {
    const doc = schemaDocs.find((s) => s.id === c.req.param('id'));
    if (!doc) throw new ScimError(404, 'Schema not found');
    return scim(c, doc);
  });

  api.get('/Users', (c) => {
    refuseQuery(c, ['filter', 'startIndex', 'count', 'attributes', 'excludedAttributes']);
    const startIndex = Math.max(1, Number.parseInt(c.req.query('startIndex') ?? '1', 10) || 1);
    const count = Math.min(MAX_RESULTS, Math.max(0, Number.parseInt(c.req.query('count') ?? String(MAX_RESULTS), 10) || 0));
    const filter = c.req.query('filter');
    let total: number;
    let ids: string[];
    if (filter !== undefined) {
      const all = filterIds(deps.sql, filter);
      total = all.length;
      ids = all.slice(startIndex - 1, startIndex - 1 + count);
    } else {
      total = (deps.sql.exec('SELECT count(*) AS n FROM user').toArray()[0] as { n: number }).n;
      ids = (
        deps.sql.exec('SELECT id FROM user ORDER BY created_at, id LIMIT ? OFFSET ?', count, startIndex - 1).toArray() as { id: string }[]
      ).map((r) => r.id);
    }
    const project = projectionOf(c) ?? ((r) => r);
    const resources = ids.map((id) => project(toResource(deps.sql, userById(deps.sql, id)!, base)));
    return scim(c, { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });
  });

  api.get('/Users/:id', (c) => {
    refuseQuery(c, ['attributes', 'excludedAttributes']);
    const row = userById(deps.sql, c.req.param('id'));
    if (!row) throw new ScimError(404, `User ${c.req.param('id')} not found`);
    const project = projectionOf(c) ?? ((r) => r);
    return scim(c, project(toResource(deps.sql, row, base)));
  });

  api.post('/Users', async (c) => {
    refuseQuery(c, ['dryRun']);
    const dryRun = dryRunOf(c);
    const body = await bodyOf(c);
    return answer(c, runMaybeDry(deps.transaction, dryRun, (inner) => createOp(opContext(c, inner), body)), dryRun);
  });

  api.patch('/Users/:id', async (c) => {
    refuseQuery(c, ['dryRun']);
    const dryRun = dryRunOf(c);
    const body = await bodyOf(c);
    return answer(c, runMaybeDry(deps.transaction, dryRun, (inner) => patchOp(opContext(c, inner), c.req.param('id'), body)), dryRun);
  });

  api.delete('/Users/:id', (c) => {
    refuseQuery(c, ['dryRun']);
    const dryRun = dryRunOf(c);
    return answer(c, runMaybeDry(deps.transaction, dryRun, (inner) => deleteOp(opContext(c, inner), c.req.param('id'))), dryRun);
  });

  api.post('/Bulk', async (c) => {
    refuseQuery(c, ['dryRun']);
    const dryRun = dryRunOf(c);
    const body = (await bodyOf(c)) as { schemas?: unknown; Operations?: unknown; failOnErrors?: unknown } | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body.schemas) || !body.schemas.includes(BULK_REQUEST_SCHEMA)) {
      throw new ScimError(400, `schemas must include ${BULK_REQUEST_SCHEMA}`, 'invalidSyntax');
    }
    if (!Array.isArray(body.Operations) || body.Operations.length === 0) {
      throw new ScimError(400, 'Operations must be a non-empty array', 'invalidSyntax');
    }
    if (body.Operations.length > BULK_MAX_OPERATIONS) {
      throw new ScimError(413, `A Bulk request may hold at most ${BULK_MAX_OPERATIONS} operations`);
    }
    const failOnErrors = body.failOnErrors;
    if (failOnErrors !== undefined && (typeof failOnErrors !== 'number' || !Number.isInteger(failOnErrors) || failOnErrors < 1)) {
      throw new ScimError(400, 'failOnErrors must be a positive integer', 'invalidValue');
    }
    const operations = body.Operations as unknown[];
    const results = runMaybeDry(deps.transaction, dryRun, (inner) => {
      const ctx = opContext(c, inner);
      const created = new Map<string, string>();
      const out: Record<string, unknown>[] = [];
      let errors = 0;
      for (const raw of operations) {
        const op = (raw ?? {}) as { method?: unknown; bulkId?: unknown; path?: unknown; data?: unknown };
        const method = typeof op.method === 'string' ? op.method.toUpperCase() : '';
        const bulkId = typeof op.bulkId === 'string' ? op.bulkId : undefined;
        const entry: Record<string, unknown> = { method, ...(bulkId !== undefined ? { bulkId } : {}) };
        try {
          const result = bulkOperation(ctx, method, op.path, op.data, bulkId, created);
          if (result.status === 201 && bulkId !== undefined) created.set(bulkId, result.id!);
          const location = result.id ? `${base}/Users/${encodeURIComponent(result.id)}` : undefined;
          if (!(dryRun && result.status === 201) && location && result.status !== 204) entry.location = location;
          entry.status = String(result.status);
          if (result.resource) entry.response = dryRun && result.status === 201 ? withoutIdentity(result.resource) : result.resource;
        } catch (e) {
          if (!(e instanceof ScimError)) throw e;
          entry.status = String(e.status);
          entry.response = errorBody(e);
          errors += 1;
        }
        out.push(entry);
        if (failOnErrors !== undefined && errors >= failOnErrors) break;
      }
      return out;
    });
    return scim(c, { schemas: [BULK_RESPONSE_SCHEMA], Operations: results }, 200, dryRun ? { [DRY_RUN_HEADER]: 'true' } : {});
  });

  // Everything else — `PUT`, `/Groups`, `/Me`, `/.search` — is not served, and says so.
  api.all('*', (c) => {
    throw new ScimError(501, `${c.req.method} ${new URL(c.req.url).pathname} is not supported by this SCIM server`);
  });

  return api;
}

/** One Bulk operation (RFC 7644 §3.7). A path may name a user created earlier in the same request as `bulkId:<id>`. */
function bulkOperation(
  ctx: OpContext,
  method: string,
  path: unknown,
  data: unknown,
  bulkId: string | undefined,
  created: Map<string, string>,
): OpResult {
  if (typeof path !== 'string') throw new ScimError(400, 'path must be a string', 'invalidPath');
  if (method === 'POST') {
    if (path !== '/Users') throw new ScimError(400, 'POST is supported on /Users only', 'invalidPath');
    if (bulkId === undefined) throw new ScimError(400, 'A POST operation needs a bulkId', 'invalidSyntax');
    return createOp(ctx, data);
  }
  const match = /^\/Users\/([^/]+)$/.exec(path);
  if (!match) throw new ScimError(400, `${method} is supported on /Users/{id} only`, 'invalidPath');
  let id = decodeURIComponent(match[1]!);
  if (id.startsWith('bulkId:')) {
    const resolved = created.get(id.slice('bulkId:'.length));
    if (!resolved) throw new ScimError(409, `${id} names no user created earlier in this request`, 'invalidValue');
    id = resolved;
  }
  if (method === 'PATCH') return patchOp(ctx, id, data);
  if (method === 'DELETE') return deleteOp(ctx, id);
  throw new ScimError(501, `${method} is not supported in a Bulk request`);
}

/** The whole surface, mounted at `/scim/v2`. */
export function scimApp(deps: ScimDeps): Hono {
  return new Hono().route(SCIM_PATH, createScimApi(deps));
}
