/**
 * How a second person reaches this desk — the ONE implementation both hosts mount.
 *
 * A hosted install starts with exactly one human: whoever claimed the owner seat.
 * Everybody else arrives through here. The durable half already lives in one place
 * (`vertical-auth`'s identity DO holds the pending `invite` rows and binds a verified
 * subject to the principal one names); what lived in two places, and now lives here,
 * is the flow around it — mint a principal, grant it a role, hand back a one-time
 * link, and on acceptance put the new colleague in the directory.
 *
 * It is under `harness/` for the reason everything here is: it reads request headers,
 * mints tokens and writes roles through the host's admin surface. None of that is
 * available to module code, and none of it belongs in an operation.
 *
 * ── Why the dev server could not simply skip it ──────────────────────────────
 * It did, and the cost was that the whole flow existed only in a deployment nobody
 * runs locally: no way to demo it, no way to test it, and a hosted-only bug fixed by
 * pushing. Manyfold's dev server answered the same problem with a SECOND
 * implementation over its own sqlite table, which is how a dev login stops resembling
 * the login a customer runs. So this file takes the two things that genuinely differ
 * as arguments — where a pending invite is written, and how a subject is bound to a
 * principal — and keeps every decision that does not.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  z,
  type BoundedBecomeMint,
  type BoundedBecomeRevoke,
  type CapabilityExchange,
  type CapabilityId,
  type Coverage,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
} from '@substrat-run/contracts';
/**
 * The invite itself is vertical-auth's (#1686): `mintMemberInvite` grants the role under the
 * assignment bound, mints the link as a `become` capability in the desk's own scope and records
 * it; `acceptMemberInvite` redeems a link (or, LEGACY, a hash-only invite minted before this);
 * `withdrawMemberInvite` revokes the link before the row. The `/invite-routes` subpath and not
 * the root: the root exports `IdentityDO`, which imports `cloudflare:workers`, and the node dev
 * server mounts this file too.
 */
import {
  acceptMemberInvite,
  legacyInviteListReporter,
  mintMemberInvite,
  uncovered,
  withdrawMemberInvite,
} from '@substrat-run/vertical-auth/invite-routes';

/** A pending invite, as an admin sees it. Never the token — only its hash is kept. */
export interface PendingInvite {
  readonly principal: string;
  readonly roleKey: string;
  readonly email: string | null;
  readonly created_at: string;
}

/** Who an accepted invite made the caller, and at which role — read while the row still says. */
export interface ClaimedInvite {
  readonly principal: string;
  readonly roleKey: string;
}

/**
 * Where pending invites live, and how a login becomes the principal one names.
 *
 * The worker's is the tenant's identity DO; the dev server's is a file beside the
 * seeded cast. Both bind the subject through the same kernel identity directory in the
 * end — the DO because it IS one, the dev server through `host.admin.linkIdentity` —
 * so an accepted invite produces the same fact in either host.
 */
export interface InviteStore {
  list(): Promise<PendingInvite[]>;
  /** Record an invite: its link's hash, and which capability the link is (#1686). */
  create(invite: {
    principal: string;
    roleKey: string;
    email: string | null;
    tokenHash: string;
    capabilityId: string;
  }): Promise<void>;
  /** The capability an open invite's link is, or null for a legacy hash-only one. */
  linkOf(principal: string): Promise<string | null>;
  revoke(principal: string): Promise<void>;
  /** Is this hash an open invite's link — asked BEFORE the scope spends the link's use. */
  matches(tokenHash: string): Promise<boolean>;
  /**
   * Bind this verified subject to the invite the exchanged capability is, consuming it — only
   * while the row still names that capability and principal. Null otherwise.
   *
   * It returns the ROLE as well as the principal, and that is not a convenience. The
   * role decides whether the new arrival belongs in the staff directory, and it is
   * gone the moment the invite is consumed — so the only place that can still answer
   * is the store, while it still has the row.
   */
  claimByCapability(sub: string, capabilityId: string, principal: string): Promise<ClaimedInvite | null>;
  /** Pending legacy hash-only invites (#2175), when the store can count them — a number, nothing identifying. */
  legacyCount?(): Promise<number>;
  /** LEGACY: bind by the hash of a token minted before #1686. Null when no open invite matches. */
  claim(sub: string, tokenHash: string): Promise<ClaimedInvite | null>;
}

