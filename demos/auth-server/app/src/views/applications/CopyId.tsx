import { useState } from 'react';

/**
 * A record's id with a copy button — the string an operator pastes into a support thread or
 * matches against a customer's own configuration. Shared by the user and application headers.
 */
export function CopyId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <code>{value}</code>
      <button
        className="btn tiny"
        aria-label={`Copy the ${label}`}
        onClick={async () => {
          // Only claim it was copied if it was. `navigator.clipboard` is absent outside a
          // secure context, and a button that says "Copied" over an empty clipboard is
          // worse than one that does nothing visible.
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
