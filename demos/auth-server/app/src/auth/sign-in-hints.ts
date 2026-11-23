/**
 * What a relying party may say about the screen it is sending someone to (#3345), read from the
 * SIGNED authorize query the plugin hands `/login` and `/signup`:
 *
 *  - `login_hint` (OIDC Core 3.1.2.1): the address to pre-fill. A hint and nothing more: it proves
 *    nothing about who is at the keyboard, so it only fills a field the person can still change,
 *    and every check (password, verification, the client's sign-in policy) runs as before. Anything
 *    that is not an address is dropped without a word: an OP SHOULD tolerate a hint it cannot use.
 *  - `screen_hint=signup` (the Auth0 convention, which `@substrat-run/oidc-rp` forwards): open on
 *    "Create account". `prompt=create` arrives as this too, rewritten by the issuer
 *    (`createAsSignUpScreen` in `src/auth.ts`).
 *
 * Read from the signed query rather than the address bar, so what the screen pre-fills is exactly
 * what the request that will be resumed carries.
 */
export interface SignInHints {
  loginHint: string | null;
  signUp: boolean;
}

/** The longest address the issuer's own address checks take (RFC 5321's path limit). */
const MAX_ADDRESS = 320;

/**
 * An address, judged the way a sign-up form would: one `@`, something either side, a dot in the
 * domain, no whitespace or angle brackets. Deliberately not a full RFC 5322 parser; the issuer
 * judges what is submitted.
 */
export function isAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>.]+$/.test(value);
}

export function signInHintsOf(oauthQuery: string | null): SignInHints {
  if (!oauthQuery) return { loginHint: null, signUp: false };
  const query = new URLSearchParams(oauthQuery);
  const hint = (query.get('login_hint') ?? '').trim();
  return { loginHint: isAddress(hint) ? hint : null, signUp: query.get('screen_hint') === 'signup' };
}

/**
 * Which screen a person lands on: `signup`, `signin`, or `signin` saying that an account cannot
 * be made here (`closed`).
 *
 * Sign-up is open only when the issuer allows it AND the client accepts passwords: an account made
 * here is a password account, and a client that refuses passwords would turn it away at authorize
 * (the sign-in screen hides its "Create account" for the same reason). A refused social sign-in
 * comes back to sign-in whatever was asked, because that is the screen that shows its reason.
 */
export function entryScreen(input: {
  askedSignUp: boolean;
  signUpOpen: boolean;
  socialError: boolean;
}): 'signup' | 'signin' | 'closed' {
  if (!input.askedSignUp || input.socialError) return 'signin';
  return input.signUpOpen ? 'signup' : 'closed';
}
