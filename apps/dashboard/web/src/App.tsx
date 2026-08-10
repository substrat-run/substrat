import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toast, Dialog, Input, useAutoRefresh } from '@substrat-run/ui';
import { api, signIn, signOut, ApiError, needsOnboarding, type AppAuthChoice, type AppRow, type CatalogEntry, type Deployment, type GitReposResult, type Me, type MeResult, type Member, type InviteRole } from './lib/api';
import { DEV_MOCK, MOCK_APPS, MOCK_CATALOG, MOCK_DEPLOYMENTS, MOCK_GIT_REPOS, MOCK_ME, MOCK_MEMBERS } from './lib/mock';
import { navigate as go, setTeamSlug } from './lib/router';
import { verticalMeta } from './lib/demo';
import { DashShell, type Crumb, type NavKey } from './components/DashShell';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsPopover } from './components/NotificationsPopover';
import { SignIn, Interstitial, InviteBlocked } from './views/SignIn';
import { Onboarding } from './views/Onboarding';
import { Apps } from './views/Apps';
import { Verticals, VerticalDetail } from './views/Verticals';
import { CreateApp } from './views/CreateApp';
import { AppDetail } from './views/AppDetail';
import { Team } from './views/Team';
import { Domains } from './views/Domains';
import { Integrations } from './views/Integrations';
import { Billing } from './views/Billing';
import { Analytics } from './views/Analytics';
import { Settings } from './views/Settings';

/** The path route, parsed. `section` maps to the sidebar; `app`/`tab`/`vertical` drive detail. */
interface Route {
  section: NavKey | 'new';
  app?: string;
  tab?: string;
  vertical?: string;
  /** The team slug the URL is scoped to (its first segment); absent on legacy slug-less paths. */
  team?: string;
}

const SECTIONS: NavKey[] = ['overview', 'apps', 'verticals', 'domains', 'team', 'integrations', 'analytics', 'billing', 'settings'];

function parsePath(): Route {
  let parts = window.location.pathname.split('/').filter(Boolean);
  // The first segment is the team slug (`/acme-x1y2z3/apps`) unless it's a section
  // (a legacy slug-less path) or a reserved word. Real slugs always carry a ULID
  // tail (worker's `teamSlug()`), so they can never shadow a section name.
  let team: string | undefined;
  if (parts[0] && !SECTIONS.includes(parts[0] as NavKey) && !['invite', 'deployments', 'api'].includes(parts[0])) {
    team = parts[0];
    parts = parts.slice(1);
  }
  if (parts[0] === 'apps' && parts[1] === 'new') return { section: 'new', team };
  // The tab may carry a sub-section (settings/environment); AppDetail parses it.
  if (parts[0] === 'apps' && parts[1]) return { section: 'apps', app: parts[1], tab: parts.slice(2).join('/') || 'overview', team };
  // A vertical's slug (acme-co/helpdesk) carries a slash, so it's URI-encoded into the
  // single segment — the `/` stays as `%2F` in the pathname, so it never splits across parts.
  if (parts[0] === 'verticals' && parts[1]) return { section: 'verticals', vertical: decodeURIComponent(parts[1]), team };
  // Legacy alias: the page was called "Deployments" before the apps/verticals split.
  if (parts[0] === 'deployments') return { section: 'verticals', team };
  const section = (SECTIONS.includes(parts[0] as NavKey) ? parts[0] : 'overview') as NavKey;
  return { section, team };
}

/** Fallback org label from the signed-in email domain (acme.com → "Acme"). */
function orgFrom(email?: string | null): string {
  const domain = email?.split('@')[1]?.split('.')[0];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'Workspace';
}

