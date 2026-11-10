import {
  CloudflareEmailTransport,
  MockEmailTransport,
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type SendEmailBinding,
} from '@substrat-run/adapter-email';
import type { Locale } from './locale-wire.js';
import type { ClientTheme } from './theme-wire.js';

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
export function senderFor(emailFrom?: string, name?: string): EmailAddress {
  return { email: emailFrom ?? 'no-reply@send.substrat.net', name: name || 'Substrat Auth' };
}

/** What of the issuer's theme a mail can use. Clients block `data:` images, so https only. */
export interface EmailBrand {
  color?: string;
  foreground?: string;
  logoUrl?: string;
}

export function emailBrandOf(theme: ClientTheme): EmailBrand {
  return {
    ...(theme.colorPrimary ? { color: theme.colorPrimary } : {}),
    ...(theme.colorPrimaryForeground ? { foreground: theme.colorPrimaryForeground } : {}),
    ...(theme.logoUrl?.startsWith('https://') ? { logoUrl: theme.logoUrl } : {}),
  };
}

/** The language and look of one mail. */
export interface MailStyle {
  locale: Locale;
  brand?: EmailBrand;
}

const PLAIN: MailStyle = { locale: 'en' };

const EN = {
  resetSubject: 'Reset your password',
  resetLead: 'We received a request to reset your password',
  resetAction: 'Reset it here',
  resetIgnore: 'If you did not request this, you can ignore this email — your password will not change.',
  resetTitle: 'Reset your password',
  resetCta: 'Reset password',
  verifySubject: 'Verify your email',
  verifyLead: 'Confirm this email address to finish setting up your account',
  verifyAction: 'Verify here',
  verifyIgnore: 'If you did not create an account, you can ignore this email.',
  verifyTitle: 'Verify your email',
  verifyCta: 'Verify email',
  inviteSubject: 'Set up your account',
  inviteLead: 'You have been invited to set up an account. Choose BankID or a password and phone verification',
  inviteExpiry: 'This invitation expires in 24 hours',
  inviteCta: 'Set up account',
  githubSubject: 'Verify your email for GitHub sign-in',
  githubLead: 'Verify this email to finish signing in with the GitHub account {name}',
  githubNote: 'Open this link in the browser where you signed in with GitHub. It expires in 10 minutes and becomes your account email',
  githubIgnore: 'If you did not request this, ignore this email.',
  codeSubject: 'Your sign-in code: {code}',
  codeLead: 'Enter this code to finish signing in with BankID. It expires in 10 minutes.',
  codeIgnore: 'If this was not you, you can ignore this email.',
  joinedSubject: 'BankID was connected to your account',
  joinedLead: 'A BankID was connected to your account using a code sent to this address. It can now be used to sign in.',
  joinedWarning: 'If this was not you, contact your administrator right away.',
  pasteLink: 'Or paste this link into your browser:',
};

const COPY: Record<Locale, typeof EN> = {
  en: EN,
  sv: {
    resetSubject: 'Återställ ditt lösenord',
    resetLead: 'Vi har tagit emot en begäran om att återställa ditt lösenord',
    resetAction: 'Återställ det här',
    resetIgnore: 'Om det inte var du som begärde detta kan du bortse från mejlet. Ditt lösenord ändras inte.',
    resetTitle: 'Återställ ditt lösenord',
    resetCta: 'Återställ lösenord',
    verifySubject: 'Verifiera din e-post',
    verifyLead: 'Bekräfta den här e-postadressen för att slutföra ditt konto',
    verifyAction: 'Verifiera här',
    verifyIgnore: 'Om du inte har skapat något konto kan du bortse från mejlet.',
    verifyTitle: 'Verifiera din e-post',
    verifyCta: 'Verifiera e-post',
    inviteSubject: 'Konfigurera ditt konto',
    inviteLead: 'Du har blivit inbjuden att konfigurera ett konto. Välj BankID eller lösenord och telefonverifiering',
    inviteExpiry: 'Inbjudan gäller i 24 timmar',
    inviteCta: 'Konfigurera konto',
    githubSubject: 'Verifiera din e-post för inloggning med GitHub',
    githubLead: 'Verifiera den här e-postadressen för att slutföra inloggningen med GitHub-kontot {name}',
    githubNote: 'Öppna länken i webbläsaren där du loggade in med GitHub. Den gäller i 10 minuter och blir ditt kontos e-postadress',
    githubIgnore: 'Om det inte var du som begärde detta kan du bortse från mejlet.',
    codeSubject: 'Din inloggningskod: {code}',
    codeLead: 'Ange den här koden för att slutföra inloggningen med BankID. Den gäller i 10 minuter.',
    codeIgnore: 'Om det inte var du kan du bortse från mejlet.',
    joinedSubject: 'BankID har kopplats till ditt konto',
    joinedLead: 'Ett BankID har kopplats till ditt konto med en kod som skickades till den här adressen. Det kan nu användas för att logga in.',
    joinedWarning: 'Om det inte var du, kontakta din administratör omedelbart.',
    pasteLink: 'Eller klistra in länken i din webbläsare:',
  },
};

