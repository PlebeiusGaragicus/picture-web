import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatRequestError } from '../formatError';
import type { PiTaskEvent, PiTaskProfile, PiTaskState } from '../types';

const TERMINAL_STATES: PiTaskState[] = ['done', 'failed', 'cancelled'];

export function isTerminalTaskState(state: PiTaskState | null): boolean {
  return state !== null && TERMINAL_STATES.includes(state);
}

/**
 * Drives one narrow pi task profile: starts it, attaches to its SSE event
 * stream (reattaching to an already-running task on mount), and reports
 * live events + terminal state. `onFinished` fires once per completed run.
 */
export function usePiTask(
  projectSlug: string | null,
  profile: PiTaskProfile,
  onFinished?: (state: PiTaskState) => void | Promise<void>,
) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [state, setState] = useState<PiTaskState | null>(null);
  const [events, setEvents] = useState<PiTaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const attach = useCallback(
    (slug: string, id: string) => {
      closeStream();
      finishedRef.current = false;
      setTaskId(id);
      setEvents([]);
      const source = new EventSource(api.piTaskEventsUrl(slug, id));
      sourceRef.current = source;
      source.onmessage = (message) => {
        let record: PiTaskEvent;
        try {
          record = JSON.parse(message.data) as PiTaskEvent;
        } catch {
          return;
        }
        setEvents((current) => [...current, record]);
        if (record.event.type === 'task_state') {
          const nextState = record.event.state as PiTaskState;
          setState(nextState);
          if (record.event.error) {
            setError(String(record.event.error));
          }
          if (isTerminalTaskState(nextState) && !finishedRef.current) {
            finishedRef.current = true;
            source.close();
            if (sourceRef.current === source) sourceRef.current = null;
            void onFinishedRef.current?.(nextState);
          }
        }
      };
      source.onerror = () => {
        // Stream closed server-side after a terminal event; EventSource
        // auto-reconnects otherwise (with Last-Event-ID replay).
        if (finishedRef.current) {
          source.close();
        }
      };
    },
    [closeStream],
  );

  // Reattach to an already-running task for this profile on mount.
  useEffect(() => {
    if (!projectSlug) {
      setTaskId(null);
      setState(null);
      setEvents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const active = await api.listPiTasks(projectSlug, { profile, active: true });
        if (!cancelled && active.length) {
          setState(active[0].state);
          setTarget(active[0].target ?? null);
          attach(projectSlug, active[0].taskId);
        }
      } catch (err) {
        console.error('[photo-web] failed to check running pi tasks', err);
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [attach, closeStream, profile, projectSlug]);

  const start = useCallback(
    async (options: { target?: string; force?: boolean; instructions?: string } = {}) => {
      if (!projectSlug) return;
      setError(null);
      try {
        const status = await api.startPiTask(projectSlug, profile, options);
        setState(status.state);
        setTarget(status.target ?? null);
        attach(projectSlug, status.taskId);
      } catch (err) {
        setError(formatRequestError(err));
      }
    },
    [attach, profile, projectSlug],
  );

  const abort = useCallback(async () => {
    if (!projectSlug || !taskId) return;
    try {
      await api.abortPiTask(projectSlug, taskId);
    } catch (err) {
      setError(formatRequestError(err));
    }
  }, [projectSlug, taskId]);

  const dismiss = useCallback(() => {
    closeStream();
    setTaskId(null);
    setTarget(null);
    setState(null);
    setEvents([]);
    setError(null);
  }, [closeStream]);

  const isActive = state !== null && !isTerminalTaskState(state);

  return { taskId, target, state, events, error, isActive, start, abort, dismiss };
}
