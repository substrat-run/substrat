import { SubIcons } from '@substrat-run/ui';
import { detailTarget } from './paths';

// Re-exported so the console's routing is still one import for the screens that read it — the
// split in `paths.ts` is about what a test can reach, not about where a caller should look.
export {
  APPLICATIONS_PATH,
  BANKID_PATH,
  BANKID_SETTINGS_PATH,
  PROVIDERS_PATH,
  USERS_PATH,
  applicationDetailId,
  detailTarget,
  isBankIdSettingsPath,
  providerDetailId,
  userDetailId,
} from './paths';

/**
 * Lucide `circle-user`. `@substrat-run/ui` has `users` (a group) but no single-person icon,
 * and "Your account" is emphatically not the directory — borrowing the group glyph would say
 * the wrong thing in the one place a non-administrator ever looks. Inlined rather than added
 * to the package: this app is the only caller so far, and a shared icon set earns an entry
 * from a second one.
 */
const ICON_ACCOUNT =
  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.7a8 8 0 0 1 10 0"/>';

export interface Route {
  path: string;
  label: string;
  icon: string;
  /** Which nav group it sits in — the order of first appearance is the order on screen. */
  group: string;
  /** False for the one screen an ordinary person of this issuer reaches. */
  adminOnly: boolean;
}

/**
 * The route table. Two groupings are deliberate rather than inherited from the order the
 * panels happened to grow in:
 *
 * - **BankID is a sign-in method, beside the OAuth providers** — not a section of its own
 *   because it is exotic. It is separate from "Sign-in providers" only because it is
 *   configured on completely different terms (an mTLS certificate and an environment, no
 *   client id and no redirect URI to register), so one editor could not serve both.
 * - **Access sits with them, not with the issuer's settings.** It reads as a lone toggle
 *   between two registries today; it is in fact the answer to "who may get in at all",
 *   which is the same question the providers list answers one upstream at a time.
 *
 * It lives in its own module, apart from the console that renders it, because the SIGNED-OUT
 * screens need it too: `returnTarget` below is the only thing that decides where signing in
 * lands, and the sign-in screen must not have to import the console to ask.
 */
export const ROUTES: Route[] = [
  { path: '/users', label: 'Users', icon: SubIcons.users, group: 'Directory', adminOnly: true },
  { path: '/applications', label: 'Applications', icon: SubIcons.layers, group: 'Directory', adminOnly: true },
  { path: '/providers', label: 'Sign-in providers', icon: SubIcons.globe, group: 'Sign-in', adminOnly: true },
  { path: '/bankid', label: 'BankID', icon: SubIcons.box, group: 'Sign-in', adminOnly: true },
  { path: '/access', label: 'Access', icon: SubIcons.sliders, group: 'Sign-in', adminOnly: true },
  { path: '/issuer', label: 'Issuer', icon: SubIcons.cog, group: 'Issuer', adminOnly: true },
  { path: '/account', label: 'Your account', icon: ICON_ACCOUNT, group: 'You', adminOnly: false },
];

/**
 * Where to come back to once this person is authenticated: the console screen they actually
 * asked for, or `/` — which the console replaces with its first section on the way in.
 *
 * A pasted `/applications` used to be thrown away by the sign-in it triggered, and the person
 * landed on Users wondering what happened to the link they were sent. Keeping it is what fixes
 * that; keeping it as an **allowlist** is what keeps the fix from becoming a hole. This value is
 * handed to an upstream provider as `callbackURL` and comes back through a redirect, so
 * "whatever was in the address bar" would be an open-redirect parameter with a round trip
 * through Google attached. Only a path this table names, or a detail URL `paths.ts` recognised —
 * by parsing an id out of it, or by matching BankID's literal second segment — survives, and the
 * four OIDC hand-off paths (`/login`, `/signup`, `/consent`, `/reset-password`) are neither: they
 * are where the browser already is, never where it should be sent next.
 */
export function returnTarget(pathname: string): string {
  if (ROUTES.some((r) => r.path === pathname)) return pathname;
  // A detail URL is the kind of path outside the table worth surviving a sign-in: it is the
  // link an operator pastes into a support conversation, and it is exactly where the person
  // opening it meant to land.
  return detailTarget(pathname) ?? '/';
}
