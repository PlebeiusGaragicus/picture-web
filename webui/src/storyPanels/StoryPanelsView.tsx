import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import type { StoryPanel, StoryPanelDocument } from '../types';
import { BookTextSelector, type TextSelectionRange } from './BookTextSelector';
import { PageLayoutEditor } from './PageLayoutEditor';
import { PanelChunkList } from './PanelChunkList';

function sortedPanels(panels: StoryPanel[]) {
  return [...panels].sort((a, b) => a.startOffset - b.startOffset || a.order - b.order);
}

function withSelectedText(bookText: string, panel: StoryPanel): StoryPanel {
  return { ...panel, selectedText: bookText.slice(panel.startOffset, panel.endOffset) };
}

export function StoryPanelsView({ projectSlug }: { projectSlug: string }) {
  const [bookText, setBookText] = useState('');
  const [document, setDocument] = useState<StoryPanelDocument | null>(null);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedBookPanelId, setFocusedBookPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [book, panels] = await Promise.all([
        api.getStoryPanelBook(projectSlug),
        api.getStoryPanels(projectSlug),
      ]);
      setBookText(book.text);
      setDocument(panels);
      setSelectedPanelId((current) => current ?? sortedPanels(panels.panels)[0]?.id ?? null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const panels = useMemo(() => sortedPanels(document?.panels ?? []), [document]);

  const selectPanelChunk = (panelId: string) => {
    setSelectedPanelId(panelId);
    setFocusedBookPanelId(null);
    window.setTimeout(() => setFocusedBookPanelId(panelId), 0);
  };

  const focusPanelChunk = (panelId: string) => {
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const createPanel = async () => {
    if (!selection) return;
    setIsCreating(true);
    setError(null);
    try {
      const next = await api.createStoryPanel(projectSlug, selection);
      setDocument(next);
      setSelection(null);
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.startOffset === selection.startOffset && panel.endOffset === selection.endOffset)?.id ?? null);
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsCreating(false);
    }
  };

  const saveDocument = async (nextDocument: StoryPanelDocument) => {
    setIsSaving(true);
    setError(null);
    try {
      const saved = await api.saveStoryPanels(projectSlug, nextDocument);
      setDocument(saved);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deletePanel = async (panelId: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const next = await api.deleteStoryPanel(projectSlug, panelId);
      setDocument(next);
      setSelectedPanelId(sortedPanels(next.panels)[0]?.id ?? null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  const adjustPanelRange = async (panelId: string, startOffset: number, endOffset: number) => {
    if (!document) return;
    const ordered = sortedPanels(document.panels);
    const targetIndex = ordered.findIndex((panel) => panel.id === panelId);
    if (targetIndex < 0) return;
    const target = ordered[targetIndex];
    const nextStart = Math.max(0, Math.min(startOffset, endOffset - 1));
    const nextEnd = Math.min(bookText.length, Math.max(endOffset, nextStart + 1));
    const updates = new Map<string, StoryPanel>();
    updates.set(target.id, withSelectedText(bookText, { ...target, startOffset: nextStart, endOffset: nextEnd }));
    const previous = ordered[targetIndex - 1];
    if (previous && previous.endOffset > nextStart) {
      const adjustedPrevious = { ...previous, endOffset: Math.max(previous.startOffset + 1, nextStart) };
      updates.set(previous.id, withSelectedText(bookText, adjustedPrevious));
    }
    const next = ordered[targetIndex + 1];
    if (next && next.startOffset < nextEnd) {
      const adjustedNext = { ...next, startOffset: Math.min(next.endOffset - 1, nextEnd) };
      updates.set(next.id, withSelectedText(bookText, adjustedNext));
    }
    await saveDocument({
      ...document,
      panels: document.panels.map((panel) => updates.get(panel.id) ?? panel),
    });
  };

  const toggleFinalized = async (panel: StoryPanel) => {
    setIsSaving(true);
    setError(null);
    try {
      const next = await api.patchStoryPanel(projectSlug, panel.id, { finalized: !panel.finalized });
      setDocument(next);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="story-adaptation-screen">
        <p className="muted">Loading story panels...</p>
      </div>
    );
  }

  if (!bookText) {
    return (
      <div className="story-adaptation-screen">
        <section className="story-card">
          <h2>Story Panels</h2>
          <p className="muted">Upload book text in Story & Style before creating panel chunks.</p>
        </section>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="story-adaptation-screen">
        <section className="story-card">
          <h2>Story Panels</h2>
          <p className="error">{error ?? 'Unable to load story panels.'}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="story-adaptation-screen story-panels-screen">
      <header className="story-panels-header story-card">
        <div>
          <h1>Story Panels</h1>
          <p className="muted">Chunk the source text into comic panels, then shape those panels on pages.</p>
        </div>
        <div className="story-panels-stats">
          <strong>{panels.length}</strong>
          <span>panels</span>
        </div>
      </header>
      {error && <p className="error error-banner">{error}</p>}
      <div className="story-panels-grid">
        <PageLayoutEditor
          document={document}
          selectedPanelId={selectedPanelId}
          onSelectPanel={setSelectedPanelId}
          onSaveDocument={saveDocument}
          isSaving={isSaving}
        />
        <div className="story-panels-text-row">
          <BookTextSelector
            bookText={bookText}
            panels={panels}
            selection={selection}
            focusedPanelId={focusedBookPanelId}
            onSelectionChange={setSelection}
            onCreatePanel={createPanel}
            onDeletePanel={deletePanel}
            onAdjustPanelRange={adjustPanelRange}
            onFocusPanelChunk={focusPanelChunk}
            isCreating={isCreating}
          />
          <PanelChunkList
            bookLength={bookText.length}
            panels={panels}
            pages={document.pages}
            selectedPanelId={selectedPanelId}
            focusedPanelId={focusedChunkPanelId}
            onSelectPanel={selectPanelChunk}
            onDeletePanel={deletePanel}
            onToggleFinalized={toggleFinalized}
            isSaving={isSaving}
          />
        </div>
      </div>
    </div>
  );
}
