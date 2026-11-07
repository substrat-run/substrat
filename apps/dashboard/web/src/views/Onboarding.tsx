import { useState } from 'react';
import { Button, Input } from '@substrat-run/ui/wa';
import { StrataGlyph } from '../lib/icons';

/**
 * First-run onboarding (screen shown once, right after sign-up). A login that
 * belongs to no team yet lands here instead of being silently bootstrapped —
 * they name their first team, which `POST /api/teams` provisions with them as
 * owner. The same form backs the in-app "New team" dialog; this is its full-page
 * variant for a user who has nothing else to look at yet.
 */
export function Onboarding({ name, busy, onCreate }: { name?: string | null; busy?: boolean; onCreate: (teamName: string) => void }) {
  const [team, setTeam] = useState('');
  const trimmed = team.trim();
  const submit = () => {
    if (trimmed && !busy) onCreate(trimmed);
  };
  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StrataGlyph size={20} />
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>substrat</span>
      </div>
      <div
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        style={{ width: 352, maxWidth: '100%', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box' }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
          {name ? `Welcome, ${name}` : 'Create your team'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          A team holds your apps, domains, and billing. You can create more later and invite people to each.
        </div>
        <Input label="Team name" placeholder="Acme Inc" value={team} onChange={(e) => setTeam(e.target.value)} />
        <Button style={{ width: '100%', justifyContent: 'center' }} disabled={!trimmed || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create team'}
        </Button>
      </div>
    </div>
  );
}
