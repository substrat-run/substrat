/**
 * The signup surface — the public form, the confirmation mail, and the two pages its
 * links land on. The ONE implementation both hosts mount.
 *
 * It lives under `harness/` for the reason everything here does: it reads request
 * headers, builds URLs, and sends email. None of that is available to module code and
 * none of it belongs in an operation. What is an operation is every decision that
 * matters — whether this origin may sign anybody up, whether a token opens a row, what
 * a second submission means. This file carries the token from the operation to the
 * person and back.
 *
 * ## Why the two doors are shaped differently
 *
 * `POST /signup` is a browser on an embedded page, so it goes through
 * `mountPublicSurface` — preflight, origin allowlist, the desk's signup service — the
 * same door the chat widget uses.
 *
 * `/confirm` and `/unsubscribe` are NAVIGATIONS out of an email, and they are mounted
 * at the top level, deliberately outside that guard. A mail client sends no `Origin`
 * header, so a door that demanded one would refuse every real click; and there is
 * nothing for the guard to add, because the token IS the authority and it opens exactly
 * one row. They answer with HTML rather than JSON for the same reason: a person is
 * looking at the result.
 *
 * ## Why the GET does not change anything, and a POST does
 *
 * Both used to mutate on the `GET`, which is the mistake that quietly defeats the whole
 * feature. Mail clients, corporate link scanners (Safe Links, Proofpoint, Mimecast) and
 * prefetching proxies fetch URLs they find in a message body, without anybody clicking:
 *
 *   - a prefetched UNSUBSCRIBE link removes an address its owner still wants;
 *   - a prefetched CONFIRM link records a confirmation nobody performed — destroying the
 *     one thing double opt-in exists to produce, and doing it invisibly.
 *
 * So the `GET` is a read-only landing page with a button, and the button `POST`s. The
 * token is still the entire authority and it rides in the form, so there is nothing for
 * a cross-site post to forge that it does not already have. The cost is one extra click
 * on a link somebody meant to click, which is the correct thing to spend here.
 *
 * ## Why a token link may name several desks
 *
 * A hosted install is one desk per hostname and `desksForToken` hands back that one.
 * The dev server runs several desks in one process, and a link out of an email carries
 * no hostname that distinguishes them — so it hands back all of them and the route asks
 * each in turn. That is a real difference between the hosts rather than a fudge: in
 * production the list has one element and the loop runs once.
 */
import type { Context, Hono } from 'hono';
import {
  mountPublicSurface,
  type PublicServiceActor,
  type ResolvePublicActor,
} from '@substrat-run/vertical-host';

/** A desk, resolved for one request: how to act as its signup service. */
export type SignupDesk = PublicServiceActor;

/** What a signup produced, for the host that is about to put it in an email. */
export interface PendingConfirmation {
  readonly kind: 'waitlist' | 'newsletter';
  readonly email: string;
  readonly confirmUrl: string;
  /**
   * The way out, in the very first message.
   *
   * Not an afterthought: the signup form promises "an unsubscribe link that always
   * works", and a confirmation mail is a message like any other — somebody whose
   * address was typed in by a stranger should not have to confirm first in order to
   * get out.
   */
  readonly unsubscribeUrl: string;
}

export interface SignupSurfaceOptions {
  /** Which desk a browser on `origin` is signing up to. */
  readonly resolveDesk: (c: Context, origin: string) => Promise<SignupDesk | null>;
  /**
   * Which desks a token out of an email could belong to. One in a hosted install
   * (the hostname decided); every desk this process serves on the dev server.
   */
  readonly desksForToken: (c: Context) => Promise<SignupDesk[]>;
  /**
   * Where the links in this desk's mail point.
   *
   * A host option rather than a field on the request, because a URL built out of a
   * `Host` header is a URL somebody else can choose: put your own hostname on a
   * request and the confirmation mail we send to a stranger carries your link. Each
   * host answers this from what it actually knows — the routed hostname on the worker,
   * the port it is listening on in development.
   */
  readonly publicOriginOf: (c: Context) => string;
  /**
   * Send the confirmation.
   *
   * Deliberately NOT awaited by the route: a mail provider's latency is not something
   * the person who just clicked submit should hold a connection open for, and the row
   * is already committed by the time this is called. The Hono context rides along
   * because a Workers isolate needs the promise handed to `executionCtx.waitUntil` —
   * "not awaited" and "not tracked" are different, and only one of them works.
   */
  readonly sendConfirmation?: (c: Context, pending: PendingConfirmation) => void;
}

