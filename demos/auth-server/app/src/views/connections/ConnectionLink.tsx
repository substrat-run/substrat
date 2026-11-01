import type { CSSProperties, ReactNode } from 'react';
import { navigate } from '../../console/router';
import { connectionPath } from '../../console/routes';

/**
 * A real anchor to a connection, not a click handler on a cell: a connection is a place, so the
 * link has to be copyable, middle-clickable and openable in a tab. The plain click stays
 * same-document.
 */
export function ConnectionLink({
  id, className, style, children,
}: { id: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  const href = connectionPath(id);
  return (
    <a
      href={href}
      className={className}
      style={style}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
