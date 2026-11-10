import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  clientOptions,
  currentSession,
  pendingConsent,
  pendingOAuthQuery,
  setupState,
  signOut,
  socialErrorFrom,
  type ClientSignIn,
  type ClientTheme,
  type ConsentRequest,
  type Session,
} from './api';
import { Consent } from './auth/Consent';
import { ResetPassword } from './auth/ResetPassword';
import { Setup } from './auth/Setup';
import { SignIn } from './auth/SignIn';
import { SignUp } from './auth/SignUp';
import { Invitation } from './auth/Invitation';
import { GitHubEmail } from './auth/GitHubEmail';
import { recoverInvitation, saveInvitation, type InvitationRecovery } from './auth/invitation-recovery';
import { returnTarget } from './console/routes';
import { Card, Centered } from './primitives';
import { drawsForRelyingParty } from './auth/hand-off';
import { LocaleContext, detectLocale, storeLocale } from './auth/locale';
import { translate } from '../../src/messages.js';
import { themeTitle } from '../../src/theme-wire.js';
import type { Locale } from '../../src/locale-wire.js';
import { applyClientTheme, paintHandOff } from './theme-apply';

// The console is its own chunk. Everyone a relying party sends to /login downloads this
// bundle, and none of them will ever see the operator's screens — so the shell, the views
// and their API client load only once a session says there is a console to draw.
const Console = lazy(() => import('./console/Console').then((m) => ({ default: m.Console })));
import { IssuerUnreachable } from './wire';

type Phase =
  | { t: 'github-email' }
  | { t: 'invitation'; recovery: InvitationRecovery }
  | { t: 'loading' }
  /**
   * The read that decides every other screen did not answer (`wire.ts`).
   *
   * A phase of its own rather than an error on one of the others, because at this point NOTHING
   * is known: not whether the issuer is bootstrapped, not whether anyone is signed in, so there
   * is no screen this belongs on top of. Its absence is what made a failure here render as
   * "Loading…" forever — the one outcome in this app that told the person nothing at all.
   */
  | { t: 'failed'; message: string }
  | { t: 'reset'; token: string }
  | { t: 'setup' }
  | {
      t: 'signin';
      signupEnabled: boolean;
      oauthQuery: string | null;
      /** The methods THIS client accepts — the issuer's own list when no client sent them. */
      signIn: ClientSignIn;
      socialError: string | null;
    }
  | { t: 'signup'; forOidc: boolean; oauthQuery: string | null }
  | { t: 'consent'; request: ConsentRequest }
  | { t: 'not-admin'; session: Session }
  | { t: 'dashboard'; session: Session };