export function App() {
  const [me, setMe] = useState<MeResult | null | undefined>(undefined);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [apps, setApps] = useState<AppRow[]>([]);
  // True until the FIRST listApps() lands. `apps` starting as [] is indistinguishable
  // from "no apps yet", and rendering on that guess flashed the "Create your first
  // app" onboarding at everyone (and a 404 at app deep-links) on every load. In the
  // dev preview `?loading=1` pins it, so the skeleton is previewable like `?onboarding=1`.
  const [appsLoading, setAppsLoading] = useState(
    () => !DEV_MOCK || new URLSearchParams(window.location.search).get('loading') === '1',
  );
  // Keyset cursors for the paged lists (#458-shape): non-null ⇒ older entries exist
  // ("Load more"); null ⇒ the loaded window is the whole list.
  const [appsCursor, setAppsCursor] = useState<string | null>(null);
  const [appsLoadingMore, setAppsLoadingMore] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [membersLoadingMore, setMembersLoadingMore] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [promoting, setPromoting] = useState(false);
  const [route, setRoute] = useState<Route>(parsePath);
  const [dark, setDark] = useState(() => {
    // `?theme=dark|light` wins on load (handy for demos + screenshots); otherwise
    // the per-user preference persisted in localStorage.
    const forced = new URLSearchParams(window.location.search).get('theme');
    if (forced === 'dark' || forced === 'light') return forced === 'dark';
    return localStorage.getItem('substrat.dash.theme') === 'dark';
  });
  const [palette, setPalette] = useState(false);
  const [notifs, setNotifs] = useState(false);
  const [unread, setUnread] = useState(true);
  const [toast, setToast] = useState<{ status: 'success' | 'danger'; title: string; detail?: string }>();
  // Set when a signed-in user follows an invite meant for a different email — shown
  // instead of dropping them into onboarding ("create a team").
  const [inviteBlock, setInviteBlock] = useState<{ token: string; teamName?: string; invitedEmail?: string; signedInAs?: string } | null>(null);

  // Theme → data-theme on the root (every token flips; no per-theme overrides).
  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    localStorage.setItem('substrat.dash.theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Path routing (History API): Back/Forward and our own `navigate()` both fire
  // `popstate`, so re-parse the location from there.
  useEffect(() => {
    const onPop = () => setRoute(parsePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ⌘K opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Refresh = back to the FIRST page (the newest window); "Load more" appends below.
  const reloadApps = useCallback(async () => {
    if (DEV_MOCK) return;
    const page = await api.listApps();
    setApps(page.entries);
    setAppsCursor(page.nextCursor);
  }, []);

  const appsMoreRef = useRef(false);
  const loadMoreApps = useCallback(async () => {
    if (DEV_MOCK || appsMoreRef.current || !appsCursor) return;
    appsMoreRef.current = true;
    setAppsLoadingMore(true);
    try {
      const page = await api.listApps({ cursor: appsCursor });
      // Dedupe against a refresh that raced this append (the provisioning poll).
      setApps((prev) => [...prev, ...page.entries.filter((e) => !prev.some((p) => p.id === e.id))]);
      setAppsCursor(page.nextCursor);
    } finally {
      appsMoreRef.current = false;
      setAppsLoadingMore(false);
    }
  }, [appsCursor]);

  /** The install's durable step record (#424), for the cards' live progress list. */
  const loadInstallSteps = useCallback(
    (scopeId: string) => (DEV_MOCK ? Promise.resolve([]) : api.installSteps(scopeId)),
    [],
  );

  const reloadDeployments = useCallback(async () => {
    if (DEV_MOCK) return;
    setDeployments(await api.listDeployments());
  }, []);

  // Git-import state is fetched lazily by the Create-App view (it hits GitHub), so it
  // isn't loaded on every dashboard open. Mock-aware so the dev preview renders it.
  const loadGitRepos = useCallback(async (account?: string): Promise<GitReposResult> => (DEV_MOCK ? MOCK_GIT_REPOS : api.gitRepos(account)), []);

  // Session check → on sign-in, load apps + members + catalog + deployments. First,
  // handle an invite acceptance (a `/invite/<token>` link, or one stashed across the
  // login round-trip). Dev-preview short-circuits to the demo tenant, no OIDC.
  useEffect(() => {
    if (DEV_MOCK) {
      // `?onboarding=1` previews the teamless first-run screen without a backend.
      if (new URLSearchParams(window.location.search).get('onboarding') === '1') {
        setMe({ needsOnboarding: true, email: MOCK_ME.email, name: MOCK_ME.name });
        return;
      }
      setMe(MOCK_ME);
      setApps(MOCK_APPS);
      setMembers(MOCK_MEMBERS);
      setCatalog(MOCK_CATALOG);
      setDeployments(MOCK_DEPLOYMENTS);
      return;
    }
    let live = true;
    void (async () => {
      // 1. Invite acceptance. The invite is carried THROUGH auth by the OIDC layer's
      //    `returnTo` (the callback returns here to `/invite/<token>`), so there is no
      //    localStorage stash and the accept always runs with a session in hand.
      const token = window.location.pathname.match(/^\/invite\/([^/]+)$/)?.[1] ?? null;
      if (token) {
        const who = await api.me();
        const preview = await api.previewInvite(token).catch(() => null);
        if (!who) {
          // Not signed in. Prefill the invited email and default to the sign-up screen
          // (invitees are usually new), then come back to this same link to accept.
          signIn({ returnTo: `/invite/${token}`, loginHint: preview?.email, screenHint: 'signup' });
          return;
        }
        // Signed in: this invite belongs to a specific email, so verify it is THIS
        // account before doing anything. An existing member (e.g. the team owner) would
        // otherwise be silently switched in by the server's "already a member" shortcut
        // when they open an invite meant for someone else — never learning it wasn't
        // theirs. If it doesn't match, block and offer to sign out into the invited email.
        const myEmail = (who as { email?: string | null }).email?.trim().toLowerCase();
        const invitedEmail = preview?.email?.trim().toLowerCase();
        if (preview && invitedEmail && invitedEmail !== myEmail) {
          if (!live) return;
          window.history.replaceState(null, '', '/');
          setInviteBlock({ token, teamName: preview.teamName, invitedEmail: preview.email, signedInAs: (who as { email?: string | null }).email ?? undefined });
          return;
        }
        try {
          await api.acceptInvite(token);
          window.history.replaceState(null, '', '/team');
          window.location.reload();
          return;
        } catch {
          // Signed in with the right email but the engine still refused (the invite
          // lapsed or was revoked). Show a clear block, never the onboarding dead-end.
          if (!live) return;
          window.history.replaceState(null, '', '/');
          setInviteBlock({ token, teamName: preview?.teamName, invitedEmail: preview?.email, signedInAs: (who as { email?: string | null }).email ?? undefined });
          return;
        }
      }

      // 2. Normal session load. Signed out → hand straight off to the IdP (there is
      //    no local sign-in page). The one exception is a failed login round-trip
      //    (`?error=auth`), where redirecting again would loop — that renders the
      //    retry card instead.
      let m = await api.me();
      if (!live) return;
      if (m === null && new URLSearchParams(window.location.search).get('error') !== 'auth') {
        const here = `${window.location.pathname}${window.location.search}`;
        signIn(here !== '/' ? { returnTo: here } : {});
        return; // `me` stays undefined → interstitial while the browser navigates
      }
      // A team-prefixed deep link (`/other-team/apps`) may name a DIFFERENT team than
      // the cookie-pinned one — switch BEFORE the fetch burst below so everything
      // loads scoped to the team the URL asks for. An unknown slug is left alone
      // here; the normalize effect rewrites it onto the pinned team.
      if (m && !needsOnboarding(m)) {
        const session = m;
        const urlTeam = parsePath().team;
        const current = session.teams.find((t) => t.id === session.currentTeamId);
        const target = urlTeam && urlTeam !== current?.slug ? session.teams.find((t) => t.slug === urlTeam) : undefined;
        if (target) {
          await api.switchTeam(target.id);
          m = (await api.me()) ?? m;
          if (!live) return;
        }
      }
      setMe(m);
      // A teamless login (onboarding) has nothing to load yet — skip the fetches.
      if (m && !needsOnboarding(m)) {
        const emptyPage = { entries: [] as Member[], nextCursor: null };
        const [a, mem, c, d] = await Promise.all([
          api.listApps(),
          api.listMembers().catch(() => emptyPage),
          api.catalog(),
          api.listDeployments().catch(() => []),
        ]);
        if (!live) return;
        setApps(a.entries);
        setAppsCursor(a.nextCursor);
        setMembers(mem.entries);
        setMembersCursor(mem.nextCursor);
        setCatalog(c);
        setDeployments(d);
      }
      setAppsLoading(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Team-in-URL bookkeeping: pin the current team's slug so `navigate()` prefixes
  // every path, rewrite legacy slug-less paths (`/apps` → `/<team>/apps`) and
  // unknown slugs onto the pinned team, and honor a Back/Forward landing on
  // ANOTHER team's history entry by re-scoping onto that team (full reload — the
  // whole portal re-scopes server-side, same as the switcher).
  useEffect(() => {
    if (!me || needsOnboarding(me) || window.location.pathname.startsWith('/invite/')) return;
    const slug = me.teams.find((t) => t.id === me.currentTeamId)?.slug;
    if (!slug) return;
    setTeamSlug(slug);
    if (route.team === slug) return;
    const target = route.team ? me.teams.find((t) => t.slug === route.team) : undefined;
    if (target) {
      // First loads switch in the session effect above (before data fetches); this
      // branch covers in-page history traversal across teams.
      if (DEV_MOCK) setMe({ ...me, currentTeamId: target.id, tenant: target.id });
      else void api.switchTeam(target.id).then(() => window.location.reload()).catch(() => {});
      return;
    }
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (route.team) parts.shift(); // an unknown slug — swap it for the pinned team's
    window.history.replaceState(null, '', `/${[slug, ...parts].join('/')}${window.location.search}`);
    setRoute(parsePath());
  }, [me, route.team]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // While any install is running, refresh the list on a short poll (#424): the row's
  // status flip (and the server-side reconcile of a stranded 'provisioning' row against
  // the directory) lands without a manual reload. There is no poll otherwise — the list
  // is event-driven (create/retry/resume all reload explicitly).
  useEffect(() => {
    if (DEV_MOCK || !apps.some((a) => a.status === 'provisioning')) return;
    const t = setInterval(() => void reloadApps().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [apps, reloadApps]);

  const createApp = useCallback(
    async (input: { verticalSlug: string; name: string; auth?: AppAuthChoice; config?: Record<string, string> }) => {
      let name = input.name;
      try {
        if (DEV_MOCK) {
          const row: AppRow = { id: String(Date.now()), app_scope_id: `01J${Date.now()}`, vertical_slug: input.verticalSlug, name, status: 'provisioning', hostname: null, created_by: MOCK_ME.email!, created_at: new Date().toISOString() };
          setApps((a) => [row, ...a]);
        } else {
          const row = await api.createApp(input);
          name = row.name;
          await reloadApps();
        }
        go('/apps');
        setToast({ status: 'success', title: `${name} is provisioning`, detail: 'It will appear in your grid as it comes up.' });
      } catch (e) {
        // The row (if any) is now `failed`, not silently `provisioning` — surface why.
        await reloadApps().catch(() => {});
        go('/apps');
        setToast({ status: 'danger', title: `Couldn’t create ${name}`, detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [reloadApps],
  );

  const deletingRef = useRef(false);
  const deleteApp = useCallback(
    async (app: AppRow) => {
      // Guard the double-click: ignore a second delete while one is already in flight.
      if (deletingRef.current) return;
      deletingRef.current = true;
      try {
        if (DEV_MOCK) setApps((a) => a.filter((x) => x.id !== app.id));
        else {
          await api.deleteApp(app.id);
          await reloadApps();
        }
        go('/apps');
        setToast({ status: 'success', title: `${app.name} deleted`, detail: 'Its hostname is offline; audit history is retained.' });
      } catch (e) {
        // Already gone (e.g. a slipped double-submit) is the state we wanted, not an error.
        if (e instanceof ApiError && e.status === 404) {
          await reloadApps();
          go('/apps');
        } else {
          setToast({ status: 'danger', title: 'Delete failed', detail: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        deletingRef.current = false;
      }
    },
    [reloadApps],
  );

  const retryingRef = useRef(false);
  const retryApp = useCallback(
    async (scopeId: string) => {
      // Guard the double-click, same as delete.
      if (retryingRef.current) return;
      retryingRef.current = true;
      try {
        if (DEV_MOCK) {
          setApps((a) => a.map((x) => (x.app_scope_id === scopeId ? { ...x, status: 'provisioning' } : x)));
        } else {
          await api.retryApp(scopeId);
          await reloadApps();
        }
        go('/apps');
        setToast({ status: 'success', title: 'Retrying', detail: 'Re-provisioning the app — it will update in your grid as it comes up.' });
      } catch (e) {
        // A retry that still fails re-marks the row failed and surfaces the REAL error.
        await reloadApps().catch(() => {});
        go('/apps');
        setToast({ status: 'danger', title: 'Retry failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        retryingRef.current = false;
      }
    },
    [reloadApps],
  );

  const resumingRef = useRef(false);
  const resumeApp = useCallback(
    async (scopeId: string) => {
      if (resumingRef.current) return;
      resumingRef.current = true;
      try {
        if (DEV_MOCK) {
          setApps((a) => a.map((x) => (x.app_scope_id === scopeId ? { ...x, status: 'active' } : x)));
        } else {
          await api.resumeApp(scopeId);
          await reloadApps();
        }
        setToast({ status: 'success', title: 'Resumed', detail: 'Setup finished — the app is active.' });
      } catch (e) {
        // A resume that still can't come up marks the row failed with the REAL error,
        // which unlocks Retry on the card.
        await reloadApps().catch(() => {});
        setToast({ status: 'danger', title: 'Resume failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        resumingRef.current = false;
      }
    },
    [reloadApps],
  );

  const promoteDeployment = useCallback(
    async (slug: string, versionId: string, channel: 'prod') => {
      if (promoting) return;
      setPromoting(true);
      try {
        if (DEV_MOCK) {
          setDeployments((ds) =>
            ds.map((d) =>
              d.slug !== slug
                ? d
                : { ...d, channels: [...d.channels.filter((c) => c.channel !== channel), { channel, versionId }] },
            ),
          );
        } else {
          try {
            await api.promoteDeployment(slug, channel, versionId);
          } catch (e) {
            // The registry refuses a promotion that changes the permission or migration
            // surface until the change is acknowledged (the §4 checkpoint). Surface the
            // refusal verbatim and let the person acknowledge it deliberately — the same
            // dialog the staff console shows, one confirm instead of a silent flag.
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes('acknowledge it explicitly')) throw e;
            if (!window.confirm(`${msg}\n\nPromote anyway?`)) throw new Error('Promotion cancelled — the change was not acknowledged.');
            await api.promoteDeployment(slug, channel, versionId, { permissionChange: true, migrationChange: true });
          }
          await reloadDeployments();
        }
        setToast({ status: 'success', title: `Promoted to ${channel}`, detail: `${slug} now serves ${channel} from this version.` });
      } catch (e) {
        setToast({ status: 'danger', title: 'Promotion failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        setPromoting(false);
      }
    },
    [promoting, reloadDeployments],
  );

  // Remove a pushed vertical (versions + channels included). The registry refuses while
  // any app still runs it — the refusal names the count — so this can never strand an
  // install; the confirm carries that rule so the refusal is never a surprise.
  const removeDeployment = useCallback(
    async (slug: string) => {
      if (promoting) return;
      if (
        !window.confirm(
          `Remove ${slug}?\n\nIts pushed versions and release channels are deleted from the registry. Apps still running it block the removal — delete them first.`,
        )
      )
        return;
      setPromoting(true);
      try {
        if (DEV_MOCK) {
          setDeployments((ds) => ds.filter((d) => d.slug !== slug));
        } else {
          await api.deleteDeployment(slug);
          await reloadDeployments();
        }
        setToast({ status: 'success', title: 'Vertical removed', detail: `${slug} was removed from the registry.` });
      } catch (e) {
        setToast({ status: 'danger', title: 'Removal failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        setPromoting(false);
      }
    },
    [promoting, reloadDeployments],
  );

  // Switch team → the server pins the choice in a cookie and the whole portal
  // re-scopes on reload. Dev-preview just flips the local mock selection.
  const switchTeam = useCallback(
    async (teamId: string) => {
      if (!me || needsOnboarding(me) || teamId === me.currentTeamId) return;
      const slug = me.teams.find((t) => t.id === teamId)?.slug;
      if (DEV_MOCK) {
        setTeamSlug(slug ?? null);
        setMe((m) => (m ? { ...m, currentTeamId: teamId as Me['currentTeamId'], tenant: teamId as Me['tenant'] } : m));
        go('/overview');
        return;
      }
      try {
        await api.switchTeam(teamId);
        // A full navigation onto the new team's URL re-scopes the whole portal.
        window.location.href = slug ? `/${slug}/overview` : '/overview';
      } catch (e) {
        setToast({ status: 'danger', title: 'Could not switch team', detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [me],
  );

  // Create a team → the server provisions it, links the owner, and switches to it,
  // so the client reloads onto the new team. Dev-preview mutates the local mock.
  const createTeam = useCallback(
    async (name: string) => {
      const teamName = name.trim();
      if (!teamName || creatingTeam) return;
      setCreatingTeam(true);
      try {
        if (DEV_MOCK) {
          const id = `01J2Q8Z3V9K4W7X2M5N6P7T${Date.now().toString().slice(-3)}`;
          setMe((m) => {
            const base: Me = m && !needsOnboarding(m) ? m : { ...MOCK_ME, teams: [] };
            const team = { id: id as Me['tenant'], name: teamName, slug: teamName.toLowerCase() };
            return { ...base, teams: [...base.teams, team], currentTeamId: id as Me['currentTeamId'], tenant: id as Me['tenant'] };
          });
          setNewTeamOpen(false);
          setNewTeamName('');
          setTeamSlug(teamName.toLowerCase());
          go('/overview');
          setToast({ status: 'success', title: `${teamName} created`, detail: 'You’re now in your new team.' });
          return;
        }
        await api.createTeam(teamName);
        // Land on the ROOT, not a reload of the old team's URL: the fresh load pins
        // the new team and the normalize effect prefixes its slug.
        window.location.href = '/';
      } catch (e) {
        setToast({ status: 'danger', title: 'Could not create team', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        setCreatingTeam(false);
      }
    },
    [creatingTeam],
  );

  const reloadMembers = useCallback(async () => {
    if (DEV_MOCK) return;
    const page = await api.listMembers().catch(() => ({ entries: [] as Member[], nextCursor: null }));
    setMembers(page.entries);
    setMembersCursor(page.nextCursor);
  }, []);

  // Keep the dashboard live without a manual browser reload: refetch when the tab
  // regains focus, plus a 30s poll while it stays visible (the provisioning poll
  // above stays — 5s is the right cadence for an install in flight). Catalog rides
  // along so a freshly pushed vertical version shows up too.
  const refreshAll = useCallback(async () => {
    if (DEV_MOCK) return;
    await Promise.all([reloadApps(), reloadMembers(), reloadDeployments(), api.catalog().then(setCatalog)]);
  }, [reloadApps, reloadMembers, reloadDeployments]);
  useAutoRefresh(refreshAll, { enabled: !DEV_MOCK && me != null && !needsOnboarding(me) && !inviteBlock });

  const membersMoreRef = useRef(false);
  const loadMoreMembers = useCallback(async () => {
    if (DEV_MOCK || membersMoreRef.current || !membersCursor) return;
    membersMoreRef.current = true;
    setMembersLoadingMore(true);
    try {
      const page = await api.listMembers({ cursor: membersCursor });
      setMembers((prev) => [...prev, ...page.entries.filter((e) => !prev.some((p) => p.id === e.id))]);
      setMembersCursor(page.nextCursor);
    } finally {
      membersMoreRef.current = false;
      setMembersLoadingMore(false);
    }
  }, [membersCursor]);

  // Invite a member → returns a shareable accept link (Team shows it to copy). The
  // roster refreshes so the pending invite appears. Dev-preview fakes both.
  const inviteMember = useCallback(
    async (email: string, roleKey: InviteRole): Promise<{ acceptUrl: string } | void> => {
      if (DEV_MOCK) {
        const id = String(Date.now());
        setMembers((ms) => [
          { id, principal: null, email, role_key: roleKey, status: 'invited', invitation_id: id, invited_by: 'you', invited_at: new Date().toISOString(), joined_at: null },
          ...ms,
        ]);
        return { acceptUrl: `${window.location.origin}/invite/demo-${id}` };
      }
      const res = await api.inviteMember(email, roleKey);
      await reloadMembers();
      return res;
    },
    [reloadMembers],
  );

  const revokeInvite = useCallback(
    async (invitationId: string) => {
      try {
        if (DEV_MOCK) setMembers((ms) => ms.filter((m) => m.invitation_id !== invitationId));
        else {
          await api.revokeInvite(invitationId);
          await reloadMembers();
        }
        setToast({ status: 'success', title: 'Invite revoked' });
      } catch (e) {
        setToast({ status: 'danger', title: 'Could not revoke invite', detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [reloadMembers],
  );

  // Resend a pending invite's email. The link may be refreshed (a lapsed invitation is
  // renewed), so reload the roster to pick up the new id. Dev-preview just toasts.
  const resendInvite = useCallback(
    async (invitationId: string) => {
      try {
        if (!DEV_MOCK) {
          const res = await api.resendInvite(invitationId);
          await reloadMembers();
          setToast(
            res.emailDelivered
              ? { status: 'success', title: 'Invite re-sent' }
              : { status: 'danger', title: 'Invite re-sent, but email delivery failed', detail: 'Share the link manually — check the email sending setup.' },
          );
        } else {
          setToast({ status: 'success', title: 'Invite re-sent' });
        }
      } catch (e) {
        setToast({ status: 'danger', title: 'Could not resend invite', detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [reloadMembers],
  );

  const removeMember = useCallback(
    async (memberId: string) => {
      try {
        if (DEV_MOCK) setMembers((ms) => ms.filter((m) => m.id !== memberId));
        else {
          await api.removeMember(memberId);
          await reloadMembers();
        }
        setToast({ status: 'success', title: 'Member removed', detail: 'Their access is revoked.' });
      } catch (e) {
        setToast({ status: 'danger', title: 'Could not remove member', detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [reloadMembers],
  );

  const openApp = useMemo(() => (route.app ? apps.find((a) => a.app_scope_id === route.app) : undefined), [apps, route.app]);
  const openVertical = useMemo(() => (route.vertical ? deployments.find((d) => d.slug === route.vertical) : undefined), [deployments, route.vertical]);

  // A deep-linked app can sit beyond the loaded page window — keep walking older
  // pages until it turns up (or the list is exhausted), instead of flashing a 404.
  useEffect(() => {
    if (DEV_MOCK || !route.app || appsLoading || !appsCursor) return;
    if (apps.some((a) => a.app_scope_id === route.app)) return;
    void loadMoreApps().catch(() => {});
  }, [route.app, apps, appsCursor, appsLoading, loadMoreApps]);

  // The team's issuer instances offered in Identity pickers (#427): any ACTIVE app of a
  // vertical that DECLARES `provides: ['oidc-issuer']` (capability-driven, from the
  // catalog), plus the legacy `auth-server` slug for rows pushed before the declaration.
  const oidcProviderSlugs = useMemo(() => {
    const slugs = new Set(['auth-server']);
    for (const entry of catalog) if (entry.provides?.includes('oidc-issuer')) slugs.add(entry.slug);
    return slugs;
  }, [catalog]);

  // Session mode: checking → interstitial; signed out → redirect to the IdP (only a
  // failed round-trip renders the retry card); signed in but teamless → onboarding
  // (name your first team).
  if (inviteBlock) {
    return (
      <InviteBlocked
        teamName={inviteBlock.teamName}
        invitedEmail={inviteBlock.invitedEmail}
        signedInAs={inviteBlock.signedInAs}
        onSignOut={() => signOut({ returnTo: `/invite/${inviteBlock.token}` })}
        onContinue={() => window.location.assign('/')}
      />
    );
  }
  if (me === undefined) return <Interstitial />;
  if (me === null) {
    const failed = new URLSearchParams(window.location.search).get('error') === 'auth';
    return <SignIn error={failed} />;
  }
  if (needsOnboarding(me)) {
    return <Onboarding name={me.name} busy={creatingTeam} onCreate={(n) => void createTeam(n)} />;
  }

  const currentTeam = me.teams?.find((t) => t.id === me.currentTeamId);
  const org = currentTeam?.name ?? orgFrom(me.email);
  const activeNav: NavKey = route.section === 'new' ? 'apps' : route.section;

  const authServers = apps.filter((a) => oidcProviderSlugs.has(a.vertical_slug) && a.status === 'active' && a.hostname);

  const crumbs: Crumb[] = [{ label: org, onClick: () => go('/overview') }];
  if (route.section === 'apps' || route.section === 'new') crumbs.push({ label: 'Apps', onClick: () => go('/apps') });
  if (route.section === 'new') crumbs.push({ label: 'New app' });
  if (route.section === 'apps' && openApp) crumbs.push({ label: openApp.name });
  if (route.section === 'verticals') {
    crumbs.push({ label: 'Verticals', onClick: route.vertical ? () => go('/verticals') : undefined });
    if (openVertical) crumbs.push({ label: openVertical.name });
  }
  if (['domains', 'team', 'integrations', 'analytics', 'billing', 'settings'].includes(route.section)) {
    crumbs.push({ label: route.section.charAt(0).toUpperCase() + route.section.slice(1) });
  }

  return (
    <DashShell
      active={activeNav}
      onNav={(k) => go(`/${k}`)}
      org={org}
      teams={me.teams ?? []}
      currentTeamId={me.currentTeamId}
      onSwitchTeam={(id) => void switchTeam(id)}
      onNewTeam={() => { setNewTeamName(''); setNewTeamOpen(true); }}
      userEmail={me.email ?? 'you@substrat.run'}
      userName={me.name ?? me.email?.split('@')[0] ?? 'Account'}
      crumbs={crumbs}
      unread={unread}
      onToggleTheme={() => setDark((d) => !d)}
      onOpenPalette={() => setPalette(true)}
      onOpenNotifications={() => { setNotifs(true); setUnread(false); }}
      onSignOut={signOut}
    >
      {route.section === 'new' ? (
        <CreateApp
          catalog={catalog}
          teamName={currentTeam?.name}
          authServers={authServers}
          onCancel={() => go('/apps')}
          onCreate={createApp}
        />
      ) : route.section === 'apps' && openApp ? (
        <AppDetail
          app={openApp}
          tab={route.tab ?? 'overview'}
          onTab={(t) => go(`/apps/${openApp.app_scope_id}/${t}`)}
          onDeleted={() => void deleteApp(openApp)}
          authServers={authServers}
        />
      ) : route.section === 'apps' && route.app ? (
        // While the first listApps() is in flight — or older pages are still being
        // walked for a deep link — the app is merely unresolved, not missing: the
        // skeleton, never a flashed 404.
        appsLoading || appsCursor !== null ? (
          <Apps apps={apps} loading onCreate={() => go('/apps/new')} onOpen={() => {}} onRetry={() => {}} />
        ) : (
          <NotFound label="That app could not be found." onBack={() => go('/apps')} />
        )
      ) : route.section === 'overview' || route.section === 'apps' ? (
        <Apps apps={apps} loading={appsLoading} onCreate={() => go('/apps/new')} onOpen={(s) => go(`/apps/${s}/overview`)} onRetry={(s) => void retryApp(s)} onResume={(s) => void resumeApp(s)} loadSteps={loadInstallSteps} hasMore={appsCursor !== null} loadingMore={appsLoadingMore} onLoadMore={() => void loadMoreApps()} />
      ) : route.section === 'verticals' && openVertical ? (
        <VerticalDetail
          d={openVertical}
          busy={promoting}
          onPromote={(vid, ch) => void promoteDeployment(openVertical.slug, vid, ch)}
          onRemove={() => void removeDeployment(openVertical.slug)}
          onBack={() => go('/verticals')}
        />
      ) : route.section === 'verticals' && route.vertical ? (
        // The deployments list loads with the first session fetch — while it's in flight
        // the vertical is unresolved, not missing (the same 404-flash guard as apps).
        appsLoading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</div>
        ) : (
          <NotFound label="That vertical could not be found." backLabel="Back to verticals" onBack={() => go('/verticals')} />
        )
      ) : route.section === 'verticals' ? (
        <Verticals deployments={deployments} onPromote={(slug, vid, ch) => void promoteDeployment(slug, vid, ch)} onRemove={(slug) => void removeDeployment(slug)} onOpen={(slug) => go(`/verticals/${encodeURIComponent(slug)}`)} busy={promoting} loadGitRepos={loadGitRepos} />
      ) : route.section === 'team' ? (
        <Team
          members={members}
          meEmail={me.email ?? ''}
          canManage={['owner', 'admin'].includes(members.find((m) => m.principal === me.principal)?.role_key ?? 'owner')}
          onInvite={inviteMember}
          onResend={(id) => void resendInvite(id)}
          onRevoke={(id) => void revokeInvite(id)}
          onRemove={(id) => void removeMember(id)}
          hasMore={membersCursor !== null}
          loadingMore={membersLoadingMore}
          onLoadMore={() => void loadMoreMembers()}
        />
      ) : route.section === 'domains' ? (
        <Domains />
      ) : route.section === 'integrations' ? (
        <Integrations />
      ) : route.section === 'billing' ? (
        <Billing />
      ) : route.section === 'analytics' ? (
        <Analytics />
      ) : route.section === 'settings' ? (
        <Settings org={org} />
      ) : null}

      {palette && (
        <CommandPalette
          apps={apps.map((a) => {
            const m = verticalMeta(a.vertical_slug);
            return { name: a.name, accent: m.accent, status: a.status, host: a.hostname, onOpen: () => go(`/apps/${a.app_scope_id}/overview`) };
          })}
          onClose={() => setPalette(false)}
          onAction={(label) => {
            if (label === 'Create app') go('/apps/new');
            else if (label === 'Invite member') go('/team');
            else if (label === 'Add domain') go('/domains');
          }}
        />
      )}
      {notifs && <NotificationsPopover onClose={() => setNotifs(false)} onMarkRead={() => { setUnread(false); setNotifs(false); }} />}

      <Dialog
        open={newTeamOpen}
        title="Create a team"
        description="A team has its own apps, domains, and billing. You’ll be its owner."
        confirmLabel={creatingTeam ? 'Creating…' : 'Create team'}
        confirmDisabled={!newTeamName.trim() || creatingTeam}
        onConfirm={() => void createTeam(newTeamName)}
        onCancel={() => { setNewTeamOpen(false); setNewTeamName(''); }}
      >
        <div onKeyDown={(e) => { if (e.key === 'Enter' && newTeamName.trim()) void createTeam(newTeamName); }}>
          <Input label="Team name" placeholder="Acme Inc" value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} />
        </div>
      </Dialog>

      {toast && (
        <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 60 }}>
          <Toast status={toast.status} title={toast.title} detail={toast.detail} />
        </div>
      )}
    </DashShell>
  );
}

function NotFound({ label, onBack, backLabel = 'Back to apps' }: { label: string; onBack: () => void; backLabel?: string }) {
  return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)' }}>
      {label} <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>{backLabel}</a>
    </div>
  );
}
