import { useState } from 'react';
import { ApiError } from '../lib/api';

/** The request id a failed call named (#2192), or undefined where the answer carried none. */
export const requestIdOf = (e: unknown): string | undefined => (e instanceof ApiError ? e.requestId : undefined);

/**
 * "Request id: <id>" with a Copy button — what a person quotes when they report a failure.
 * Renders nothing without an id, so a surface can mount it unconditionally.
 */
export function RequestIdNote({ id }: { id: string | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>
      <span>Request id:</span>
      <span style={{ fontFamily: 'var(--font-mono)', userSelect: 'all' }}>{id}</span>
      <button type="button" onClick={copy} style={{ fontSize: 12 }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
