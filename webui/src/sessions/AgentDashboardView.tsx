import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '../api';
import { formatRequestError } from '../formatError';
import type { AgentSession, AgentSessionKind, AgentSessionStatus, PiTaskState, PiTaskStatus, PiTraceDocument } from '../types';
import { useAttachedPiTask } from './usePiTask';
import { PiTaskPanel } from './PiTaskPanel';
import { cleanSessionPreview, formatSessionSubtitle, PiTraceTimeline, summarizeTrace } from './PiTraceView';

const emptyTrace: PiTraceDocument = {
  steps: [],
  stats: { messageCount: 0, toolCount: 0, userCount: 0, assistantCount: 0 },
};

function kindLabel(kind: AgentSessionKind) {
  switch (kind) {
    case 'read-book':
      return 'Read book';
    case 'extract-character-list':
      return 'List characters';
    case 'extract-character':
      return 'Extract character';
    case 'extract-all-characters':
      return 'Extract all characters';
    case 'suggest-concept-character':
      return 'Character suggest';
    case 'suggest-concept-location':
      return 'Location suggest';
    case 'draft-panel-prompt':
      return 'Draft panel prompt';
    case 'refine-panel-prompt':
      return 'Refine panel prompt';
    default:
      return kind;
  }
}

function statusLabel(status: AgentSessionStatus) {
  switch (status) {
    case 'running':
      return 'Running';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

function sourceValue(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function sessionPreviewText(session: AgentSession, trace: PiTraceDocument | null | undefined) {
  const traceSummary = summarizeTrace(trace ?? null);
  if (traceSummary.preview) {
    return cleanSessionPreview(traceSummary.preview);
  }
  if (session.error) return cleanSessionPreview(session.error);
  if (session.status === 'running') return 'Pi is working on this session.';
  if (!session.piSessionId && !session.piSessionFile) return 'No Pi trace captured yet.';
  return 'No messages yet.';
}

function sessionSubtitle(session: AgentSession, trace: PiTraceDocument | null | undefined) {
  const stats = trace?.stats ?? {
    messageCount: Number(session.stats?.messageCount ?? 0),
    toolCount: Number(session.stats?.toolCount ?? 0),
  };
  return formatSessionSubtitle(session.updatedAt, stats);
}

function sessionSourceText(session: AgentSession) {
  if (session.kind === 'read-book') return 'Root book-context session used by later Pi tasks.';
  const outputCardId = sourceValue(session.source, 'outputCardId');
  if (outputCardId) return `Created concept card ${outputCardId}.`;
  const outputNodeId = sourceValue(session.source, 'outputNodeId');
  if (outputNodeId) return `Created canvas node ${outputNodeId}.`;
  const panelId = sourceValue(session.source, 'panelId');
  const promptId = sourceValue(session.source, 'promptId');
  if (panelId && promptId) return `Wrote image prompt ${promptId} on ${panelId}.`;
  const subjectKind = sourceValue(session.source, 'subjectKind');
  if (subjectKind) return `Concept Art ${subjectKind} suggestion.`;
  return 'Pi coding-agent session.';
}

/** One live task in the dashboard strip: attaches to the SSE stream by id. */
function ActiveTaskCard({
  projectSlug,
  task,
  onFinished,
  onDismiss,
}: {
  projectSlug: string;
  task: PiTaskStatus;
  onFinished: (state: PiTaskState) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const { state, events, error, abort } = useAttachedPiTask(projectSlug, task.taskId, task.state, onFinished);
  return (
    <PiTaskPanel
      title={task.title}
      state={state}
      events={events}
      error={error}
      onAbort={() => void abort()}
      onDismiss={onDismiss}
    />
  );
}

export function AgentDashboardView({
  projectSlug,
  onReloadAdaptation,
}: {
  projectSlug: string;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [trace, setTrace] = useState<PiTraceDocument | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, PiTraceDocument>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isTraceLoading, setIsTraceLoading] = useState(false);
  const [traceCollapsed, setTraceCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracked live tasks stay visible after they finish until dismissed.
  const [trackedTasks, setTrackedTasks] = useState<PiTaskStatus[]>([]);
  const trackedIdsRef = useRef<Set<string>>(new Set());
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null;

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await api.listAgentSessions(projectSlug);
      setSessions(next);
      setActiveSessionId((current) => current && next.some((session) => session.id === current) ? current : next[0]?.id ?? null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Discover running tasks and keep watching for new ones.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const active = await api.listPiTasks(projectSlug, { active: true });
        if (cancelled) return;
        const fresh = active.filter((task) => !trackedIdsRef.current.has(task.taskId));
        if (fresh.length) {
          for (const task of fresh) trackedIdsRef.current.add(task.taskId);
          setTrackedTasks((current) => [...current, ...fresh]);
        }
      } catch (err) {
        console.error('[photo-web] failed to poll pi tasks', err);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectSlug]);

  const dismissTask = useCallback((taskId: string) => {
    trackedIdsRef.current.delete(taskId);
    setTrackedTasks((current) => current.filter((task) => task.taskId !== taskId));
  }, []);

  const onTaskFinished = useCallback(async () => {
    await loadSessions();
    await onReloadAdaptation();
  }, [loadSessions, onReloadAdaptation]);

  const loadTrace = useCallback(async (sessionId: string) => {
    setIsTraceLoading(true);
    setError(null);
    try {
      const nextTrace = await api.getAgentSessionTrace(projectSlug, sessionId);
      setTrace(nextTrace);
      setTraceCache((current) => ({ ...current, [sessionId]: nextTrace }));
    } catch (err) {
      setTrace(null);
      setError(formatRequestError(err));
    } finally {
      setIsTraceLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    if (!activeSession?.id) {
      setTrace(null);
      return;
    }
    const cached = traceCache[activeSession.id];
    if (cached && activeSession.status !== 'running') {
      setTrace(cached);
      return;
    }
    if (!activeSession.piSessionId && !activeSession.piSessionFile) {
      setTrace(emptyTrace);
      return;
    }
    void loadTrace(activeSession.id);
  }, [activeSession?.id, activeSession?.piSessionFile, activeSession?.piSessionId, activeSession?.status, loadTrace, traceCache]);

  useEffect(() => {
    if (!sessions.some((session) => session.status === 'running')) return;
    const timer = window.setInterval(async () => {
      const next = await api.listAgentSessions(projectSlug);
      setSessions(next);
      const selected = activeSessionId ? next.find((session) => session.id === activeSessionId) : null;
      if (selected?.status === 'running' && (selected.piSessionId || selected.piSessionFile)) {
        await loadTrace(selected.id);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeSessionId, loadTrace, projectSlug, sessions]);

  const archiveSession = async (session: AgentSession) => {
    setError(null);
    try {
      const archived = await api.patchAgentSession(projectSlug, session.id, { archived: true });
      setSessions((current) => current.filter((item) => item.id !== archived.id));
      setActiveSessionId((current) => current === archived.id ? null : current);
      setTraceCache((current) => {
        const next = { ...current };
        delete next[archived.id];
        return next;
      });
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

  const sessionCards = useMemo(() => sessions.map((session) => {
    const cachedTrace = traceCache[session.id];
    return {
      session,
      preview: sessionPreviewText(session, cachedTrace),
      subtitle: sessionSubtitle(session, cachedTrace),
    };
  }), [sessions, traceCache]);

  return (
    <div className="story-adaptation-screen">
      {trackedTasks.length > 0 && (
        <div className="agent-dashboard-tasks">
          <header className="agent-dashboard-tasks-header">
            <h2>Live tasks</h2>
            <p className="muted">Pi agents working right now. Panels stay after they finish until dismissed.</p>
          </header>
          {trackedTasks.map((task) => (
            <ActiveTaskCard
              key={task.taskId}
              projectSlug={projectSlug}
              task={task}
              onFinished={onTaskFinished}
              onDismiss={() => dismissTask(task.taskId)}
            />
          ))}
        </div>
      )}
      <div className="story-adaptation-grid is-agent-sessions">
        <section className="story-card agent-dashboard-sidebar">
          <header className="agent-dashboard-sidebar-header">
            <div>
              <h2>Agent Sessions</h2>
              <p className="muted">Every narrow pi task run in this project, with its full trace.</p>
            </div>
            <button className="secondary agent-dashboard-icon-button" type="button" onClick={() => void loadSessions()} disabled={isLoading} aria-label="Refresh sessions">
              ↻
            </button>
          </header>

          <div className="agent-dashboard-session-list">
            {sessionCards.map(({ session, preview, subtitle }) => (
              <button
                key={session.id}
                type="button"
                className={clsx('agent-dashboard-session-item', activeSession?.id === session.id && 'is-selected')}
                onClick={() => setActiveSessionId(session.id)}
              >
                <span className="agent-dashboard-session-title-row">
                  <span className="agent-dashboard-session-title">{session.title}</span>
                  <span className={clsx('agent-session-status', `is-${session.status}`)}>{statusLabel(session.status)}</span>
                </span>
                <span className="agent-dashboard-session-kind">{kindLabel(session.kind)}</span>
                <span className="agent-dashboard-session-preview">{preview}</span>
                <small>{subtitle}</small>
              </button>
            ))}
            {!sessions.length && (
              <div className="agent-dashboard-empty-panel is-compact">
                <p className="muted">No agent sessions yet. Run Read book, Suggest, or Draft prompt from the other views.</p>
              </div>
            )}
          </div>
        </section>

        <section className="story-card agent-dashboard-main">
          {error && <p className="error">{error}</p>}
          {activeSession ? (
            <>
              <div className="archetype-card-head">
                <div>
                  <div className="agent-session-heading">
                    <h2>{activeSession.title}</h2>
                    <span className={clsx('agent-session-status', `is-${activeSession.status}`)}>{statusLabel(activeSession.status)}</span>
                  </div>
                  <p className="muted">{sessionSourceText(activeSession)}</p>
                </div>
                <div className="agent-dashboard-main-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setTraceCollapsed((value) => !value)}
                    disabled={!trace?.steps.length}
                  >
                    {traceCollapsed ? 'Expand trace' : 'Collapse trace'}
                  </button>
                  <button className="secondary" type="button" onClick={() => void loadSessions()} disabled={isLoading}>Refresh</button>
                  <button className="secondary" type="button" onClick={() => void archiveSession(activeSession)}>Archive</button>
                </div>
              </div>
              {activeSession.error && <p className="error">{activeSession.error}</p>}
              <PiTraceTimeline
                trace={trace}
                collapsed={traceCollapsed}
                isLoading={isTraceLoading}
                emptyMessage={activeSession.status === 'running' ? 'Waiting for Pi trace events…' : 'No Pi trace yet.'}
              />
            </>
          ) : (
            <div className="agent-dashboard-empty-panel">
              <p className="muted">Select an agent session to browse its trace.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
