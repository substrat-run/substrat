/**
 * Artboards 09–12 — desk settings, admin only.
 *
 * 960px with a 180px nav, per the handoff. The two screens with real weight are
 * Identity verification (10), where a secret is shown exactly once, and Usage (12),
 * where a per-token price gets a type treatment rather than a rounding.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import {
  api,
  assistantStatus,
  invites,
  refreshKbSource,
  type AgentProfile,
  type AssistantStatus,
  type Contact,
  type KbSource,
  type PendingInvite,
  type Session,
} from '../api.js';
import { contacts } from '../contacts.js';
import { Avatar, Dot, Empty, UnitPrice, ago } from '../ui.js';

export type SettingsTab =
  | 'you'
  | 'desk'
  | 'team'
  | 'identity'
  | 'knowledge'
  | 'assistant'
  | 'usage';

/**
 * The tab strip, and what each tab needs to be worth showing.
 *
 * `admin: false` is the whole reason this is a table rather than a literal: "You" is
 * the one screen an ordinary agent has business on, and Settings used to refuse them
 * outright — which is how a desk full of agents ended up with a directory nobody could
 * put themselves in.
 */
const TABS: { id: SettingsTab; label: string; admin: boolean }[] = [
  { id: 'you', label: 'You', admin: false },
  { id: 'desk', label: 'Desk', admin: true },
  { id: 'team', label: 'Team', admin: true },
  { id: 'identity', label: 'Identity verification', admin: true },
  { id: 'knowledge', label: 'Knowledge base', admin: true },
  { id: 'assistant', label: 'Assistant', admin: true },
  { id: 'usage', label: 'Usage & cost', admin: true },
];