/** `https://desk.example/confirm?t=…` — built once, so the mail and the route agree. */
export function confirmUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/confirm?t=${encodeURIComponent(token)}`;
}

/** `https://desk.example/unsubscribe?t=…`. */
export function unsubscribeUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/unsubscribe?t=${encodeURIComponent(token)}`;
}

/**
 * The row a token opens, asked of each candidate desk in turn.
 *
 * A desk that does not hold the token answers `not_found`, which is not an error here
 * — it is the answer to "is it yours". Anything else is a real failure and is left to
 * propagate, so a broken desk does not read as a bad link.
 */
async function spendToken(
  desks: readonly SignupDesk[],
  operation: 'ticket0/confirm-signup' | 'ticket0/unsubscribe-signup',
  token: string,
): Promise<{ kind: string } | null> {
  for (const desk of desks) {
    try {
      return await desk.invoke<{ kind: string }>(operation, { token });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return null;
}

/**
 * "No desk holds this token", told apart from every other failure.
 *
 * Matched on the platform's error CODE rather than on a message, because a message is
 * prose that gets rewritten. Falling through on anything else is the important half: a
 * desk that is down must not make a valid link report itself as invalid.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'not_found';
}

export function mountSignupSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: SignupSurfaceOptions,
): void {
  const resolveActor: ResolvePublicActor = (c, { origin }) => options.resolveDesk(c, origin);

  mountPublicSurface(app, {
    // The desk's own signup service, which holds one key and cannot read the list it
    // writes to. See `SERVICE_ROLES` in `src/provision.ts`.
    service: 'signup',
    basePath: '/signup',
    resolveActor,
    routes: (route) => {
      route.post('/', async (c, { actor: desk, origin }) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          kind?: unknown;
          email?: unknown;
          note?: unknown;
        };
        /**
         * `origin` comes from the header and never from the body — the same rule the
         * widget's session route follows. Everything else is the person's own typing
         * and is parsed by the host against the operation's declared input before it
         * reaches the handler.
         */
        const result = await desk.invoke<{
          id: string;
          kind: 'waitlist' | 'newsletter';
          state: string;
          confirmToken: string | null;
          unsubscribeToken: string;
        }>('ticket0/submit-signup', {
          kind: body.kind,
          email: body.email,
          note: body.note ?? null,
          origin,
        });

        /**
         * Mail goes out only when there is a token, which is exactly when there is
         * something to confirm. An address already confirmed, or one re-submitted
         * inside the throttle, produces none — and the response is the same either
         * way, so the form cannot be used to find out which.
         */
        if (result.confirmToken) {
          const origin = options.publicOriginOf(c);
          options.sendConfirmation?.(c, {
            kind: result.kind,
            email: String(body.email),
            confirmUrl: confirmUrl(origin, result.confirmToken),
            unsubscribeUrl: unsubscribeUrl(origin, result.unsubscribeToken),
          });
        }
        // Never the token, and never whether this address was already known.
        return c.json({ ok: true, kind: result.kind });
      });
    },
  });

  /** The landing page for a confirm link — renders, changes nothing. */
  app.get('/confirm', (c) =>
    page(c, {
      title: 'One more tap',
      body: 'Confirm the address you signed up with and you are on the list.',
      action: { path: '/confirm', token: c.req.query('t') ?? '', label: 'Confirm my address' },
    }),
  );

  app.post('/confirm', async (c) => {
    const token = await tokenFromForm(c);
    const row = token
      ? await spendToken(await options.desksForToken(c), 'ticket0/confirm-signup', token)
      : null;
    return page(
      c,
      row
        ? {
            title: 'You are on the list',
            body:
              row.kind === 'newsletter'
                // A place on the list, not a delivery date: the desk stores signups and
                // nothing sends the changelog yet. Every issue that does go out will carry
                // an unsubscribe link, which is a promise about the mail rather than about
                // when it starts, so it is safe to make here.
                ? 'You will get the changelog by email, and every issue carries an unsubscribe link.'
                : 'Thanks — we will be in touch when there is an invite for you.',
          }
        : {
            title: 'That link did not work',
            // Both real causes, because we genuinely cannot tell them apart: the hash
            // is nulled when it is spent, so a used link and a mistyped one are the
            // same lookup. Saying so is more useful than picking one and being wrong.
            body: 'It may already have been used, or it may have been cut short by a mail client. Sign up again and we will send a fresh one.',
          },
      row ? 200 : 404,
    );
  });

  /** And for an unsubscribe link. Also renders nothing but a button. */
  app.get('/unsubscribe', (c) =>
    page(c, {
      title: 'Unsubscribe',
      body: 'Confirm and this address comes off the list. Nothing further will be sent to it.',
      action: { path: '/unsubscribe', token: c.req.query('t') ?? '', label: 'Unsubscribe me' },
    }),
  );

  app.post('/unsubscribe', async (c) => {
    const token = await tokenFromForm(c);
    const row = token
      ? await spendToken(await options.desksForToken(c), 'ticket0/unsubscribe-signup', token)
      : null;
    return page(
      c,
      row
        ? { title: 'Unsubscribed', body: 'That address is off the list. Nothing further will be sent to it.' }
        : { title: 'That link did not work', body: 'It may have been cut short by a mail client. Reply to any message from us and we will take the address off by hand.' },
      row ? 200 : 404,
    );
  });
}

/**
 * The token out of the posted form, or out of the query string.
 *
 * The query string is accepted on the POST as well, and that is what makes RFC 8058
 * one-click unsubscribe possible later: a mail client posting to the `List-Unsubscribe`
 * URL sends its own body, not our form's.
 */
async function tokenFromForm(c: Context): Promise<string> {
  const query = c.req.query('t');
  if (query) return query;
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = (body as Record<string, unknown>)['t'];
  return typeof token === 'string' ? token : '';
}

/**
 * The page a person lands on. Self-contained on purpose: it is reached from a mail
 * client, sometimes in an in-app browser, and a stylesheet that fails to load would
 * leave somebody staring at unstyled text wondering whether it worked.
 */
function page(
  c: Context,
  content: {
    title: string;
    body: string;
    /** When present, the page is a landing page with a button rather than a result. */
    action?: { path: string; token: string; label: string };
  },
  status: 200 | 404 = 200,
) {
  const form = content.action
    ? `<form method="post" action="${escapeHtml(content.action.path)}">
