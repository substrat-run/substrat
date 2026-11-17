import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';
import { requestLoading, requestOk, settleFailure, type RequestState } from '../request-state';

export interface Request<T> {
  state: RequestState<T>;
  /**
   * Read again. With an answer shown it stays shown until the new one lands (a failed reload
   * keeps it); from an error it goes back to loading, so a Retry visibly does something.
   * Resolves once settled, and never rejects.
   */
  reload: () => Promise<void>;
  /** For an optimistic edit of the answer (pair with `mapOk`). */
  set: Dispatch<SetStateAction<RequestState<T>>>;
}

/**
 * One read, held as a `RequestState` (#3244). `load` runs on mount and whenever `deps` change;
 * a change of `deps` is a different question (another team, another app), so it starts over
 * from loading rather than captioning the new key with the old key's answer. A response that
 * lands after a newer read started is dropped.
 */
export function useRequest<T>(load: () => Promise<T>, deps: DependencyList): Request<T> {
  const [state, set] = useState<RequestState<T>>(requestLoading);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const value = await loadRef.current();
      if (mine === generation.current) set(requestOk(value));
    } catch (error) {
      if (mine === generation.current) set(settleFailure<T>(error));
    }
  }, []);

  useEffect(() => {
    set(requestLoading());
    void run();
    return () => {
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's key
  }, deps);

  const reload = useCallback(() => {
    set((prev) => (prev.state === 'error' ? requestLoading() : prev));
    return run();
  }, [run]);

  return { state, reload, set };
}
