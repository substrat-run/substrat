import { useEffect, useState } from 'react';
import { api, type FieldReadsView } from '../lib/api';
import { card } from '../components/ui';

/**
 * Sampled response fields for one installed app — the observed half beside the declared
 * Field coverage card. Counts are the vertical's assertions, for this scope only.
 */
export function FieldReads({ scopeId, hours = 24 }: { scopeId: string; hours?: number }) {
  const [view, setView] = useState<FieldReadsView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setView(null);
    setError('');
    api.appFieldReads(scopeId, hours).then((answer) => { if (live) setView(answer); })
      .catch(() => { if (live) setError('Field counts could not be loaded.'); });
    return () => { live = false; };
  }, [scopeId, hours]);

  const body = error ? <p role="alert">{error}</p>
    : !view ? <p>Loading field counts…</p>
    : !view.available ? <p>Field counts are not available for this version yet.</p>
    : view.groups.length === 0 ? <p>No requests were armed for field coverage in this window.</p>
    : null;

  return <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
    <h3 style={{ margin: 0, fontSize: 15 }}>Sampled field counts</h3>
    {body ?? <Groups view={view!} />}
  </div>;
}

function Groups({ view }: { view: FieldReadsView }) {
  return <div style={{ display: 'grid', gap: 12 }}>
    <p style={{ margin: 0, fontSize: 13 }}>
      Vertical-asserted counts of fields this installed app returned in sampled response
      serialisations, from requests the router sent to it. A zero means
      no return was observed in this sample; it does not prove a field is unused. Null fields count
      as returned. Absent optional fields are excluded from the eligible count.
    </p>
    {view.groups.map((group, i) => {
      const rate = group.sampleRate === null ? 'rate unknown' : `${(group.sampleRate * 100).toPrecision(3)}% router sample`;
      const window = view.window ? `${view.window.since}–${view.window.until}` : 'window unknown';
      return <div key={`${group.sampleRate ?? 'unknown'}-${i}`} style={{ display: 'grid' }}>
        <h4 style={{ margin: '0 0 6px' }}>Vertical-asserted field counts · {rate} · {window}</h4>
        <p style={{ margin: '0 0 10px', fontSize: 12 }}>
          {group.armedRequests} armed requests; {group.refused} malformed reports refused. {rate}; {window}.
        </p>
        {group.operations.every((op) => op.responses === 0) &&
          <p>Armed requests, but no walked responses were observed in this sample ({rate}; {window}).</p>}
        {group.operations.map((op) => <div key={op.operation} style={{ marginBottom: 12 }}>
          <strong>{op.operation}</strong> <span style={{ fontSize: 12 }}>({op.responses} sampled responses; {rate}; {window})</span>
          <table><thead><tr><th>Field</th><th>Present</th><th>Null</th><th>Absent</th><th>Eligible</th><th>Sample and window</th></tr></thead>
            <tbody>{op.fields.map((field) => <tr key={field.field}>
              <td><code>{field.field}</code></td><td>{field.present}</td><td>{field.empty}</td>
              <td>{field.absent}</td><td>{field.eligible}</td><td>{rate}; {window}</td>
            </tr>)}</tbody></table>
        </div>)}
        <p style={{ fontSize: 12, margin: 0 }}>
          Not observed returned in this sample ({rate}; {window}):{' '}
          {group.notObservedReturned.length
            ? group.notObservedReturned.map((f) => `${f.operation}.${f.field}`).join(', ')
            : 'none'}.
        </p>
      </div>;
    })}
  </div>;
}
