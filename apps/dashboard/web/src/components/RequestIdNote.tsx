import { useState } from 'react';
import { ApiError } from '../lib/api';
import { ULID } from '../lib/palette';

/**
 * The request id a failed call named (#2192), or undefined where the answer carried none. A
 * failure from the generated team client carries no headers, only its problem body, which
 * names the same id as `requestId` — read from there, as one ULID.
 */
export const requestIdOf = (e: unknown): string | undefined => {
  if (e instanceof ApiError) return e.requestId;
  const body = e instanceof Error ? (e as { body?: unknown }).body : undefined;
  const id = body !== null && typeof body === 'object' ? (body as { requestId?: unknown }).requestId : undefined;
  return typeof id === 'string' && ULID.test(id) ? id : undefined;
};

/** A failure's message for a toast, with the request id to quote when the answer named one (#2192). */
export const failureDetail = (e: unknown): string => {
  const message = e instanceof Error ? e.message : String(e);
  const id = requestIdOf(e);
  return id ? `${message} (request id ${id})` : message;
};

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