/**
 * The desk one request addresses: its invite store, and the host's bounded verbs an invite
 * runs. Each is the host's own: the check and the write in one scope task, a refusal writing
 * nothing.
 */
export interface InviteDesk {
  readonly store: InviteStore;
  /** The desk's scope id, for the #2175 measurement line. Public in that context; absent on a dev desk. */
  readonly scopeId?: string;
  /** Grant a freshly minted principal a scope-wide role, bounded by what `caller` holds. */
  readonly grantRole: (caller: PrincipalId, principal: PrincipalId, roleKey: string) => Promise<Coverage>;
  /** Take a role back — the undo of a grant whose invite could not be recorded. */
  readonly revokeRole: (principal: PrincipalId, roleKey: string) => Promise<unknown>;
  /**
   * Mint an invite's link: a `become` capability, bounded by what `caller` holds — and, for a
   * customer, carrying the bind onto their contact (#1686), bounded by `contact:invite` there.
   */
  readonly mintLink: (caller: PrincipalId, input: PrincipalBecomeCapabilityInput) => Promise<BoundedBecomeMint>;
  /** Revoke an invite's link, recording `caller`. */
  readonly revokeLink: (caller: PrincipalId, capabilityId: CapabilityId) => Promise<BoundedBecomeRevoke>;
  /** Exchange a link in the desk's scope — `become` only; a customer's binds them there. */
  readonly exchange: (secret: string) => Promise<CapabilityExchange | null>;
  /** Invoke an operation AS a principal — how an accepted invitee gets their profile row. */
  readonly invokeAs: (principal: string, operation: string, input: unknown) => Promise<unknown>;
}

/** The verified caller, as the host's auth provider reports them. */
export interface InviteSubject {
  readonly sub: string;
  readonly name?: string | null;
  readonly email?: string | null;
}

export interface InviteSurfaceOptions {
  /**
   * The roles a PERSON may be invited at, in the order the picker offers them.
   *
   * Listing the humans is the check. A desk's role table also holds three service
   * accounts held by nobody, and offering `widget` in an invite dropdown would be
   * offering to hand somebody the desk's own chat service.
   */
  readonly humanRoles: readonly string[];
  /**
   * Which of those roles WORK the desk — the ones whose holder belongs in the staff
   * directory. A `customer` is invited at a human role and is not staff: the portal is
   * not the inbox, and a customer offered in an assignee picker would be a bug.
   */
  readonly staffRoles: readonly string[];
  /** A role that names a contact to open the portal on, and the input field it reads. */
  readonly contactBoundRole?: string;
  /** Which desk this request is for, and how to write to it. */
  readonly deskOf: (c: Context) => Promise<InviteDesk>;
  /**
   * Assert the caller may manage this desk's people, and say who they are. Throws (401/403)
   * if not — the check itself is the host's, because only it knows how a caller is
   * authenticated. The principal it returns is who every bound is then asked about.
   */
  readonly requireAdmin: (c: Context) => Promise<{ principal: PrincipalId }>;
  /** The verified caller, or null. Used only by accept, which has no admin to check. */
  readonly subjectOf: (c: Context) => Promise<InviteSubject | null>;
  /**
   * Where the accept link points. The API origin in the worker (it serves the app
   * too); the Vite origin on the dev server, which does not.
   */
  readonly appOrigin: (c: Context) => string;
  /** The wall clock, for `created_at` on a store that does not stamp its own. */
  readonly now?: () => string;
}

const inviteBody = z.object({
  email: z.string().email().optional(),
  roleKey: z.string().min(1),
  /** For a contact-bound role: whose conversations this person may see. */
  contactId: z.string().min(1).optional(),
});

