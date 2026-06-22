import { useState } from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import { HelpTip } from '../ui';
import { BookTextSelector, type TextSelectionRange } from './BookTextSelector';
import { PanelChunkList } from './PanelChunkList';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import { sortedPanels, withSelectedText } from './storyPanelUtils';
import { useStoryPanelDocument } from './useStoryPanelDocument';

import { PanelChunksToggleButton } from './PanelChunksToggle';

export function BookTextView({
  projectSlug,
  onNavigateToLayoutEditor,
  isPhaseSidebarCollapsed,
  panelChunksOpen,
  onPanelChunksOpenChange,
}: {
  projectSlug: string;
  onNavigateToLayoutEditor: (navigation: LayoutEditorNavigation) => void;
  isPhaseSidebarCollapsed: boolean;
  panelChunksOpen: boolean;
  onPanelChunksOpenChange: (open: boolean) => void;
}) {
  const {
    bookText,
    document,
    storyPanels,
    isLoading,
    isSaving,
    error,
    setError,
    setDocument,
    saveDocument,
    deletePanel,
  } = useStoryPanelDocument(projectSlug);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedBookPanelId, setFocusedBookPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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

  const openPanelPlacement = (panelId: string) => {
    if (!document) return;
    const panel = document.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    setSelectedPanelId(panelId);
    onNavigateToLayoutEditor({ panelId, layoutMode: 'single-chunks' });
  };

  const createPanel = async () => {
    if (!selection) return;
    setIsCreating(true);
    setError(null);
    try {
      const next = await api.createStoryPanel(projectSlug, selection);
      setDocument(next);
      setSelection(null);
      setSelectedPanelId(
        sortedPanels(next.panels).find(
          (panel) => panel.sourceKind === 'story' && panel.startOffset === selection.startOffset && panel.endOffset === selection.endOffset,
        )?.id ?? null,
      );
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    const next = await deletePanel(panelId);
    if (next) {
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.sourceKind === 'story')?.id ?? null);
    }
  };

  const adjustPanelRange = async (panelId: string, startOffset: number, endOffset: number) => {
    if (!document) return;
    const ordered = sortedPanels(document.panels).filter((panel) => panel.sourceKind === 'story');
    const targetIndex = ordered.findIndex((panel) => panel.id === panelId);
    if (targetIndex < 0) return;
    const target = ordered[targetIndex];
    if (target.startOffset === null || target.endOffset === null) return;
    const nextStart = Math.max(0, Math.min(startOffset, endOffset - 1));
    const nextEnd = Math.min(bookText.length, Math.max(endOffset, nextStart + 1));
    const updates = new Map<string, ReturnType<typeof withSelectedText>>();
    updates.set(target.id, withSelectedText(bookText, { ...target, startOffset: nextStart, endOffset: nextEnd }));
    const previous = ordered[targetIndex - 1];
    if (previous && previous.startOffset !== null && previous.endOffset !== null && previous.endOffset > nextStart) {
      const adjustedPrevious = { ...previous, endOffset: Math.max(previous.startOffset + 1, nextStart) };
      updates.set(previous.id, withSelectedText(bookText, adjustedPrevious));
    }
    const next = ordered[targetIndex + 1];
    if (next && next.startOffset !== null && next.endOffset !== null && next.startOffset < nextEnd) {
      const adjustedNext = { ...next, startOffset: Math.min(next.endOffset - 1, nextEnd) };
      updates.set(next.id, withSelectedText(bookText, adjustedNext));
    }
    await saveDocument({
      ...document,
      panels: document.panels.map((panel) => updates.get(panel.id) ?? panel),
    });
  };

  if (isLoading) {
    return (
      <div className="story-adaptation-screen">
        <p className="muted">Loading book text...</p>
      </div>
    );
  }

  if (!bookText) {
    return (
      <div className="story-adaptation-screen story-view-screen story-view-screen--empty">
        <h1 className="story-view-title">Story</h1>
        <p className="muted">Upload book text in Story & Style before creating panel chunks.</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="story-adaptation-screen story-view-screen story-view-screen--empty">
        <h1 className="story-view-title">Story</h1>
        <p className="error">{error ?? 'Unable to load panel chunks.'}</p>
      </div>
    );
  }

  const panelChunks = (
    <PanelChunkList
      variant="plain"
      bookLength={bookText.length}
      panels={storyPanels}
      pages={document.pages}
      selectedPanelId={selectedPanelId}
      focusedPanelId={focusedChunkPanelId}
      onSelectPanel={selectPanelChunk}
      onOpenPanelPlacement={openPanelPlacement}
      onDeletePanel={handleDeletePanel}
      isSaving={isSaving}
    />
  );

  return (
    <div className="story-adaptation-screen story-panels-screen story-view-screen">
      {!isPhaseSidebarCollapsed && (
        <header className="story-view-head">
          <div className="archetype-card-title">
            <h1 className="story-view-title">Story</h1>
            <HelpTip text="Select a passage to open actions, or drag panel edges to refine chunks." />
          </div>
          {!panelChunksOpen && (
            <PanelChunksToggleButton variant="expand" onClick={() => onPanelChunksOpenChange(true)} />
          )}
        </header>
      )}
      {error && <p className="error error-banner story-view-error">{error}</p>}
      <div className={`story-view-workspace ${panelChunksOpen ? 'is-chunks-open' : ''}`}>
        <div className="story-view-text-pane">
          <BookTextSelector
            bookText={bookText}
            panels={storyPanels}
            selection={selection}
            focusedPanelId={focusedBookPanelId}
            onSelectionChange={setSelection}
            onCreatePanel={createPanel}
            onDeletePanel={handleDeletePanel}
            onAdjustPanelRange={adjustPanelRange}
            onFocusPanelChunk={focusPanelChunk}
            isCreating={isCreating}
          />
        </div>
        {panelChunksOpen && (
          <aside className="story-view-chunks-pane">
            <div className="story-view-chunks-pane-head">
              <h2 className="story-view-chunks-title">Chunks</h2>
              <PanelChunksToggleButton variant="collapse" onClick={() => onPanelChunksOpenChange(false)} />
            </div>
            {panelChunks}
          </aside>
        )}
      </div>
    </div>
  );
}
