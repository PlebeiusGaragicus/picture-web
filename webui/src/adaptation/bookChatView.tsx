import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatRequestError } from '../formatError';
import type { AdaptationStatus, BookChatSession, PiTraceDocument } from '../types';
import { useBookSessionLoad } from './useBookSessionLoad';
import { cleanSessionPreview, formatSessionSubtitle, PiTraceTimeline, summarizeTrace } from './piTraceView';

function sessionPreviewText(session: BookChatSession, trace: PiTraceDocument | null | undefined) {
  const lastAssistant = [...session.turns].reverse().find((turn) => turn.role === 'assistant' && turn.text.trim());
  if (lastAssistant?.text.trim()) {
    return cleanSessionPreview(lastAssistant.text);
  }
  const lastUser = [...session.turns].reverse().find((turn) => turn.role === 'user' && turn.text.trim());
  if (lastUser?.text.trim()) {
    return cleanSessionPreview(lastUser.text);
  }
  const traceSummary = summarizeTrace(trace ?? null);
  if (traceSummary.preview) {
    return cleanSessionPreview(traceSummary.preview);
  }
  return 'No messages yet';
}

export function BookChatView({
  projectSlug,
  adaptation,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<BookChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
  const canChat = adaptation.hasBookSession && !isReadingBook;

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await api.listBookChatSessions(projectSlug);
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
      const nextTrace = await api.getBookChatTrace(projectSlug, sessionId);
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
    if (cached) {
      setTrace(cached);
      return;
    }
    if (activeSession.turns.length === 0) {
      setTrace({ steps: [], stats: { messageCount: 0, toolCount: 0, userCount: 0, assistantCount: 0 } });
      return;
    }
    void loadTrace(activeSession.id);
  }, [activeSession?.id, activeSession?.turns.length, loadTrace, traceCache]);

  const createSession = async () => {
    if (!canChat) return;
    setError(null);
    try {
      const created = await api.createBookChatSession(projectSlug, { title: `Book chat ${sessions.length + 1}` });
      setSessions((current) => [created, ...current]);
      setActiveSessionId(created.id);
      setDraft('');
      setTrace({ steps: [], stats: { messageCount: 0, toolCount: 0, userCount: 0, assistantCount: 0 } });
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

  const archiveSession = async (session: BookChatSession) => {
    setError(null);
    try {
      const archived = await api.patchBookChatSession(projectSlug, session.id, { archived: true });
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
    if (!text || !activeSession || isSending || !canChat) return;
    setDraft('');
    setIsSending(true);
    setError(null);
    try {
      const updated = await api.sendBookChatTurn(projectSlug, activeSession.id, text);
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
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
    const stats = cachedTrace?.stats ?? {
      messageCount: session.turns.length,
      toolCount: session.turns.filter((turn) => turn.role === 'assistant').reduce(
        (count, turn) => count + turn.events.filter((event) => event.type === 'tool_start').length,
        0,
      ),
    };
    return {
      session,
      preview: sessionPreviewText(session, cachedTrace),
      subtitle: formatSessionSubtitle(session.updatedAt, stats),
    };
  }), [sessions, traceCache]);

  return (
    <div className="story-adaptation-screen">
      <div className="story-adaptation-grid is-book-chat">
        <section className="story-card book-chat-sidebar">
          <header className="book-chat-sidebar-header">
            <div>
              <h2>Book Chat</h2>
              <p className="muted">Conversations forked from the read-book Pi session.</p>
            </div>
            <button className="secondary book-chat-icon-button" type="button" onClick={() => void loadSessions()} disabled={isLoading} aria-label="Refresh chats">
              ↻
            </button>
          </header>

          {!canChat && (
            <div className="book-chat-alert" role="status">
              {isReadingBook
                ? 'Reading book in Pi…'
                : adaptation.hasBook
                  ? 'Read the book on the Story page before starting a chat.'
                  : 'Upload book.txt on the Story page before starting a chat.'}
            </div>
          )}

          {canChat && (
            <div className="book-chat-sidebar-toolbar">
              <button className="generate-button" type="button" onClick={() => void createSession()}>
                New chat
              </button>
            </div>
          )}

          {canChat && (
            <div className="book-chat-session-list">
              {sessionCards.map(({ session, preview, subtitle }) => (
                <button
                  key={session.id}
                  type="button"
                  className={`book-chat-session-item ${activeSession?.id === session.id ? 'is-selected' : ''}`}
                  onClick={() => setActiveSessionId(session.id)}
                >
                  <span className="book-chat-session-title">{session.title}</span>
                  <span className="book-chat-session-preview">{preview}</span>
                  <small>{subtitle}</small>
                </button>
              ))}
              {!sessions.length && (
                <div className="book-chat-empty-panel is-compact">
                  <p className="muted">No chats yet. Start one to ask Pi about the book.</p>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="story-card book-chat-main">
          {error && <p className="error">{error}</p>}
          {activeSession && canChat ? (
            <>
              <div className="archetype-card-head">
                <div>
                  <h2>{activeSession.title}</h2>
                  <p className="muted">
                    {activeSession.piSessionId ? 'Continuing a forked Pi session.' : 'First message forks the read-book session.'}
                  </p>
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
                  <button className="secondary" type="button" onClick={() => void archiveSession(activeSession)} disabled={isSending}>Archive</button>
                </div>
              </div>
              <PiTraceTimeline
                trace={trace}
                collapsed={traceCollapsed}
                isLoading={isTraceLoading}
                emptyMessage="Send a message to start a Pi trace."
                footer={isSending ? (
                  <div className="chat-generation-status" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Pi is reading the book context...
                  </div>
                ) : null}
              />
              <div className="book-chat-composer">
                <textarea
                  className="prompt-textarea"
                  value={draft}
                  disabled={isSending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask about the book, characters, scenes, themes, or adaptation choices..."
                />
                <button className="generate-button" type="button" onClick={() => void send()} disabled={!draft.trim() || isSending}>
                  {isSending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