const acceptBody = z.object({ token: z.string().min(1) });

/**
 * Put somebody in the staff directory, as themselves, the first time they arrive.
 *
 * `ticket0_agent_profiles` IS the directory — a deliberate reading of "staff of this
 * desk", because nothing in a scope lets module code ask who else holds
 * `conversation:read`. The rule it gives a person is "set your profile and appear",
 * and until #1149 a hosted desk offered nobody any way to do that: the directory was
 * empty, the assignee picker offered nobody, and every screen showing an owner showed
 * the tail of a ULID. So joining writes the row, from the name the issuer already
 * knows. It is a starting point and not a decision — Settings → Your profile edits it,
 * calling the same operation this does.
 *
 * Exported because the OWNER arrives by a different door (`/api/claim-owner`) and
 * needs the identical row; a desk whose only human is missing from its own directory
 * is the case that made this visible.
 *
 * Deliberately best-effort. By the time this runs the seat or the invite is already
 * claimed and the role already granted, so a failure here must not turn a successful
 * join into an error inviting them to retry a token that is now spent. They land
 * without a display name and fix it in Settings.
 */
export async function recordStaffProfile(
  invokeAs: (principal: string, operation: string, input: unknown) => Promise<unknown>,
  principal: string,
  subject: InviteSubject,
): Promise<void> {
  const displayName = subject.name?.trim() || subject.email?.trim() || principal.slice(-8);
  try {
    await invokeAs(principal, 'ticket0/set-agent-profile', {
      displayName,
      avatarUrl: null,
      signature: null,
    });
  } catch {
    /* they are in; the name is editable in Settings */
  }
}

/** A customer invite the kernel refused for its contact (#1686), as the admin is told. */
function bindRefused(refused: Extract<BoundedBecomeMint, { refused: string }>['refused']): HTTPException {
  if (refused === 'bind-record-missing') return new HTTPException(404, { message: 'no such contact on this desk' });
  if (refused === 'bind-record-bound') {
    return new HTTPException(409, { message: 'this contact already has a portal login — unbind it before inviting someone else' });
  }
  if (refused === 'bind-record-ambiguous') {
    // ticket0_contacts.id is the primary key, so this is a corrupt desk rather than a user's mistake.
    return new HTTPException(409, { message: 'more than one contact row carries this id — the contact cannot be bound' });
  }
  if (refused === 'bind-record-held') {
    // A customer invited before binding invites: they hold the portal, but the contact never named them.
    return new HTTPException(409, {
      message: 'this contact already has a portal customer from an earlier invite — unbind the contact before inviting someone to it',
    });
  }
  return new HTTPException(409, { message: 'this desk has not been set up to bind a customer to a contact yet' });
}

/**
 * Mount `GET/POST /api/invites`, `POST /api/invites/:principal/revoke` and
 * `POST /api/accept-invite`.
 *
 * The name is only ever written for a STAFF role, and the profile write is what puts
 * somebody in `list-agents` — so the directory fills itself as people join, rather
 * than waiting for each of them to discover a settings screen.
 */
