import { useCallback, useEffect, useState } from 'react';
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
import { Console } from './console/Console';
import { returnTarget } from './console/routes';
import { Centered } from './primitives';

type Phase =
  | { t: 'loading' }
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
 * The wire vocabulary (`src/branding.ts`) mapped onto the custom properties `tokens.css`
 * declares — the ENTIRE contract between a client's `metadata.theme` and these screens.
 * Values arrive sanitized (hex colors, a px radius), so setting them is safe; `setProperty`
 * takes them as one CSS value, never as parseable stylesheet text.
 */
const THEME_VARS: [keyof ClientTheme, string][] = [
  ['colorPrimary', '--accent'],
  ['colorPrimaryForeground', '--accent-contrast'],
  ['colorBackground', '--bg'],
  ['colorPanel', '--panel'],
  ['colorInput', '--panel-2'],
  ['colorText', '--text'],
  ['colorMutedText', '--muted'],
  ['borderRadius', '--radius'],
];

/**
 * Apply (or, with `{}`, fully remove) a client theme. Removal matters: `refresh()` runs
 * again after sign-in, and the dashboard must come back in the issuer's own colors rather
 * than whichever relying party's flow ran last.
 */
function applyClientTheme(theme: ClientTheme): void {
  const root = document.documentElement.style;
  for (const [key, cssVar] of THEME_VARS) {
    const value = theme[key];
    if (value) root.setProperty(cssVar, value);
    else root.removeProperty(cssVar);
  }
  // The card's larger radius follows the input radius instead of being its own key.
  if (theme.borderRadius) root.setProperty('--radius-lg', `${parseInt(theme.borderRadius, 10) + 6}px`);
  else root.removeProperty('--radius-lg');
}

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

  const refresh = useCallback(async () => {
    // A password-reset link lands the user here with a token — handle that first.
    const url = new URL(window.location.href);
    if (url.pathname === '/reset-password') {
      const token = url.searchParams.get('token');
      if (token) return setPhase({ t: 'reset', token });
    }
    const { needsSetup, signupEnabled, providers } = await setupState();
    // A social sign-in that was refused comes back to `/` carrying its reason. Read it before
    // anything else re-renders, so the sign-in screen can say what happened.
    const socialError = socialErrorFrom(url);
    if (needsSetup) return setPhase({ t: 'setup' });
    const session = await currentSession();
    // The pending authorize request, if one sent this person here. The server does NOT
    // remember it — it is carried in this signed query and must be handed back with whatever
    // the person does next, or the relying party never hears the answer.
    const oauthQuery = pendingOAuthQuery(url);
    const forOidc = oauthQuery !== null;

    // The application that sent this person here decides how these screens look AND which
    // sign-in methods they offer — its operator's `metadata.theme` and `metadata.signIn`, read
    // per client id. Only inside an authorize hand-off: the console's own sign-in is never
    // themed and never narrowed, which is also the operator's way back in when a client is
    // restricted to an upstream that has broken.
    const clientId = forOidc ? url.searchParams.get('client_id') : null;
    const options = clientId
      ? await clientOptions(clientId, providers)
      : { theme: {}, signIn: { providers, password: true, restricted: false } };
    applyClientTheme(options.theme);
    setTheme(options.theme);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    void refresh();
  }, [refresh]);

  const signOutAndRefresh = useCallback(async () => {
    await signOut();
    // Signing out from a console URL would otherwise leave the address bar on a section the
    // signed-out screen has nothing to do with.
    window.history.replaceState({}, '', '/');
    void refresh();
  }, [refresh]);

  switch (phase.t) {
    case 'loading':
      return <Centered>Loading…</Centered>;
    case 'reset':
      return <ResetPassword token={phase.token} onDone={() => { window.history.replaceState({}, '', '/'); void refresh(); }} />;
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
          onSignIn={() => void refresh()}
        />
      );
    case 'consent':
      return <Consent request={phase.request} theme={theme} />;
    case 'not-admin':
      // Not a dead end any more, and no longer a lone card either: the same console renders,
      // with the one section this person may see. It is where they connect a second way of
      // signing in — and "account not linked" is precisely the wall that sends them looking.
      return <Console session={phase.session} admin={false} onSignOut={signOutAndRefresh} />;
    case 'dashboard':
      return <Console session={phase.session} admin onSignOut={signOutAndRefresh} />;
  }
}
