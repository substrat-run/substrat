import type { CSSProperties, ReactNode } from 'react';
import { requestErrorText, type RequestState } from '../request-state';
import { Button } from './controls';

export interface RequestErrorProps {
  /** What could not be read, as a noun phrase: "the team's members". */
  what: string;
  error?: unknown;
  /** Read again. Absent ⇒ no button (a read with nothing to retry). */
  onRetry?: () => void;
  style?: CSSProperties;
}

/** A failed read, said as one — never drawn as an empty list (#3244). */
export function RequestError({ what, error, onRetry, style }: RequestErrorProps) {
  const detail = requestErrorText(error);
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', fontSize: 13, color: 'var(--text-secondary)', ...style }}>
      <span style={{ flex: '1 1 240px' }}>
        <span style={{ color: 'var(--status-danger-fg)', fontWeight: 500 }}>Could not read {what}.</span>
        {detail && <span style={{ color: 'var(--text-tertiary)' }}> {detail}</span>}
      </span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export interface RequestViewProps<T> {
  state: RequestState<T>;
  /** Drawn while loading — a `SkeletonRegion` laid out like `children` will be. */
  skeleton: ReactNode;
  /** Drawn only for a settled answer with nothing in it. */
  empty: ReactNode;
  /** Default: an empty array. */
  isEmpty?: (value: T) => boolean;
  /** Noun phrase for the error: "the team's members". */
  what: string;
  onRetry?: () => void;
  errorStyle?: CSSProperties;
  children: (value: T) => ReactNode;
}

/**
 * Loading, failed, empty or the content — chosen from the request's state, never from the
 * value's length alone (#3244). The empty state is a claim about the data, so it waits for
 * an answer; a failed read is an error with a retry, never "nothing here".
 */
export function RequestView<T>({ state, skeleton, empty, isEmpty = defaultIsEmpty, what, onRetry, errorStyle, children }: RequestViewProps<T>) {
  if (state.state === 'loading') return <>{skeleton}</>;
  if (state.state === 'error') return <RequestError what={what} error={state.error} onRetry={onRetry} style={errorStyle} />;
  return <>{isEmpty(state.value) ? empty : children(state.value)}</>;
}

const defaultIsEmpty = (value: unknown) => Array.isArray(value) && value.length === 0;
