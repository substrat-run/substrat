import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, getSite, type ContentTypeDef } from './api';
import { renderMarkdown } from './Markdown';
import { AssetStripe, Avatar, Card, MicroLabel, Mono } from './ui';

// The delivery-surface preview (design screen 6): what the public read API serves for a
// published entry — the frozen revision, references resolved (a draft/archived target
// ships as an explicit $unresolved marker, never silently dropped), ETag = content hash.
// Split view: the resolved payload rendered like a consumer would, and the raw JSON.

interface Payload { hash: string; publishedAt: string; body: Record<string, unknown> }

export function DeliveryPreview({ typeKey, slug, rev, def }: { typeKey: string; slug: string; rev?: number | null; def?: ContentTypeDef }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.deliver(typeKey, slug).then(setPayload).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [typeKey, slug]);

  if (err) return <Card style={{ color: 'var(--st-danger-fg)', background: 'var(--st-danger-bg)', borderColor: 'transparent' }}>{err}</Card>;
  if (!payload) return <Card><Mono>resolving delivery…</Mono></Card>;

  const revLabel = rev != null ? `rev ${rev}` : 'the published rev';
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* The request bar — cacheable, immutable, hash-addressed. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 5, background: 'var(--accent-soft)', color: 'var(--accent)' }}>GET</span>
        <Mono style={{ fontSize: 12, color: 'var(--ink)' }}>/sites/{getSite()}/{typeKey}/{slug}</Mono>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--st-published-fg)' }}>200</span>
        <Mono style={{ fontSize: 11 }} title={payload.hash}>
          ETag: "{payload.hash.slice(0, 6)}…{payload.hash.slice(-3)}" <span style={{ color: 'var(--faint)' }}>= content hash of {revLabel}</span>
        </Mono>
        <Mono style={{ fontSize: 11 }}>cache-control: public, immutable</Mono>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 10px', borderRadius: 'var(--r-pill)', background: 'var(--st-approved-bg)', color: 'var(--st-approved-fg)', whiteSpace: 'nowrap' }}>
          FROZEN {rev != null ? `REV ${rev}` : ''} ❄
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <div style={{ padding: 16, borderRight: '1px solid var(--border)', minWidth: 0 }}>
          <MicroLabel>Resolved payload · as the public API serves it</MicroLabel>
          <ResolvedView body={payload.body} def={def} />
        </div>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 16px 0' }}>
            <MicroLabel>Raw response · REST, CDN-cacheable</MicroLabel>
          </div>
          <pre style={{ margin: 0, padding: 14, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.55, overflow: 'auto', maxHeight: 430, flex: 1 }}>
            {highlight(JSON.stringify(payload.body, null, 2))}
          </pre>
        </div>
      </div>
      <div style={{ padding: '9px 14px', borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
        Unresolved refs ship explicitly as <Mono style={{ fontSize: 10.5 }}>$unresolved</Mono>, never silently dropped. The same
        hash rides in the ETag, so a CDN can cache the frozen revision forever.
      </div>
    </Card>
  );
}

// ── The rendered (consumer's-eye) view of the resolved body ─────────────────

function isUnresolved(v: unknown): v is { $unresolved: true; reason: string; id?: string } {
  return !!v && typeof v === 'object' && (v as { $unresolved?: boolean }).$unresolved === true;
}
function isResolvedRef(v: unknown): v is { $ref: string; title: string } {
  return !!v && typeof v === 'object' && typeof (v as { $ref?: string }).$ref === 'string';
}

