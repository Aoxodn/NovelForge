import { useCallback, useEffect, useRef, useState } from 'react';

export interface DurableDraft<T extends object> {
  draft: T;
  setDraft: (patch: Partial<T> | ((prev: T) => T)) => void;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  flush: () => Promise<boolean>;
  reset: (value: T) => void;
  retry: () => Promise<boolean>;
}

interface Session<T> {
  id: number | null;
  value: T;
  revision: number;
  savedRevision: number;
  error: string | null;
  inFlight: Promise<boolean> | null;
}

/** Each entity owns its snapshot and save queue. Late responses cannot save
 * another entity's draft or clear its state. flush joins the existing queue. */
export function useDurableDraft<T extends object>(
  entityId: number | null,
  initial: T,
  saveFn: (id: number, draft: T) => Promise<unknown>,
  debounceMs = 800,
): DurableDraft<T> {
  const makeSession = (id: number | null, value: T): Session<T> => ({
    id,
    value,
    revision: 0,
    savedRevision: 0,
    error: null,
    inFlight: null,
  });
  const sessionRef = useRef<Session<T>>(makeSession(entityId, initial));
  const sessions = useRef(new Map<number | null, Session<T>>());
  const saveRef = useRef(saveFn);
  saveRef.current = saveFn;
  const mounted = useRef(false);
  const [, render] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback(() => {
    if (mounted.current) render((n) => n + 1);
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const persist = useCallback(
    (session: Session<T>): Promise<boolean> => {
      if (session.inFlight) return session.inFlight;
      if (session.id === null || session.savedRevision === session.revision) {
        return Promise.resolve(true);
      }
      const id = session.id;
      // Assign inFlight before invoking save, including synchronous failures.
      session.inFlight = Promise.resolve().then(async () => {
        session.error = null;
        try {
          while (session.savedRevision !== session.revision) {
            const revision = session.revision;
            const snapshot = session.value;
            await saveRef.current(id, snapshot);
            session.savedRevision = revision;
          }
          return true;
        } catch (e) {
          session.error = String(e);
          return false;
        } finally {
          session.inFlight = null;
          notify();
        }
      });
      notify();
      return session.inFlight;
    },
    [notify],
  );

  const flush = useCallback(() => {
    clearTimer();
    return persist(sessionRef.current);
  }, [clearTimer, persist]);

  useEffect(() => {
    const previous = sessionRef.current;
    if (previous.id !== entityId) {
      clearTimer();
      sessions.current.set(previous.id, previous);
      void persist(previous);
      sessionRef.current =
        sessions.current.get(entityId) ?? makeSession(entityId, initial);
      notify();
    }
    // initial is a seed, not a reason to replace an edited draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, clearTimer, persist, notify]);

  const session = sessionRef.current;
  useEffect(() => {
    if (
      session.savedRevision === session.revision ||
      session.id === null ||
      session.error
    )
      return;
    timer.current = setTimeout(() => void persist(session), debounceMs);
    return clearTimer;
  }, [
    session,
    session.revision,
    session.savedRevision,
    session.error,
    debounceMs,
    persist,
    clearTimer,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      void persist(sessionRef.current);
    };
  }, [clearTimer, persist]);

  const setDraft = useCallback(
    (patch: Partial<T> | ((prev: T) => T)) => {
      const current = sessionRef.current;
      current.value =
        typeof patch === 'function'
          ? patch(current.value)
          : { ...current.value, ...patch };
      current.revision += 1;
      current.error = null;
      notify();
    },
    [notify],
  );

  const reset = useCallback(
    (value: T) => {
      const current = sessionRef.current;
      // External refreshes must not erase a pending or failed draft.
      if (current.inFlight || current.savedRevision !== current.revision)
        return;
      clearTimer();
      current.value = value;
      current.error = null;
      notify();
    },
    [clearTimer, notify],
  );

  return {
    draft: session.value,
    setDraft,
    dirty: session.savedRevision !== session.revision,
    saving: session.inFlight !== null,
    error: session.error,
    flush,
    reset,
    retry: flush,
  };
}
