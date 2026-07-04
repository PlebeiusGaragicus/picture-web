import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatRequestError } from '../formatError';
import type { AdaptationStatus, AgentSession, AgentSessionKind, AgentSessionStatus, BookChatSession, PiTraceDocument } from '../types';
import { useBookSessionLoad } from './useBookSessionLoad';
import { cleanSessionPreview, formatSessionSubtitle, PiTraceTimeline, summarizeTrace } from './PiTraceView';

const emptyTrace: PiTraceDocument = {
  steps: [],
  stats: { messageCount: 0, toolCount: 0, userCount: 0, assistantCount: 0 },
};

function kindLabel(kind: AgentSessionKind) {
  switch (kind) {
    case 'read-book':
      return 'Read book';
    case 'book-chat':
      return 'Book chat';
    case 'concept-character-suggest':
      return 'Character suggest';
    case 'concept-location-suggest':
      return 'Location suggest';
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

function bookChatSessionId(session: AgentSession | null) {
  if (!session || session.kind !== 'book-chat') return null;
  return sourceValue(session.source, 'bookChatSessionId') ?? session.id;
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
  if (session.kind === 'book-chat') return 'Conversation forked from the read-book session.';
  if (session.kind === 'read-book') return 'Root book-context session used by later Pi tasks.';
  const outputCardId = sourceValue(session.source, 'outputCardId');
  if (outputCardId) return `Created concept card ${outputCardId}.`;
  const outputNodeId = sourceValue(session.source, 'outputNodeId');
  if (outputNodeId) return `Created canvas node ${outputNodeId}.`;
  const subjectKind = sourceValue(session.source, 'subjectKind');
  if (subjectKind) return `Concept Art ${subjectKind} suggestion.`;
  return 'Pi coding-agent session.';
}

export function AgentSessionsView({
  projectSlug,
  adaptation,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeBookChat, setActiveBookChat] = useState<BookChatSession | null>(null);
  const [trace, setTrace] = useState<PiTraceDocument | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, PiTraceDocument>>({});
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTraceLoading, setIsTraceLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [traceCollapsed, setTraceCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isLoading: isReadingBook } = useBookSessionLoad(projectSlug, onReloadAdaptation);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null;
  const activeBookChatId = bookChatSessionId(activeSession);
  const canCreateChat = adaptation.hasBookSession && !isReadingBook;
  const canSendChat = canCreateChat && activeSession?.kind === 'book-chat' && activeSession.status !== 'archived';

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
    if (!activeBookChatId) {
      setActiveBookChat(null);
      return;
    }
    let cancelled = false;
    api.getBookChatSession(projectSlug, activeBookChatId)
      .then((session) => {
        if (!cancelled) setActiveBookChat(session);
      })
      .catch(() => {
        if (!cancelled) setActiveBookChat(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeBookChatId, projectSlug]);

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

  const createSession = async () => {
    if (!canCreateChat) return;
    setError(null);
    try {
      const created = await api.createBookChatSession(projectSlug, { title: `Book chat ${sessions.length + 1}` });
      await loadSessions();
      setActiveSessionId(created.id);
      setDraft('');
      setTrace(emptyTrace);
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

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

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeSession || !activeBookChatId || isSending || !canSendChat) return;
    setDraft('');
    setIsSending(true);
    setError(null);
    try {
      const updated = await api.sendBookChatTurn(projectSlug, activeBookChatId, text);
      setActiveBookChat(updated);
      await loadSessions();
      await loadTrace(updated.id);
    } catch (err) {
      setError(formatRequestError(err));
      await loadSessions();
    } finally {
      setIsSending(false);
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
      <div className="story-adaptation-grid is-book-chat is-agent-sessions">
        <section className="story-card book-chat-sidebar">
          <header className="book-chat-sidebar-header">
            <div>
              <h2>Agent Sessions</h2>
              <p className="muted">Browse Pi traces from Read book, Suggest, and book chats.</p>
            </div>
            <button className="secondary book-chat-icon-button" type="button" onClick={() => void loadSessions()} disabled={isLoading} aria-label="Refresh chats">
              ↻
            </button>
          </header>

          {!canCreateChat && (
            <div className="book-chat-alert" role="status">
              {isReadingBook
                ? 'Reading book in Pi…'
                : adaptation.hasBook
                  ? 'Read the book on the Story page before starting a book chat.'
                  : 'Upload book.txt on the Story page before starting a book chat.'}
            </div>
          )}

          <div className="book-chat-sidebar-toolbar">
            {canCreateChat && (
              <button className="generate-button" type="button" onClick={() => void createSession()}>
                New chat
              </button>
            )}
          </div>

          <div className="book-chat-session-list">
            {sessionCards.map(({ session, preview, subtitle }) => (
              <button
                key={session.id}
                type="button"
                className={`book-chat-session-item ${activeSession?.id === session.id ? 'is-selected' : ''}`}
                onClick={() => setActiveSessionId(session.id)}
              >
                <span className="book-chat-session-title-row">
                  <span className="book-chat-session-title">{session.title}</span>
                  <span className={`agent-session-status is-${session.status}`}>{statusLabel(session.status)}</span>
                </span>
                <span className="book-chat-session-kind">{kindLabel(session.kind)}</span>
                <span className="book-chat-session-preview">{preview}</span>
                <small>{subtitle}</small>
              </button>
            ))}
            {!sessions.length && (
              <div className="book-chat-empty-panel is-compact">
                <p className="muted">No agent sessions yet. Use Read book or Suggest to create one.</p>
              </div>
            )}
          </div>
        </section>

        <section className="story-card book-chat-main">
          {error && <p className="error">{error}</p>}
          {activeSession ? (
            <>
              <div className="archetype-card-head">
                <div>
                  <div className="agent-session-heading">
                    <h2>{activeSession.title}</h2>
                    <span className={`agent-session-status is-${activeSession.status}`}>{statusLabel(activeSession.status)}</span>
                  </div>
                  <p className="muted">{sessionSourceText(activeSession)}</p>
                </div>
                <div className="book-chat-main-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setTraceCollapsed((value) => !value)}
                    disabled={!trace?.steps.length}
                  >
                    {traceCollapsed ? 'Expand trace' : 'Collapse trace'}
                  </button>
                  <button className="secondary" type="button" onClick={() => void loadSessions()} disabled={isLoading}>Refresh</button>
                  <button className="secondary" type="button" onClick={() => void archiveSession(activeSession)} disabled={isSending}>Archive</button>
                </div>
              </div>
              {activeSession.error && <p className="error">{activeSession.error}</p>}
              <PiTraceTimeline
                trace={trace}
                collapsed={traceCollapsed}
                isLoading={isTraceLoading}
                emptyMessage={activeSession.status === 'running' ? 'Waiting for Pi trace events…' : 'No Pi trace yet.'}
                footer={isSending ? (
                  <div className="chat-generation-status" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Pi is reading the book context...
                  </div>
                ) : null}
              />
              {activeSession.kind === 'book-chat' && (
                <div className="book-chat-composer">
                  <textarea
                    className="prompt-textarea"
                    value={draft}
                    disabled={isSending || !canSendChat}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={activeBookChat ? 'Ask about the book, characters, scenes, themes, or adaptation choices...' : 'Loading book chat...'}
                  />
                  <button className="generate-button" type="button" onClick={() => void send()} disabled={!draft.trim() || isSending || !activeBookChat || !canSendChat}>
                    {isSending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="book-chat-empty-panel">
              <p className="muted">Select an agent session to browse its trace.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export const BookChatView = AgentSessionsView;
