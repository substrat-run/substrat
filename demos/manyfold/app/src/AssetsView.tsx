import { useEffect, useMemo, useState } from 'react';
import { api, getSite, type ContentTypeDef } from './api';
import { AssetStripe, Button, Card, Drawer, Empty, MicroLabel, Mono } from './ui';

// Screen 12 (Asset library) + the 4b side-drawer picker for assetRef fields.
// Milestone A has no asset store — uploads land through an R2 storage connector in
// design phase 2 — so the library is the designed shell over an honest data source:
// the demo file manifest plus every assetRef value actually used by entries in this
// site, with USED BY computed from the real bodies.

export interface AssetInfo {
  id: string;
  size?: string;
  dims?: string;
  uploader?: string;
}

/** The demo world's file manifest (the mock's seed). assetRef values are free-form ids
 *  in milestone A, so these filenames are valid values for the form to link. */
export const DEMO_ASSETS: AssetInfo[] = [
  { id: 'tasting-table.jpg', size: '2.1 MB', dims: '2400×1600', uploader: 'Maja' },
  { id: 'roastery-bags.jpg', size: '1.4 MB', dims: '1800×1200', uploader: 'Emil' },
  { id: 'maja-portrait.jpg', size: '640 KB', dims: '1200×1200', uploader: 'Maja' },
  { id: 'counter-morning.jpg', size: '1.8 MB', dims: '2400×1350', uploader: 'Sofia' },
  { id: 'menu-spring.pdf', size: '310 KB', uploader: 'Maja' },
  { id: 'emil-portrait.jpg', size: '590 KB', dims: '1200×1200', uploader: 'Emil' },
  { id: 'cloudberries.jpg', size: '2.6 MB', dims: '2400×1600', uploader: 'Sofia' },
];

export interface AssetUse {
  entryTitle: string;
  typeKey: string;
  field: string;
  published: boolean;
}

/** Scan every entry body in the site for assetRef/assetRefMany values → id → uses. */
export function useAssetIndex(types: ContentTypeDef[]): { uses: Map<string, AssetUse[]>; loaded: boolean } {
  const [uses, setUses] = useState<Map<string, AssetUse[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      const map = new Map<string, AssetUse[]>();
      const all = await api.listEntries().catch(() => []);
      for (const item of all) {
        const def = types.find((t) => t.key === item.type_key);
        if (!def) continue;
        const assetFields = Object.entries(def.fields).filter(([, f]) => f.type === 'assetRef' || f.type === 'assetRefMany');
        if (assetFields.length === 0) continue;
        const detail = await api.getEntry(item.id).catch(() => null);
        if (!detail) continue;
        for (const [name, f] of assetFields) {
          const v = detail.body[name];
          const ids = f.type === 'assetRefMany' ? ((v as string[]) ?? []) : v ? [v as string] : [];
          for (const id of ids) {
            const list = map.get(id) ?? [];
            list.push({ entryTitle: item.title, typeKey: item.type_key, field: name, published: item.status === 'published' });
            map.set(id, list);
          }
        }
      }
      setUses(map);
      setLoaded(true);
    })().catch(() => setLoaded(true));
  }, [types]);
  return { uses, loaded };
}

function allAssets(uses: Map<string, AssetUse[]>): AssetInfo[] {
  const known = new Set(DEMO_ASSETS.map((a) => a.id));
  const extra = [...uses.keys()].filter((id) => !known.has(id)).map((id) => ({ id }));
  return [...DEMO_ASSETS, ...extra];
}

// ── Screen 12 · Asset library ───────────────────────────────────────────────