type MailInput = { to: string; from: EmailAddress; style?: MailStyle };

/**
 * The password-reset email. The reset link is a capability sent only to the account's own
 * address; Better Auth builds it and hands it to `sendResetPassword` — we only wrap it.
 */
export function resetPasswordEmail(input: MailInput & { url: string }): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  const text = [`${c.resetLead}.`, '', `${c.resetAction}: ${input.url}`, '', c.resetIgnore].join('\n');
  return { to: input.to, from: input.from, subject: c.resetSubject, html: actionEmailHtml(c.resetTitle, c.resetCta, input.url, style), text };
}

/** The email-verification message — same shape, different verb. */
export function verifyEmail(input: MailInput & { url: string }): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  const text = [`${c.verifyLead}.`, '', `${c.verifyAction}: ${input.url}`, '', c.verifyIgnore].join('\n');
  return { to: input.to, from: input.from, subject: c.verifySubject, html: actionEmailHtml(c.verifyTitle, c.verifyCta, input.url, style), text };
}

/** Shared single-button transactional layout — the lead line, one CTA, the raw link. */
export function invitationEmail(input: MailInput & { url: string }): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  return {
    to: input.to, from: input.from, subject: c.inviteSubject,
    text: `${c.inviteLead}.\n\n${input.url}\n\n${c.inviteExpiry}.`,
    html: actionEmailHtml(`${c.inviteLead}. ${c.inviteExpiry}`, c.inviteCta, input.url, style),
  };
}

export function githubEmailVerification(input: MailInput & { name: string; url: string }): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  const lead = c.githubLead.replace('{name}', input.name);
  return {
    to: input.to, from: input.from, subject: c.githubSubject,
    text: `${lead}.\n\n${input.url}\n\n${c.githubNote}. ${c.githubIgnore}`,
    html: actionEmailHtml(`${lead}. ${c.githubNote}`, c.verifyCta, input.url, style),
  };
}

export function bankidEmailCode(input: MailInput & { code: string }): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  return {
    to: input.to, from: input.from, subject: c.codeSubject.replace('{code}', input.code),
    text: `${c.codeLead}\n\n${input.code}\n\n${c.codeIgnore}`,
    html: `${logoHtml(style)}<p>${escapeHtml(c.codeLead)}</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${escapeHtml(input.code)}</p><p>${escapeHtml(c.codeIgnore)}</p>`,
  };
}

/** Tells an account's address that an emailed code joined a BankID to it. Names no person. */
export function bankidJoinedNotice(input: MailInput): EmailMessage {
  const style = input.style ?? PLAIN;
  const c = COPY[style.locale];
  return {
    to: input.to, from: input.from, subject: c.joinedSubject,
    text: `${c.joinedLead}\n\n${c.joinedWarning}`,
    html: `${logoHtml(style)}<p>${escapeHtml(c.joinedLead)}</p><p>${escapeHtml(c.joinedWarning)}</p>`,
  };
}

function logoHtml(style: MailStyle): string {
  const logo = style.brand?.logoUrl;
  return logo ? `<p style="margin:0 0 24px"><img src="${escapeAttr(logo)}" alt="" style="max-height:48px;max-width:240px"></p>` : '';
}

function actionEmailHtml(lead: string, cta: string, url: string, style: MailStyle): string {
  const background = escapeAttr(style.brand?.color ?? '#1a1a1a');
  const foreground = escapeAttr(style.brand?.foreground ?? '#fff');
  return `<!-- ${escapeHtml(cta)} -->
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  ${logoHtml(style)}
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">${escapeHtml(lead)}.</p>
  <p style="margin:0 0 28px">
    <a href="${escapeAttr(url)}"
       style="display:inline-block;background:${background};color:${foreground};text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px">
      ${escapeHtml(cta)}
    </a>
  </p>
  <p style="font-size:12.5px;line-height:1.5;color:#6b6b6b;margin:0">
    ${escapeHtml(COPY[style.locale].pasteLink)}<br>
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