export function mountInvites(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as every mount here: one file, two hosts
  app: Hono<any, any, any>,
  opts: InviteSurfaceOptions,
): void {
  const now = opts.now ?? (() => new Date().toISOString());
  const reportLegacyOnList = legacyInviteListReporter();

  app.get('/api/invites', async (c) => {
    await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    await reportLegacyOnList(desk.scopeId ?? '', desk.store.legacyCount && (() => desk.store.legacyCount!()));
    return c.json({ roles: [...opts.humanRoles], invites: await desk.store.list() });
  });

  app.post('/api/invites', async (c) => {
    const { principal: caller } = await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    const { email, roleKey, contactId } = inviteBody.parse(await c.req.json());
    if (!opts.humanRoles.includes(roleKey)) {
      throw new HTTPException(400, {
        message: `'${roleKey}' is not a role a person can be invited at`,
      });
    }
    const customer = roleKey === opts.contactBoundRole;
    if (customer && !contactId) {
      throw new HTTPException(400, {
        message: 'a customer invite names the contact whose history it opens (contactId)',
      });
    }
    const minted = await mintMemberInvite(
      {
        grant: (assignee) => desk.grantRole(caller, assignee, roleKey),
        /**
         * A customer's link BINDS whoever claims it to their contact (#1686): the claim sets
         * `ticket0_contacts.principal` to them and gives them the declared portal shape, in
         * one transaction. This is not delegation — the inviter hands over none of their own
         * authority, so it is bounded by `contact:invite` on that contact rather than by
         * anything the portal confers, checked here and again when the link is claimed.
         */
        mint: async (link) => {
          const out = await desk.mintLink(caller, customer ? { ...link, bind: { entity: { entityType: 'contact', entityId: contactId! } } } : link);
          if (!out.ok && 'refused' in out && out.refused.startsWith('bind-')) throw bindRefused(out.refused);
          return out;
        },
        record: (principal, tokenHash, capabilityId) =>
          desk.store.create({ principal, roleKey, email: email ?? null, tokenHash, capabilityId }),
        revokeCapability: (link) => desk.revokeLink(caller, link),
        rollback: (principal) => desk.revokeRole(principal, roleKey),
      },
      { roleKey, email: email ?? null, origin: opts.appOrigin(c) },
    );
    if (!minted.ok) throw uncovered(minted.coverage.missing, customer ? `contact:${contactId}` : roleKey, 'invite at');
    return c.json({ ...minted.invite, created_at: now() }, 201);
  });

  app.post('/api/invites/:principal/revoke', async (c) => {
    const { principal: caller } = await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    // The link first, then the row (#1686): a revoke that fails leaves the row for the retry.
    await withdrawMemberInvite(
      {
        directory: {
          inviteLink: (_scope, principal) => desk.store.linkOf(principal),
          revokeInvite: async (_scope, principal) => {
            await desk.store.revoke(principal);
            return null;
          },
        },
        revokeCapability: (link) => desk.revokeLink(caller, link),
      },
      '',
      c.req.param('principal'),
    );
    return c.body(null, 204);
  });

  /**
   * Accept an invite: the invitee has signed in at the issuer, and now claims it.
   * Binds their subject → the pre-minted principal, which already holds the role. For a
   * customer the exchange also binds them to their contact and gives them its portal shape,
   * in the scope, in the same transaction that spends the link (#1686).
   */
  app.post('/api/accept-invite', async (c) => {
    const subject = await opts.subjectOf(c);
    if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
    const { token } = acceptBody.parse(await c.req.json());
    const desk = await opts.deskOf(c);
    let claimed: ClaimedInvite | null = null;
    const keep = (row: ClaimedInvite | null) => {
      claimed = row;
      return row?.principal ?? null;
    };
    await acceptMemberInvite(
      {
        directory: {
          claimInvite: async (_scope, sub, hash) => keep(await desk.store.claim(sub, hash)),
          legacyInviteCount: desk.store.legacyCount && (() => desk.store.legacyCount!()),
          inviteMatches: (_scope, hash) => desk.store.matches(hash),
          claimInviteByCapability: async (_scope, sub, capabilityId, principal) =>
            keep(await desk.store.claimByCapability(sub, capabilityId, principal)),
        },
        exchange: (secret) => desk.exchange(secret),
      },
      desk.scopeId ?? '',
      subject.sub,
      token,
    );
    const joined = claimed as ClaimedInvite | null;
    if (!joined) {
      throw new HTTPException(400, { message: 'this invite is invalid or already used' });
    }
    // Staff go in the directory; a customer does not. The portal is not the inbox, and
    // a customer offered in an assignee picker would be a bug.
    if (opts.staffRoles.includes(joined.roleKey)) {
      await recordStaffProfile(desk.invokeAs, joined.principal, subject);
    }
    return c.json({ ok: true, principal: joined.principal });
  });
}
