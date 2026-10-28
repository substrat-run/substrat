import { useState } from 'react';
import { Dialog } from '@substrat-run/ui';
import type { AppEnvValue, EnvVarSpec } from '../lib/api';

export type EnvEntry = { key: string; value: string; secret: boolean };

function parseEnv(text: string, spec: EnvVarSpec[], values: AppEnvValue[]): { entries: EnvEntry[]; errors: string[] } {
  const secrets = new Map([...values.map((v) => [v.key, v.isSecret] as const), ...spec.map((s) => [s.key, s.secret] as const)]);
  const entries: EnvEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    const source = line.trim();
    if (!source || source.startsWith('#')) return;
    const body = source.startsWith('export ') ? source.slice(7).trimStart() : source;
    const equal = body.indexOf('=');
    const key = body.slice(0, equal < 0 ? undefined : equal).trim();
    const value = equal < 0 ? '' : body.slice(equal + 1).trim();
    const lineNo = index + 1;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) errors.push(`Line ${lineNo}: use an UPPER_SNAKE_CASE key.`);
    else if (equal < 0) errors.push(`Line ${lineNo}: add = after the key.`);
    else if (!value) errors.push(`Line ${lineNo}: enter a value.`);
    else if (seen.has(key)) errors.push(`Line ${lineNo}: ${key} appears more than once.`);
    else {
      seen.add(key);
      const quoted = value[0] === '"' || value[0] === "'";
      if (quoted && value.at(-1) !== value[0]) errors.push(`Line ${lineNo}: close the quoted value.`);
      else {
        const decoded = quoted ? value.slice(1, -1) : value;
        if (!decoded) errors.push(`Line ${lineNo}: enter a value.`);
        else entries.push({ key, value: decoded, secret: secrets.get(key) ?? true });
      }
    }
  });
  return { entries, errors };
}

/** Bulk import for per-app configuration. Values remain in this dialog until a successful save. */
export function EnvImport({ spec, values, onSave, onClose }: {
  spec: EnvVarSpec[];
  values: AppEnvValue[];
  onSave: (entries: EnvEntry[]) => Promise<void>;
  onClose: () => void;
}) {
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseEnv(paste, spec, values);
  const save = async () => {
    if (parsed.errors.length || parsed.entries.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed.entries);
      setPaste('');
      setBusy(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open title="Add from .env" description="Paste KEY=value lines. Saved secret values cannot be read back." confirmLabel="Save" confirmDisabled={parsed.errors.length > 0 || parsed.entries.length === 0} busy={busy} onConfirm={() => void save()} onCancel={onClose} width={560}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
        .env contents
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} spellCheck={false} style={{ width: '100%', padding: 10, fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--surface-inset)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6 }} />
      </label>
      {parsed.entries.length > 0 && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>{parsed.entries.length} valid {parsed.entries.length === 1 ? 'entry' : 'entries'}</div>}
      {parsed.errors.map((message) => <div key={message} role="alert" style={{ marginTop: 6, fontSize: 12, color: 'var(--status-danger-fg)' }}>{message}</div>)}
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--status-danger-fg)' }}>{error}</div>}
    </Dialog>
  );
}
