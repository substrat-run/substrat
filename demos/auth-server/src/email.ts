import {
  CloudflareEmailTransport,
  MockEmailTransport,
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type SendEmailBinding,
} from '@substrat-run/adapter-email';

/**
 * The auth server's email seam. Email is an ADAPTER (D-18: a notification transport is
 * infra the host consumes), so it is resolved from the environment and used by host code —
 * here, inside the Better Auth `sendResetPassword` / `sendVerificationEmail` callbacks. The
 * templates are pure (no transport, no env) so the same message is produced in dev and prod
 * and is trivially testable. Mirrors apps/dashboard/src/email.ts.
 */

export interface EmailEnv {
  /** The Cloudflare Email Service `send_email` binding, when configured. */
  EMAIL?: SendEmailBinding;
  /** The sender address (e.g. `no-reply@send.substrat.net`); the domain must be onboarded. */
  EMAIL_FROM?: string;
}

/**
 * Resolve the transport: Cloudflare Email Service when the `send_email` binding is present
 * (prod), else the in-memory mock (local dev / tests without a sending domain). The mock
 * accepts and drops — a missing binding must not crash a password-reset request.
 */
export function transportFor(env: EmailEnv): EmailTransport {
  return env.EMAIL ? new CloudflareEmailTransport(env.EMAIL) : new MockEmailTransport();
}

/** The sender address, from the (manifest-declared) EMAIL_FROM with a sensible default —
 *  a dedicated sending subdomain. Takes the resolved value so the manifest stays the single
 *  source of the config keys this app reads. */
export function senderFor(emailFrom?: string): EmailAddress {
  return { email: emailFrom ?? 'no-reply@send.substrat.net', name: 'Substrat Auth' };
}

/**
 * The password-reset email. The reset link is a capability sent only to the account's own
 * address; Better Auth builds it and hands it to `sendResetPassword` — we only wrap it.
 */
export function resetPasswordEmail(input: { to: string; from: EmailAddress; url: string }): EmailMessage {
  const subject = 'Reset your Substrat password';
  const text = [
    'We received a request to reset your password.',
    '',
    `Reset it here: ${input.url}`,
    '',
    'If you did not request this, you can ignore this email — your password will not change.',
  ].join('\n');
  return { to: input.to, from: input.from, subject, html: actionEmailHtml('Reset your password', 'Reset password', input.url), text };
}

/** The email-verification message — same shape, different verb. */
export function verifyEmail(input: { to: string; from: EmailAddress; url: string }): EmailMessage {
  const subject = 'Verify your Substrat email';
  const text = [
    'Confirm this email address to finish setting up your account.',
    '',
    `Verify here: ${input.url}`,
    '',
    'If you did not create an account, you can ignore this email.',
  ].join('\n');
  return { to: input.to, from: input.from, subject, html: actionEmailHtml('Verify your email', 'Verify email', input.url), text };
}

/** Shared single-button transactional layout — the lead line, one CTA, the raw link. */
export function invitationEmail(input: { to: string; from: EmailAddress; url: string }): EmailMessage {
  return {
    to: input.to, from: input.from, subject: 'Set up your account',
    text: `You have been invited to set up an account. Choose BankID or a password and phone verification.\n\n${input.url}\n\nThis invitation expires in 24 hours.`,
    html: actionEmailHtml('You have been invited to set up an account. This invitation expires in 24 hours', 'Set up account', input.url),
  };
}

function actionEmailHtml(lead: string, cta: string, url: string): string {
  return `<!-- ${escapeHtml(cta)} -->
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">${escapeHtml(lead)}.</p>
  <p style="margin:0 0 28px">
    <a href="${escapeAttr(url)}"
       style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px">
      ${escapeHtml(cta)}
    </a>
  </p>
  <p style="font-size:12.5px;line-height:1.5;color:#6b6b6b;margin:0">
    Or paste this link into your browser:<br>
    <a href="${escapeAttr(url)}" style="color:#6b6b6b">${escapeHtml(url)}</a>
  </p>
</div>`;
}

/** Minimal HTML-text escaping — the CTA text and URL are the only interpolations. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for an attribute value (double-quoted `href`). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