export function AssetLibrary({ types }: { types: ContentTypeDef[] }) {
  const { uses, loaded } = useAssetIndex(types);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const assets = useMemo(() => allAssets(uses), [uses]);
  const shown = assets.filter((a) => (query ? a.id.toLowerCase().includes(query.toLowerCase()) : true));
  const sel = assets.find((a) => a.id === selected) ?? null;
  const selUses = sel ? (uses.get(sel.id) ?? []) : [];
  const publishedUses = selUses.filter((u) => u.published).length;
  const phase2 = 'Media uploads land through an R2 storage connector (design phase 2).';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Assets</h1>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>{assets.length} files · this site only</div>
        </div>
        <Button variant="primary" disabled title={phase2}>Upload</Button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="⌕  Search assets…"
          style={{ font: 'inherit', fontSize: 13, padding: '7px 12px', width: 260, borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
          {shown.map((a) => {
            const on = a.id === selected;
            const n = (uses.get(a.id) ?? []).length;
            return (
              <div key={a.id} onClick={() => setSelected(on ? null : a.id)} style={{ cursor: 'pointer' }}>
                <AssetStripe
                  label={a.id}
                  style={{ aspectRatio: '1', border: on ? '2px solid var(--accent)' : '1px solid var(--border)', padding: on ? 7 : 8 }}
                />
                <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</div>
                <div style={{ fontSize: 11, color: 'var(--faint)' }}>{a.size ?? '—'} · {loaded ? (n > 0 ? `used by ${n}` : 'unused') : '…'}</div>
              </div>
            );
          })}
          <div
            title={phase2}
            style={{ aspectRatio: '1', borderRadius: 'var(--r-input)', border: '2px dashed var(--border2)', display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 12.5, textAlign: 'center', padding: 10, cursor: 'not-allowed' }}
          >
            Drop files to upload
          </div>
        </div>

        {sel ? (
          <Card>
            <AssetStripe label={`${sel.id} · preview`} style={{ aspectRatio: '4/3', marginBottom: 12 }} />
            <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4, wordBreak: 'break-all' }}>{sel.id}</div>
            <Mono style={{ display: 'block', fontSize: 11, marginBottom: 14 }}>
              {[sel.size, sel.dims, sel.uploader ? `uploaded by ${sel.uploader}` : null].filter(Boolean).join(' · ') || 'referenced id — no file metadata'}
            </Mono>
            <MicroLabel>Used by</MicroLabel>
            {selUses.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--faint)', marginBottom: 12 }}>Not referenced by any entry in this site.</div>
            ) : (
              selUses.map((u, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.entryTitle}</span>
                  <Mono style={{ fontSize: 11 }}>{u.typeKey} · {u.field}</Mono>
                </div>
              ))
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <Button size="sm" disabled title={phase2}>Replace file</Button>
              <Button size="sm" disabled title={publishedUses > 0 ? `Delete is disabled — referenced by ${publishedUses} published entr${publishedUses === 1 ? 'y' : 'ies'}.` : phase2}>
                Delete
              </Button>
            </div>
            {publishedUses > 0 && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
                Delete is disabled — referenced by {publishedUses} published entr{publishedUses === 1 ? 'y' : 'ies'}.
              </div>
            )}
          </Card>
        ) : (
          <Card>
            <Empty title="No asset selected" hint="Select a tile to see its metadata and which entries reference it." />
          </Card>
        )}
      </div>
      <div style={{ marginTop: 16, padding: '12px 16px', border: '1px dashed var(--border2)', borderRadius: 'var(--r-card)', fontSize: 12.5, color: 'var(--muted)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)', marginRight: 8 }}>NOTE</span>
        {phase2} The grid is the designed shell over the demo manifest; <Mono style={{ fontSize: 11 }}>assetRef</Mono> fields link these ids today and USED BY is computed from real entry bodies.
      </div>
    </div>
  );
}

// ── 4b · Side drawer picker (assetRef fields: "Replace from library") ───────

export function AssetDrawer(props: {
  fieldName: string;
  current?: string;
  types: ContentTypeDef[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { uses } = useAssetIndex(props.types);
  const [query, setQuery] = useState('');
  const assets = useMemo(() => allAssets(uses), [uses]);
  const shown = assets.filter((a) => (query ? a.id.toLowerCase().includes(query.toLowerCase()) : true));

  return (
    <Drawer onClose={props.onClose}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>Asset library</div>
        <Mono style={{ fontSize: 11 }}>{props.fieldName} · {getSite()}</Mono>
        <button onClick={props.onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', font: 'inherit' }}>✕</button>
      </div>
      <div style={{ padding: '10px 16px' }}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="⌕  Search assets…"
          style={{ width: '100%', font: 'inherit', fontSize: 13, padding: '7px 11px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 10px 10px' }}>
        {shown.map((a) => {
          const on = a.id === props.current;
          return (
            <div
              key={a.id}
              onClick={() => props.onPick(a.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 'var(--r-input)', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent', marginBottom: 2 }}
            >
              <AssetStripe style={{ width: 40, height: 30, flex: '0 0 40px', padding: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</span>
              <Mono style={{ fontSize: 10.5 }}>{a.size ?? ''}</Mono>
              {on && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>✓</span>}
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={props.onClose}>Done</Button>
      </div>
    </Drawer>
  );
}
