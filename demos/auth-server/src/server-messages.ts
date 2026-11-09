import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { requestLocale, type Locale } from './locale-wire.js';

/**
 * Swedish for the refusals this issuer's own plugins throw, keyed by their English text.
 *
 * `@better-auth/i18n` translates Better Auth's errors, which carry a code. Ours carry only a
 * message, and every refusal already says what it means where it is thrown, so the English is
 * the key rather than a parallel list of codes. `test/server-messages.test.ts` reads the plugins
 * and fails on a literal with no entry here.
 */
export const SWEDISH_REFUSALS: Record<string, string> = {
  'This sign-in has expired. Start again with BankID.': 'Inloggningen har gått ut. Börja om med BankID.',
  'Enter an address you can receive mail at': 'Ange en adress där du kan ta emot e-post',
  'Wait a minute before requesting another code': 'Vänta en minut innan du begär en ny kod',
  'Too many codes requested. Start again with BankID.': 'För många koder har begärts. Börja om med BankID.',
  'The code could not be sent. Check the address and try again.': 'Koden kunde inte skickas. Kontrollera adressen och försök igen.',
  'Too many attempts. Start again with BankID.': 'För många försök. Börja om med BankID.',
  'Request a new code': 'Begär en ny kod',
  'Invalid code': 'Ogiltig kod',
  'This code has already been used': 'Koden har redan använts',
  'There is no account with this address here. Ask an administrator to create one.': 'Det finns inget konto med den här adressen. Be en administratör att skapa ett.',
  'This sign-in has already been used': 'Den här inloggningen har redan använts',
  'could not create a session': 'Det gick inte att skapa en session',
  'An email address is required': 'En e-postadress krävs',
  'This account is protected. Sign in to it first, then connect BankID from your account page.': 'Kontot är skyddat. Logga in på det först och koppla sedan BankID från din kontosida.',
  'These accounts cannot be joined': 'De här kontona kan inte slås ihop',
  'unknown or expired BankID order': 'BankID-ordern är okänd eller har gått ut',
  'Verify your email and sign in again before connecting BankID': 'Verifiera din e-post och logga in igen innan du kopplar BankID',
  'Verify your SMS factor before connecting BankID': 'Verifiera din sms-kod innan du kopplar BankID',
  'This BankID order belongs to another setup session': 'BankID-ordern hör till en annan session',
  'This BankID order has already been used': 'BankID-ordern har redan använts',
  'This BankID is already connected to another account': 'Det här BankID:t är redan kopplat till ett annat konto',
  'The invited account no longer exists': 'Det inbjudna kontot finns inte längre',
  'This BankID is not linked to an account here. Ask an administrator to create one, or allow BankID to create accounts.': 'Det här BankID:t är inte kopplat till något konto här. Be en administratör att skapa ett.',
  'SMS verification is not configured': 'Sms-verifiering är inte konfigurerad',
  'Sign in again with your password before verifying your phone': 'Logga in igen med ditt lösenord innan du verifierar din telefon',
  'Use your registered phone number': 'Använd ditt registrerade telefonnummer',
  'Verify your email before registering a phone': 'Verifiera din e-post innan du registrerar en telefon',
  'A phone number is required': 'Ett telefonnummer krävs',
  'SMS verification is unavailable. Please try again later.': 'Sms-verifiering är inte tillgänglig just nu. Försök igen senare.',
  'Request a new SMS code': 'Begär en ny sms-kod',
  'Too many attempts. Try again in ten minutes.': 'För många försök. Försök igen om tio minuter.',
  'Invalid or expired SMS code': 'Sms-koden är ogiltig eller har gått ut',
  'This code has already been used or replaced': 'Koden har redan använts eller ersatts',
  'Your registered phone changed. Sign in again.': 'Din registrerade telefon har ändrats. Logga in igen.',
  'Phone enrollment is already in progress. Sign in again.': 'Telefonregistrering pågår redan. Logga in igen.',
  'Could not create a session': 'Det gick inte att skapa en session',
  'Administrators only': 'Endast för administratörer',
  'This account already exists. Use its existing sign-in method.': 'Kontot finns redan. Använd dess befintliga inloggningsmetod.',
  'The invitation email could not be sent': 'Inbjudan kunde inte skickas',
  'This invitation is invalid or expired': 'Inbjudan är ogiltig eller har gått ut',
  'This account is already set up. Sign in with its existing method.': 'Kontot är redan konfigurerat. Logga in med dess befintliga metod.',
  'Could not create a setup session': 'Det gick inte att starta kontokonfigureringen',
  'Open your invitation to set up this account': 'Öppna din inbjudan för att konfigurera kontot',
  'This account already has a sign-in method': 'Kontot har redan en inloggningsmetod',
  'Password setup is already in progress': 'Lösenordet håller redan på att ställas in',
  'Open this verification link in the browser where you signed in with GitHub.': 'Öppna verifieringslänken i webbläsaren där du loggade in med GitHub.',
  'This GitHub sign-in expired. Sign in again.': 'GitHub-inloggningen har gått ut. Logga in igen.',
  'This verification link is invalid or expired.': 'Verifieringslänken är ogiltig eller har gått ut.',
  'Open this link in the browser where you signed in with GitHub.': 'Öppna länken i webbläsaren där du loggade in med GitHub.',
  'This GitHub account needs administrator help.': 'Det här GitHub-kontot behöver hjälp av en administratör.',
  'Sign in again with your existing method before connecting GitHub.': 'Logga in igen med din befintliga metod innan du kopplar GitHub.',
  'Finish account setup and SMS verification before connecting GitHub.': 'Slutför kontokonfigurering och sms-verifiering innan du kopplar GitHub.',
  'This GitHub account already belongs to another account.': 'Det här GitHub-kontot tillhör redan ett annat konto.',
  'Verify your existing account email before connecting GitHub.': 'Verifiera e-postadressen på ditt befintliga konto innan du kopplar GitHub.',
  'This email already has an account. Sign in with its existing method and connect GitHub under Sign-in methods.': 'E-postadressen har redan ett konto. Logga in med dess befintliga metod och koppla GitHub under Inloggningsmetoder.',
  'Wait a minute before requesting another email.': 'Vänta en minut innan du begär ett nytt mejl.',
  'The verification email could not be sent. Try again shortly.': 'Verifieringsmejlet kunde inte skickas. Försök igen om en stund.',
  'GitHub sign-up is no longer available. Use an existing sign-in method.': 'Registrering med GitHub är inte längre tillgänglig. Använd en befintlig inloggningsmetod.',
  'The sign-in request changed. Sign in again.': 'Inloggningsbegäran har ändrats. Logga in igen.',
  'This GitHub account changed. Sign in again.': 'GitHub-kontot har ändrats. Logga in igen.',
  'This account is disabled.': 'Kontot är inaktiverat.',
  'Use your organization’s required sign-in method to change this account email.': 'Använd din organisations inloggningsmetod för att ändra kontots e-postadress.',
  'This verification link has already been used.': 'Verifieringslänken har redan använts.',
  'Could not create a session. Sign in again.': 'Det gick inte att skapa en session. Logga in igen.',
};

/** Translates a refusal with no code, the kind `@better-auth/i18n` passes over. */
export const localizedRefusals = (issuerDefault: Locale) => ({
  id: 'localized-refusals',
  hooks: {
    after: [{
      matcher: () => true,
      handler: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (!isAPIError(returned) || returned.body?.code) return;
        if (requestLocale(ctx.headers, issuerDefault) !== 'sv') return;
        const swedish = SWEDISH_REFUSALS[returned.message];
        if (swedish) throw new APIError(returned.status, { message: swedish });
      }),
    }],
  },
});
