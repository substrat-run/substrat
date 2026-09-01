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
import { z } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
/**
 * The token shape, its hash and the `?invite=` path — the same three facts the owner
 * claim link is built from, imported rather than reimplemented so the two doors into a
 * desk cannot start disagreeing about any of them. The `/tokens` subpath and not the
 * root: the root exports `IdentityDO`, which imports `cloudflare:workers`, and the
 * node dev server mounts this file too.
 */
import { claimToken, invitePath, sha256Hex } from '@substrat-run/vertical-auth/tokens';

/** A pending invite, as an admin sees it. Never the token — only its hash is kept. */
export interface PendingInvite {
  readonly principal: string;
  readonly roleKey: string;
  readonly email: string | null;
  readonly created_at: string;
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
  create(invite: {
    principal: string;
    roleKey: string;
    email: string | null;
    tokenHash: string;
  }): Promise<void>;
  revoke(principal: string): Promise<void>;
  /**
   * Bind this verified subject to the open invite matching `tokenHash`, consuming it.
   * Null when no open invite matches — the one answer a caller gets for every way this
   * can fail.
   *
   * It returns the ROLE as well as the principal, and that is not a convenience. The
   * role decides whether the new arrival belongs in the staff directory, and it is
   * gone the moment the invite is consumed — so the only place that can still answer
   * is the store, while it still has the row. The caller cannot look it up first: on
   * the dev server an invitee has no principal yet and therefore no desk to list.
   */
  claim(sub: string, tokenHash: string): Promise<{ principal: string; roleKey: string } | null>;
}

/** The desk one request addresses: its invite store, and the writes an invite makes. */
export interface InviteDesk {
  readonly store: InviteStore;
  /** Grant a freshly minted principal a scope-wide role. */
  readonly assignRole: (principal: string, roleKey: string) => Promise<void>;
  /** Narrow a customer to ONE contact's history — the portal grant. */
  readonly grantContactPortal: (principal: string, contactId: string) => Promise<void>;
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
   * Assert the caller may manage this desk's people. Throws (401/403) if not — the
   * check itself is the host's, because only it knows how a caller is authenticated.
   */
  readonly requireAdmin: (c: Context) => Promise<void>;
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

  app.get('/api/invites', async (c) => {
    await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    return c.json({ roles: [...opts.humanRoles], invites: await desk.store.list() });
  });

  app.post('/api/invites', async (c) => {
    await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    const { email, roleKey, contactId } = inviteBody.parse(await c.req.json());
    if (!opts.humanRoles.includes(roleKey)) {
      throw new HTTPException(400, {
        message: `'${roleKey}' is not a role a person can be invited at`,
      });
    }
    if (roleKey === opts.contactBoundRole && !contactId) {
      throw new HTTPException(400, {
        message: 'a customer invite names the contact whose history it opens (contactId)',
      });
    }
    const principal = ulid();
    const token = claimToken();
    await desk.assignRole(principal, roleKey);
    if (roleKey === opts.contactBoundRole) {
      /**
       * The PORTAL grant. The admin proved they hold `desk:configure` above, and
       * `contact:read` is in the same role, so the id they name is one they can already
       * read off the contacts list — what this hands over is strictly narrower than
       * what they hold: one contact's own conversations, public messages only, no inbox.
       *
       * The id is not checked against a row, because there is no read-one-contact
       * operation and inventing one to validate an argument would be the wrong reason
       * to widen the surface. A grant naming a contact that does not exist opens
       * nothing — the walk starts at a row that is not there — so the failure mode is
       * an invite that shows an empty portal, not somebody else's history.
       */
      await desk.grantContactPortal(principal, contactId!);
    }
    await desk.store.create({
      principal,
      roleKey,
      email: email ?? null,
      tokenHash: await sha256Hex(token),
    });
    return c.json(
      {
        principal,
        roleKey,
        email: email ?? null,
        created_at: now(),
        acceptUrl: `${opts.appOrigin(c)}${invitePath(token)}`,
      },
      201,
    );
  });

  app.post('/api/invites/:principal/revoke', async (c) => {
    await opts.requireAdmin(c);
    const desk = await opts.deskOf(c);
    await desk.store.revoke(c.req.param('principal'));
    return c.body(null, 204);
  });

  /**
   * Accept an invite: the invitee has signed in at the issuer, and now claims it.
   * Binds their subject → the pre-minted principal, which already holds the role (and,
   * for a customer, the grant on their own contact).
   */
  app.post('/api/accept-invite', async (c) => {
    const subject = await opts.subjectOf(c);
    if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
    const { token } = acceptBody.parse(await c.req.json());
    const desk = await opts.deskOf(c);
    const claimed = await desk.store.claim(subject.sub, await sha256Hex(token));
    if (!claimed) {
      throw new HTTPException(400, { message: 'this invite is invalid or already used' });
    }
    // Staff go in the directory; a customer does not. The portal is not the inbox, and
    // a customer offered in an assignee picker would be a bug.
    if (opts.staffRoles.includes(claimed.roleKey)) {
      await recordStaffProfile(desk.invokeAs, claimed.principal, subject);
    }
    return c.json({ ok: true, principal: claimed.principal });
  });
}