<input type="hidden" name="t" value="${escapeHtml(content.action.token)}">
<button type="submit">${escapeHtml(content.action.label)}</button>
</form>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #fbfbfa; color: #1c1c1a; padding: 24px; }
  main { max-width: 34rem; text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 .6rem; }
  p { margin: 0; color: #5c5c57; }
  form { margin-top: 1.4rem; }
  button { font: inherit; font-weight: 500; padding: 10px 20px; border: 0; border-radius: 6px;
           background: #4f46e5; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e9e9e6; }
    p { color: #a3a39d; }
    button { background: #6366f1; }
  }
</style>
</head><body><main>
<h1>${escapeHtml(content.title)}</h1>
<p>${escapeHtml(content.body)}</p>
${form}
</main></body></html>`;
  return c.html(html, status);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The confirmation email, both parts.
 *
 * `text` is not a courtesy: the transport port refuses a message without one
 * (`prepareMessage`), because a missing text part is a deliverability signal and some
 * clients render nothing else. So the two are built together, from the same words,
 * where they cannot drift.
 *
 * The link is the whole message. There is no marketing above it, no tracking pixel, and
 * no second call to action — this mail exists to be clicked once, and every extra thing
 * in it is a reason for a spam filter to hold it.
 */
export function confirmationEmail(pending: PendingConfirmation): {
  subject: string;
  html: string;
  text: string;
} {
  const waitlist = pending.kind === 'waitlist';
  const subject = waitlist ? 'Confirm your place on the Substrat beta list' : 'Confirm your Substrat changelog subscription';
  const lead = waitlist
    ? 'Somebody asked for an invite to the Substrat private beta with this address.'
    : 'Somebody asked for the weekly Substrat changelog at this address.';
  const action = waitlist ? 'Confirm and join the list' : 'Confirm and subscribe';
  const url = pending.confirmUrl;
  return {
    subject,
    text:
      `${lead}\n\nIf that was you, confirm here:\n${url}\n\n` +
      `If it was not, ignore this — the address goes nowhere unless the link is clicked. ` +
      `To make sure nothing ever reaches it:\n${pending.unsubscribeUrl}\n`,
    html: `<!doctype html><html><body style="margin:0;padding:24px;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1a;background:#fbfbfa">
<div style="max-width:34rem;margin:0 auto">
<p style="margin:0 0 1rem">${escapeHtml(lead)}</p>
<p style="margin:0 0 1.4rem">If that was you, confirm it:</p>
<p style="margin:0 0 1.4rem"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1c1c1a;color:#fff;text-decoration:none">${escapeHtml(action)}</a></p>
<p style="margin:0 0 .8rem;color:#5c5c57;font-size:14px">If it was not you, ignore this — the address goes nowhere unless the link is clicked.</p>
<p style="margin:0;color:#5c5c57;font-size:13px"><a href="${escapeHtml(pending.unsubscribeUrl)}" style="color:#5c5c57">Make sure nothing ever reaches this address</a></p>
</div></body></html>`,
  };
}