function ResolvedView({ body, def }: { body: Record<string, unknown>; def?: ContentTypeDef }) {
  const fieldType = (name: string) => def?.fields[name]?.type;
  const target = (name: string) => def?.fields[name]?.target;
  const titleField = def?.titleField ?? 'title';
  const entries = Object.entries(body);

  const title = body[titleField];
  const rendered = new Set<string>([titleField]);
  const blocks: ReactNode[] = [];

  // Hero first, like the mock (any assetRef with a value).
  for (const [name, v] of entries) {
    if (fieldType(name) === 'assetRef' && typeof v === 'string' && v) {
      rendered.add(name);
      blocks.push(<AssetStripe key={`asset-${name}`} label={`${name} · ${v}`} style={{ height: 110, marginBottom: 12 }} />);
    }
  }

  blocks.push(
    <div key="title" style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>{typeof title === 'string' ? title : '—'}</div>,
  );

  // Body prose (richText) under the title.
  for (const [name, v] of entries) {
    if (fieldType(name) === 'richText' && typeof v === 'string' && v.trim()) {
      rendered.add(name);
      blocks.push(<div key={`rich-${name}`} style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>{renderMarkdown(v)}</div>);
    }
  }

  // Reference lists (refMany) — resolved in order, unresolved shown honestly.
  for (const [name, v] of entries) {
    if (Array.isArray(v) && v.some((x) => isResolvedRef(x) || isUnresolved(x))) {
      rendered.add(name);
      blocks.push(
        <div key={`many-${name}`} style={{ margin: '12px 0' }}>
          <MicroLabel>{name} · refMany{target(name) ? `(${target(name)})` : ''}, resolved in order</MicroLabel>
          {v.map((x, i) =>
            isUnresolved(x) ? (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', marginBottom: 6, borderRadius: 'var(--r-input)', border: '1px dashed var(--st-danger-fg)', color: 'var(--st-danger-fg)', fontSize: 12.5 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em' }}>UNRESOLVED</span>
                <Mono style={{ fontSize: 11, color: 'inherit' }}>{(x as { id?: string }).id?.slice(0, 8) ?? '—'}…</Mono>
                <span>— target is {x.reason === 'not_published' ? 'not published' : x.reason}; omitted from delivery</span>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', marginBottom: 6, borderRadius: 'var(--r-input)', border: '1px solid var(--border)', fontSize: 13 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--st-published-fg)' }}>RESOLVED</span>
                <span style={{ fontWeight: 600 }}>{isResolvedRef(x) ? x.title : String(x)}</span>
              </div>
            ),
          )}
        </div>,
      );
    }
  }

  // Single resolved refs → the author-card treatment.
  for (const [name, v] of entries) {
    if (!Array.isArray(v) && (isResolvedRef(v) || isUnresolved(v))) {
      rendered.add(name);
      blocks.push(
        <div key={`one-${name}`} style={{ margin: '12px 0' }}>
          <MicroLabel>{name}</MicroLabel>
          {isUnresolved(v) ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 'var(--r-input)', border: '1px dashed var(--st-danger-fg)', color: 'var(--st-danger-fg)', fontSize: 12.5 }}>
              unresolved — target is {v.reason === 'not_published' ? 'not published' : v.reason}
            </div>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '6px 14px 6px 7px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)' }}>
              <Avatar name={v.title} size={24} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{v.title}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--st-published-fg)' }}>RESOLVED</span>
            </div>
          )}
        </div>,
      );
    }
  }

  // Everything else → compact meta rows.
  const rest = entries.filter(([name, v]) => !rendered.has(name) && v !== undefined && v !== null && v !== '');
  if (rest.length > 0) {
    blocks.push(
      <div key="meta" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        {rest.map(([name, v]) => (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 12.5 }}>
            <Mono style={{ fontSize: 11 }}>{name}</Mono>
            <span style={{ textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}
            </span>
          </div>
        ))}
      </div>,
    );
  }

  return <div>{blocks}</div>;
}

function highlight(json: string): ReactNode {
  return json.split('\n').map((line, i) => (
    <div key={i} style={line.includes('$unresolved') ? { color: 'var(--st-danger-fg)', background: 'var(--st-danger-bg)' } : undefined}>{line}</div>
  ));
}
