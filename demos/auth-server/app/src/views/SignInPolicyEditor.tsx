import type { PublicProvider } from '../api';
import {
  PASSWORD_METHOD,
  describeFlow,
  draftProblems,
  newRoute,
  type PolicyDraft,
} from './sign-in-draft';

/**
 * The per-application sign-in settings (`metadata.signIn`, `src/sign-in-policy.ts`), laid out
 * in the order a person thinks about them: how people START, which methods are open to
 * everyone, which email domains are sent one particular way, and — last, because it is the
 * result — what a visitor will actually see. The summary is derived from the same draft that
 * saving writes (`describeFlow`), so it cannot describe something else.
 */
export function SignInPolicyEditor({
  draft, onChange, offered, offeredError, builtin,
}: {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  offered: PublicProvider[] | null;
  offeredError: string | null;
  builtin: boolean;
}) {
  const set = (patch: Partial<PolicyDraft>) => onChange({ ...draft, ...patch });
  const toggle = (id: string, on: boolean) => {
    const methods = new Set(draft.methods);
    if (on) methods.add(id);
    else methods.delete(id);
    set({ methods });
  };
  const providers = offered ?? [];
  const password = draft.methods.has(PASSWORD_METHOD);
  const staged = !builtin && draft.identifierFirst;
  const problems = draftProblems(draft, providers, builtin);
  const flow = offered ? describeFlow(draft, providers, builtin) : null;

  return (
    <>
      <h3>Sign-in</h3>
      <p className="muted small">
        {builtin
          ? 'Which buttons this console’s own sign-in screen draws. It is drawn, not enforced: a console sign-in never passes through the authorize endpoint, so this narrows the screen and nothing else.'
          : 'How people sign in when this application sends them here. This is enforced at the authorize endpoint, not merely on the screen: a session established another way is asked to sign in again rather than handed a code.'}
      </p>
      <label className="toggle">
        <input type="checkbox" checked={!draft.restrict} onChange={(e) => set({ restrict: !e.target.checked })} />
        <span>
          <strong>Accept every method this issuer offers</strong>
          <em className="hint">The default. New providers become available to this application as they are added.</em>
        </span>
      </label>

      {draft.restrict && (
        <div className="signin-editor">
          {offeredError ? (
            <p className="error">
              The issuer’s sign-in providers could not be read ({offeredError}), so this application’s
              policy cannot be edited. Reload the page to try again.
            </p>
          ) : !offered ? (
            <em className="hint">Loading the providers this issuer offers…</em>
          ) : null}

          {!builtin && (
            <fieldset className="signin-group">
              <legend>1 · How people start</legend>
              <label className="toggle">
                <input type="radio" name="signin-start" checked={!draft.identifierFirst} onChange={() => set({ identifierFirst: false })} />
                <span>
                  <strong>Show the methods on one screen</strong>
                  <em className="hint">Buttons for each provider, and the email and password form, side by side.</em>
                </span>
              </label>
              <label className="toggle">
                <input type="radio" name="signin-start" checked={draft.identifierFirst} onChange={() => set({ identifierFirst: true })} />
                <span>
                  <strong>Ask for email first</strong>
                  <em className="hint">
                    One question, then the right way in. Company directories are never listed as buttons,
                    so nobody is shown another organisation’s single sign-on.
                  </em>
                </span>
              </label>
            </fieldset>
          )}

          <fieldset className="signin-group">
            <legend>{builtin ? 'Methods' : staged ? '2 · Open to everyone' : '2 · Methods'}</legend>
            {staged && <p className="muted small">Shown as buttons on the first screen. Email below is for everyone else.</p>}
            <label className="toggle">
              <input type="checkbox" checked={password} onChange={(e) => toggle(PASSWORD_METHOD, e.target.checked)} />
              <span>Email and password</span>
            </label>
            {password && !builtin && (
              <label className="toggle nested">
                <input type="checkbox" checked={draft.requireSms} onChange={(e) => set({ requireSms: e.target.checked })} />
                <span>
                  <strong>Require an SMS code after the password</strong>
                  <em className="hint">
                    People register their phone the first time (their email must be verified), and confirm
                    with a code every time after.
                  </em>
                </span>
              </label>
            )}
            {providers.map((provider) => (
              <label className="toggle" key={provider.id}>
                <input type="checkbox" checked={draft.methods.has(provider.id)} onChange={(e) => toggle(provider.id, e.target.checked)} />
                <span>{provider.label}</span>
              </label>
            ))}
            {offered && !offered.length && (
              <em className="hint">
                This issuer has no upstream provider configured yet — add one under Sign-in providers, and
                it can be chosen here.
              </em>
            )}
          </fieldset>

          {/* Also while rules exist but the start screen was switched back to one screen: they
              still fail validation, so they must stay visible and removable. */}
          {!builtin && (staged || draft.routes.length > 0) && (
            <fieldset className="signin-group">
              <legend>3 · Reserved for an email domain</legend>
              <p className="muted small">
                People whose address is at one of these domains sign in through that provider
                <strong> and no other way</strong> — also if they try a password. The provider does not
                have to be ticked above: that list is for everyone, this one is for one organisation.
              </p>
              {draft.routes.map((route, index) => (
                <div className="route-row" key={route.key}>
                  <label className="field">
                    <span>Domains</span>
                    <input
                      value={route.domains}
                      placeholder="acme.se, acme.com"
                      onChange={(e) => onChange({ ...draft, routes: draft.routes.map((r) => (r.key === route.key ? { ...r, domains: e.target.value } : r)) })}
                    />
                  </label>
                  <label className="field">
                    <span>Must sign in with</span>
                    <select
                      value={route.provider}
                      onChange={(e) => onChange({ ...draft, routes: draft.routes.map((r) => (r.key === route.key ? { ...r, provider: e.target.value } : r)) })}
                    >
                      <option value="">Choose a provider…</option>
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </label>
                  <button
                    className="btn danger tiny"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() => set({ routes: draft.routes.filter((r) => r.key !== route.key) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button className="btn tiny" disabled={!offered} onClick={() => set({ routes: [...draft.routes, newRoute(providers.length === 1 ? providers[0]!.id : '')] })}>
                Add a domain rule
              </button>
            </fieldset>
          )}

          {problems.length > 0 && (
            <ul className="error signin-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}

          {flow && (
            <div className={`flow-preview${flow.deadEnd ? ' dead' : ''}`}>
              <strong>What people will see</strong>
              {flow.deadEnd ? (
                <p className="error">Nobody can sign in with these settings. Tick at least one method.</p>
              ) : (
                <>
                  <p className="small">First screen: {flow.first.join(' · ')}</p>
                  <ul>
                    {flow.visitors.map((v) => (
                      <li key={`${v.who}-${v.what}`}><span>{v.who}</span> → {v.what}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
