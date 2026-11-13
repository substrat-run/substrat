/**
 * Plugins: which members may use the workspace's plugins, decided here and nowhere else.
 *
 * A plugin is another app of the tenant that takes its people from this one (`demos/notes`).
 * It has no members of its own: when somebody signs in to it, it asks this app who they are
 * and what they may do. This screen is where the answer comes from. A change reaches a plugin
 * the next time it asks, which is within five minutes, in both directions.
 *
 * Only an admin may read or change it; anyone else is refused by the server, and told so here.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';

/** Where the Notes plugin runs, when the dev server says (`VITE_NOTES_URL`). */
export const NOTES_URL: string | undefined = import.meta.env.VITE_NOTES_URL;

type Member = Awaited<ReturnType<typeof api.listMembers>>['entries'][number];

export function Plugins() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setMembers((await api.listMembers({ sort: 'display_name' })).entries);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const toggle = async (m: Member) => {
    try {
      if (m.plugin_access) await api.revokePluginAccess({ memberId: m.id });
      else await api.grantPluginAccess({ memberId: m.id });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  const refused = error instanceof ApiError && error.status === 403;
  return (
    <section>
      <h2>Plugins</h2>
      <p className="sub">
        A plugin is another app of this workspace, with its own screens and its own data, that takes its people
        from here: whoever is switched on below may use it. A change reaches a plugin the next time it asks,
        which is within five minutes.
      </p>
      <div className="card plugin">
        <div className="row">
          <span>
            <strong>Notes</strong>
            <span className="muted">A shared notepad for the workspace.</span>
          </span>
          <span className="spacer" />
          {NOTES_URL ? (
            <wa-button size="s" href={NOTES_URL}>
              Open Notes
            </wa-button>
          ) : (
            <span className="muted">Runs beside this app with `pnpm --filter @substrat-run/demo-notes dev`</span>
          )}
        </div>
      </div>
      <h3>Who may use plugins</h3>
      {refused ? (
        <wa-callout class="error" variant="warning" size="s">
          <strong>Not allowed. </strong>Only an admin decides who may use plugins.
        </wa-callout>
      ) : error ? (
        <wa-callout class="error" variant="danger" size="s">
          <strong>Something went wrong. </strong>
          {error instanceof Error ? error.message : String(error)}
        </wa-callout>
      ) : null}
      {members && !refused ? (
        <div className="card">
          {members.length === 0 ? <div className="empty">No members yet.</div> : null}
          {members.map((m) => (
            <div className="row" key={m.id}>
              <span>
                {m.display_name} <span className="muted">{m.email}</span>
              </span>
              <span className="spacer" />
              <wa-switch checked={m.plugin_access || undefined} onClick={() => void toggle(m)}>
                Plugins
              </wa-switch>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