export function Settings({
  tab,
  caps,
  session,
  go,
}: {
  tab: SettingsTab;
  caps: Capabilities | null;
  session: Session;
  go: (v: View) => void;
}) {
  const admin = caps?.configure === true;
  const tabs = TABS.filter((t) => admin || !t.admin);
  // A deep link to an admin tab held by somebody who is not one — a bookmark, or a
  // link a colleague pasted. Land them on what they may see rather than on a wall.
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id;

  return (
    <div
      className="frame"
      style={{ width: 960, maxWidth: '100%', display: 'grid', gridTemplateColumns: '180px 1fr', background: 'var(--surface)' }}
    >
      <nav style={{ borderRight: '1px solid var(--hairline)', padding: 12, background: 'var(--app-bg)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => go({ name: 'settings', tab: t.id })}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 0,
              cursor: 'pointer',
              borderRadius: 6,
              padding: '7px 10px',
              marginBottom: 2,
              font: `${t.id === active ? 600 : 500} 12px 'Geist', sans-serif`,
              color: t.id === active ? 'var(--text)' : 'var(--secondary)',
              background: t.id === active ? 'var(--nav-active)' : 'transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <section style={{ padding: 22, minHeight: 460 }}>
        {active === 'you' ? <You session={session} /> : null}
        {active === 'desk' ? <Desk /> : null}
        {active === 'team' ? <Team session={session} /> : null}
        {active === 'identity' ? <Identity /> : null}
        {active === 'knowledge' ? <Knowledge /> : null}
        {active === 'assistant' ? <Assistant go={go} /> : null}
        {active === 'usage' ? <Usage money={caps?.money === true} /> : null}
      </section>
    </div>
  );
}

function Head({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="t-page">{title}</div>
      {note ? (
        <div className="t-meta" style={{ marginTop: 4 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div className="micro" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {children}
      {hint ? (
        <div className="t-small" style={{ marginTop: 5 }}>
          {hint}
        </div>
      ) : null}
    </label>
  );
}


/* ── Team ───────────────────────────────────────────────────────────────── */

/**
 * Who works this desk, and how a second person gets here at all.
 *
 * The two lists are deliberately not one. The **directory** is `list-agents` — the
 * `agentProfile` rows, which are what makes somebody assignable, and which the
 * `assign` handler validates against. **Pending invites** are a host-surface fact
 * living outside the scope entirely (a pre-minted principal and a hashed token in the
 * identity directory), and somebody who has not accepted holds a role and belongs in
 * no picker. Merging them into one roster would put a name in front of an agent that
 * `assign` would then refuse.
 */
function Team({ session }: { session: Session }) {
  const [staff, setStaff] = useState<AgentProfile[] | null>(null);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  const [role, setRole] = useState('agent');
  const [email, setEmail] = useState('');
  const [contactId, setContactId] = useState('');
  const [people, setPeople] = useState<Contact[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    // The directory is read fresh here, not through `agents()`: that cache exists so a
    // hundred rows in the inbox resolve one name each, and this is the screen where
    // somebody has just changed who is in it.
    void api
      .listAgents()
      .then((p) => setStaff(p.entries))
      .catch((e: Error) => setLoadFailed(e.message));
    void invites
      .list()
      .then((r) => {
        setPending(r.invites);
        setRoles(r.roles);
        setRole((cur) => (r.roles.includes(cur) ? cur : (r.roles[0] ?? '')));
      })
      .catch((e: Error) => setLoadFailed(e.message));
  }, []);
  useEffect(load, [load]);

  // Only for a customer invite, and only then: the portal is a grant on ONE contact,
  // so the form has to name which — and a free-text ULID field would be a way to make
  // a typo permanent.
  useEffect(() => {
    if (role !== 'customer' || people.length > 0) return;
    void contacts().then((m) => setPeople([...m.values()]));
  }, [role, people.length]);

  const create = async () => {
    setBusy(true);
    setFailed(null);
    setLink(null);
    setCopied(false);
    try {
      const made = await invites.create({
        roleKey: role,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(role === 'customer' && contactId ? { contactId } : {}),
      });
      setLink(made.acceptUrl);
      setEmail('');
      setContactId('');
      load();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (principal: string) => {
    setFailed(null);
    try {
      await invites.revoke(principal);
      load();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  if (loadFailed) return <Empty title="Could not load the team" note={loadFailed} />;

  return (
    <>
      <Head
        title="Team"
        note="Everyone who works this desk. An invite grants a role at once and hands back a one-time link — the person holds it until they sign in."
      />

      <div className="micro" style={{ marginBottom: 8 }}>
        On the desk
      </div>
      <div style={{ marginBottom: 26 }}>
        {staff === null ? (
          <div className="t-meta">Loading…</div>
        ) : staff.length === 0 ? (
          <div className="t-small" style={{ color: 'var(--secondary)' }}>
            Nobody has a profile yet — so the assignee picker has nothing to offer. Set
            yours under “You”, and invite the rest of the desk below.
          </div>
        ) : (
          staff.map((a) => (
            <Row key={a.principal}>
              <Avatar name={a.display_name} size={26} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="t-strong">
                  {a.display_name}
                  {a.principal === session.principal ? (
                    <span className="t-small" style={{ color: 'var(--secondary)' }}>
                      {' '}
                      · you
                    </span>
                  ) : null}
                </div>
                <div className="t-small mono" style={{ color: 'var(--secondary)' }}>
                  {a.principal}
                </div>
              </div>
            </Row>
          ))
        )}
      </div>

      <div className="micro" style={{ marginBottom: 8 }}>
        Invite somebody
      </div>
      <div
        style={{
          border: '1px solid var(--hairline)',
          borderRadius: 8,
          padding: 14,
          marginBottom: 26,
        }}
      >
        {failed ? (
          <div className="t-small" style={{ color: 'var(--red, #b3261e)', marginBottom: 10 }}>
            {failed}
          </div>
        ) : null}
        <Field
          label="Email"
          hint="For your own reference. The invite is claimed by whoever opens the link and signs in — this desk hosts no sign-up and sends no mail here."
        >
          <input
            className="input"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role" hint={ROLE_NOTE[role]}>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        {role === 'customer' ? (
          <Field
            label="Whose conversations"
            hint="A customer sees one contact's own history and nothing else — pick which."
          >
            <select
              className="input"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Choose a contact…</option>
              {people.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name ?? c.email ?? c.id}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <button
          className="btn btn-primary"
          disabled={busy || !role || (role === 'customer' && !contactId)}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
        {link ? (
          <div style={{ marginTop: 14 }}>
            <div className="t-small" style={{ marginBottom: 6 }}>
              Send this link to them. It works once, and it is shown once — only its hash
              is kept here.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input mono"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="micro" style={{ marginBottom: 8 }}>
        Invited, not yet arrived
      </div>
      {pending.length === 0 ? (
        <div className="t-small" style={{ color: 'var(--secondary)' }}>
          No outstanding invites.
        </div>
      ) : (
        pending.map((i) => (
          <Row key={i.principal}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="t-strong">{i.email ?? 'Invite'}</div>
              <div className="t-small" style={{ color: 'var(--secondary)' }}>
                {i.roleKey} · {ago(i.created_at)}
              </div>
            </div>
            <button className="btn btn-ghost" onClick={() => void revoke(i.principal)}>
              Revoke
            </button>
          </Row>
        ))
      )}
    </>
  );
}

/** What each role actually opens, said where the choice is made rather than in a doc. */
const ROLE_NOTE: Record<string, string> = {
  'desk-admin': 'The whole inbox, the settings, the knowledge base and the money.',
  agent: 'The whole inbox: reply, assign, resolve. No settings and no cost figures.',
  customer: 'The portal only — one contact’s own conversations, public messages.',
};

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderBottom: '1px solid var(--hairline)',
        padding: '10px 2px',
      }}
    >
      {children}
    </div>
  );
}

/* ── You ────────────────────────────────────────────────────────────────── */

/**
 * Your own profile — and the reason it is a screen rather than a detail.
 *
 * `ticket0_agent_profiles` IS the desk's directory: a profile is what makes somebody
 * assignable, and the model says so in as many words ("an agent who cannot be found in
 * the picker sets their profile and appears"). Until #1149 nothing in the app let
 * anybody do that, so on a hosted desk the row existed for nobody, `list-agents`
 * answered empty, and every owner cell showed the tail of a ULID.
 *
 * Joining now writes the row from the name the issuer knows, so this is a correction
 * rather than a first step — but it is the only place the name and the signature can
 * be corrected, and it is open to every agent, not only the admin. That is why the tab
 * strip below is capability-dependent and this tab is in it either way.
 */
function You({ session }: { session: Session }) {
  const [profile, setProfile] = useState<{ displayName: string; signature: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listAgents()
      .then((p) => {
        const mine = p.entries.find((a) => a.principal === session.principal);
        setProfile({
          // Falling back to the signed-in name means the field is never empty on a desk
          // where the row has not been written yet — the person confirms rather than types.
          displayName: mine?.display_name ?? session.display,
          signature: mine?.signature ?? '',
        });
      })
      .catch(() => setProfile({ displayName: session.display, signature: '' }));
  }, [session.principal, session.display]);

  if (!profile) return <div className="t-meta">Loading…</div>;

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFailed(null);
    try {
      await api.setAgentProfile({
        displayName: profile.displayName,
        avatarUrl: null,
        signature: profile.signature.trim() || null,
      });
      setSaved(true);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head
        title="You"
        note="How colleagues find you in the assignee picker, and how you sign off on mail that leaves the desk."
      />
      <Field label="Display name" hint="What the inbox, the rail and the picker call you.">
        <input
          className="input"
          value={profile.displayName}
          onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
        />
      </Field>
      <Field label="Signature" hint="Appended to outbound email. Left empty, nothing is added.">
        <textarea
          className="textarea"
          rows={3}
          value={profile.signature}
          onChange={(e) => setProfile({ ...profile, signature: e.target.value })}
        />
      </Field>
      {failed ? (
        <div className="t-small" style={{ color: 'var(--red, #b3261e)', marginBottom: 10 }}>
          {failed}
        </div>
      ) : null}
      <button
        className="btn btn-primary"
        disabled={saving || !profile.displayName.trim()}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {saved ? (
        <span className="t-small" style={{ marginLeft: 10, color: 'var(--green)' }}>
          Saved
        </span>
      ) : null}
    </>
  );
}

/* ── 09 Desk ────────────────────────────────────────────────────────────── */

function Desk() {
  const [desk, setDesk] = useState<{
    from_address: string;
    greeting: string;
    allowed_origins: string;
    business_hours: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Two failures, two states — deliberately not one.
   *
   * A load failure means there is no form to show; a save failure means the form is
   * right there with the user's edits in it. Sharing one `failed` between them threw
   * those edits away by unmounting the form to show the error about them.
   */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The origin being typed, and why the last one was refused. Kept apart from the
  // list itself: the list lives in `desk.allowed_origins`, the one string the save
  // sends, so what is shown and what is saved cannot be two different arrays.
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    void api.getDesk().then(setDesk).catch((e: Error) => setLoadFailed(e.message));
  }, []);
  // A rejected request is not a slow one. Saying "Loading…" forever is the screen
  // lying about which of the two happened.
  if (loadFailed) return <Empty title="Could not load the desk" note={loadFailed} />;
  if (!desk) return <div className="t-meta">Loading…</div>;

  const origins: string[] = JSON.parse(desk.allowed_origins || '[]');
  const setOrigins = (next: string[]) => setDesk({ ...desk, allowed_origins: JSON.stringify(next) });

  /**
   * An ORIGIN, not a URL. The browser sends `https://substrat.net` and the desk
   * compares strings, so `https://substrat.net/` or a page path pasted from the
   * address bar would save cleanly and never match. Reduce to the origin here, where
   * the person can see what was kept.
   */
  const addOrigin = () => {
    const raw = draft.trim();
    if (!raw) return;
    let origin: string;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      origin = url.origin;
    } catch {
      setDraftError(`"${raw}" is not an http(s) origin - try https://example.com`);
      return;
    }
    setDraftError(null);
    setDraft('');
    if (!origins.includes(origin)) setOrigins([...origins, origin]);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFailed(null);
    try {
      await api.configureDesk({
        fromAddress: desk.from_address,
        greeting: desk.greeting,
        allowedOrigins: origins,
        businessHours: desk.business_hours,
      });
      setSaved(true);
    } catch (e) {
      // Reported, not swallowed — and `finally` releases the button either way, so a
      // failure does not leave "Saving…" wedged on screen.
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head title="Desk" note="How this desk introduces itself, and where its widget may be embedded." />
      <Field
        label="From address"
        hint={
          <span style={{ color: 'var(--green)' }}>
            ● DNS verified · SPF, DKIM, MX
          </span>
        }
      >
        <input
          className="input mono"
          value={desk.from_address}
          onChange={(e) => setDesk({ ...desk, from_address: e.target.value })}
        />
      </Field>
      <Field label="Greeting" hint="The first thing a visitor sees in the widget.">
        <textarea
          className="textarea"
          rows={2}
          value={desk.greeting}
          onChange={(e) => setDesk({ ...desk, greeting: e.target.value })}
        />
      </Field>
      <Field label="Business hours">
        <input
          className="input"
          placeholder="Mon–Fri · 09:00–18:00 · Europe/Stockholm"
          value={desk.business_hours ?? ''}
          onChange={(e) => setDesk({ ...desk, business_hours: e.target.value || null })}
        />
      </Field>
      <Field
        label="Widget origins"
        hint="A site not on this list is refused before a conversation exists. Add the origin the page is served from, then Save."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {origins.length === 0 ? (
            <div className="t-small" style={{ color: 'var(--secondary)' }}>
              No origins yet - the widget is refused everywhere until one is added.
            </div>
          ) : null}
          {origins.map((o) => (
            <div
              key={o}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: '1px solid var(--hairline)',
                borderRadius: 6,
                padding: '7px 10px',
                background: 'var(--app-bg)',
              }}
            >
              <span className="mono" style={{ fontSize: 12, flex: 1 }}>
                {o}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOrigins(origins.filter((x) => x !== o))}
              >
                Remove
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              style={{ flex: 1, fontSize: 12 }}
              placeholder="https://www.example.com"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOrigin();
                }
              }}
            />
            <button type="button" className="btn btn-ghost" onClick={addOrigin} disabled={!draft.trim()}>
              Add
            </button>
          </div>
          {draftError ? (
            <div className="t-small" style={{ color: 'var(--danger-2)' }}>
              {draftError}
            </div>
          ) : null}
        </div>
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="t-small" style={{ color: 'var(--green)' }}>Saved.</span> : null}
        {failed ? (
          <span className="t-small" style={{ color: 'var(--danger-2)' }}>
            {failed}
          </span>
        ) : null}
      </div>
    </>
  );
}

/* ── 10 Identity verification ───────────────────────────────────────────── */

function Identity() {
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  return (
    <>
      <Head
        title="Identity verification"
        note="How a customer's own site vouches for who a visitor is, without a support login."
      />

      <div className="card" style={{ padding: 14, marginBottom: 18 }}>
        <div className="micro" style={{ marginBottom: 7 }}>
          Current secret
        </div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--secondary)' }}>
          t0_sec_•••••••••••••••••••••••••• — not retrievable
        </div>
        <div className="t-small" style={{ marginTop: 10, lineHeight: 1.6 }}>
          Your server computes{' '}
          <span className="mono" style={{ background: '#f1f1f0', padding: '1px 5px', borderRadius: 3 }}>
            user_hash = HMAC-SHA256(secret, user_id)
          </span>{' '}
          and passes it to the widget. The browser never holds the secret, which is what
          makes the claim trustworthy.
        </div>
      </div>

      {!secret ? (
        <button className="btn btn-danger" onClick={() => setRotating(true)} disabled={rotating}>
          Rotate…
        </button>
      ) : null}

      {rotating && !secret ? (
        <div
          style={{
            border: '1px solid var(--danger-border)',
            background: 'var(--danger-bg)',
            borderRadius: 8,
            padding: 14,
            marginTop: 14,
          }}
        >
          <div className="t-strong" style={{ color: 'var(--danger-2)', marginBottom: 6 }}>
            Rotating invalidates every signature your site is producing
          </div>
          <div className="t-small" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Verified visitors fall back to anonymous until your server picks up the new
            secret. The new value is shown once and never again.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-danger"
              onClick={() =>
                void api.rotateVerificationSecret().then((r) => setSecret(r.secret))
              }
            >
              Rotate the secret
            </button>
            <button className="btn btn-ghost" onClick={() => setRotating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* The rotation moment. Shown once, and the close button waits for the copy. */}
      {secret ? (
        <div
          style={{
            border: '1px solid #d9a0a0',
            borderRadius: 8,
            overflow: 'hidden',
            marginTop: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              background: 'var(--danger-bg)',
              borderBottom: '1px solid var(--danger-border-2)',
            }}
          >
            <div className="t-strong" style={{ color: 'var(--danger-2)' }}>
              Secret rotated — copy it now
            </div>
            <span
              className="mono"
              style={{
                marginLeft: 'auto',
                font: "600 10px 'Geist Mono', monospace",
                letterSpacing: '.07em',
                color: 'var(--danger)',
                border: '1px solid var(--danger-border)',
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              SHOWN ONCE
            </span>
          </div>
          <div style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
            <code
              className="mono"
              style={{
                flex: 1,
                fontSize: 12,
                background: 'var(--app-bg)',
                border: '1px solid var(--hairline)',
                borderRadius: 6,
                padding: '9px 11px',
                wordBreak: 'break-all',
              }}
            >
              {secret}
            </code>
            <button
              className="btn"
              style={{ background: '#17181a', borderColor: '#17181a', color: '#fff' }}
              onClick={() => {
                void navigator.clipboard?.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div
            style={{
              margin: '0 14px 14px',
              padding: '10px 12px',
              background: 'var(--danger-bg-2)',
              border: '1px solid var(--danger-border-2)',
              borderRadius: 6,
              font: "400 12px/1.6 'Geist', sans-serif",
              color: 'var(--danger-3)',
            }}
          >
            Signatures made with the old secret are already invalid. Verified visitors
            fall back to anonymous until your server is updated.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 14px',
              borderTop: '1px solid var(--hairline)',
              background: 'var(--app-bg)',
            }}
          >
            <span className="t-small mono">
              old secret invalidated {new Date().toISOString().slice(11, 19)} UTC
            </span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              disabled={!copied}
              onClick={() => {
                setSecret(null);
                setRotating(false);
                setCopied(false);
              }}
            >
              I've stored it — close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ── 11 Knowledge base ──────────────────────────────────────────────────── */

const GRID = '190px 1.6fr 56px 118px 96px 56px';

type Kind = KbSource['kind'];

/**
 * The kinds a person may add. `sitemap` is in the model but the fetcher does not
 * implement it yet — offering it would be a control that always fails.
 */
const KINDS: { value: Kind; label: string; hint: string }[] = [
  {
    value: 'llms-txt',
    label: 'llms.txt',
    hint: 'An llms.txt index of links, or an llms-full.txt corpus — told apart by shape, not by you.',
  },
  { value: 'markdown', label: 'Markdown', hint: 'One markdown page, cited whole.' },
];

const EMPTY_DRAFT = { label: '', url: '', kind: 'llms-txt' as Kind };

function Knowledge() {
  const [sources, setSources] = useState<KbSource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Two failures, two states. The list not loading is a page-level problem that the
  // loading fallback must not hide; an ingest being refused is news about ONE source,
  // and the successful re-read that follows it must not wipe that news.
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [ingestFailed, setIngestFailed] = useState<string | null>(null);
  // And a third, for the form: a refused add belongs beside the fields it refused,
  // not in the cards above the table, which are about sources that exist.
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [addFailed, setAddFailed] = useState<string | null>(null);

  // Returns the request, not `void`: the Re-read handler chains `.then(load)` and
  // clears `busy` in a `finally` — and a `load` that returned nothing would settle
  // that `finally` at once, re-enabling the button over a row it had not re-read yet.
  const load = () =>
    api
      .listKbSources()
      .then((p) => {
        setSources(p.entries);
        setLoadFailed(null);
      })
      .catch((e: Error) => setLoadFailed(e.message));
  useEffect(() => {
    void load();
  }, []);

  /**
   * Read one source now — the refresh route, which fetches, not `ingestKbSource`,
   * which only records the intent and left the row at "ingesting" for good.
   */
  const read = (id: string) => {
    setBusy(id);
    setIngestFailed(null);
    return (
      refreshKbSource(id)
        // Both ways, because a refused read is exactly when the row is most worth
        // re-reading: the failure is recorded on the source itself, and `.then(load)`
        // alone would never go and fetch it.
        .catch((e: Error) => setIngestFailed(e.message))
        .then(load)
        // `finally`, or a failed re-read leaves "Re-read" disabled for the rest of
        // the session — on the row most likely to need it.
        .finally(() => setBusy(null))
    );
  };

  const add = async () => {
    setAdding(true);
    setAddFailed(null);
    try {
      const s = await api.addKbSource({ ...draft, label: draft.label.trim(), url: draft.url.trim() });
      setDraft({ ...EMPTY_DRAFT, kind: draft.kind });
      // The row first, then the read: a source that fails its first read should
      // fail on screen, on its own row, not vanish behind an error about the form.
      await load();
      await read(s.id);
    } catch (e) {
      setAddFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const failures = [loadFailed, ingestFailed].filter((f): f is string => f !== null);
  const failureCards = failures.map((f) => (
    <div key={f} className="card" style={{ padding: '10px 14px', marginBottom: 12, color: 'var(--danger)' }}>
      <span className="t-small">{f}</span>
    </div>
  ));

  // The error before the fallback, or a list that never loads reads as one that
  // is still loading.
  if (!sources) {
    return loadFailed ? (
      <>
        <Head title="Knowledge base" note="What the assistant reads before it answers." />
        {failureCards}
      </>
    ) : (
      <div className="t-meta">Loading…</div>
    );
  }

  const canAdd = !adding && draft.label.trim() !== '' && draft.url.trim() !== '';

  return (
    <>
      <Head title="Knowledge base" note="What the assistant reads before it answers." />
      {failureCards}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          className="micro-6"
          style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 12px', padding: '9px 14px', color: 'var(--muted)' }}
        >
          <div>Source</div>
          <div>URL</div>
          <div>Kind</div>
          <div>Last read</div>
          <div>Status</div>
          <div />
        </div>
        {sources.length === 0 ? (
          <div className="t-small" style={{ padding: '14px', borderTop: '1px solid var(--row-line)' }}>
            No sources yet — the assistant has nothing to answer from. Add one below.
          </div>
        ) : null}
        {sources.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              gap: '0 12px',
              alignItems: 'center',
              padding: '11px 14px',
              borderTop: '1px solid var(--row-line)',
              background: s.status === 'failed' ? 'var(--danger-bg-2)' : 'var(--surface)',
            }}
          >
            <div style={{ font: "500 12px 'Geist', sans-serif" }}>{s.label}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--secondary-2)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.url}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              {s.kind === 'llms-txt' ? 'feed' : s.kind === 'sitemap' ? 'crawl' : 'file'}
            </div>
            <div className="t-small">
              {s.last_ingested_at ? new Date(s.last_ingested_at).toLocaleDateString() : '—'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Dot
                color={s.status === 'failed' ? '#b3261e' : s.status === 'ingesting' ? '#c05310' : '#9a9da2'}
                spin={s.status === 'ingesting'}
              />
              <span className="t-small mono">{s.status}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() => void read(s.id)}
              >
                {busy === s.id ? 'Reading…' : 'Re-read'}
              </button>
            </div>
            {s.status === 'failed' || s.last_error ? (
              <div
                style={{
                  gridColumn: '1 / -1',
                  marginTop: 9,
                  padding: '9px 11px',
                  background: 'var(--danger-bg)',
                  border: '1px solid var(--danger-border-2)',
                  borderRadius: 6,
                  font: "400 12px/1.6 'Geist', sans-serif",
                  color: 'var(--danger-3)',
                }}
              >
                <span className="mono">{s.last_error ?? 'The last read of this source failed.'}</span>
                {' — '}
                {s.last_ingested_at
                  ? 'The assistant still answers from the last good copy — say so rather than going quiet.'
                  : 'This source has never been read, so the assistant has nothing of it to answer from.'}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14, padding: 14 }}>
        <div className="micro" style={{ marginBottom: 10 }}>
          Add a source
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) void add();
          }}
          style={{ display: 'grid', gridTemplateColumns: '190px 1fr 130px auto', gap: 10, alignItems: 'center' }}
        >
          <input
            className="input"
            placeholder="Label"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <input
            className="input mono"
            type="url"
            placeholder="https://docs.example.com/llms.txt"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
          <select
            className="input"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={!canAdd}>
            {adding ? 'Adding…' : 'Add & read'}
          </button>
        </form>
        <div className="t-small" style={{ marginTop: 8 }}>
          {KINDS.find((k) => k.value === draft.kind)?.hint} It is read as soon as it is added;
          the same URL twice is the same source. A hosted desk can only reach the hosts its
          version declares (<span className="mono">substrat.outbound</span> in package.json) —
          a source on any other host is refused when read, and the refusal shows on its row.
        </div>
        {addFailed ? (
          <div className="t-small" style={{ marginTop: 8, color: 'var(--danger-2)' }}>
            {addFailed}
          </div>
        ) : null}
      </div>

      <div className="t-small" style={{ marginTop: 12 }}>
        Every answer cites the articles it drew from.
      </div>
    </>
  );
}

/* ── Assistant ──────────────────────────────────────────────────────────── */

/**
 * Is the assistant working, and with what?
 *
 * Two facts an admin asking "why is nobody getting answers" needs on one screen, and
 * neither used to be anywhere in the desk. Which model this install runs is a host
 * fact — with no credential the desk quotes the documentation and labels itself
 * `offline/extractive`, which is honest on a turn record and invisible from the inbox.
 * And a turn that failed was, until its reason was recorded, a note that said "I
 * could not answer this one" and nothing else. This shows the model, says plainly
 * when it is not one, and lists the newest failures by conversation.
 */
function Assistant({ go }: { go: (v: View) => void }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  useEffect(() => {
    assistantStatus()
      .then((s) => {
        setStatus(s);
        setLoadFailed(null);
      })
      .catch((e: Error) => setLoadFailed(e.message));
  }, []);

  if (!status) {
    return loadFailed ? (
      <>
        <Head title="Assistant" note="Which model answers, and what has gone wrong." />
        <div className="card" style={{ padding: '10px 14px', color: 'var(--danger)' }}>
          <span className="t-small">{loadFailed}</span>
        </div>
      </>
    ) : (
      <div className="t-meta">Loading…</div>
    );
  }

  const { health } = status;
  return (
    <>
      <Head title="Assistant" note="Which model answers, and what has gone wrong." />

      <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <div className="micro" style={{ marginBottom: 6 }}>
          Model
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot color={status.generative ? 'var(--green)' : '#c98a1a'} />
          <span className="mono" style={{ font: "500 13px 'Geist Mono', monospace" }}>
            {status.model}
          </span>
        </div>
        {status.hosting ? (
          <div className="t-small" style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
            Runs at {status.hosting.vendor} · {status.hosting.location} · {status.hosting.dataNote}
          </div>
        ) : null}
        {status.generative ? (
          <div className="t-small" style={{ marginTop: 8 }}>
            Answers are generated from the knowledge base by this model, on the platform's
            credential, and metered to this desk — see Usage &amp; cost.
          </div>
        ) : (
          <div
            style={{
              marginTop: 10,
              padding: '9px 11px',
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border-2)',
              borderRadius: 6,
              font: "400 12px/1.55 'Geist', sans-serif",
              color: 'var(--danger-3)',
            }}
          >
            <strong>The platform cannot run <span className="mono">{status.spec}</span>.</strong>{' '}
            The assistant is quoting the best-matching documentation section rather than
            generating an answer.{' '}
            {status.missing.length > 0 ? (
              <>
                The platform holds no{' '}
                {status.missing.map((m, i) => (
                  <span key={m}>
                    {i > 0 ? ', ' : ''}
                    <span className="mono">{m}</span>
                  </span>
                ))}
                .{' '}
              </>
            ) : null}
            Pick a model the platform runs — <span className="mono">TICKET0_MODEL</span> in this
            install's environment (the dashboard's Env tab for a hosted desk,{' '}
            <span className="mono">demos/ticket0/.env</span> for the dev server).
          </div>
        )}
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '11px 16px',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <span className="micro">Last 24 hours</span>
          <span className="t-small">
            {health.turns} turn{health.turns === 1 ? '' : 's'} ·{' '}
            <span style={{ color: health.failed > 0 ? 'var(--danger-3)' : undefined }}>
              {health.failed} failed
            </span>
          </span>
        </div>
        {health.recent.length === 0 ? (
          <div className="t-meta" style={{ padding: '18px 16px' }}>
            No failed turns. Every message the assistant was asked to answer got a turn
            recorded — answered, drafted, or escalated to a person.
          </div>
        ) : (
          health.recent.map((f) => (
            <div key={f.id} style={{ padding: '11px 16px', borderBottom: '1px solid var(--hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <button
                  onClick={() => go({ name: 'conversation', id: f.conversation_id })}
                  style={{
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    font: "500 12px 'Geist', sans-serif",
                    color: 'var(--accent-text)',
                    textAlign: 'left',
                  }}
                >
                  {f.subject || 'Untitled conversation'}
                </button>
                <span className="t-small mono">{f.model}</span>
                <span className="t-small" style={{ marginLeft: 'auto' }}>
                  {ago(f.created_at)}
                </span>
              </div>
              <div
                className="mono"
                style={{
                  marginTop: 6,
                  font: "400 11px/1.5 'Geist Mono', monospace",
                  color: 'var(--danger-3)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {f.error ?? 'No reason was recorded.'}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/* ── 12 Usage & cost ────────────────────────────────────────────────────── */

function Usage({ money }: { money: boolean }) {
  const [usage, setUsage] = useState<{
    total: string;
    currency: string;
    lines: { meterKey: string; qty: string; unitPrice: string; amount: string; entryCount: number }[];
  } | null>(null);
  const [closing, setClosing] = useState(false);
  const month = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  useEffect(() => {
    if (money) void api.usageSummary({}).then(setUsage as never);
  }, [money]);

  if (!money)
    return <Empty title="Usage is the desk admin's" note="Your account does not hold `usage:read`." />;
  if (!usage) return <div className="t-meta">Loading…</div>;

  return (
    <>
      <Head title="Usage & cost" note={`${month} · what the assistant has spent`} />
      {/* Spend alone is half a sentence — the other half is what it settled, which is a
          screen of its own under the same key (#1085). */}
      <div className="t-small" style={{ marginTop: -10, marginBottom: 14 }}>
        <a href="#/reports">Reports</a> puts this number over what the assistant resolved.
      </div>
      <div className="card" style={{ overflow: 'hidden', marginBottom: 18 }}>
        <div
          className="micro-6"
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 110px 150px 100px',
            gap: '0 12px',
            padding: '9px 14px',
            color: 'var(--muted)',
          }}
        >
          <div>Meter</div>
          <div style={{ textAlign: 'right' }}>Quantity</div>
          <div style={{ textAlign: 'right' }}>Unit price</div>
          <div style={{ textAlign: 'right' }}>Amount</div>
        </div>
        {usage.lines.map((l) => (
          <div
            key={l.meterKey}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 110px 150px 100px',
              gap: '0 12px',
              alignItems: 'center',
              padding: '11px 14px',
              borderTop: '1px solid var(--row-line)',
            }}
          >
            <div className="mono" style={{ fontSize: 12 }}>
              {l.meterKey}
            </div>
            <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
              {Number(l.qty).toLocaleString()}
            </div>
            <div style={{ textAlign: 'right' }}>
              <UnitPrice amount={l.unitPrice} />
            </div>
            <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
              ${Number(l.amount).toFixed(4)}
            </div>
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '13px 14px',
            borderTop: '1px solid var(--hairline)',
            background: 'var(--app-bg)',
          }}
        >
          <span className="micro">Total</span>
          <span style={{ font: "600 17px 'Geist Mono', monospace", letterSpacing: '-.01em' }}>
            ${Number(usage.total).toFixed(2)}
          </span>
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--hairline)',
          borderRadius: 8,
          padding: 14,
          background: 'var(--surface)',
        }}
      >
        <div className="t-strong" style={{ marginBottom: 5 }}>
          Close {month.split(' ')[0]}
        </div>
        <div className="t-small" style={{ marginBottom: 12, lineHeight: 1.6 }}>
          Closing freezes the window into immutable lines and moves the horizon forward.
          Nothing can be recorded behind it afterwards, and a closed month cannot be
          reopened.
        </div>
        <button
          className="btn"
          style={{
            background: 'var(--danger-bg)',
            borderColor: 'var(--danger-border)',
            color: 'var(--danger-2)',
          }}
          disabled={closing}
          onClick={() => {
            setClosing(true);
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            void api
              .closeUsagePeriod({ from, to: now.toISOString() })
              .then(() => api.usageSummary({}))
              .then(setUsage as never)
              .finally(() => setClosing(false));
          }}
        >
          {closing ? 'Closing…' : `Close ${month.split(' ')[0]}…`}
        </button>
      </div>
    </>
  );
}
