import { useState } from 'react';
import { Card, Tabs } from '../components';
import { APP_SHA, APP_VERSION } from '../lib/version';

/**
 * Console settings. Today it holds one tab — About, the running build stamp that used
 * to sit in the sidebar footer — but it exists as a tabbed page so console-level
 * settings (staff prefs, fleet defaults) have a home to grow into rather than a
 * one-off caption tucked under the nav.
 */
export function Settings() {
  const [tab, setTab] = useState('about');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Settings
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
          Console configuration and the running build.
        </p>
      </div>

      <Tabs
        tabs={[{ value: 'about', label: 'About' }]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'about' && (
        <Card title="Running build" description="The console build currently served to your browser.">
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13, rowGap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)' }}>Version</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>v{APP_VERSION}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>Commit</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{APP_SHA}</span>
          </div>
        </Card>
      )}
    </div>
  );
}