/**
 * This app is TWO surfaces behind one origin: the admin console, and the issuer's own
 * user-facing OIDC pages. `src/auth.ts` configures `loginPage: '/login'` and
 * `consentPage: '/consent'`, and Better Auth redirects people there mid-authorize — so those
 * two paths are part of the OIDC contract, not client routes we happen to own.
 *
 * Picking the screen from session state ALONE is what broke that (#898): `/consent` with a
 * session rendered the dashboard, so every relying party outside `trustedClients` was dropped
 * mid-round-trip and the user landed on an admin page they had not asked for. Path first,
 * then session.
 *
 * So this component still claims exactly four paths, and every OTHER path falls through to
 * the console, which routes it (`console/router.ts`). The order is what keeps the two apart:
 * an authorize hand-off can never be answered by a console screen, and a console URL can
 * never be mistaken for one.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>({ t: 'loading' });
  const [theme, setTheme] = useState<ClientTheme>({});
  const [locale, setLocale] = useState<Locale>(() => detectLocale('en'));
  const choose = useCallback((next: Locale) => {
    storeLocale(next, true);
    setLocale(next);
  }, []);

  const refresh = useCallback(async () => {
    // A password-reset link lands the user here with a token — handle that first.
    const url = new URL(window.location.href);
    // These three have no relying party behind them, so they take the theme the console's own
    // sign-in does, which is where the issuer's lands (`clientBranding`). The read has its own
    // fallback, so a link someone was emailed still opens if it fails.
    const settleLocale = (issuerDefault: Locale, allowed?: readonly Locale[]) => {
      const settled = detectLocale(issuerDefault, allowed);
      storeLocale(settled, false);
      setLocale(settled);
    };
    const paintWithoutClient = async () => {
      const { theme: issuer, defaultLocale } = await clientOptions(null, []);
      applyClientTheme(issuer);
      setTheme(issuer);
      settleLocale(defaultLocale, issuer.languages);
    };
    if (url.pathname === '/github-email') {
      await paintWithoutClient();
      return setPhase({ t: 'github-email' });
    }
    const invitation = recoverInvitation(url);
    if (invitation) {
      // Clear the capability from the address bar only after tab-scoped storage succeeds.
      if (saveInvitation(invitation)) window.history.replaceState({}, '', '/accept-invitation');
      await paintWithoutClient();
      return setPhase({ t: 'invitation', recovery: invitation });
    }
    if (url.pathname === '/reset-password') {
      const token = url.searchParams.get('token');
      if (token) {
        await paintWithoutClient();
        return setPhase({ t: 'reset', token });
      }
    }
    const { needsSetup, signupEnabled, providers } = await setupState();
    // A social sign-in that was refused comes back to `/` carrying its reason. Read it before
    // anything else re-renders, so the sign-in screen can say what happened.
    const socialError = socialErrorFrom(url, detectLocale('en'));
    if (needsSetup) return setPhase({ t: 'setup' });
    const session = await currentSession();
    // The pending authorize request, if one sent this person here. The server does NOT
    // remember it — it is carried in this signed query and must be handed back with whatever
    // the person does next, or the relying party never hears the answer.
    const oauthQuery = pendingOAuthQuery(url);
    const forOidc = oauthQuery !== null;

    /**
     * The application these screens are being drawn FOR decides how they look and which
     * sign-in methods they offer — its operator's `metadata.theme` and `metadata.signIn`,
     * read per client id.
     *
     * Mid-authorize that is the relying party that sent this person here. Otherwise it is the
     * console itself, which now has a row of its own in the registry
     * (`src/console-client.ts`): passing NO client id is how this asks for it, so the id
     * lives on the server and not in a constant here.
     *
     * `?builtin=0` skips that and takes the unthemed, unnarrowed defaults below — the way
     * back in when the console has been narrowed to an upstream that has since broken. It
     * costs nothing to allow, because a console sign-in never reaches `/oauth2/authorize` and
     * so its policy was never enforced against anything; a relying party's is, and this
     * escape hatch cannot touch that one.
     */
    const plainDefaults = { theme: {} as ClientTheme, defaultLocale: 'en' as const, signIn: { providers, password: true, restricted: false } };
    // The relying party mid-authorize; `null` is the console asking about itself.
    const clientId = forOidc ? url.searchParams.get('client_id') : null;
    // Two ways to end up on the plain screen: the operator asked for it, or an authorize
    // query arrived naming no client at all (which is malformed, and was never themed).
    const plain = forOidc ? !clientId : url.searchParams.get('builtin') === '0';
    const options = plain ? plainDefaults : await clientOptions(clientId, providers);
    applyClientTheme(options.theme);
    setTheme(options.theme);
    settleLocale(options.defaultLocale, options.theme.languages);
    const signIn = options.signIn;

    // An authorize request is waiting on an answer. Without a session the consent code cannot
    // be honoured, so fall back to sign-in — Better Auth resumes from its own prompt cookie.
    if (url.pathname === '/consent') {
      const request = pendingConsent(url);
      if (session && request) return setPhase({ t: 'consent', request });
      return setPhase({ t: 'signin', signupEnabled, oauthQuery, signIn, socialError });
    }
    // Sign-up is a pre-auth screen like the other two, and reachable mid-authorize: the
    // pending request lives in a cookie, so creating an account resumes it the same way
    // signing in does. A closed issuer sends this path back to sign-in rather than showing
    // a form the endpoint would refuse.
    if (url.pathname === '/signup') {
      return setPhase(signupEnabled ? { t: 'signup', forOidc, oauthQuery } : { t: 'signin', signupEnabled, oauthQuery, signIn, socialError });
    }
    // `/login` means an RP asked for a sign-in, and that stays true when a session already
    // exists: `prompt=login` (and an expired `max_age`) is a re-authentication request, and
    // answering it with the dashboard strands the flow exactly as `/consent` did.
    if (url.pathname === '/login') return setPhase({ t: 'signin', signupEnabled, oauthQuery, signIn, socialError });

    if (!session) return setPhase({ t: 'signin', signupEnabled, oauthQuery, signIn, socialError });
    setPhase(session.role === 'admin' ? { t: 'dashboard', session } : { t: 'not-admin', session });
  }, []);

  /**
   * Every caller of `refresh` goes through here, and that is the whole point: there were five
   * bare `void refresh()` calls, so a rejection anywhere — including after a sign-in, where the
   * person has just proved who they are — left the phase on whatever it was and nothing said
   * why. A rejection is now a screen.
   */
  const run = useCallback(() => {
    refresh().catch((e: unknown) => {
      // The issuer's own words go to the console and never to the page — `wire.ts` carries the
      // two apart, and this is the half that is allowed to be specific.
      const detail = e instanceof IssuerUnreachable ? e.detail : undefined;
      if (detail) console.error('auth-server: the issuer said:', detail);
      setPhase({ t: 'failed', message: e instanceof Error ? e.message : String(e) });
    });
  }, [refresh]);

  useEffect(() => {
    run();
  }, [run]);

  // A hand-off screen is the relying party's to theme, so the console's page colour (set before
  // the first paint by index.html, kept by `useConsoleTheme`) comes off as soon as one renders.
  useEffect(() => {
    if (drawsForRelyingParty(phase.t)) document.documentElement.removeAttribute('data-console-theme');
  }, [phase.t]);

  // A theme's palette and raw CSS exist only on those screens. The console is never theirs to
  // restyle: an operator who pasted something broken has to be able to get in and undo it.
  // Before the paint, so a themed screen does not flash the built-in one.
  useLayoutEffect(() => {
    const handOff = drawsForRelyingParty(phase.t);
    paintHandOff(handOff ? theme : null);
    document.documentElement.lang = handOff ? locale : 'en';
  }, [phase.t, theme, locale]);

  /**
   * Sign-in finished without an OIDC request to resume — hand the URL to the console.
   *
   * A console screen the person actually asked for is KEPT: someone pasted `/applications`,
   * was shown the sign-in screen because they had no session, and the link they were sent is
   * the whole reason they are here. Everything else — the four hand-off paths, an unknown
   * URL — becomes `/`, which is not a screen either; the console replaces it with its first
   * section on the way in, so the back button never has to step through this hop.
   * `returnTarget` is the allowlist that decides which of the two a path is.
   */
  const doneSigningIn = useCallback(() => {
    const target = returnTarget(window.location.pathname);
    // Compared WITH the query, so a refusal that has since been answered (`?social_error=1`
    // and its `error…` companions) does not ride along into the signed-in console's address bar.
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({}, '', target);
    }
    run();
  }, [run]);

  const signOutAndRefresh = useCallback(async () => {
    await signOut();
    // Signing out from a console URL would otherwise leave the address bar on a section the
    // signed-out screen has nothing to do with.
    window.history.replaceState({}, '', '/');
    run();
  }, [run]);

  const screen = () => { switch (phase.t) {
    case 'github-email': return <GitHubEmail theme={theme} />;
    case 'invitation': return <Invitation recovery={phase.recovery} theme={theme} />;
    case 'loading':
      return <Centered>{translate(locale, 'common.loading', {}, theme.text?.[locale])}</Centered>;
    case 'failed':
      // Named as the issuer's problem rather than the person's, because it is: nothing they
      // typed reaches these two reads. Retry is the whole remedy and is worth offering — the
      // failures this catches are transient (a deploy mid-flight, a 5xx) far more often than
      // not, and before this the only retry available was the one the person guessed at.
      return (
        <Centered>
          <Card title={themeTitle(theme, locale)} logo={theme.logoUrl}>
            <p className="error">{phase.message}</p>
            <p className="muted">{translate(locale, 'failed.notYou', {}, theme.text?.[locale])}</p>
            <button className="btn primary" onClick={() => { setPhase({ t: 'loading' }); run(); }}>
              {translate(locale, 'common.tryAgain', {}, theme.text?.[locale])}
            </button>
          </Card>
        </Centered>
      );
    case 'reset':
      return <ResetPassword token={phase.token} theme={theme} onDone={() => { window.history.replaceState({}, '', '/'); run(); }} />;
    case 'setup':
      return <Setup onDone={doneSigningIn} />;
    case 'signin':
      return (
        <SignIn
          onDone={doneSigningIn}
          signupEnabled={phase.signupEnabled}
          oauthQuery={phase.oauthQuery}
          signIn={phase.signIn}
          socialError={phase.socialError}
          theme={theme}
          onSignUp={() => setPhase({ t: 'signup', forOidc: phase.oauthQuery !== null, oauthQuery: phase.oauthQuery })}
        />
      );
    case 'signup':
      // The URL is left alone on purpose: a pending authorize request is carried in a cookie,
      // and staying on `/login` keeps the browser's back button on the flow it came from.
      return (
        <SignUp
          forOidc={phase.forOidc}
          oauthQuery={phase.oauthQuery}
          theme={theme}
          onDone={doneSigningIn}
          onSignIn={run}
        />
      );
    case 'consent':
      return <Consent request={phase.request} theme={theme} />;
    case 'not-admin':
      // Not a dead end any more, and no longer a lone card either: the same console renders,
      // with the one section this person may see. It is where they connect a second way of
      // signing in — and "account not linked" is precisely the wall that sends them looking.
      return (
        <Suspense fallback={null}>
          <Console session={phase.session} admin={false} onSignOut={signOutAndRefresh} />
        </Suspense>
      );
    case 'dashboard':
      return (
        <Suspense fallback={null}>
          <Console session={phase.session} admin onSignOut={signOutAndRefresh} />
        </Suspense>
      );
  } };

  return <LocaleContext.Provider value={{ locale, choose, overrides: theme.text?.[locale], languages: theme.languages }}>{screen()}</LocaleContext.Provider>;
}
